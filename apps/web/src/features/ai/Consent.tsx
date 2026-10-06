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
        <dt>Objects in scope</dt><dd>{!grants.allow_object_context ? 'No object details' : context.selected_object_ids.length ? context.selected_object_ids.join(', ') : 'All objects in the pinned document'}</dd>
        <dt>Image access</dt><dd>{grants.allow_image ? 'Image authorized' : 'No image authorized'}</dd>
        <dt>Object-context access</dt><dd>{!grants.allow_object_context ? 'No object details authorized' : context.selected_object_ids.length ? 'Selected objects authorized' : 'All pinned objects authorized'}</dd>
        <dt>Image region</dt><dd>{grants.preview_crop ? `${grants.preview_crop.x_min}, ${grants.preview_crop.y_min} – ${grants.preview_crop.x_max}, ${grants.preview_crop.y_max}` : grants.allow_image ? 'Full canonical image' : 'No pixels'}</dd>
        <dt>Server preview expires</dt><dd>{preview.expires_at}</dd>
        <dt>Instruction (provider receives only after authorization)</dt><dd><q>{prompt}</q></dd>
      </dl>
      <label>
        <input type="checkbox" checked={confirmed} disabled={disabled} onChange={(event) => onChange(event.currentTarget.checked)} />
        I reviewed this exact scope and authorize this run.
      </label>
    </section>
  );
}
