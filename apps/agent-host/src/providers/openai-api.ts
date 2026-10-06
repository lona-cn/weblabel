//! OpenAI Platform API adapter (Responses API) for `openai_api`.
//!
//! Wire shape follows the provider's own contract (docs/provider-compatibility.md):
//! `POST {base}/responses` with `authorization: Bearer`, `instructions`, typed
//! `input` items carrying `input_image` payloads, flat `function` tools with
//! `strict`, and Responses SSE events (`response.output_item.added`,
//! `response.function_call_arguments.*`, `response.completed`). This is NOT an
//! OpenAI-compatible template shared with the other adapters.

import type { ModelCapabilities } from '../../../../packages/contracts/generated/ModelCapabilities';
import type { ModelProfile } from '../../../../packages/contracts/generated/ModelProfile';
import type { RunEvent } from '../../../../packages/contracts/generated/RunEvent';
import type { StartRunRequest } from '../../../../packages/contracts/generated/StartRunRequest';
import suggestionSchema from '../../../../packages/contracts/generated/suggestion_set.schema.json';
import type { AttributeDef } from '../../../../packages/contracts/generated/AttributeDef';
import type { ProviderAdapter, RuntimeContext } from '../registry';
import { redactText, redactValue } from '../security/redaction';
import {
  BoundedHttpClient,
  DEFAULT_TOOL_BUDGETS,
  ToolLoopBudget,
  resolveSecretRef,
  validateSecretRef,
  type BaseApproval,
  type FetchLike,
  type SseFrame,
  type ToolBudgets,
} from './http/client';
import {
  ProviderError,
  decodeJson,
  parseToolCallArguments,
  validateCandidateDraft,
  type CandidateDomainContext,
  type ProviderErrorCode,
} from './http/errors';
import { ImageBudget, imageGrantIds, planImageInputs, prepareImage, type PreparedImageInput } from './http/images';
import { costDisplay, normalizeUsage, totalObservedUsage, updateObservedUsage, type NormalizedUsage, type TokenPricing } from './http/usage';

export interface OpenAiApiAdapterConfig {
  profile_id: string;
  /** Exact account-available full model ID (e.g. `gpt-6-luna`); never an alias. */
  model_id: string;
  credential: { secret_ref: string };
  api_base?: string;
  base_approval?: BaseApproval;
  local_admins?: string[];
  /** Explicit capability evidence; nothing is inferred from the model name. */
  capabilities?: ModelCapabilities;
  /** Unknown account entitlement stays blocked until verified (live gate: T32). */
  account_model_verified?: boolean;
  budgets?: Partial<ToolBudgets>;
  pricing?: TokenPricing | null;
  fetch_impl?: FetchLike;
  secret_env?: Record<string, string | undefined>;
  timeout_ms?: number;
  max_response_bytes?: number;
  max_stream_bytes?: number;
}

const SYSTEM_TEXT = 'You are a WebLabel annotation assistant. Use the provided tools to inspect regions and propose changes.';
const READ_REGION_DESC =
  'Read an authorized image region as a PNG crop. region=null reads the full image. The crop is attached to the next message; this call returns transform metadata only.';
const PROPOSE_DESC = 'Submit proposed annotation changes and quality issues. Use null for omitted issues, optional create attributes or unchanged partial-edit attributes. The server validates every field strictly before anything is stored.';
const REPORT_DESC = 'Report suspected quality issues without proposing annotation changes.';

type JsonSchema = Record<string, unknown>;
const DEFINITIONS = suggestionSchema.definitions as Record<string, JsonSchema>;

/** Project the generated domain contract into OpenAI's strict subset. Attribute
 * maps are closed over the actual ontology, not replaced with open objects.
 * The original schema/domain validators remain authoritative on tool output. */
function strictSchema(schema: JsonSchema): JsonSchema {
  if (typeof schema.$ref === 'string') {
    const name = schema.$ref.split('/').at(-1)!;
    if (name === 'AttributeMap') throw new ProviderError('adapter_error', 'attribute schema requires ontology');
    return strictSchema(DEFINITIONS[name]);
  }
  const result: JsonSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'format' || key === 'propertyNames') continue;
    if (key === 'oneOf' || key === 'anyOf') result.anyOf = (value as JsonSchema[]).map(strictSchema);
    else if (key === 'items') result.items = strictSchema(value as JsonSchema);
    else if (key === 'properties') result.properties = Object.fromEntries(
      Object.entries(value as Record<string, JsonSchema>).map(([name, child]) => [name, strictSchema(child)]),
    );
    else result[key] = value;
  }
  if (result.type === 'object') {
    result.additionalProperties = false;
    result.required = Object.keys(result.properties as JsonSchema);
  }
  return result;
}

