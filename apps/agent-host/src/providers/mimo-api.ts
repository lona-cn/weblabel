//! Xiaomi MiMo API adapter (`mimo_api`).
//!
//! Wire shape follows MiMo's own documented contract
//! (docs/provider-compatibility.md): `POST {base}/chat/completions` with Bearer
//! auth, a `system` role message, user content parts carrying `image_url`
//! objects (URL or Base64 data URL, 50 MB per image), function tools wrapped
//! under `function`, SSE chunks and the `[DONE]` sentinel. Documented `usage:
//! null` is preserved as unknown. Token Plan `tp-...` keys must use the exact
//! console-provided base URL — it is never guessed. Tool-call arguments are
//! treated as untrusted (MiMo documents they can be invalid or carry unknown
//! fields) and pass strict schema+domain validation. This is NOT an
//! OpenAI-compatible template shared with the other adapters.

import type { ModelCapabilities } from '../../../../packages/contracts/generated/ModelCapabilities';
import type { ModelProfile } from '../../../../packages/contracts/generated/ModelProfile';
import type { RunEvent } from '../../../../packages/contracts/generated/RunEvent';
import type { StartRunRequest } from '../../../../packages/contracts/generated/StartRunRequest';
import type { ProviderAdapter, RuntimeContext } from '../registry';
import { redactText, redactValue } from '../security/redaction';
import {
  BoundedHttpClient,
  DEFAULT_TOOL_BUDGETS,
  OFFICIAL_API_BASES,
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
import { costDisplay, mergeUsage, normalizeUsage, type NormalizedUsage, type TokenPricing } from './http/usage';

export interface MiMoApiAdapterConfig {
  profile_id: string;
  /** Exact documented model ID (e.g. `mimo-v2.6-pro`); never an alias. */
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
const PROPOSE_DESC = 'Submit proposed annotation changes and quality issues. The server validates every field strictly before anything is stored.';
const REPORT_DESC = 'Report suspected quality issues without proposing annotation changes.';

const READ_REGION_SCHEMA = {
  type: 'object',
  properties: {
    region: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          properties: {
            type: { const: 'bbox_xyxy' },
            x_min: { type: 'number' },
            y_min: { type: 'number' },
            x_max: { type: 'number' },
            y_max: { type: 'number' },
          },
          required: ['type', 'x_min', 'y_min', 'x_max', 'y_max'],
          additionalProperties: false,
        },
      ],
    },
  },
  required: ['region'],
  additionalProperties: false,
};
const PROPOSE_SCHEMA = {
  type: 'object',
  properties: {
    changes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['kind', 'change_id', 'reason'],
        properties: { kind: { type: 'string' } },
      },
    },
    issues: { type: 'array', items: { type: 'object' } },
    score: { type: ['number', 'null'] },
  },
  required: ['changes'],
  additionalProperties: false,
};
const REPORT_SCHEMA = {
  type: 'object',
  properties: { issues: { type: 'array', items: { type: 'object' } } },
  required: ['issues'],
  additionalProperties: false,
};

const TOOLS: Record<string, unknown>[] = [
  { type: 'function', function: { name: 'read_region', description: READ_REGION_DESC, parameters: READ_REGION_SCHEMA } },
  { type: 'function', function: { name: 'propose_changes', description: PROPOSE_DESC, parameters: PROPOSE_SCHEMA } },
  { type: 'function', function: { name: 'report_issues', description: REPORT_DESC, parameters: REPORT_SCHEMA } },
];

interface MiMoToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface MiMoStreamEvent {
  choices?: unknown;
  usage?: unknown;
}

