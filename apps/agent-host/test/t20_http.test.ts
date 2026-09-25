//! T20 — OpenAI/Luna, Anthropic and MiMo HTTP provider adapters.
//!
//! All HTTP traffic is fixture-driven through an injected `fetch_impl`; this
//! suite performs no network calls, sends no real credentials and no real
//! media. Live provider evidence belongs to T32 and is NOT claimed here.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

import type { AnnotationDocument } from '../../../packages/contracts/generated/AnnotationDocument';
import type { BBox } from '../../../packages/contracts/generated/BBox';
import type { OntologyVersion } from '../../../packages/contracts/generated/OntologyVersion';
import type { RunEvent } from '../../../packages/contracts/generated/RunEvent';
import type { StartRunRequest } from '../../../packages/contracts/generated/StartRunRequest';
import type { SuggestionSet } from '../../../packages/contracts/generated/SuggestionSet';
import type { ProviderAdapter, RuntimeContext, RuntimeReadRegion } from '../src/registry';
import {
  decodeJson,
  parseToolCallArguments,
  validateCandidateDraft,
  validateQualityIssues,
} from '../src/providers/http/errors';
import { BoundedHttpClient, ToolLoopBudget, resolveSecretRef, type FetchLike } from '../src/providers/http/client';
import { costDisplay, mergeUsage, normalizeUsage, type NormalizedUsage } from '../src/providers/http/usage';
import { imageGrantIds, planImageInputs, pngDimensions, prepareImage, privacyFingerprint } from '../src/providers/http/images';
import { createOpenAiApiAdapter, type OpenAiApiAdapterConfig } from '../src/providers/openai-api';
import { createAnthropicApiAdapter, type AnthropicApiAdapterConfig } from '../src/providers/anthropic-api';
import { createMiMoApiAdapter, type MiMoApiAdapterConfig } from '../src/providers/mimo-api';

const testDir = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(testDir, 'fixtures', 'http');
const repoRoot = resolve(testDir, '..', '..', '..');

// Fixture files in test/fixtures/http are written by this task with a fixed
// shape, so their structure is asserted at the parse boundary (named types),
// while provider-supplied wire content is validated by the adapters' own
// untrusted-output checks (src/providers/http/errors.ts).
interface ImageEntry {
  base64: string;
  data_url: string;
}
interface WireFixture {
  fixture_kind: string;
  wire: unknown;
}
interface SyntheticImagesFixture {
  fixture_kind: string;
  images: { full: ImageEntry; crop: ImageEntry };
}
interface ContentPart {
  type: string;
  source?: { type: string };
  image_url?: { url: string };
}
interface WireBody {
  instructions?: string;
  system?: string;
  stream?: boolean;
  input?: Array<{ content?: ContentPart[] }>;
  messages?: Array<{ role?: string; content?: ContentPart[] }>;
  tools?: Array<{ type?: string; name?: string; strict?: boolean; input_schema?: unknown; function?: { name: string } }>;
}
interface ImageEventData {
  kind: string;
  object_id: string | null;
  transform_to_canonical: number[];
  privacy_fingerprint: string;
}

function fixtureWire(name: string): unknown {
  const fixture = JSON.parse(readFileSync(join(fixtureDir, name), 'utf8')) as WireFixture;
  return fixture.wire;
}

function fixtureText(name: string): string {
  return readFileSync(join(fixtureDir, name), 'utf8');
}

function fixtureImage(name: 'full' | 'crop'): ImageEntry {
  const fixture = JSON.parse(readFileSync(join(fixtureDir, 'synthetic-images.json'), 'utf8')) as SyntheticImagesFixture;
  return fixture.images[name];
}

const FULL_IMAGE = fixtureImage('full');
const CROP_IMAGE = fixtureImage('crop');
const FULL_BYTES = Uint8Array.from(Buffer.from(FULL_IMAGE.base64, 'base64'));
const CROP_BYTES = Uint8Array.from(Buffer.from(CROP_IMAGE.base64, 'base64'));
const IDENTITY_TRANSFORM = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const CROP_TRANSFORM = [1, 0, 10, 0, 1, 20, 0, 0, 1];

const goldenDocument = JSON.parse(
  readFileSync(join(repoRoot, 'tests', 'fixtures', 'golden', 'document.json'), 'utf8'),
) as AnnotationDocument;
const goldenOntology = JSON.parse(
  readFileSync(join(repoRoot, 'tests', 'fixtures', 'golden', 'ontology.json'), 'utf8'),
) as OntologyVersion;

const TOOL_REGION: BBox = { type: 'bbox_xyxy', x_min: 20, y_min: 30, x_max: 60, y_max: 90 };
const OBJECT_REGION: BBox = { type: 'bbox_xyxy', x_min: 10, y_min: 20, x_max: 110, y_max: 220 };

function startRunRequest(overrides: Partial<StartRunRequest> = {}): StartRunRequest {
  return {
    operation_id: 'operation_t20_1',
    profile_id: 'profile_openai_t20',
    context: {
      project_id: 'project_golden',
      asset_revision_id: 'asset_revision_golden',
      annotation_revision_id: 'annotation_rev_golden',
      ontology_version_id: 'ontology_v1',
      draft_generation: 8,
      canonical_sha256: 'c'.repeat(64),
      selected_object_ids: ['object_person_001'],
      object_hashes: { object_person_001: 'h1' },
      input_fingerprint: 'sha-t20-input-1',
    },
    intent: 'audit_attributes',
    prompt: 'Audit helmet_state for the selected person.',
    consent_id: 'consent_t20_1',
    ...overrides,
  };
}

interface FakeRuntimeContext extends RuntimeContext {
  approved_grant_ids: string[];
  reads: Array<{ grant_id: string; region: BBox | null }>;
  submitted: unknown[];
  reported_issues: unknown[];
}

function makeContext(): FakeRuntimeContext {
  const reads: Array<{ grant_id: string; region: BBox | null }> = [];
  const submitted: unknown[] = [];
  const reported_issues: unknown[] = [];
  return {
    run_id: 'run_t20_001',
    approved_grant_ids: ['grant_t20_1'],
    reads,
    submitted,
    reported_issues,
    async read_region(grant_id: string, region: BBox | null): Promise<RuntimeReadRegion> {
      reads.push({ grant_id, region });
      if (region === null) {
        return { bytes: FULL_BYTES, mime: 'image/png', transform_to_canonical: IDENTITY_TRANSFORM };
      }
      return {
        bytes: CROP_BYTES,
        mime: 'image/png',
        transform_to_canonical: [1, 0, region.x_min, 0, 1, region.y_min, 0, 0, 1],
      };
    },
    async get_document(): Promise<AnnotationDocument> {
      return goldenDocument;
    },
    async get_ontology(): Promise<OntologyVersion> {
      return goldenOntology;
    },
    async submit_candidates(candidate: unknown): Promise<SuggestionSet> {
      submitted.push(candidate);
      return {
        suggestion_set_id: 'suggestion_set_t20_1',
        model_run_id: 'model_run_t20_1',
        prediction_id: 'prediction_t20_1',
        context: startRunRequest().context,
        changes: [],
        issues: [],
        score: null,
        state: 'pending',
      };
    },
    async report_issues(issues: unknown): Promise<void> {
      reported_issues.push(issues);
    },
  };
}

