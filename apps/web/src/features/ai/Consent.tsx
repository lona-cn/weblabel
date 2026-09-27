import type { ConsentPreview } from './useRun';

export function Consent({ preview, confirmed, onChange, disabled = false }: {
  preview: ConsentPreview;
  confirmed: boolean;
  onChange: (confirmed: boolean) => void;
  disabled?: boolean;
}) {
  const { profile, context, intent, prompt, grants } = preview;
  return (
    <section aria-labelledby="ai-consent-heading" data-testid="ai-consent">
      <h3 id="ai-consent-heading">Review and authorize this run</h3>
      <dl>
        <dt>Provider and model</dt><dd>{profile.provider_id} · {profile.model_id}</dd>
        <dt>Project</dt><dd>{context.project_id}</dd>
        <dt>Asset revision</dt><dd>{context.asset_revision_id}</dd>
        <dt>Annotation revision</dt><dd>{context.annotation_revision_id}</dd>
        <dt>Ontology version</dt><dd>{context.ontology_version_id}</dd>
        <dt>Intent</dt><dd>{intent}</dd>
        <dt>Objects in scope</dt><dd>{context.selected_object_ids.length ? context.selected_object_ids.join(', ') : 'All objects in the pinned document'}</dd>
        <dt>Image access</dt><dd>{grants.image ? 'Image authorized' : 'No image authorized'}</dd>
        <dt>Selected-object access</dt><dd>{grants.selected_objects ? 'Selected objects authorized' : 'No object details authorized'}</dd>
        <dt>Crop</dt><dd>{grants.crop ? `${grants.crop.x_min}, ${grants.crop.y_min} – ${grants.crop.x_max}, ${grants.crop.y_max}` : 'No crop authorized'}</dd>
        <dt>Instruction (sent only after you run)</dt><dd><q>{prompt}</q></dd>
      </dl>
      <label>
        <input type="checkbox" checked={confirmed} disabled={disabled} onChange={(event) => onChange(event.currentTarget.checked)} />
        I reviewed this exact scope and authorize this run.
      </label>
    </section>
  );
}
