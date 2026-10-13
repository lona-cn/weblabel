import type { DraftRecord } from '../../lib/persistence/types';
import { admitRawDraft } from '../../lib/persistence/draft-store';

/** Location is a read-only choice, never a migration or write authorization. */
export function locateOntology(assetId: string, taskOntology: string | null, explicitOntology: string | null, draft: DraftRecord | null): { ontologyId: string | null; conflict: boolean } {
  if (draft) admitRawDraft(draft, assetId);
  const ontologyId = taskOntology || explicitOntology || draft?.ontology_version_id || null;
  return { ontologyId, conflict: !!draft && !!ontologyId && draft.ontology_version_id !== ontologyId };
}