function attributeSchema(defs: AttributeDef[], partial: boolean): JsonSchema {
  const properties = Object.fromEntries(defs.map(def => {
    const scalar: JsonSchema = def.kind === 'enum' ? { type: 'string', enum: def.enum_values }
      : { type: def.kind === 'text' ? 'string' : def.kind };
    // Strict schemas require every property. Null explicitly denotes an
    // omitted optional attribute or a field not changed by a partial edit.
    return [def.key, partial || !def.required ? { anyOf: [scalar, { type: 'null' }] } : scalar];
  }));
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}

function toolsForDomain(domain: CandidateDomainContext): JsonSchema[] {
  const attributes = (partial: boolean): JsonSchema => domain.ontology.labels.length === 0
    ? attributeSchema([], partial)
    : { anyOf: domain.ontology.labels.map(label => attributeSchema(label.attributes, partial)) };
  const object = DEFINITIONS.AnnotationObject;
  const annotation = strictSchema({ ...object, properties: {
    ...(object.properties as JsonSchema), attributes: attributes(false),
  } });
  const changes = (DEFINITIONS.Change.oneOf as JsonSchema[]).map(change => {
    const properties = change.properties as JsonSchema;
    return strictSchema({ ...change, properties: {
      ...properties,
      ...('object' in properties ? { object: annotation } : {}),
      ...('values' in properties ? { values: attributes(true) } : {}),
    } });
  });
  const bbox = strictSchema(DEFINITIONS.BBox);
  const issues = { type: 'array', items: strictSchema(DEFINITIONS.QualityIssue) };
  return [
    { type: 'function', name: 'read_region', description: READ_REGION_DESC, strict: true, parameters: {
      type: 'object', properties: { region: { anyOf: [bbox, { type: 'null' }] } },
      required: ['region'], additionalProperties: false,
    } },
    { type: 'function', name: 'propose_changes', description: PROPOSE_DESC, strict: true, parameters: {
      type: 'object', properties: { changes: { type: 'array', items: { anyOf: changes } },
        issues: { anyOf: [issues, { type: 'null' }] }, score: { type: ['number', 'null'] } },
      required: ['changes', 'issues', 'score'], additionalProperties: false,
    } },
    { type: 'function', name: 'report_issues', description: REPORT_DESC, strict: true, parameters: {
      type: 'object', properties: { issues }, required: ['issues'], additionalProperties: false,
    } },
  ];
}

/** Decode only the strict wire's explicit omission markers; unknown keys and
 * invalid required fields still reach the existing domain validator unchanged. */
function domainToolArguments(name: string, raw: string, domain: CandidateDomainContext): unknown {
  if (name !== 'propose_changes') return raw;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return raw; }
  if (!value || typeof value !== 'object' || !('changes' in value) || !Array.isArray(value.changes)) return value;
  if ('issues' in value && value.issues === null) value.issues = [];
  for (const change of value.changes) {
    if (!change || typeof change !== 'object') continue;
    const created = change.kind === 'create' && change.object && typeof change.object === 'object';
    const labelId = created ? change.object.label_id
      : domain.document.objects.find(object => object.object_id === change.object_id)?.label_id;
    const defs = domain.ontology.labels.find(label => label.label_id === labelId)?.attributes ?? [];
    const values = created ? change.object.attributes : change.kind === 'set_attributes' ? change.values : null;
    if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
    for (const def of defs) if ((!created || !def.required) && values[def.key] === null) delete values[def.key];
  }
  return value;
}

interface ResponsesToolCall {
  item_id: string;
  call_id: string;
  name: string;
  arguments: string;
}

interface ResponsesStreamEvent {
  type?: unknown;
  item?: unknown;
  item_id?: unknown;
  delta?: unknown;
  arguments?: unknown;
  response?: unknown;
}

interface ResponsesStreamResult {
  toolCalls: ResponsesToolCall[];
  text: string;
}

