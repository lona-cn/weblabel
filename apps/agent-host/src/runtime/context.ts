import type { AnnotationDocument } from '../../../../packages/contracts/generated/AnnotationDocument';
import type { BBox } from '../../../../packages/contracts/generated/BBox';
import type { OntologyVersion } from '../../../../packages/contracts/generated/OntologyVersion';
import type { StartRunRequest } from '../../../../packages/contracts/generated/StartRunRequest';
import type { SuggestionSet } from '../../../../packages/contracts/generated/SuggestionSet';
import type { RuntimeContext, RuntimeReadRegion } from '../registry';
import { RegistryError } from '../registry';

export interface RuntimeBinding { apiBase: string; token: string; run_id: string; request: StartRunRequest }
interface Facts { run_id: string; media: { width: number; height: number }; ontology: OntologyVersion; allow_image: boolean; allow_object_context: boolean; approved_grant_ids: string[]; approved_image_region: BBox | null }

export class ServerRuntimeContext implements RuntimeContext {
  readonly run_id: string;
  readonly approved_grant_ids: readonly string[];
  readonly approved_image_region: BBox | null;
  readonly allow_image: boolean;
  readonly allow_object_context: boolean;
  private constructor(private readonly binding: RuntimeBinding, private readonly facts: Facts, private readonly signal: AbortSignal) {
    this.run_id = binding.run_id;
    this.approved_grant_ids = facts.approved_grant_ids;
    this.approved_image_region = facts.approved_image_region;
    this.allow_image = facts.allow_image;
    this.allow_object_context = facts.allow_object_context;
  }
  static async open(binding: RuntimeBinding, signal: AbortSignal): Promise<ServerRuntimeContext> {
    const facts = await callTool(binding, signal, 'get_context', {}) as Facts;
    if (facts.run_id !== binding.run_id || typeof facts.allow_image !== 'boolean' || typeof facts.allow_object_context !== 'boolean' || !Array.isArray(facts.approved_grant_ids)) throw new RegistryError('invalid_runtime_context');
    return new ServerRuntimeContext(binding, facts, signal);
  }
  async read_region(grant_id: string, region: BBox | null): Promise<RuntimeReadRegion> {
    if (!this.allow_image || !this.approved_grant_ids.includes(grant_id)) throw new RegistryError('image_grant_missing');
    const result = await callTool(this.binding, this.signal, 'read_region', { region }) as { mime: 'image/png'; data_base64: string; transform_to_canonical: number[] };
    if (result.mime !== 'image/png' || typeof result.data_base64 !== 'string') throw new RegistryError('invalid_region');
    return { bytes: Buffer.from(result.data_base64, 'base64'), mime: result.mime, transform_to_canonical: result.transform_to_canonical };
  }
  async get_document(): Promise<AnnotationDocument> {
    const objects: AnnotationDocument['objects'] = [];
    let cursor: string | null = null;
    if (this.allow_object_context) {
      const seen = new Set<string>();
      do {
        const page = await callTool(this.binding, this.signal, "list_objects", { limit: 100, ...(cursor ? { cursor } : {}) }) as { items: Array<{ object: AnnotationDocument["objects"][number] }>; next_cursor: string | null };
        for (const item of page.items) objects.push(item.object);
        if (objects.length > 10_000 || (page.next_cursor && seen.has(page.next_cursor))) throw new RegistryError('object_budget_exceeded');
        cursor = page.next_cursor;
        if (cursor) seen.add(cursor);
      } while (cursor);
    }
    return { schema_version: 1, asset_revision_id: this.binding.request.context.asset_revision_id, ontology_version_id: this.binding.request.context.ontology_version_id, coordinate_space: { type: "canonical_image_pixels", width: this.facts.media.width, height: this.facts.media.height }, completion: "unprocessed", objects };
  }
  async get_ontology(): Promise<OntologyVersion> {
    const facts = await callTool(this.binding, this.signal, 'get_context', {}) as Facts;
    return facts.ontology;
  }
  async submit_candidates(candidate: unknown): Promise<SuggestionSet> {
    const draft = candidate as Pick<SuggestionSet, 'changes' | 'issues' | 'score'>;
    const result = await callTool(this.binding, this.signal, 'propose_changes', draft) as Pick<SuggestionSet, 'suggestion_set_id' | 'prediction_id' | 'state'>;
    return { ...draft, ...result, model_run_id: this.run_id, context: this.binding.request.context };
  }
  async report_issues(issues: unknown): Promise<void> { await callTool(this.binding, this.signal, 'report_issues', { issues }); }
}

async function callTool(binding: RuntimeBinding, signal: AbortSignal, tool: string, args: unknown): Promise<unknown> {
  const base = new URL(binding.apiBase);
  if (base.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname) || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new RegistryError('api_base_untrusted');
  const response = await fetch(`${base.origin}/internal/agent-tools/${tool}`, { method: 'POST', headers: { authorization: `Bearer ${binding.token}`, 'content-type': 'application/json' }, body: JSON.stringify(args), signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), redirect: 'error' });
  const reader = response.body?.getReader();
  if (!reader) throw new RegistryError('tool_output_missing');
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 16 * 1024 * 1024) throw new RegistryError('tool_output_too_large'); chunks.push(value); }
  } finally { await reader.cancel(); }
  const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!response.ok) throw new RegistryError(typeof result.code === 'string' ? result.code : 'agent_tools_rejected');
  return result;
}
