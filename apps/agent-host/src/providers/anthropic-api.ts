//! Anthropic Platform API adapter (`anthropic_api`).
//!
//! Wire shape follows the provider's own contract (docs/provider-compatibility.md):
//! `POST {base}/v1/messages` with `x-api-key` + `anthropic-version` headers, a
//! top-level `system` string, user/assistant content blocks with base64 `image`
//! sources, `input_schema` tools, and Anthropic SSE events (`message_start`,
//! `content_block_*`, `message_delta`, `message_stop`). Tool arguments arrive as
//! `input_json_delta` fragments and tool results return as `tool_result`
//! blocks. This is NOT an OpenAI-compatible template shared with the others.

import type { ModelCapabilities } from '../../../../packages/contracts/generated/ModelCapabilities';
import type { ModelProfile } from '../../../../packages/contracts/generated/ModelProfile';
import type { RunEvent } from '../../../../packages/contracts/generated/RunEvent';
import type { StartRunRequest } from '../../../../packages/contracts/generated/StartRunRequest';
import type { ProviderAdapter, RuntimeContext } from '../registry';
import { redactText } from '../security/redaction';
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
import { costDisplay, mergeUsage, normalizeUsage, type NormalizedUsage, type TokenPricing } from './http/usage';

export interface AnthropicApiAdapterConfig {
  profile_id: string;
  /** Exact account-available full model ID (e.g. `claude-sonnet-5`); never an alias. */
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
  { name: 'read_region', description: READ_REGION_DESC, input_schema: READ_REGION_SCHEMA },
  { name: 'propose_changes', description: PROPOSE_DESC, input_schema: PROPOSE_SCHEMA },
  { name: 'report_issues', description: REPORT_DESC, input_schema: REPORT_SCHEMA },
];

interface AnthropicToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface AnthropicStreamEvent {
  type?: unknown;
  message?: unknown;
  index?: unknown;
  content_block?: unknown;
  delta?: unknown;
  usage?: unknown;
  error?: unknown;
}