interface MiMoStreamResult {
  toolCalls: MiMoToolCall[];
  text: string;
  usage: unknown;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

async function consumeMiMoStream(frames: AsyncIterable<SseFrame>, budget: ToolLoopBudget): Promise<MiMoStreamResult> {
  const calls = new Map<number, MiMoToolCall>();
  const order: MiMoToolCall[] = [];
  let text = '';
  let usage: unknown = null;
  let terminal = false;
  for await (const frame of frames) {
    budget.chargeBytes(byteLength(frame.data));
    if (frame.data === '[DONE]') {
      terminal = true;
      continue;
    }
    const payload: unknown = decodeJson(frame.data);
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new ProviderError('invalid_json', 'stream frame is not a JSON object');
    }
    const chunk = payload as MiMoStreamEvent; // every field read below is type-checked
    if (chunk.usage !== undefined && chunk.usage !== null) usage = chunk.usage;
    if (!Array.isArray(chunk.choices) || chunk.choices.length === 0) continue;
    const choice = chunk.choices[0];
    if (typeof choice !== 'object' || choice === null) continue;
    const { delta, finish_reason } = choice as { delta?: unknown; finish_reason?: unknown };
    if (typeof delta === 'object' && delta !== null) {
      const { content, tool_calls } = delta as { content?: unknown; tool_calls?: unknown };
      if (typeof content === 'string') text += content;
      if (Array.isArray(tool_calls)) {
        for (const entry of tool_calls) {
          if (typeof entry !== 'object' || entry === null) continue;
          const { index, id, function: fn } = entry as { index?: unknown; id?: unknown; function?: unknown };
          if (typeof index !== 'number') continue;
          let call = calls.get(index);
          if (call === undefined) {
            call = { id: typeof id === 'string' ? id : `call_${index}`, name: '', arguments: '' };
            calls.set(index, call);
            order.push(call);
          }
          if (typeof id === 'string') call.id = id;
          if (typeof fn === 'object' && fn !== null) {
            const { name, arguments: args } = fn as { name?: unknown; arguments?: unknown };
            if (typeof name === 'string') call.name = name;
            if (typeof args === 'string') call.arguments += args;
          }
        }
      }
    }
    if (typeof finish_reason === 'string' && finish_reason !== 'tool_calls' && finish_reason !== 'stop') {
      throw new ProviderError('provider_reported_failure', `provider finished with ${finish_reason}`);
    }
  }
  if (!terminal) throw new ProviderError('interrupted_stream', 'stream ended before [DONE]');
  return { toolCalls: order, text, usage };
}

