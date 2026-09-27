import type { AnnotationObject } from '../../../../../packages/contracts/generated/AnnotationObject';
import type { Change } from '../../../../../packages/contracts/generated/Change';
import type { SuggestionSet } from '../../../../../packages/contracts/generated/SuggestionSet';

function values(value: Record<string, unknown> | null): string {
  return value === null ? '—' : Object.entries(value).map(([key, item]) => `${key}: ${String(item)}`).join(', ') || '—';
}

export function DiffView({ change, objects, set, selected, onToggle, disabled }: {
  change: Change;
  objects: ReadonlyMap<string, AnnotationObject>;
  set: SuggestionSet;
  selected: boolean;
  onToggle: (changeId: string, selected: boolean) => void;
  disabled: boolean;
}) {
  const objectId = change.kind === 'create' ? change.object.object_id : change.object_id;
  const before = change.kind === 'create' ? null : objects.get(objectId) ?? null;
  const beforeSummary = before === null ? '—' : `label_id: ${before.label_id}; ${values(before.attributes)}`;
  const afterSummary = change.kind === 'create'
    ? `label_id: ${change.object.label_id}; ${values(change.object.attributes)}`
    : change.kind === 'set_attributes'
      ? `label_id: ${before?.label_id ?? 'Unavailable'}; ${values(change.values)}`
      : `label_id: ${change.label_id}; ${values(before?.attributes ?? null)}`;
  const afterGeometry = change.kind === 'create' ? JSON.stringify(change.object.geometry) : before ? JSON.stringify(before.geometry) : 'Unavailable';
  const reason = change.reason || 'No reason supplied';
  return (
    <li data-testid={`candidate-${change.change_id}`}>
      <label>
        <input type="checkbox" checked={selected} disabled={disabled} onChange={(event) => onToggle(change.change_id, event.currentTarget.checked)} aria-label={`Select change ${change.change_id}`} />
        <strong>{change.kind}</strong> · object <code>{objectId}</code>
      </label>
      <dl>
        <dt>Before</dt><dd>{beforeSummary}</dd>
        <dt>After</dt><dd>{afterSummary}</dd>
        <dt>Geometry (projection only)</dt><dd>{change.kind === 'set_attributes' ? 'Unchanged' : afterGeometry}</dd>
        <dt>Reason</dt><dd>{reason}</dd>
        <dt>Source</dt><dd>Prediction <code>{set.prediction_id}</code> · run <code>{set.model_run_id}</code></dd>
        <dt>Confidence</dt><dd>{set.score === null ? 'Not provided' : 'Model-reported score; not a probability of correctness'}</dd>
      </dl>
    </li>
  );
}