interface ResponsesReceipt {
  provider_id: 'openai_api';
  requested_model_id: string;
  actual_model_id: string | null;
  response_id: string | null;
  auth_kind: 'api_key';
  transport: 'openai_responses_sse';
  runtime_version: null;
  runtime_version_status: 'not_exposed';
  budgets: { max_tool_turns: number; max_run_ms: number; max_total_bytes: number; request_timeout_ms: number; cost_usd: null };
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

async function* consumeResponsesStream(
  frames: AsyncGenerator<SseFrame>,
  budget: ToolLoopBudget,
  checkpoint: () => RunEvent,
  observeResponse: (response: { id?: unknown; model?: unknown; usage?: unknown }) => RunEvent | null,
): AsyncGenerator<RunEvent, ResponsesStreamResult> {
  const calls = new Map<string, ResponsesToolCall>();
  const order: ResponsesToolCall[] = [];
  let text = '';
  let terminal = false;
  let failure: string | null = null;
  // Start the actual HTTP attempt before publishing its null-identity receipt.
  // One pending read only; no detached frame pump, token RPC, or event queue.
  const first = frames.next();
  void first.catch(() => {}); // consumer cancellation can close during the yield
  try {
    yield checkpoint();
    for (let next = await first; !next.done; next = await frames.next()) {
      const frame = next.value;
      budget.chargeBytes(byteLength(frame.data));
      const payload: unknown = decodeJson(frame.data);
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        throw new ProviderError('invalid_json', 'stream frame is not a JSON object');
      }
      const event = payload as ResponsesStreamEvent; // every field read below is type-checked
      const type = typeof event.type === 'string' ? event.type : frame.event;
      if (
        (type === 'response.created' || type === 'response.in_progress' || type === 'response.completed' ||
          type === 'response.failed' || type === 'response.incomplete') &&
        typeof event.response === 'object' && event.response !== null && !Array.isArray(event.response)
      ) {
        // Observe before parsing tools or raising stream/terminal failures. Metadata
        // is evidence only, never a tool ID, schema, permission or model selection.
        const observation = observeResponse(event.response as { id?: unknown; model?: unknown; usage?: unknown });
        if (observation !== null) yield observation;
      }
      if (type === 'response.output_item.added' && typeof event.item === 'object' && event.item !== null) {
        const item = event.item as { type?: unknown; id?: unknown; call_id?: unknown; name?: unknown; arguments?: unknown };
        if (item.type === 'function_call') {
          const item_id = typeof item.id === 'string' ? item.id : String(item.call_id ?? '');
          const call: ResponsesToolCall = {
            item_id,
            call_id: typeof item.call_id === 'string' ? item.call_id : item_id,
            name: typeof item.name === 'string' ? item.name : '',
            arguments: typeof item.arguments === 'string' ? item.arguments : '',
          };
          calls.set(item_id, call);
          order.push(call);
        }
      } else if (type === 'response.function_call_arguments.delta' && typeof event.delta === 'string') {
        const call = calls.get(String(event.item_id ?? ''));
        if (call !== undefined) call.arguments += event.delta;
      } else if (type === 'response.function_call_arguments.done' && typeof event.arguments === 'string') {
        const call = calls.get(String(event.item_id ?? ''));
        if (call !== undefined) call.arguments = event.arguments;
      } else if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
        text += event.delta;
      } else if (type === 'response.completed') {
        terminal = true;
      } else if (type === 'response.failed' || type === 'response.incomplete') {
        failure = type;
      }
    }
  } finally {
    await frames.return(undefined);
  }
  if (failure !== null) throw new ProviderError('provider_reported_failure', `provider reported ${failure}`);
  if (!terminal) throw new ProviderError('interrupted_stream', 'stream ended before response.completed');
  return { toolCalls: order, text };
}