export function createMiMoApiAdapter(config: MiMoApiAdapterConfig): ProviderAdapter {
  if (typeof config.profile_id !== 'string' || config.profile_id.length === 0) {
    throw new ProviderError('adapter_error', 'profile_id must be a non-empty string');
  }
  if (typeof config.model_id !== 'string' || config.model_id.length === 0) {
    throw new ProviderError('adapter_error', 'model_id must be the exact documented model ID');
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
    provider_id: 'mimo_api',
    api_base: config.api_base,
    base_approval: config.base_approval,
    local_admins: config.local_admins,
    fetch_impl: config.fetch_impl,
    timeout_ms: config.timeout_ms,
    max_response_bytes: config.max_response_bytes,
    max_stream_bytes: config.max_stream_bytes,
  });

  function buildRequestBody(messages: Record<string, unknown>[]): Record<string, unknown> {
    return {
      model: config.model_id,
      stream: true,
      max_tokens: budgets.max_output_tokens,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
    };
  }

  function imagePart(image: PreparedImageInput): Record<string, unknown> {
    return { type: 'image_url', image_url: { url: image.data_url } };
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
          provider_id: 'mimo_api',
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
      try {
        const secret = resolveSecretRef(config.credential.secret_ref, config.secret_env ?? process.env);
        knownSecrets = [secret];
        if (secret.startsWith('tp-') && (config.api_base === undefined || config.api_base === OFFICIAL_API_BASES.mimo_api)) {
          throw new ProviderError('base_not_approved', 'Token Plan credentials require the exact console-provided base URL');
        }
        const budget = new ToolLoopBudget(budgets);
        const document = await ctx.get_document();
        const ontology = await ctx.get_ontology();
        const domain: CandidateDomainContext = { intent: input.intent, bbox_output: capabilities.bbox_output, document, ontology };
        const grantIds = "allow_image" in ctx && ctx.allow_image === false ? [] : imageGrantIds(ctx);
        const imageBudget: ImageBudget = { max_bytes: budgets.max_image_bytes, max_pixels: budgets.max_pixels, pixels_used: 0 };

        const messages: Record<string, unknown>[] = [{ role: 'system', content: SYSTEM_TEXT }];
        const firstContent: Record<string, unknown>[] = [{ type: 'text', text: input.prompt }];
        for (const request of planImageInputs(input, document, budgets.max_crops, ctx)) {
          const image = prepareImage(await ctx.read_region(grantIds[0], request.region), request, imageBudget);
          imageBudget.pixels_used += image.pixel_count;
          firstContent.push(imagePart(image));
          yield emit('progress', `image input ${image.kind}`, imageProgress(image));
        }
        messages.push({ role: 'user', content: firstContent });

        for (;;) {
          budget.beginTurn();
          const frames = client.sendStream(
            '/chat/completions',
            {
              headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
              body: JSON.stringify(buildRequestBody(messages)),
            },
            signal,
          );
          const parsed = await consumeMiMoStream(frames, budget);
          turnUsages.push(normalizeUsage(parsed.usage, pricing));

          let proposed = false;
          for (const call of parsed.toolCalls) {
            messages.push({
              role: 'assistant',
              content: null,
              tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }],
            });
            yield emit('tool_call', `tool ${call.name}`, { name: call.name, call_id: call.id });
            const args = parseToolCallArguments(call.name, call.arguments, domain);
            if (args.tool === 'read_region') {
              const image = prepareImage(
                await ctx.read_region(grantIds[0], args.region),
                { kind: args.region === null ? 'full' : 'crop', region: args.region, object_id: null },
                imageBudget,
              );
              imageBudget.pixels_used += image.pixel_count;
              messages.push({
                role: 'tool',
                tool_call_id: call.id,
                content: JSON.stringify({
                  kind: image.kind,
                  region: image.region,
                  width: image.width,
                  height: image.height,
                  transform_to_canonical: image.transform_to_canonical,
                  mime: image.mime,
                }),
              });
              messages.push({ role: 'user', content: [imagePart(image)] });
              yield emit('progress', 'tool read_region result', imageProgress(image));
            } else if (args.tool === 'propose_changes') {
              await ctx.submit_candidates(args.draft);
              proposed = true;
              // Every tool call needs a matching role:'tool' message in the
              // next request, or the following turn is protocol-invalid.
              messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ accepted: true }) });
              yield emit('candidate', 'candidate submitted', {
                change_ids: args.draft.changes.map((change) => change.change_id),
                issue_ids: args.draft.issues.map((issue) => issue.issue_id),
                score: args.draft.score,
              });
            } else {
              await ctx.report_issues(args.issues);
              messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ accepted: true }) });
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

        const usage =
          turnUsages.reduce<NormalizedUsage | null>((acc, turn) => (acc === null ? turn : mergeUsage(acc, turn, pricing)), null) ??
          normalizeUsage(null, pricing);
        yield emit('succeeded', 'run succeeded', { usage, cost_display: costDisplay(usage), turns: budget.turns });
      } catch (error) {
        if (signal?.aborted === true) {
          yield emit('cancelled', 'run cancelled', null);
          return;
        }
        const code: ProviderErrorCode = error instanceof ProviderError ? error.code : 'adapter_error';
        const message = error instanceof Error ? error.message : 'unexpected adapter failure';
        const usage =
          turnUsages.reduce<NormalizedUsage | null>((acc, turn) => (acc === null ? turn : mergeUsage(acc, turn, pricing)), null) ??
          normalizeUsage(null, pricing);
        yield emit('failed', `run failed: ${code}`, {
          error_code: code,
          error_message: message,
          usage,
          cost_display: costDisplay(usage),
        });
      }
    },
  };
}
