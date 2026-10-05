import { useState } from 'react';
import type { AnnotationObject } from '../../../../../packages/contracts/generated/AnnotationObject';
import { canAcceptSuggestion, type CandidateEntry } from './useRun';
import { DiffView } from './DiffView';

export function CandidateList({ entries, activeAsset, activeContext, activeGeneration, busy, onAccept }: {
  entries: readonly CandidateEntry[];
  activeAsset: string;
  activeContext: CandidateEntry['candidate']['context'];
  activeGeneration?: number;
  busy: boolean;
  onAccept: (entry: CandidateEntry, changeIds: string[]) => void;
}) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  return (
    <section aria-label="AI candidates and issues">
      {entries.length === 0 ? <p role="status">No candidates have been returned.</p> : null}
      {entries.map((entry) => {
        const candidate = entry.candidate;
        const acceptAllowed = canAcceptSuggestion({ active_asset: activeAsset, candidate_asset: entry.asset_revision_id, active_context: activeContext, run_context: entry.run_context, active_generation: activeGeneration ?? activeContext.draft_generation, candidate, busy, schema_error: entry.schema_error });
        const ids = selected[entry.key] ?? [];
        const sourceAssetIsCurrent = entry.asset_revision_id === activeAsset;
        return (
          <article key={entry.key} aria-label={`Candidate set ${candidate.suggestion_set_id}`}>
            {!sourceAssetIsCurrent ? <p role="status">This result belongs to asset {entry.asset_revision_id}; it is retained for comparison and cannot be accepted here.</p> : null}
            {candidate.state === 'stale' || (sourceAssetIsCurrent && !acceptAllowed && !entry.schema_error) ? <p role="status">Stale or mismatched context: compare only; rerun to create an acceptable candidate.</p> : null}
            {entry.schema_error ? <p role="alert">{entry.schema_error}</p> : null}
            <ul>
              {candidate.changes.map((change) => (
                <DiffView key={change.change_id} change={change} objects={entry.objects} set={candidate} selected={ids.includes(change.change_id)} disabled={!acceptAllowed} onToggle={(id, checked) => setSelected((current) => {
                  const currentIds = current[entry.key] ?? [];
                  return { ...current, [entry.key]: checked ? [...currentIds, id].filter((value, index, all) => all.indexOf(value) === index) : currentIds.filter((value) => value !== id) };
                })} />
              ))}
            </ul>
            {candidate.issues.map((issue) => <p key={issue.issue_id} role="note">Issue {issue.code}: {issue.message}</p>)}
            {candidate.score === null ? <p>Confidence: Not provided</p> : <p>Model-reported score: {candidate.score} · not a correctness probability</p>}
            <button type="button" data-testid="accept-selected" disabled={!acceptAllowed || ids.length === 0} onClick={() => onAccept(entry, ids)}>Accept selected changes</button>
          </article>
        );
      })}
    </section>
  );
}
