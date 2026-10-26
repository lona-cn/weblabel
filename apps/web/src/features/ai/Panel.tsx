import type { BBox } from '../../../../../packages/contracts/generated/BBox';
import { useEffect, useRef, useState } from 'react';
import type { ModelProfile } from '../../../../../packages/contracts/generated/ModelProfile';
import type { RunContext } from '../../../../../packages/contracts/generated/RunContext';
import type { RunIntent } from '../../../../../packages/contracts/generated/RunIntent';
import type { AnnotationDocument } from '../../../../../packages/contracts/generated/AnnotationDocument';
import type { EditorCommand } from '../../../../../packages/contracts/generated/EditorCommand';
import type { EditorDelta } from '../../../../../packages/contracts/generated/EditorDelta';
import type { SaveQueue } from '../../lib/persistence/save-queue';
import type { OntologyVersion } from '../../../../../packages/contracts/generated/OntologyVersion';
import { CandidateList } from './CandidateList';
import { Consent } from './Consent';
import { ProviderPicker } from './ProviderPicker';
import { RunProgress } from './RunProgress';
import { useRun } from './useRun';
import type { ConsentPreview, RunApi, RunScope } from './run-controller';
import { OutcomeSummary } from './OutcomeSummary';

export function Panel({ asset_revision_id, profiles, context, ontology, getDocument, getGeneration, generation, dispatch, saveQueue, obtainConsent, refreshContext, grants, api, csrfToken, intent: initialIntent = 'audit_attributes', onModelWaitingChange, onFocusRegion, onRunScopeChange }: {
  asset_revision_id: string;
  profiles: readonly ModelProfile[];
  context: RunContext;
  ontology: OntologyVersion;
  getDocument: () => AnnotationDocument | null;
  getGeneration: () => number | null;
  generation: number;
  dispatch: (command: EditorCommand) => EditorDelta | null;
  saveQueue?: SaveQueue;
  obtainConsent?: (preview: ConsentPreview) => Promise<string>;
  refreshContext: (snapshot: { document: AnnotationDocument; generation: number; annotation_revision_id: string }) => RunContext | Promise<RunContext>;
  grants: ConsentPreview['grants'];
  csrfToken?: string | null;
  api?: RunApi;
  intent?: RunIntent;
  onModelWaitingChange?: (waiting: boolean) => void;
  onFocusRegion?: (bounds: BBox) => boolean;
  onRunScopeChange?: (scope: RunScope | null) => void;
}) {
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(profiles[0]?.provider_id === 'codex_local' ? null : profiles[0]?.profile_id ?? null);
  const [intent, setIntent] = useState<RunIntent>(initialIntent);
  const profile = profiles.find((item) => item.profile_id === selectedProfileId) ?? null;
  useEffect(() => {
    if (!profiles.some((item) => item.profile_id === selectedProfileId)) setSelectedProfileId(null);
  }, [profiles, selectedProfileId]);
  const [prompt, setPrompt] = useState('');
  const [confirmedPreviewKey, setConfirmedPreviewKey] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const contextKey = JSON.stringify([context.project_id, context.asset_revision_id, context.ontology_version_id, context.selected_object_ids, context.object_hashes]);
  const [preview, setPreview] = useState<ConsentPreview | null>(null);
  const [previewVisual, setPreviewVisual] = useState<{ document: AnnotationDocument; ontology: OntologyVersion } | null>(null);
  const [decisionRevision, setDecisionRevision] = useState(0);
  const preparation = useRef(0);
  const [preparingScope, setPreparingScope] = useState(false);
  useEffect(() => {
    preparation.current += 1;
    setPreviewVisual(null);
    setPreview(null);
    setPreviewOpen(false);
    setConfirmedPreviewKey(null);
  }, [contextKey, generation, prompt, intent, JSON.stringify(profile), JSON.stringify(ontology), JSON.stringify(grants)]);
  const controller = useRun({
    asset_revision_id, profile, context, ontology, intent, prompt, grants, obtainConsent, dispatch,
    getDocument,
    getGeneration,
    refreshContext,
    saveQueue,
    csrfToken,
    api,
  });
  useEffect(() => { onModelWaitingChange?.(controller.modelWaiting); }, [controller.modelWaiting, onModelWaitingChange]);
  useEffect(() => () => onModelWaitingChange?.(false), [onModelWaitingChange]);
  useEffect(() => { onRunScopeChange?.(controller.runScope); }, [controller.runScope, onRunScopeChange]);
  useEffect(() => () => onRunScopeChange?.(null), [onRunScopeChange]);
  const previewKey = preview === null ? null : JSON.stringify(preview);
  const consentChecked = previewKey !== null && confirmedPreviewKey === previewKey;

  const startRun = async () => {
    const epoch = ++preparation.current;
    setPreparingScope(true);
    setPreviewOpen(false);
    setConfirmedPreviewKey(null);
    try {
      const refreshed = await controller.preparePreview();
      if (refreshed && epoch === preparation.current) {
        setPreviewVisual(controller.getPreviewSnapshot(refreshed.preview_id));
        setPreview(refreshed);
        setPreviewOpen(true);
      }
    } finally {
      setPreparingScope(false);
    }
  };
  const authorizeAndRun = async () => {
    if (!consentChecked || !previewKey) return;
    if (!preview) return;
    await controller.run(preview);
    setPreviewOpen(false);
    setConfirmedPreviewKey(null);
  };


  return (
    <aside className="ai-panel" aria-label="AI 审校面板" data-testid="ai-panel">
      <details className="ai-rules"><summary>类别规范</summary><section aria-label="本次类别规范">
        <h3>类别规范第 {ontology.version_no} 版</h3>
        <pre>{ontology.guidelines_markdown}</pre>
        {ontology.labels.map((label) => <div key={label.label_id}>
          <h4>{label.name}</h4>
          <p>允许形状： {label.allowed_geometry_types.map((kind) => ({ bbox_xyxy: '矩形', polygon: '多边形', rotated_box: '旋转框' }[kind] ?? kind)).join('、')}</p>
          {label.attributes.map((attribute) => <p key={attribute.key}>{attribute.key} · {{ text: '文本', number: '数值', boolean: '开关', enum: '选项' }[attribute.kind]} · {attribute.required ? '必填' : '选填'}{attribute.default_value !== null ? ` · 默认值 ${JSON.stringify(attribute.default_value)}` : ''}{attribute.enum_values?.length ? ` · 选项 ${attribute.enum_values.join('、')}` : ''}{attribute.min !== null ? ` · 最小值 ${attribute.min}` : ''}{attribute.max !== null ? ` · 最大值 ${attribute.max}` : ''}</p>)}
        </div>)}
      </section></details>
      <ProviderPicker profiles={profiles} selected={profile?.profile_id ?? null} disabled={controller.busy || preparingScope} onSelect={(next) => { setSelectedProfileId(next.profile_id); setConfirmedPreviewKey(null); setPreviewOpen(false); }} />
      <label htmlFor="ai-intent">任务</label>
      <select id="ai-intent" value={intent} disabled={controller.busy || preparingScope} onChange={(event) => { setIntent(event.currentTarget.value as RunIntent); setConfirmedPreviewKey(null); setPreviewOpen(false); }} aria-label="运行任务">
        <option value="audit_attributes">检查属性</option><option value="find_issues">查找问题</option><option value="detect">检测对象</option>
      </select>
      <label htmlFor="ai-prompt">指令</label>
      <textarea id="ai-prompt" data-testid="ai-prompt" value={prompt} onChange={(event) => { setPrompt(event.currentTarget.value); setConfirmedPreviewKey(null); }} disabled={controller.busy || preparingScope} rows={4} />
      <p>对象范围：{context.selected_object_ids.length ? `${context.selected_object_ids.length} 个所选对象` : '当前版本的全部对象'}；图片与对象详情以授权预览为准。</p>
      <button type="button" data-testid="ai-run" disabled={controller.busy || preparingScope || !profile || prompt.trim().length === 0 || context.asset_revision_id !== asset_revision_id} onClick={() => void startRun()}>{preparingScope ? '正在同步并确认范围…' : '确认运行范围'}</button>
      {previewOpen && preview ? <>
        <Consent preview={preview} document={previewVisual?.document ?? null} ontology={previewVisual?.ontology ?? null} confirmed={consentChecked} onChange={(checked) => setConfirmedPreviewKey(checked ? previewKey : null)} />
        <button type="button" data-testid="ai-authorize" disabled={!consentChecked || controller.busy || preparingScope || !obtainConsent} onClick={() => void authorizeAndRun()}>授权并开始</button>
      </> : null}
      {controller.error ? <div role="alert"><p>{controller.error.replace(/^[A-Z_0-9]+:\s*/, '').split('格式不正确：')[0] + (controller.error.includes('格式不正确：') ? '格式不正确，请重试。' : '')}</p><details><summary>错误详情</summary>{controller.error}</details></div> : null}
      {controller.savedMessage ? <p role="status">{controller.savedMessage}</p> : null}
      <RunProgress runId={controller.runId} events={controller.events} busy={controller.busy} onCancel={() => void controller.cancel()} />
      {onFocusRegion ? <p>定位主画布仅改变视图；不会采纳建议或修改标注。</p> : null}
      <CandidateList entries={controller.candidates} activeAsset={asset_revision_id} activeContext={context} activeGeneration={generation} busy={controller.busy} onFocusRegion={onFocusRegion} onDecisionRecorded={() => setDecisionRevision(value => value + 1)} onAccept={(entry, changeIds, rejectedIds) => void controller.acceptSelected(entry.candidate, entry.asset_revision_id, changeIds, entry.schema_error, rejectedIds)} />
      {controller.runId ? <OutcomeSummary runId={controller.runId} refreshKey={JSON.stringify([controller.events.at(-1)?.seq, controller.savedMessage, decisionRevision])} /> : null}
    </aside>
  );
}