interface AnthropicStreamResult {
  toolCalls: AnthropicToolCall[];
  text: string;
  usage: unknown;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function usageField(container: unknown, key: string): number | undefined {
  if (typeof container !== 'object' || container === null) return undefined;
  const usage = (container as { usage?: unknown }).usage;
  if (typeof usage !== 'object' || usage === null) return undefined;
  const value = (usage as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

async function consumeAnthropicStream(frames: AsyncIterable<SseFrame>, budget: ToolLoopBudget): Promise<AnthropicStreamResult> {
  const calls = new Map<number, AnthropicToolCall>();
  const order: AnthropicToolCall[] = [];
  let text = '';
  let input_tokens: number | undefined;
  let output_tokens: number | undefined;
  let terminal = false;
  let failure: string | null = null;
  for await (const frame of frames) {
    budget.chargeBytes(byteLength(frame.data));
    const payload: unknown = decodeJson(frame.data);
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new ProviderError('invalid_json', 'stream frame is not a JSON object');
    }
    const event = payload as AnthropicStreamEvent; // every field read below is type-checked
    const type = typeof event.type === 'string' ? event.type : frame.event;
    if (type === 'message_start') {
      input_tokens = usageField(event.message, 'input_tokens') ?? input_tokens;
    } else if (type === 'content_block_start' && typeof event.index === 'number' && typeof event.content_block === 'object' && event.content_block !== null) {
      const block = event.content_block as { type?: unknown; id?: unknown; name?: unknown };
      if (block.type === 'tool_use') {
        const call: AnthropicToolCall = {
          id: typeof block.id === 'string' ? block.id : '',
          name: typeof block.name === 'string' ? block.name : '',
          arguments: '',
        };
        calls.set(event.index, call);
        order.push(call);
      }
    } else if (type === 'content_block_delta' && typeof event.index === 'number' && typeof event.delta === 'object' && event.delta !== null) {
      const delta = event.delta as { type?: unknown; partial_json?: unknown; text?: unknown };
      const call = calls.get(event.index);
      if (call !== undefined && delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        call.arguments += delta.partial_json;
      } else if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        text += delta.text;
      }
    } else if (type === 'message_delta') {
      output_tokens = usageField(event, 'output_tokens') ?? output_tokens;
      input_tokens = usageField(event, 'input_tokens') ?? input_tokens;
    } else if (type === 'message_stop') {
      terminal = true;
    } else if (type === 'error') {
      const error = event.error as { message?: unknown } | null;
      failure = error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : 'provider error frame';
    }
  }
  if (failure !== null) throw new ProviderError('provider_reported_failure', failure);
  if (!terminal) throw new ProviderError('interrupted_stream', 'stream ended before message_stop');
  return { toolCalls: order, text, usage: { input_tokens: input_tokens ?? null, output_tokens: output_tokens ?? null } };
}

export function createAnthropicApiAdapter(config: AnthropicApiAdapterConfig): ProviderAdapter {
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
    provider_id: 'anthropic_api',
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
      max_tokens: budgets.max_output_tokens,
      system: SYSTEM_TEXT,
      messages,
      tools: TOOLS,
      stream: true,
    };
  }

  function imageBlock(image: PreparedImageInput): Record<string, unknown> {
    return {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: Buffer.from(image.bytes).toString('base64') },
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
          provider_id: 'anthropic_api',
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
      const emit = (type: RunEvent['type'], message: string, data: Record<string, unknown> | null): RunEvent => ({
        run_id,
        seq: seq++,
        type,
        message,
        data,
      });
      yield emit('started', 'run started', null);
      // Hoisted so a failure still reports the usage observed before it (C4):
      // unknown stays unknown, never 0.
      const turnUsages: NormalizedUsage[] = [];
      try {
        const secret = resolveSecretRef(config.credential.secret_ref, config.secret_env ?? process.env);
        const budget = new ToolLoopBudget(budgets);
        const document = await ctx.get_document();
        const ontology = await ctx.get_ontology();
        const domain: CandidateDomainContext = { intent: input.intent, bbox_output: capabilities.bbox_output, document, ontology };
        const grantIds = imageGrantIds(ctx);
        const imageBudget: ImageBudget = { max_bytes: budgets.max_image_bytes, max_pixels: budgets.max_pixels, pixels_used: 0 };

        const messages: Record<string, unknown>[] = [];
        const firstContent: Record<string, unknown>[] = [{ type: 'text', text: input.prompt }];
        for (const request of planImageInputs(input, document, budgets.max_crops)) {
          const image = prepareImage(await ctx.read_region(grantIds[0], request.region), request, imageBudget);
          imageBudget.pixels_used += image.pixel_count;
          firstContent.push(imageBlock(image));
          yield emit('progress', `image input ${image.kind}`, imageProgress(image));
        }
        messages.push({ role: 'user', content: firstContent });

        for (;;) {
          budget.beginTurn();
          const frames = client.sendStream(
            '/v1/messages',
            {
              headers: {
                'x-api-key': secret,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json',
              },
              body: JSON.stringify(buildRequestBody(messages)),
            },
            signal,
          );
          const parsed = await consumeAnthropicStream(frames, budget);
          turnUsages.push(normalizeUsage(parsed.usage, pricing));

          let proposed = false;
          for (const call of parsed.toolCalls) {
            const args = parseToolCallArguments(call.name, call.arguments, domain);
            const toolInput = args.tool === 'read_region' ? { region: args.region } : args.tool === 'report_issues' ? { issues: args.issues } : { changes: args.draft.changes, issues: args.draft.issues, score: args.draft.score };
            messages.push({
              role: 'assistant',
              content: [{ type: 'tool_use', id: call.id, name: call.name, input: toolInput }],
            });
            yield emit('tool_call', `tool ${call.name}`, { name: call.name, call_id: call.id });
            if (args.tool === 'read_region') {
              const image = prepareImage(
                await ctx.read_region(grantIds[0], args.region),
                { kind: args.region === null ? 'full' : 'crop', region: args.region, object_id: null },
                imageBudget,
              );
              imageBudget.pixels_used += image.pixel_count;
              messages.push({
                role: 'user',
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: call.id,
                    content: JSON.stringify({
                      kind: image.kind,
                      region: image.region,
                      width: image.width,
                      height: image.height,
                      transform_to_canonical: image.transform_to_canonical,
                      mime: image.mime,
                    }),
                  },
                  imageBlock(image),
                ],
              });
              yield emit('progress', 'tool read_region result', imageProgress(image));
            } else if (args.tool === 'propose_changes') {
              await ctx.submit_candidates(args.draft);
              proposed = true;
              // Every tool_use needs a matching tool_result in the next user
              // message, or the following request is protocol-invalid.
              messages.push({
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify({ accepted: true }) }],
              });
              yield emit('candidate', 'candidate submitted', {
                change_ids: args.draft.changes.map((change) => change.change_id),
                issue_ids: args.draft.issues.map((issue) => issue.issue_id),
                score: args.draft.score,
              });
            } else {
              await ctx.report_issues(args.issues);
              messages.push({
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify({ accepted: true }) }],
              });
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
        const message = error instanceof Error ? redactText(error.message) : 'unexpected adapter failure';
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