type Reply =
  | { kind: 'text'; status: number; body: string }
  | { kind: 'stream'; body: string; status?: number }
  | { kind: 'redirect'; status: number; location: string }
  | { kind: 'hang' }
  | { kind: 'slow'; ms: number; body: string };

interface FakeFetch {
  fetch_impl: FetchLike;
  calls: Array<{ url: string; headers: Record<string, string>; body: string }>;
}

function makeFetch(replies: Reply[]): FakeFetch {
  const calls: FakeFetch['calls'] = [];
  const fetch_impl: FetchLike = async (url, init) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    calls.push({ url: String(url), headers, body: String(init.body ?? '') });
    const reply = replies.shift();
    if (reply === undefined) throw new Error('fake fetch: no scripted reply left');
    switch (reply.kind) {
      case 'text':
        return new Response(reply.body, { status: reply.status, headers: { 'content-type': 'application/json' } });
      case 'stream':
        return new Response(reply.body, { status: reply.status ?? 200, headers: { 'content-type': 'text/event-stream' } });
      case 'redirect':
        return new Response(null, { status: reply.status, headers: { location: reply.location } });
      case 'hang': {
        const { promise, reject } = Promise.withResolvers<Response>();
        const abort = () => reject(new DOMException('aborted', 'AbortError'));
        if (init.signal?.aborted === true) abort();
        else init.signal?.addEventListener('abort', abort, { once: true });
        return promise;
      }
      case 'slow': {
        // Real short delay on purpose: the time budget is measured against the
        // platform wall clock inside the run loop, and fake timers cannot be
        // advanced across the async SSE stream without driving the whole loop.
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, reply.ms);
        await promise;
        return new Response(reply.body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
    }
  };
  return { fetch_impl, calls };
}

async function collectRun(
  adapter: ProviderAdapter,
  input: StartRunRequest,
  ctx: RuntimeContext,
  signal?: AbortSignal,
): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const event of adapter.run(input, ctx, signal ?? new AbortController().signal)) {
    events.push(event);
  }
  return events;
}

function runData(events: RunEvent[], type: RunEvent['type']): Record<string, unknown> {
  const event = events.find((candidate) => candidate.type === type);
  expect(event, `expected a ${type} event in ${events.map((e) => e.type).join(',')}`).toBeDefined();
  return (event?.data ?? {}) as Record<string, unknown>;
}

function openaiAdapter(fetch_impl: FetchLike, overrides: Partial<OpenAiApiAdapterConfig> = {}): ProviderAdapter {
  return createOpenAiApiAdapter({
    profile_id: 'profile_openai_t20',
    model_id: 'gpt-6-luna',
    credential: { secret_ref: 'env:WEBLABEL_T20_OPENAI' },
    secret_env: { WEBLABEL_T20_OPENAI: 'sk-test-openai-000001' },
    account_model_verified: true,
    fetch_impl,
    ...overrides,
  });
}

function anthropicAdapter(fetch_impl: FetchLike, overrides: Partial<AnthropicApiAdapterConfig> = {}): ProviderAdapter {
  return createAnthropicApiAdapter({
    profile_id: 'profile_anthropic_t20',
    model_id: 'claude-sonnet-5',
    credential: { secret_ref: 'env:WEBLABEL_T20_ANTHROPIC' },
    secret_env: { WEBLABEL_T20_ANTHROPIC: 'sk-ant-test-000001' },
    account_model_verified: true,
    fetch_impl,
    ...overrides,
  });
}

function mimoAdapter(fetch_impl: FetchLike, overrides: Partial<MiMoApiAdapterConfig> = {}): ProviderAdapter {
  return createMiMoApiAdapter({
    profile_id: 'profile_mimo_t20',
    model_id: 'mimo-v2.6-pro',
    credential: { secret_ref: 'env:WEBLABEL_T20_MIMO' },
    secret_env: { WEBLABEL_T20_MIMO: 'sk-test-mimo-000001' },
    account_model_verified: true,
    fetch_impl,
    ...overrides,
  });
}