export function createOpenAiApiAdapter(config: OpenAiApiAdapterConfig): ProviderAdapter {
  if (typeof config.profile_id !== 'string' || config.profile_id.length === 0) {
    throw new ProviderError('adapter_error', 'profile_id must be a non-empty string');
  }
  if (typeof config.model_id !== 'string' || config.model_id.length === 0) {
    throw new ProviderError('adapter_error', 'model_id must be the exact account-available model ID');
  }
  const budgets: ToolBudgets = { ...DEFAULT_TOOL_BUDGETS, ...config.budgets };
  const pricing = config.pricing ?? null;
  const capabilities = config.capabilities ?? {
    image_input: false,
    tools: false,
    structured_output: false,
    bbox_output: false,
    attributes: false,
  };
  const client = new BoundedHttpClient({
    provider_id: 'openai_api',
    api_base: config.api_base,
    base_approval: config.base_approval,
    local_admins: config.local_admins,
    fetch_impl: config.fetch_impl,
    timeout_ms: config.timeout_ms,
    max_response_bytes: config.max_response_bytes,
    max_stream_bytes: config.max_stream_bytes,
  });

  function buildRequestBody(items: Record<string, unknown>[], tools: JsonSchema[]): Record<string, unknown> {
    return {
      model: config.model_id,
      stream: true,
      max_output_tokens: budgets.max_output_tokens,
      instructions: SYSTEM_TEXT,
      input: items,
      tools,
      tool_choice: 'auto',
    };
  }

  function imageProgress(image: PreparedImageInput): Record<string, unknown> {
    return {
      kind: image.kind,
      object_id: image.object_id,
      transform_to_canonical: image.transform_to_canonical,
      privacy_fingerprint: image.privacy_fingerprint,
      pixel_count: image.pixel_count,
    };
  }

  return {
    async probe(): Promise<ModelProfile[]> {
      let availability: ModelProfile['availability'];
      if (config.account_model_verified !== true) {
        availability = 'blocked';
      } else {
        let configured = client.base_error === null;
        if (configured) {
          try {
            validateSecretRef(config.credential?.secret_ref ?? '');
          } catch {
            configured = false;
          }
        }
        availability = configured ? 'ready' : 'needs_configuration';
      }
      return [
        {
          profile_id: config.profile_id,
          provider_id: 'openai_api',
          model_id: config.model_id,
          auth_kind: 'api_key',
          capabilities,
          availability,
          verification: 'not_run',
          runtime_version: null,
          verified_at: null,
        },
      ];
    },

    async *run(input: StartRunRequest, ctx: RuntimeContext, signal: AbortSignal): AsyncIterable<RunEvent> {
      const run_id = ctx.run_id;
      let seq = 0;
      let knownSecrets: readonly string[] = [];
      const emit = (type: RunEvent['type'], message: string, data: Record<string, unknown> | null): RunEvent => ({
        run_id,
        seq: seq++,
        type,
        message: redactText(message, knownSecrets),
        data: data === null ? null : redactValue(data, undefined, knownSecrets) as Record<string, unknown>,
      });
      yield emit('started', 'run started', null);
      // Hoisted so a failure still reports the usage observed before it (C4):
      // unknown stays unknown, never 0.
      const turnUsages: NormalizedUsage[] = [];
      const receipts: ResponsesReceipt[] = [];
      const checkpoint = (): RunEvent => {
        const usage = totalObservedUsage(turnUsages, pricing);
        const event = emit('progress', 'provider observation checkpoint', {
          receipts, receipt: receipts.at(-1) ?? null, usage, cost_display: costDisplay(usage),
        });
        // Same existing service cap: oversized untrusted IDs are a diagnostic,
        // not a reason to enlarge the evidence budget or invent identity.
        if (Buffer.byteLength(JSON.stringify(event.data), 'utf8') > 16 * 1024) {
          event.data = { dropped: 'event_data_too_large' };
        }
        return event;
      };
      try {
        const secret = resolveSecretRef(config.credential.secret_ref, config.secret_env ?? process.env);
        knownSecrets = [secret];
        const budget = new ToolLoopBudget(budgets);
        const document = await ctx.get_document();
        const ontology = await ctx.get_ontology();
        const domain: CandidateDomainContext = { intent: input.intent, bbox_output: capabilities.bbox_output, document, ontology };
        const tools = toolsForDomain(domain);
        const grantIds = "allow_image" in ctx && ctx.allow_image === false ? [] : imageGrantIds(ctx);
        const imageBudget: ImageBudget = { max_bytes: budgets.max_image_bytes, max_pixels: budgets.max_pixels, pixels_used: 0 };

        const items: Record<string, unknown>[] = [];
        const firstContent: Record<string, unknown>[] = [{ type: 'input_text', text: input.prompt }];
        for (const request of planImageInputs(input, document, budgets.max_crops, ctx)) {
          const image = prepareImage(await ctx.read_region(grantIds[0], request.region), request, imageBudget);
          imageBudget.pixels_used += image.pixel_count;
          firstContent.push({ type: 'input_image', image_url: image.data_url, detail: 'auto' });
          yield emit('progress', `image input ${image.kind}`, imageProgress(image));
        }
        items.push({ role: 'user', content: firstContent });

        for (;;) {
          budget.beginTurn();
          client.resolveRequestUrl('/responses');
          const receipt: ResponsesReceipt = {
            provider_id: 'openai_api', requested_model_id: config.model_id,
            actual_model_id: null, response_id: null, auth_kind: 'api_key', transport: 'openai_responses_sse',
            runtime_version: null, runtime_version_status: 'not_exposed',
            budgets: { max_tool_turns: budgets.max_tool_turns, max_run_ms: budgets.max_run_ms,
              max_total_bytes: budgets.max_total_bytes, request_timeout_ms: config.timeout_ms ?? 60_000, cost_usd: null },
          };
          receipts.push(receipt);
          const usageIndex = turnUsages.length;
          const frames = client.sendStream(
            '/responses',
            {
              headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
              body: JSON.stringify(buildRequestBody(items, tools)),
            },
            signal,
          );
          const parsed = yield* consumeResponsesStream(frames, budget, checkpoint, response => {
            let changed = false;
            if (typeof response.id === 'string' && response.id.length > 0 && response.id !== receipt.response_id) {
              receipt.response_id = response.id; changed = true;
            }
            if (typeof response.model === 'string' && response.model.length > 0 && response.model !== receipt.actual_model_id) {
              receipt.actual_model_id = response.model; changed = true;
            }
            changed = updateObservedUsage(turnUsages, usageIndex, response.usage, pricing) || changed;
            return changed ? checkpoint() : null;
          });
          // An entirely completed turn without usage makes totals unknown; an
          // HTTP/stream failure cannot erase usage already observed in this run.
          turnUsages[usageIndex] ??= normalizeUsage(null, pricing);

          let proposed = false;
          for (const call of parsed.toolCalls) {
            items.push({ type: 'function_call', call_id: call.call_id, name: call.name, arguments: call.arguments });
            yield emit('tool_call', `tool ${call.name}`, { name: call.name, call_id: call.call_id });
            const args = parseToolCallArguments(call.name, domainToolArguments(call.name, call.arguments, domain), domain);
            if (args.tool === 'read_region') {
              const image = prepareImage(
                await ctx.read_region(grantIds[0], args.region),
                { kind: args.region === null ? 'full' : 'crop', region: args.region, object_id: null },
                imageBudget,
              );
              imageBudget.pixels_used += image.pixel_count;
              items.push({
                type: 'function_call_output',
                call_id: call.call_id,
                output: JSON.stringify({
                  kind: image.kind,
                  region: image.region,
                  width: image.width,
                  height: image.height,
                  transform_to_canonical: image.transform_to_canonical,
                  mime: image.mime,
                }),
              });
              items.push({ role: 'user', content: [{ type: 'input_image', image_url: image.data_url, detail: 'auto' }] });
              yield emit('progress', 'tool read_region result', imageProgress(image));
            } else if (args.tool === 'propose_changes') {
              await ctx.submit_candidates(args.draft);
              proposed = true;
              // Every tool call needs a matching tool result in the next
              // request (Responses requires function_call_output per call).
              items.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify({ accepted: true }) });
              yield emit('candidate', 'candidate submitted', {
                change_ids: args.draft.changes.map((change) => change.change_id),
                issue_ids: args.draft.issues.map((issue) => issue.issue_id),
                score: args.draft.score,
              });
            } else {
              await ctx.report_issues(args.issues);
              items.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify({ accepted: true }) });
              yield emit('progress', 'quality issues reported', { issue_ids: args.issues.map((issue) => issue.issue_id) });
            }
          }
          if (parsed.toolCalls.length === 0) {
            let candidate: unknown;
            try {
              candidate = decodeJson(parsed.text);
            } catch {
              throw new ProviderError('candidate_invalid', 'model output is not parseable candidate JSON');
            }
            const draft = validateCandidateDraft(candidate, domain);
            await ctx.submit_candidates(draft);
            proposed = true;
            yield emit('candidate', 'candidate submitted', {
              change_ids: draft.changes.map((change) => change.change_id),
              issue_ids: draft.issues.map((issue) => issue.issue_id),
              score: draft.score,
            });
          }
          if (proposed) break;
        }

        const usage = totalObservedUsage(turnUsages, pricing);
        yield emit('succeeded', 'run succeeded', { usage, cost_display: costDisplay(usage), turns: budget.turns,
          receipts, receipt: receipts.at(-1) ?? null });
      } catch (error) {
        const code: ProviderErrorCode = error instanceof ProviderError ? error.code : 'adapter_error';
        const message = error instanceof Error ? error.message : 'unexpected adapter failure';
        const usage = totalObservedUsage(turnUsages, pricing);
        if (signal?.aborted === true) {
          yield emit('cancelled', 'run cancelled', { usage, cost_display: costDisplay(usage),
            receipts, receipt: receipts.at(-1) ?? null });
          return;
        }
        yield emit('failed', `run failed: ${code}`, {
          error_code: code,
          error_message: message,
          usage,
          cost_display: costDisplay(usage),
          receipts,
          receipt: receipts.at(-1) ?? null,
        });
      }
    },
  };
}