function domainContext(overrides: Partial<Parameters<typeof validateCandidateDraft>[1]> = {}) {
  return {
    intent: 'audit_attributes' as const,
    bbox_output: false,
    document: goldenDocument,
    ontology: goldenOntology,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Behavior 4a: unknown usage and cost stay null, never zero
// ---------------------------------------------------------------------------

it('does not invent a price when absent', () => {
  const u = normalizeUsage({ input_tokens: 120, output_tokens: 20 });
  expect(u.input_tokens).toBe(120);
  expect(u.cost_usd).toBeNull();
});

it('normalizes MiMo-style token names and preserves missing usage as unknown', () => {
  expect(normalizeUsage(null)).toEqual({ input_tokens: null, output_tokens: null, cost_usd: null });
  expect(normalizeUsage(undefined)).toEqual({ input_tokens: null, output_tokens: null, cost_usd: null });
  expect(normalizeUsage({ prompt_tokens: 10, completion_tokens: 5 })).toEqual({
    input_tokens: 10,
    output_tokens: 5,
    cost_usd: null,
  });
  expect(normalizeUsage({ input_tokens: '120', output_tokens: -1 })).toEqual({
    input_tokens: null,
    output_tokens: null,
    cost_usd: null,
  });
});

it('computes a cost only from explicit pricing, and keeps it null otherwise', () => {
  const pricing = { input_per_million_usd: 2, output_per_million_usd: 8 };
  expect(normalizeUsage({ input_tokens: 450, output_tokens: 43 }, pricing).cost_usd).toBeCloseTo(0.001244, 9);
  expect(normalizeUsage({ input_tokens: 450, output_tokens: 43 }, null).cost_usd).toBeNull();
  expect(normalizeUsage({ input_tokens: 450 }, pricing).cost_usd).toBeNull();
  expect(
    normalizeUsage({ input_tokens: 450, output_tokens: 43 }, { input_per_million_usd: 2, output_per_million_usd: null }).cost_usd,
  ).toBeNull();
});

it('keeps merged multi-turn usage unknown when any turn reported no usage', () => {
  const known = normalizeUsage({ input_tokens: 210, output_tokens: 12 });
  const unknown = normalizeUsage(null);
  expect(mergeUsage(known, unknown, null)).toEqual({ input_tokens: null, output_tokens: null, cost_usd: null });
  expect(costDisplay(mergeUsage(known, unknown, null))).toBe('unknown');
  expect(
    costDisplay(normalizeUsage({ input_tokens: 1, output_tokens: 1 }, { input_per_million_usd: 1, output_per_million_usd: 1 })),
  ).toBe('known');
});

// ---------------------------------------------------------------------------
// Behavior 3a: strict schema + domain validation of untrusted candidate output
// ---------------------------------------------------------------------------

it('accepts a strict-schema-and-domain valid candidate draft', () => {
  const draft = validateCandidateDraft(fixtureWire('candidate-valid.json'), domainContext());
  expect(draft.changes).toHaveLength(1);
  expect(draft.changes[0].kind).toBe('set_attributes');
  expect(draft.score).toBeNull();
});

it('rejects candidate drafts that smuggle unknown fields past the schema', () => {
  expect(() => validateCandidateDraft(fixtureWire('candidate-invalid-schema.json'), domainContext())).toThrow(/candidate_invalid/);
});

it('rejects domain-invalid candidates against the golden document and ontology', () => {
  const cases = fixtureWire('candidate-invalid-domain.json') as Record<string, unknown>;
  for (const [name, wire] of Object.entries(cases)) {
    expect(() => validateCandidateDraft(wire, domainContext()), `case ${name} must be rejected`).toThrow(/candidate_invalid/);
  }
});

it('allows create changes only for detect intent with bbox_output capability', () => {
  const createDraft = {
    changes: [
      {
        kind: 'create',
        change_id: 'change_create_1',
        object: {
          object_id: 'object_person_002',
          label_id: 'label_person',
          geometry: { type: 'bbox_xyxy', x_min: 100, y_min: 100, x_max: 140, y_max: 160 },
          attributes: { helmet_state: 'unknown' },
          origin: { type: 'prediction', prediction_id: null, model_run_id: null, import_batch_id: null },
        },
        before_hash: null,
        reason: 'new detection',
      },
    ],
    issues: [],
    score: null,
  };
  expect(() => validateCandidateDraft(createDraft, domainContext({ intent: 'detect', bbox_output: true }))).not.toThrow();
  expect(() => validateCandidateDraft(createDraft, domainContext({ intent: 'detect', bbox_output: false }))).toThrow(/candidate_invalid/);
  expect(() => validateCandidateDraft(createDraft, domainContext({ intent: 'audit_attributes', bbox_output: true }))).toThrow(/candidate_invalid/);
});

it('validates tool call arguments strictly and rejects unknown or hostile arguments', () => {
  const ok = parseToolCallArguments('read_region', { region: TOOL_REGION }, domainContext());
  expect(ok).toEqual({ tool: 'read_region', region: TOOL_REGION });
  expect(parseToolCallArguments('read_region', '{"region":null}', domainContext())).toEqual({ tool: 'read_region', region: null });
  expect(() => parseToolCallArguments('read_region', { region: null, path: 'C:\\Users\\secret.txt' }, domainContext())).toThrow(/invalid_tool_call/);
  expect(() => parseToolCallArguments('read_region', { region: null, project_id: 'project_golden' }, domainContext())).toThrow(/invalid_tool_call/);
  expect(() => parseToolCallArguments('read_region', '{not json', domainContext())).toThrow(/invalid_tool_call/);
  expect(() => parseToolCallArguments('drop_table', {}, domainContext())).toThrow(/invalid_tool_call/);
  expect(() => parseToolCallArguments('propose_changes', { changes: [{ kind: 'delete' }] }, domainContext())).toThrow(/candidate_invalid/);
  const issues = parseToolCallArguments(
    'report_issues',
    { issues: [{ issue_id: 'issue_1', object_id: null, code: 'blur', message: 'blurry', region: null }] },
    domainContext(),
  );
  expect(issues.tool).toBe('report_issues');
  expect(() =>
    validateQualityIssues(
      [{ issue_id: 'issue_1', object_id: null, code: 'blur', message: 'blurry', region: { type: 'bbox_xyxy', x_min: 700, y_min: 0, x_max: 800, y_max: 100 } }],
      domainContext(),
    ),
  ).toThrow(/candidate_invalid/);
});

// ---------------------------------------------------------------------------
// Behavior 1a: image payloads — full image and object crop with canonical
// transforms, budgets and privacy fingerprints
// ---------------------------------------------------------------------------

it('plans both a full image and a selected-object crop with canonical transforms', () => {
  const requests = planImageInputs(startRunRequest(), goldenDocument, 4);
  expect(requests).toEqual([
    { kind: 'full', region: null, object_id: null },
    { kind: 'crop', region: OBJECT_REGION, object_id: 'object_person_001' },
  ]);
  const full = prepareImage(
    { bytes: FULL_BYTES, mime: 'image/png', transform_to_canonical: IDENTITY_TRANSFORM },
    requests[0],
    { max_bytes: 1024, max_pixels: 16, pixels_used: 0 },
  );
  const crop = prepareImage(
    { bytes: CROP_BYTES, mime: 'image/png', transform_to_canonical: CROP_TRANSFORM },
    requests[1],
    { max_bytes: 1024, max_pixels: 16, pixels_used: full.pixel_count },
  );
  expect(full.width).toBe(2);
  expect(full.height).toBe(2);
  expect(full.pixel_count).toBe(4);
  expect(crop.transform_to_canonical).toEqual(CROP_TRANSFORM);
  expect(full.privacy_fingerprint).toMatch(/^[0-9a-f]{64}$/);
  expect(full.privacy_fingerprint).not.toBe(crop.privacy_fingerprint);
  // Deterministic: identical inputs must produce identical fingerprints.
  expect(privacyFingerprint({ kind: 'crop', region: OBJECT_REGION, transform_to_canonical: CROP_TRANSFORM, bytes: CROP_BYTES })).toBe(
    crop.privacy_fingerprint,
  );
  expect(full.data_url).toBe(FULL_IMAGE.data_url);
});

it('enforces image byte and pixel budgets and rejects malformed image inputs', () => {
  const request = { kind: 'full' as const, region: null, object_id: null };
  expect(() =>
    prepareImage({ bytes: FULL_BYTES, mime: 'image/png', transform_to_canonical: IDENTITY_TRANSFORM }, request, {
      max_bytes: 2,
      max_pixels: 16,
      pixels_used: 0,
    }),
  ).toThrow(/image_budget_exceeded/);
  expect(() =>
    prepareImage({ bytes: FULL_BYTES, mime: 'image/png', transform_to_canonical: IDENTITY_TRANSFORM }, request, {
      max_bytes: 1024,
      max_pixels: 3,
      pixels_used: 0,
    }),
  ).toThrow(/image_budget_exceeded/);
  expect(() =>
    prepareImage({ bytes: Uint8Array.from([1, 2, 3]), mime: 'image/png', transform_to_canonical: IDENTITY_TRANSFORM }, request, {
      max_bytes: 1024,
      max_pixels: 16,
      pixels_used: 0,
    }),
  ).toThrow(/image_invalid/);
  expect(() =>
    prepareImage({ bytes: FULL_BYTES, mime: 'image/png', transform_to_canonical: [1, 0] }, request, {
      max_bytes: 1024,
      max_pixels: 16,
      pixels_used: 0,
    }),
  ).toThrow(/image_invalid/);
  expect(pngDimensions(FULL_BYTES)).toEqual({ width: 2, height: 2 });
});

it('requires the run-scoped approved image grant channel', () => {
  expect(imageGrantIds(makeContext())).toEqual(['grant_t20_1']);
  expect(() => imageGrantIds({ run_id: 'run_t20_001' } as unknown as RuntimeContext)).toThrow(/image_grant_missing/);
  expect(() => imageGrantIds({ run_id: 'run_t20_001', approved_grant_ids: [] } as unknown as RuntimeContext)).toThrow(/image_grant_missing/);
});

// ---------------------------------------------------------------------------
// Behavior 5: API base approval and SSRF hardening
// ---------------------------------------------------------------------------

it('rejects a custom api base without explicit human approval and never fetches', async () => {
  const { fetch_impl, calls } = makeFetch([]);
  const client = new BoundedHttpClient({ provider_id: 'openai_api', api_base: 'https://proxy.example.test/v1', fetch_impl });
  await expect(client.send('/responses', { headers: {}, body: '{}' })).rejects.toThrow(/base_not_approved/);
  expect(calls).toHaveLength(0);
});

it('accepts a custom base only with a trusted local-admin approval record', async () => {
  const { fetch_impl, calls } = makeFetch([{ kind: 'text', status: 200, body: '{}' }]);
  const client = new BoundedHttpClient({
    provider_id: 'openai_api',
    api_base: 'https://proxy.example.test/v1',
    base_approval: { approved: true, approved_by: 'local-admin-1', approved_at: '2026-09-25T00:00:00Z' },
    local_admins: ['local-admin-1'],
    fetch_impl,
  });
  await client.send('/responses', { headers: {}, body: '{}' });
  expect(calls[0].url).toBe('https://proxy.example.test/v1/responses');

  const { fetch_impl: otherFetch, calls: otherCalls } = makeFetch([]);
  const untrusted = new BoundedHttpClient({
    provider_id: 'openai_api',
    api_base: 'https://proxy.example.test/v1',
    base_approval: { approved: true, approved_by: 'someone-else', approved_at: '2026-09-25T00:00:00Z' },
    local_admins: ['local-admin-1'],
    fetch_impl: otherFetch,
  });
  await expect(untrusted.send('/responses', { headers: {}, body: '{}' })).rejects.toThrow(/base_not_approved/);
  expect(otherCalls).toHaveLength(0);
});

it('rejects loopback and private-network destinations as SSRF attempts', async () => {
  const privateBases = [
    'https://127.0.0.1:9000/v1',
    'https://localhost:9000/v1',
    'https://10.1.2.3/v1',
    'https://192.168.0.10/v1',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/v1',
    'https://[::ffff:127.0.0.1]/v1',
    'https://[::ffff:7f00:1]/v1',
    'https://[::ffff:169.254.169.254]/latest/meta-data',
    'https://[::ffff:0:127.0.0.1]/v1',
    'https://printer.internal/v1',
  ];
  for (const api_base of privateBases) {
    const { fetch_impl, calls } = makeFetch([]);
    const client = new BoundedHttpClient({
      provider_id: 'mimo_api',
      api_base,
      base_approval: { approved: true, approved_by: 'local-admin-1', approved_at: '2026-09-25T00:00:00Z' },
      local_admins: ['local-admin-1'],
      fetch_impl,
    });
    await expect(client.send('/chat/completions', { headers: {}, body: '{}' }), api_base).rejects.toThrow(/ssrf_blocked/);
    expect(calls).toHaveLength(0);
  }
});

it('allows a private endpoint only when a trusted admin explicitly approves the private network', async () => {
  const { fetch_impl, calls } = makeFetch([{ kind: 'text', status: 200, body: '{}' }]);
  const client = new BoundedHttpClient({
    provider_id: 'mimo_api',
    api_base: 'http://127.0.0.1:9000/v1',
    base_approval: {
      approved: true,
      approved_by: 'local-admin-1',
      approved_at: '2026-09-25T00:00:00Z',
      allow_private_network: true,
      allow_insecure_http: true,
    },
    local_admins: ['local-admin-1'],
    fetch_impl,
  });
  await client.send('/chat/completions', { headers: {}, body: '{}' });
  expect(calls).toHaveLength(1);
});

it('never follows redirects and never leaks the Authorization header to another location', async () => {
  const { fetch_impl, calls } = makeFetch([{ kind: 'redirect', status: 307, location: 'http://127.0.0.1:9000/steal' }]);
  const client = new BoundedHttpClient({ provider_id: 'openai_api', fetch_impl });
  await expect(client.send('/responses', { headers: { authorization: 'Bearer sk-test-openai-000001' }, body: '{}' })).rejects.toThrow(
    /redirect_rejected/,
  );
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe('https://api.openai.com/v1/responses');
});

it('refuses request paths that would escape the approved base', async () => {
  const { fetch_impl, calls } = makeFetch([]);
  const client = new BoundedHttpClient({ provider_id: 'openai_api', fetch_impl });
  await expect(client.send('//evil.test/steal', { headers: {}, body: '{}' })).rejects.toThrow(/base_not_approved/);
  await expect(client.send('/../evil', { headers: {}, body: '{}' })).rejects.toThrow(/base_not_approved/);
  expect(calls).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Behavior 4b: a timed-out POST is never resent
// ---------------------------------------------------------------------------

it('times out a stuck POST without ever resending it', async () => {
  const { fetch_impl, calls } = makeFetch([{ kind: 'hang' }]);
  const client = new BoundedHttpClient({ provider_id: 'openai_api', fetch_impl, timeout_ms: 25 });
  await expect(client.send('/responses', { headers: {}, body: '{}' })).rejects.toThrow(/timeout/);
  expect(calls).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// Behavior 1b: exact per-provider wire shapes and tool round trips
// ---------------------------------------------------------------------------

it('emits the OpenAI Responses API wire shape and processes a tool round trip', async () => {
  const { fetch_impl, calls } = makeFetch([
    { kind: 'stream', body: fixtureText('openai-stream-turn1.sse') },
    { kind: 'stream', body: fixtureText('openai-stream-turn2.sse') },
  ]);
  const ctx = makeContext();
  const events = await collectRun(openaiAdapter(fetch_impl), startRunRequest(), ctx);

  expect(calls).toHaveLength(2);
  expect(calls[0].url).toBe('https://api.openai.com/v1/responses');
  expect(calls[0].headers.authorization).toBe('Bearer sk-test-openai-000001');
  expect(calls[0].headers['x-api-key']).toBeUndefined();
  expect(JSON.parse(calls[0].body)).toEqual(fixtureWire('openai-request-turn1.json'));
  expect(JSON.parse(calls[1].body)).toEqual(fixtureWire('openai-request-turn2.json'));

  expect(events[0].type).toBe('started');
  expect(events.at(-1)?.type).toBe('succeeded');
  expect(events.map((event) => event.seq)).toEqual(events.map((_event, index) => index));
  expect(events.some((event) => event.type === 'tool_call')).toBe(true);
  expect(ctx.reads).toEqual([
    { grant_id: 'grant_t20_1', region: null },
    { grant_id: 'grant_t20_1', region: OBJECT_REGION },
    { grant_id: 'grant_t20_1', region: TOOL_REGION },
  ]);
  expect(ctx.submitted).toEqual([fixtureWire('candidate-valid.json')]);
});

it('emits the Anthropic Messages API wire shape and processes a tool round trip', async () => {
  const { fetch_impl, calls } = makeFetch([
    { kind: 'stream', body: fixtureText('anthropic-stream-turn1.sse') },
    { kind: 'stream', body: fixtureText('anthropic-stream-turn2.sse') },
  ]);
  const ctx = makeContext();
  const events = await collectRun(anthropicAdapter(fetch_impl), startRunRequest(), ctx);

  expect(calls).toHaveLength(2);
  expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages');
  expect(calls[0].headers['x-api-key']).toBe('sk-ant-test-000001');
  expect(calls[0].headers['anthropic-version']).toBe('2023-06-01');
  expect(calls[0].headers.authorization).toBeUndefined();
  expect(JSON.parse(calls[0].body)).toEqual(fixtureWire('anthropic-request-turn1.json'));
  expect(JSON.parse(calls[1].body)).toEqual(fixtureWire('anthropic-request-turn2.json'));
  expect(events.at(-1)?.type).toBe('succeeded');
  expect(ctx.submitted).toEqual([fixtureWire('candidate-valid.json')]);
});

it('emits the MiMo chat/completions wire shape and processes a tool round trip', async () => {
  const { fetch_impl, calls } = makeFetch([
    { kind: 'stream', body: fixtureText('mimo-stream-turn1.sse') },
    { kind: 'stream', body: fixtureText('mimo-stream-turn2.sse') },
  ]);
  const ctx = makeContext();
  const events = await collectRun(mimoAdapter(fetch_impl), startRunRequest(), ctx);

  expect(calls).toHaveLength(2);
  expect(calls[0].url).toBe('https://api.xiaomimimo.com/v1/chat/completions');
  expect(calls[0].headers.authorization).toBe('Bearer sk-test-mimo-000001');
  expect(JSON.parse(calls[0].body)).toEqual(fixtureWire('mimo-request-turn1.json'));
  expect(JSON.parse(calls[1].body)).toEqual(fixtureWire('mimo-request-turn2.json'));
  expect(events.at(-1)?.type).toBe('succeeded');
  expect(ctx.submitted).toEqual([fixtureWire('candidate-valid.json')]);
});

it('answers every tool call with a matching tool result before the next turn', async () => {
  // A report_issues-only turn continues the loop; without a matching tool
  // result the next request would be protocol-invalid for all three dialects.
  const ackAccepted = (raw: unknown): boolean => {
    const parsed: unknown = JSON.parse(String(raw));
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      'accepted' in parsed &&
      parsed.accepted === true
    );
  };
  const openaiFetch = makeFetch([
    { kind: 'stream', body: fixtureText('openai-stream-issues.sse') },
    { kind: 'stream', body: fixtureText('openai-stream-turn2.sse') },
  ]);
  const openaiCtx = makeContext();
  await collectRun(openaiAdapter(openaiFetch.fetch_impl), startRunRequest(), openaiCtx);
  expect(openaiCtx.reported_issues).toHaveLength(1);
  const openaiTurn2 = JSON.parse(openaiFetch.calls[1].body) as { input: Array<Record<string, unknown>> };
  expect(
    openaiTurn2.input.some(
      (item) =>
        item.type === 'function_call_output' &&
        item.call_id === 'call_issues_1' &&
        ackAccepted(item.output),
    ),
  ).toBe(true);

  const anthropicFetch = makeFetch([
    { kind: 'stream', body: fixtureText('anthropic-stream-issues.sse') },
    { kind: 'stream', body: fixtureText('anthropic-stream-turn2.sse') },
  ]);
  const anthropicCtx = makeContext();
  await collectRun(anthropicAdapter(anthropicFetch.fetch_impl), startRunRequest(), anthropicCtx);
  expect(anthropicCtx.reported_issues).toHaveLength(1);
  const anthropicTurn2 = JSON.parse(anthropicFetch.calls[1].body) as {
    messages: Array<{ role: string; content: Array<{ type: string; tool_use_id?: string; content?: string }> }>;
  };
  expect(
    anthropicTurn2.messages.some((message) =>
      message.content.some(
        (block) =>
          block.type === 'tool_result' &&
          block.tool_use_id === 'toolu_issues_1' &&
          ackAccepted(block.content),
      ),
    ),
  ).toBe(true);

  const mimoFetch = makeFetch([
    { kind: 'stream', body: fixtureText('mimo-stream-issues.sse') },
    { kind: 'stream', body: fixtureText('mimo-stream-turn2.sse') },
  ]);
  const mimoCtx = makeContext();
  await collectRun(mimoAdapter(mimoFetch.fetch_impl), startRunRequest(), mimoCtx);
  expect(mimoCtx.reported_issues).toHaveLength(1);
  const mimoTurn2 = JSON.parse(mimoFetch.calls[1].body) as {
    messages: Array<{ role: string; tool_call_id?: string; content?: string }>;
  };
  expect(
    mimoTurn2.messages.some(
      (message) =>
        message.role === 'tool' &&
        message.tool_call_id === 'call_issues_1' &&
        ackAccepted(message.content),
    ),
  ).toBe(true);

  // The loop then continues and terminates with a candidate for every provider.
  expect(openaiCtx.submitted).toEqual([fixtureWire('candidate-valid.json')]);
  expect(anthropicCtx.submitted).toEqual([fixtureWire('candidate-valid.json')]);
  expect(mimoCtx.submitted).toEqual([fixtureWire('candidate-valid.json')]);
});

it('fails closed when a run carries more than one approved image grant', async () => {
  const { fetch_impl, calls } = makeFetch([]);
  const ctx = makeContext();
  ctx.approved_grant_ids = ['grant_t20_1', 'grant_t20_2'];
  const events = await collectRun(mimoAdapter(fetch_impl), startRunRequest(), ctx);
  expect(runData(events, 'failed').error_code).toBe('image_grant_missing');
  expect(calls).toHaveLength(0);
});

it("keeps each provider's role, image and tool wire formats distinct", async () => {
  const openaiFetch = makeFetch([
    { kind: 'stream', body: fixtureText('openai-stream-turn1.sse') },
    { kind: 'stream', body: fixtureText('openai-stream-turn2.sse') },
  ]);
  await collectRun(openaiAdapter(openaiFetch.fetch_impl), startRunRequest(), makeContext());
  const anthropicFetch = makeFetch([
    { kind: 'stream', body: fixtureText('anthropic-stream-turn1.sse') },
    { kind: 'stream', body: fixtureText('anthropic-stream-turn2.sse') },
  ]);
  await collectRun(anthropicAdapter(anthropicFetch.fetch_impl), startRunRequest(), makeContext());
  const mimoFetch = makeFetch([
    { kind: 'stream', body: fixtureText('mimo-stream-turn1.sse') },
    { kind: 'stream', body: fixtureText('mimo-stream-turn2.sse') },
  ]);
  await collectRun(mimoAdapter(mimoFetch.fetch_impl), startRunRequest(), makeContext());

  // The request bodies are produced by the adapters under test and compared
  // byte-for-byte against the request fixtures above; their shape is asserted
  // here at the parse boundary with named wire types.
  const openaiBody = JSON.parse(openaiFetch.calls[0].body) as WireBody;
  const anthropicBody = JSON.parse(anthropicFetch.calls[0].body) as WireBody;
  const mimoBody = JSON.parse(mimoFetch.calls[0].body) as WireBody;

  // Role format: OpenAI uses instructions + typed input items, Anthropic a
  // top-level system string, MiMo a system role message.
  expect(typeof openaiBody.instructions).toBe('string');
  expect(openaiBody.input?.[0].content?.some((part) => part.type === 'input_image')).toBe(true);
  expect(typeof anthropicBody.system).toBe('string');
  expect(anthropicBody.messages?.[0].content?.some((part) => part.type === 'image' && part.source?.type === 'base64')).toBe(true);
  expect(mimoBody.messages?.[0].role).toBe('system');
  expect(mimoBody.messages?.[1].content?.some((part) => part.type === 'image_url' && typeof part.image_url?.url === 'string')).toBe(true);

  // Tool structure: flat function tools vs input_schema tools vs function-wrapped tools.
  expect(openaiBody.tools?.[0]).toMatchObject({ type: 'function', name: 'read_region', strict: true });
  expect(anthropicBody.tools?.[0]).toMatchObject({ name: 'read_region', input_schema: expect.anything() });
  expect(mimoBody.tools?.[0]).toMatchObject({ type: 'function', function: { name: 'read_region' } });

  // Streaming: each request opts into its own provider's stream mode.
  expect(openaiBody.stream).toBe(true);
  expect(anthropicBody.stream).toBe(true);
  expect(mimoBody.stream).toBe(true);
});

it('carries canonical transforms and consistent privacy fingerprints across providers', async () => {
  const scenarios: Array<{ name: string; make: () => ProviderAdapter }> = [
    {
      name: 'openai_api',
      make: () =>
        openaiAdapter(
          makeFetch([
            { kind: 'stream', body: fixtureText('openai-stream-turn1.sse') },
            { kind: 'stream', body: fixtureText('openai-stream-turn2.sse') },
          ]).fetch_impl,
        ),
    },
    {
      name: 'anthropic_api',
      make: () =>
        anthropicAdapter(
          makeFetch([
            { kind: 'stream', body: fixtureText('anthropic-stream-turn1.sse') },
            { kind: 'stream', body: fixtureText('anthropic-stream-turn2.sse') },
          ]).fetch_impl,
        ),
    },
    {
      name: 'mimo_api',
      make: () =>
        mimoAdapter(
          makeFetch([
            { kind: 'stream', body: fixtureText('mimo-stream-turn1.sse') },
            { kind: 'stream', body: fixtureText('mimo-stream-turn2.sse') },
          ]).fetch_impl,
        ),
    },
  ];
  const fingerprints = new Map<string, string[]>();
  for (const scenario of scenarios) {
    const events = await collectRun(scenario.make(), startRunRequest(), makeContext());
    // Run-event data is produced by the adapter under test; its shape is
    // asserted at this boundary with the named event-data type.
    const imageEvents = events.filter((event) => event.type === 'progress');
    expect(imageEvents.length, `${scenario.name} image progress events`).toBe(3);
    const imageDatas = imageEvents.map((event) => event.data as unknown as ImageEventData); // run-event data shape asserted at this boundary
    expect(imageDatas.every((data) => /^[0-9a-f]{64}$/.test(data.privacy_fingerprint))).toBe(true);
    fingerprints.set(
      scenario.name,
      imageDatas.map((data) => data.privacy_fingerprint),
    );
    expect(imageDatas.find((data) => data.object_id === 'object_person_001')?.transform_to_canonical).toEqual(CROP_TRANSFORM);
    expect(imageDatas.find((data) => data.kind === 'full')?.transform_to_canonical).toEqual(IDENTITY_TRANSFORM);
  }
  expect(fingerprints.get('openai_api')).toEqual(fingerprints.get('anthropic_api'));
  expect(fingerprints.get('openai_api')).toEqual(fingerprints.get('mimo_api'));
});

// ---------------------------------------------------------------------------
// Behavior 2: controlled error taxonomy for every failure mode
// ---------------------------------------------------------------------------

async function failureCode(replies: Reply[], overrides: Partial<OpenAiApiAdapterConfig> = {}): Promise<string> {
  const { fetch_impl } = makeFetch(replies);
  const events = await collectRun(openaiAdapter(fetch_impl, overrides), startRunRequest(), makeContext());
  const last = events.at(-1);
  expect(last?.type, `expected a failed terminal event, got ${events.map((e) => e.type).join(',')}`).toBe('failed');
  return String(runData(events, 'failed').error_code);
}

it('maps HTTP and transport failures to distinct controlled errors', async () => {
  const codes = [
    await failureCode([{ kind: 'text', status: 401, body: '{"error":"revoked"}' }]),
    await failureCode([{ kind: 'text', status: 403, body: '{"error":"forbidden"}' }]),
    await failureCode([{ kind: 'text', status: 429, body: '{"error":"rate limit"}' }]),
    await failureCode([{ kind: 'text', status: 503, body: '{"error":"upstream"}' }]),
    await failureCode([{ kind: 'hang' }], { timeout_ms: 25 }),
    await failureCode([{ kind: 'stream', body: 'event: response.completed\ndata: {broken json\n\n' }]),
    await failureCode([{ kind: 'stream', body: fixtureText('openai-stream-turn1.sse') }], { max_stream_bytes: 60 }),
    await failureCode([{ kind: 'stream', body: fixtureText('openai-stream-turn1.sse').split('event: response.completed')[0] }]),
  ];
  expect(codes).toEqual([
    'unauthorized_401',
    'forbidden_403',
    'rate_limited_429',
    'upstream_5xx',
    'timeout',
    'invalid_json',
    'oversized_response',
    'interrupted_stream',
  ]);
  expect(new Set(codes).size).toBe(codes.length);
});

it('maps a stream truncated mid-frame to interrupted_stream', async () => {
  const whole = fixtureText('openai-stream-turn2.sse');
  const truncated = whole.slice(0, whole.length - 60);
  expect(await failureCode([{ kind: 'stream', body: truncated }])).toBe('interrupted_stream');
});

it('reports provider-declared stream failures distinctly', async () => {
  const body = 'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"message":"model overloaded"}}}\n\n';
  expect(await failureCode([{ kind: 'stream', body }])).toBe('provider_reported_failure');
});

// ---------------------------------------------------------------------------
// Behavior 3b: budgeted tool loops
// ---------------------------------------------------------------------------

it('stops a tool loop that exceeds its turn budget', async () => {
  const { fetch_impl } = makeFetch([{ kind: 'stream', body: fixtureText('openai-stream-turn1.sse') }]);
  const events = await collectRun(openaiAdapter(fetch_impl, { budgets: { max_tool_turns: 1 } }), startRunRequest(), makeContext());
  expect(events.at(-1)?.type).toBe('failed');
  expect(runData(events, 'failed').error_code).toBe('tool_turn_budget_exceeded');
});

it('stops a tool loop that exceeds its byte budget', async () => {
  const { fetch_impl } = makeFetch([{ kind: 'stream', body: fixtureText('openai-stream-turn1.sse') }]);
  const events = await collectRun(openaiAdapter(fetch_impl, { budgets: { max_total_bytes: 100 } }), startRunRequest(), makeContext());
  expect(runData(events, 'failed').error_code).toBe('tool_byte_budget_exceeded');
});

it('stops a tool loop that exceeds its time budget', async () => {
  const { fetch_impl } = makeFetch([{ kind: 'slow', ms: 40, body: fixtureText('openai-stream-turn1.sse') }]);
  const events = await collectRun(openaiAdapter(fetch_impl, { budgets: { max_run_ms: 5 } }), startRunRequest(), makeContext());
  expect(runData(events, 'failed').error_code).toBe('tool_time_budget_exceeded');
});

it('stops before sending anything when the image pixel budget is exceeded', async () => {
  const { fetch_impl, calls } = makeFetch([]);
  const events = await collectRun(openaiAdapter(fetch_impl, { budgets: { max_pixels: 3 } }), startRunRequest(), makeContext());
  expect(runData(events, 'failed').error_code).toBe('image_budget_exceeded');
  expect(calls).toHaveLength(0);
});

it('exposes a reusable turn/byte/time budget guard', () => {
  const budget = new ToolLoopBudget({ max_tool_turns: 2, max_total_bytes: 10, max_run_ms: 1000 }, () => 0);
  budget.beginTurn();
  budget.chargeBytes(6);
  budget.beginTurn();
  expect(() => budget.chargeBytes(6)).toThrow(/tool_byte_budget_exceeded/);
  const tight = new ToolLoopBudget({ max_tool_turns: 1, max_total_bytes: 10, max_run_ms: 1000 }, () => 0);
  tight.beginTurn();
  expect(() => tight.beginTurn()).toThrow(/tool_turn_budget_exceeded/);
});

// ---------------------------------------------------------------------------
// Behavior 3c: candidate parsing without structured_output stays strict
// ---------------------------------------------------------------------------

it('strictly validates candidates parsed from plain text when structured_output is unsupported', async () => {
  const { fetch_impl } = makeFetch([{ kind: 'stream', body: fixtureText('mimo-stream-text-candidate.sse') }]);
  const ctx = makeContext();
  const capabilities = { image_input: true, tools: true, structured_output: false, bbox_output: false, attributes: true };
  const events = await collectRun(mimoAdapter(fetch_impl, { capabilities }), startRunRequest(), ctx);
  expect(events.at(-1)?.type).toBe('succeeded');
  expect(ctx.submitted).toHaveLength(1);
  expect(ctx.submitted[0]).toEqual({
    changes: [
      {
        kind: 'set_attributes',
        change_id: 'change_t20_text',
        object_id: 'object_person_001',
        values: { helmet_state: 'wearing' },
        before_hash: 'h1',
        reason: 'Helmet strap is visible.',
      },
    ],
    issues: [],
    score: null,
  });
});

it('rejects schema-invalid text candidates with a controlled error and stores nothing', async () => {
  const { fetch_impl } = makeFetch([{ kind: 'stream', body: fixtureText('mimo-stream-text-bad-candidate.sse') }]);
  const ctx = makeContext();
  const events = await collectRun(mimoAdapter(fetch_impl), startRunRequest(), ctx);
  expect(runData(events, 'failed').error_code).toBe('candidate_invalid');
  expect(ctx.submitted).toHaveLength(0);
});

it('rejects create changes smuggled into an attribute-audit run (422 semantics)', async () => {
  const { fetch_impl } = makeFetch([{ kind: 'stream', body: fixtureText('mimo-stream-text-create.sse') }]);
  const ctx = makeContext();
  const events = await collectRun(mimoAdapter(fetch_impl), startRunRequest(), ctx);
  expect(runData(events, 'failed').error_code).toBe('candidate_invalid');
  expect(ctx.submitted).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Behavior 4c: usage and cost surfaces
// ---------------------------------------------------------------------------

it('shows unknown usage as null and never as zero', async () => {
  // MiMo documents that response usage may be null: turn 1 reports usage and
  // turn 2 reports none, so the total is unknown.
  const { fetch_impl } = makeFetch([
    { kind: 'stream', body: fixtureText('mimo-stream-turn1.sse') },
    { kind: 'stream', body: fixtureText('mimo-stream-turn2.sse') },
  ]);
  const events = await collectRun(mimoAdapter(fetch_impl), startRunRequest(), makeContext());
  const usage = runData(events, 'succeeded').usage;
  expect(usage).toEqual({ input_tokens: null, output_tokens: null, cost_usd: null });
  expect(runData(events, 'succeeded').cost_display).toBe('unknown');
  expect(JSON.stringify(usage)).not.toContain(':0');
});

it('reports summed tokens without inventing a price, and computes cost only with explicit pricing', async () => {
  const script = (): Reply[] => [
    { kind: 'stream', body: fixtureText('openai-stream-turn1.sse') },
    { kind: 'stream', body: fixtureText('openai-stream-turn2.sse') },
  ];
  const plain = await collectRun(openaiAdapter(makeFetch(script()).fetch_impl), startRunRequest(), makeContext());
  expect(runData(plain, 'succeeded').usage).toEqual({ input_tokens: 450, output_tokens: 43, cost_usd: null });
  expect(runData(plain, 'succeeded').cost_display).toBe('unknown');

  const priced = await collectRun(
    anthropicAdapter(
      makeFetch([
        { kind: 'stream', body: fixtureText('anthropic-stream-turn1.sse') },
        { kind: 'stream', body: fixtureText('anthropic-stream-turn2.sse') },
      ]).fetch_impl,
      { pricing: { input_per_million_usd: 2, output_per_million_usd: 8 } },
    ),
    startRunRequest(),
    makeContext(),
  );
  const pricedUsage = runData(priced, 'succeeded').usage as NormalizedUsage;
  expect(pricedUsage.input_tokens).toBe(450);
  expect(pricedUsage.output_tokens).toBe(43);
  expect(pricedUsage.cost_usd).toBeCloseTo(0.001244, 9);
  expect(runData(priced, 'succeeded').cost_display).toBe('known');
});

it('never auto-resends a timed-out POST during a run', async () => {
  const { fetch_impl, calls } = makeFetch([{ kind: 'hang' }]);
  const events = await collectRun(openaiAdapter(fetch_impl, { timeout_ms: 25 }), startRunRequest(), makeContext());
  expect(runData(events, 'failed').error_code).toBe('timeout');
  expect(calls).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// Secret handling and probe honesty
// ---------------------------------------------------------------------------

it('keeps resolved secrets out of run events and error messages', async () => {
  const secret = 'sk-test-verysecret-000001';
  const { fetch_impl } = makeFetch([{ kind: 'text', status: 401, body: '{"error":"revoked"}' }]);
  const events = await collectRun(openaiAdapter(fetch_impl, { secret_env: { WEBLABEL_T20_OPENAI: secret } }), startRunRequest(), makeContext());
  expect(events.at(-1)?.type).toBe('failed');
  expect(JSON.stringify(events)).not.toContain(secret);
});

it('accepts only secret references and resolves them from the environment channel', () => {
  expect(() => resolveSecretRef('sk-inline-abcdef123')).toThrow(/secret_ref_invalid/);
  expect(() => resolveSecretRef('env:MISSING_T20_VAR', {})).toThrow(/secret_ref_invalid/);
  expect(resolveSecretRef('env:WEBLABEL_T20_OPENAI', { WEBLABEL_T20_OPENAI: 'sk-test-000001' })).toBe('sk-test-000001');
});

it('fails a run with a controlled error when the credential reference cannot be resolved', async () => {
  const { fetch_impl } = makeFetch([]);
  const events = await collectRun(openaiAdapter(fetch_impl, { secret_env: {} }), startRunRequest(), makeContext());
  expect(runData(events, 'failed').error_code).toBe('secret_ref_invalid');
});

it('keeps unknown model entitlement blocked and never guesses capabilities from names', async () => {
  const adapter = createOpenAiApiAdapter({
    profile_id: 'profile_openai_t20',
    model_id: 'gpt-6-luna',
    credential: { secret_ref: 'env:WEBLABEL_T20_OPENAI' },
    fetch_impl: makeFetch([]).fetch_impl,
  });
  const [profile] = await adapter.probe();
  expect(profile).toEqual({
    profile_id: 'profile_openai_t20',
    provider_id: 'openai_api',
    model_id: 'gpt-6-luna',
    auth_kind: 'api_key',
    capabilities: { image_input: false, tools: false, structured_output: false, bbox_output: false, attributes: false },
    availability: 'blocked',
    verification: 'not_run',
    runtime_version: null,
    verified_at: null,
  });
});

it('reports readiness and configuration gaps independently of verification evidence', async () => {
  const ready = await openaiAdapter(makeFetch([]).fetch_impl).probe();
  expect(ready[0].availability).toBe('ready');
  expect(ready[0].verification).toBe('not_run');

  const unapproved = createAnthropicApiAdapter({
    profile_id: 'profile_anthropic_t20',
    model_id: 'claude-sonnet-5',
    credential: { secret_ref: 'env:WEBLABEL_T20_ANTHROPIC' },
    api_base: 'https://proxy.example.test',
    fetch_impl: makeFetch([]).fetch_impl,
    account_model_verified: true,
  });
  const [needsConfig] = await unapproved.probe();
  expect(needsConfig.availability).toBe('needs_configuration');
  expect(needsConfig.verification).toBe('not_run');

  const mimo = await mimoAdapter(makeFetch([]).fetch_impl).probe();
  expect(mimo[0].provider_id).toBe('mimo_api');
  expect(mimo[0].model_id).toBe('mimo-v2.6-pro');
});

it('requires the Token Plan console base URL instead of guessing one', async () => {
  const { fetch_impl, calls } = makeFetch([]);
  const events = await collectRun(mimoAdapter(fetch_impl, { secret_env: { WEBLABEL_T20_MIMO: 'tp-test-tokenplan-0001' } }), startRunRequest(), makeContext());
  expect(runData(events, 'failed').error_code).toBe('base_not_approved');
  expect(calls).toHaveLength(0);
});

it('cancels a run without mapping cancellation to a failure', async () => {
  const controller = new AbortController();
  const { fetch_impl, calls } = makeFetch([{ kind: 'hang' }]);
  const running = collectRun(openaiAdapter(fetch_impl), startRunRequest(), makeContext(), controller.signal);
  controller.abort();
  const events = await running;
  expect(events.at(-1)?.type).toBe('cancelled');
  expect(calls).toHaveLength(1);
});

it('decodes JSON with a controlled invalid_json error', () => {
  expect(decodeJson('{"a":1}')).toEqual({ a: 1 });
  expect(() => decodeJson('{nope')).toThrow(/invalid_json/);
});
