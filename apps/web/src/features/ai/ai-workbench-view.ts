import type { ModelProfile } from '../../../../../packages/contracts/generated/ModelProfile';
import type { OntologyVersion } from '../../../../../packages/contracts/generated/OntologyVersion';
import type { RunContext } from '../../../../../packages/contracts/generated/RunContext';
import type { RunIntent } from '../../../../../packages/contracts/generated/RunIntent';
import type { AiConsentResponse } from '../../../../../packages/contracts/generated/AiConsentResponse';
import type { AiApprovedGrants } from '../../../../../packages/contracts/generated/AiApprovedGrants';
import type { RunController, RunControllerOptions, ConsentPreview, RunScope, CandidateEntry } from './run-controller';
import { createRunController } from './run-controller';
import { mountCandidatesView } from './candidates-view';
import { mountOutcomeView } from './outcome-view';
import { readonlyVisual } from './readonly-visual';
import { api, csrfToken } from '../../lib/t15/api';
import type { EditorPort } from '../workbench/editor-port';
import { reportError, selectedIds, sessionCurrent, type WorkspaceState } from '../workbench/workspace-state';
import { action, element, labeled, option } from '../workbench/view-elements';
import { createDialog } from '../../ui/dialog';

export interface AiWorkbenchView {
  refreshProfiles(): Promise<void>;
  getRunScope(): RunScope | null;
  dispose(): void;
}
export function mountAiWorkbenchView(root: HTMLElement, state: WorkspaceState, port: EditorPort, signal: AbortSignal, navigate: (url: URL) => void): AiWorkbenchView {
  const readSignal = AbortSignal.any([signal, state.readonlyRequests.signal]);
  root.dataset.testid = 'ai-panel'; root.setAttribute('aria-label', '工作台 AI 审校');
  const profiles = element('select'); profiles.dataset.testid = 'ai-provider'; const profileInfo = element('p');
  const rules = element('details'), ruleBody = element('div'); rules.append(element('summary', '本次固定类别规范'), ruleBody);
  const intent = element('select'); intent.setAttribute('aria-label', '运行任务'); for (const [value, text] of [['audit_attributes', '检查属性'], ['find_issues', '查找问题'], ['detect', '检测对象']]) intent.append(option(value, text));
  const prompt = element('textarea'); prompt.dataset.testid = 'ai-prompt'; prompt.rows = 4;
  const scopeText = element('p'), error = element('p'); error.setAttribute('role', 'alert');
  const access = element('details'), accessFields = element('fieldset'), cropFields = element('div'), scopeError = element('p');
  access.append(element('summary', '图像与对象访问范围'), accessFields); accessFields.append(element('legend', '本次请求的数据上限'));
  const allowImage = element('input'), allowObjects = element('input'), limitCrop = element('input');
  for (const input of [allowImage, allowObjects, limitCrop]) input.type = 'checkbox';
  allowImage.checked = allowObjects.checked = true;
  allowImage.dataset.testid = 'ai-allow-image'; allowObjects.dataset.testid = 'ai-allow-objects'; limitCrop.dataset.testid = 'ai-limit-crop';
  const cropInputs = { x_min: element('input'), y_min: element('input'), x_max: element('input'), y_max: element('input') };
  cropFields.className = 'r07-geometry-fields'; cropFields.hidden = true;
  for (const key of Object.keys(cropInputs) as (keyof typeof cropInputs)[]) {
    const input = cropInputs[key]; input.type = 'number'; input.min = '0'; input.step = '1'; input.inputMode = 'numeric'; input.dataset.testid = 'ai-crop-' + key.replace('_', '-');
    input.value = key.endsWith('min') ? '0' : '';
    cropFields.append(labeled(key + ' canonical 像素边界', input));
  }
  scopeError.setAttribute('role', 'alert'); scopeError.hidden = true;
  accessFields.append(labeled('允许读取图片', allowImage), labeled('允许读取固定对象详情', allowObjects), labeled('限制为 canonical 整数像素范围', limitCrop), cropFields, scopeError);
  let cropInitialized = false;
  const progress = element('section'); progress.setAttribute('aria-label', 'AI 运行进度'); progress.dataset.testid = 'ai-run-progress';
  const eventsRoot = element('ol'), progressText = element('p'); progressText.setAttribute('role', 'status'); progressText.dataset.testid = 'ai-status';
  eventsRoot.className = 'r07-ai-events';
  const modalRoot = root.closest('.r07-workbench') ?? root;
  const consentDialog = createDialog({ id: 'ai-consent-dialog', title: '确认本次授权', testId: 'ai-consent', signal, fallbackFocus: () => modalRoot.querySelector<HTMLElement>('[data-testid="toggle-ai"]') });
  const consent = consentDialog.element;
  consent.classList.add('r07-ai-consent');
  const consentHeading = consent.querySelector('h2')!; consentHeading.tabIndex = -1; consentHeading.setAttribute('autofocus', '');
  const checked = element('input'); checked.type = 'checkbox';
  const consentBody = element('div', undefined, 'r07-ai-consent-content'), consentProvider = element('p');
  const consentNotice = element('p', '费用未知；取消运行不保证退款。');
  const candidatesRoot = element('section'); candidatesRoot.setAttribute('aria-label', 'AI 建议与问题'); const outcomeRoot = element('section');
  let profileList: readonly ModelProfile[] = [], controller: RunController | null = null, disposeControllerSubscription: (() => void) | null = null;
  let lastReady: { context: RunContext; ontology: OntologyVersion } | null = null, preview: ConsentPreview | null = null, previewIdentity: string | null = null;
  let preparing = false, preparation = 0, decisionRevision = 0, disposed = false, previousEvents: unknown = null, currentOptions: RunControllerOptions | null = null;
  let profileRead: AbortController | null = null, candidates: { update(entries: readonly CandidateEntry[]): void; dispose(): void } | null = null;
  let lastWaiting = false, lastRun: RunScope | null = null;
  let hashedHost = state.host, hashedGeneration: number | null | undefined, objectHashes: Record<string, string> = {}, selectedProjection: readonly string[] = [], ruleOntology: OntologyVersion | null = null;
  const outcome = mountOutcomeView(outcomeRoot, { signal: readSignal, isCurrent: () => sessionCurrent(state), navigate });
  function syncModalState() {
    const modal = !!modalRoot.querySelector('dialog[open]');
    if (state.modal !== modal) { state.modal = modal; state.notify(); }
  }
  const invalidatePreview = () => { preparation++; preview = null; previewIdentity = null; checked.checked = false; consentDialog.close(); syncModalState(); };
  function requestedGrants(): AiApprovedGrants | null {
    const grants: AiApprovedGrants = { allow_image: allowImage.checked, allow_object_context: allowObjects.checked, preview_crop: null };
    if (!grants.allow_image || !limitCrop.checked) return grants;
    const media = state.loaded?.media, xMin = cropInputs.x_min.valueAsNumber, yMin = cropInputs.y_min.valueAsNumber, xMax = cropInputs.x_max.valueAsNumber, yMax = cropInputs.y_max.valueAsNumber;
    if (!media || ![xMin, yMin, xMax, yMax].every(Number.isSafeInteger) || xMin < 0 || yMin < 0 || xMax <= xMin || yMax <= yMin || xMax > media.canonical_width || yMax > media.canonical_height) return null;
    grants.preview_crop = { type: 'bbox_xyxy', x_min: xMin, y_min: yMin, x_max: xMax, y_max: yMax };
    return grants;
  }
  function options(): RunControllerOptions | null {
    const loaded = state.loaded, host = port.getReadHost(), generation = host?.getGeneration(), selected = selectedIds(state);
    if (loaded && host && generation !== null && generation !== undefined) {
      const hostChanged = hashedHost !== host || hashedGeneration !== generation;
      if (hostChanged) { hashedHost = host; hashedGeneration = generation; objectHashes = host.getObjectHashes() ?? {}; }
      const revision = state.queue.getStatus(state.assetId).base_revision_id ?? loaded.revision.annotation_revision_id;
      if (hostChanged || !lastReady || lastReady.ontology !== loaded.ontology || lastReady.context.annotation_revision_id !== revision || selectedProjection !== selected) {
        selectedProjection = selected;
        lastReady = { ontology: loaded.ontology, context: { project_id: state.projectId, asset_revision_id: state.assetId, annotation_revision_id: revision,
          ontology_version_id: loaded.ontology.ontology_version_id, draft_generation: generation, canonical_sha256: loaded.media.canonical_sha256,
          selected_object_ids: [...selected], object_hashes: objectHashes, input_fingerprint: '' } };
      }
    }
    const grants = requestedGrants();
    if (!lastReady || !grants) return null;
    const fixed = lastReady, asset = state.assetId, crop = grants.preview_crop, previousCrop = currentOptions?.grants.preview_crop;
    const selectedProfile = profileList.find(profile => profile.profile_id === profiles.value) ?? null;
    if (currentOptions?.context === fixed.context && currentOptions.ontology === fixed.ontology && currentOptions.asset_revision_id === asset
      && currentOptions.profile === selectedProfile && currentOptions.intent === intent.value && currentOptions.prompt === prompt.value && currentOptions.csrfToken === csrfToken()
      && currentOptions.grants.allow_image === grants.allow_image && currentOptions.grants.allow_object_context === grants.allow_object_context
      && previousCrop?.x_min === crop?.x_min && previousCrop?.y_min === crop?.y_min && previousCrop?.x_max === crop?.x_max && previousCrop?.y_max === crop?.y_max) return currentOptions;
    return { asset_revision_id: asset, profile: selectedProfile, context: fixed.context, ontology: fixed.ontology,
      intent: intent.value as RunIntent, prompt: prompt.value, grants, saveQueue: state.queue, csrfToken: csrfToken(),
      dispatch: command => port.dispatch(command), getDocument: port.getSnapshot, getGeneration: () => port.getReadHost()?.getGeneration() ?? null,
      refreshContext(snapshot) {
        const loaded = state.loaded, host = port.getHost();
        if (!loaded || !host || loaded.media.asset_revision_id !== asset || state.assetId !== asset || snapshot.document.asset_revision_id !== asset
          || snapshot.document.ontology_version_id !== loaded.ontology.ontology_version_id || snapshot.generation !== host.getGeneration()) throw new Error('准备授权期间图片或标注已变化。');
        const hashes = host.getObjectHashes(); if (!hashes) throw new Error('无法确认对象版本。');
        return { project_id: state.projectId, asset_revision_id: asset, annotation_revision_id: snapshot.annotation_revision_id, ontology_version_id: loaded.ontology.ontology_version_id,
          draft_generation: snapshot.generation, canonical_sha256: loaded.media.canonical_sha256, selected_object_ids: [...selectedIds(state)], object_hashes: hashes, input_fingerprint: '' };
      },
      async obtainConsent(value) {
        if (!port.getHost() || !sessionCurrent(state)) throw new Error('当前身份、权限或编辑范围不允许授权。');
        const result = await api.request<AiConsentResponse>('/api/ai/consents', { method: 'POST', body: JSON.stringify({ preview_id: value.preview_id }) });
        return result.consent_id;
      },
    };
  }
  function activeIdentity(value: RunControllerOptions): string {
    return JSON.stringify([state.scope === previewScope, value.asset_revision_id, value.context, value.ontology, value.profile, value.intent, value.prompt, value.grants, value.getGeneration()]);
  }
  let previewScope: object | null = null;
  const run = action('确认运行范围', 'ai-run', signal, () => {
    if (!controller || preparing || !port.getHost() || !sessionCurrent(state)) return;
    invalidatePreview(); const epoch = preparation; preparing = true; previewScope = state.scope; updateControls();
    void controller.preparePreview().then(value => {
      if (disposed || epoch !== preparation || previewScope !== state.scope || !value || !port.getHost()) return;
      preview = value; const next = options(); if (!next) return; previewIdentity = activeIdentity(next);
      consentBody.replaceChildren(); const visualColumn = element('div');
      const provider = value.profile.provider_id;
      consentProvider.textContent = provider === 'detector_local' ? '本地检测：授权图像只在本机检测进程与本地权重之间处理。' : provider === 'mock' ? '模拟渠道，不是真实模型。' : provider === 'claude_local' ? '启动官方 native 客户端；授权内容可流向官方远端服务，本地启动不等于本地推理。' : '外部 API：授权指令、图像范围与对象详情将经服务端发送到 ' + provider + '。';
      const frozen = controller!.getPreviewSnapshot(value.preview_id);
      if (value.grants.allow_image) {
        const visual = readonlyVisual(frozen?.document ?? null, value.context.asset_revision_id, value.grants.preview_crop ? [value.grants.preview_crop] : [], [], false, value.grants.preview_crop ?? undefined);
        const caption = visual.querySelector('figcaption');
        if (caption) caption.textContent = value.grants.preview_crop ? '服务端实际授权 crop，仅此原始 canonical 像素范围；只读 SVG，不是编辑器。' : '服务端实际授权整张 canonical 图片；只读 SVG，不是编辑器。';
        visualColumn.append(visual);
      } else visualColumn.append(element('p', '服务器未授权读取图像。'));
      const dl = element('dl');
      for (const [label, text] of [['服务商 / 完整 model_id', provider + ' · ' + value.profile.model_id], ['项目', value.context.project_id], ['图片版本', value.context.asset_revision_id], ['标注版本', value.context.annotation_revision_id], ['规范版本', value.context.ontology_version_id],
        ['图片访问', value.grants.allow_image ? value.grants.preview_crop ? JSON.stringify(value.grants.preview_crop) : '整张 canonical 图片' : '不读取图片'], ['对象详情', value.grants.allow_object_context ? value.context.selected_object_ids.length ? value.context.selected_object_ids.join(', ') : '固定版本全部对象' : '不读取对象详情'], ['有效期', value.expires_at], ['指令', value.prompt]]) dl.append(element('dt', label), element('dd', text));
      consentBody.append(visualColumn, dl);
      if (value.grants.allow_object_context && frozen) for (const object of frozen.document.objects) if (!value.context.selected_object_ids.length || value.context.selected_object_ids.includes(object.object_id)) visualColumn.append(element('p', object.object_id + ': ' + JSON.stringify(object.attributes)));
      checked.checked = false; consentDialog.open(run); port.cancelGesture(); syncModalState();
    }).catch(reason => { if (!disposed) error.textContent = reportError(reason); }).finally(() => { preparing = false; if (!disposed) updateControls(); });
  });
  const authorize = action('授权并开始', 'ai-authorize', signal, () => {
    const next = options();
    if (!controller || !preview || !checked.checked || !next || previewIdentity !== activeIdentity(next) || !port.getHost() || preparing) return;
    const fixed = preview; checked.checked = false; preview = null; previewIdentity = null; consentDialog.close(); syncModalState();
    void controller.run(fixed);
  });
  const cancelPreview = consent.querySelector<HTMLButtonElement>('button')!;
  cancelPreview.textContent = '取消授权预览'; cancelPreview.dataset.testid = 'ai-consent-cancel';
  cancelPreview.addEventListener('click', invalidatePreview, { signal });
  consent.addEventListener('cancel', invalidatePreview, { signal });
  consent.addEventListener('close', () => { if (!consent.open) invalidatePreview(); }, { signal });
  const cancel = action('取消运行', 'ai-cancel', signal, () => { if (sessionCurrent(state)) void controller?.cancel(); });
  const consentActions = element('div', undefined, 'r07-button-row'); consentActions.append(authorize, cancelPreview);
  consentDialog.content.append(consentNotice, consentProvider, consentBody, labeled('我已确认以上范围，同意本次运行。仅本次授权；范围变化或过期后须重新确认。', checked), consentActions);
  modalRoot.append(consent);
  progress.append(progressText, eventsRoot, element('p', '用量缺席仍为未知；取消不保证停止上游费用。'), cancel);
  const refreshProfiles = async () => {
    if (!sessionCurrent(state)) return;
    profileRead?.abort(); const read = new AbortController(); profileRead = read;
    try {
      const result = await api.request<{ items: ModelProfile[] }>('/api/model-profiles', { signal: AbortSignal.any([readSignal, read.signal]) });
      if (disposed || read.signal.aborted || !sessionCurrent(state)) return;
      profileList = result.items.filter(profile => profile.provider_id !== 'codex_local');
      const selected = profiles.value;
      profiles.replaceChildren(option('', '请选择服务端模型预设'));
      for (const profile of profileList) profiles.append(option(profile.profile_id, profile.provider_id + ' · ' + profile.model_id));
      profiles.value = profileList.some(profile => profile.profile_id === selected) ? selected : '';
      error.textContent = ''; update();
    } catch (reason) { if (!read.signal.aborted && !disposed) error.textContent = '模型列表读取失败；人工标注可继续：' + reportError(reason); }
  };
  root.append(element('h2', 'AI 审校'), rules, labeled('模型预设', profiles), profileInfo, action('只读重新检查模型列表', 'ai-profiles-refresh', signal, () => void refreshProfiles()), labeled('任务', intent), labeled('指令', prompt), access, scopeText, run, error, progress, candidatesRoot, outcomeRoot);
  function updateControls() {
    const snapshot = controller?.getSnapshot(), profile = profileList.find(item => item.profile_id === profiles.value);
    if (ruleOntology !== state.loaded?.ontology) {
      ruleOntology = state.loaded?.ontology ?? null; ruleBody.replaceChildren();
      if (ruleOntology) {
        ruleBody.append(element('h3', '规范第 ' + ruleOntology.version_no + ' 版'), element('pre', ruleOntology.guidelines_markdown));
        for (const label of ruleOntology.labels) {
          ruleBody.append(element('h4', label.name), element('p', '允许形状：' + label.allowed_geometry_types.join('、')));
          for (const attribute of label.attributes) ruleBody.append(element('p', attribute.key + ' · ' + attribute.kind + ' · ' + (attribute.required ? '必填键' : '选填') + ' · 默认 ' + JSON.stringify(attribute.default_value) + (attribute.enum_values.length ? ' · ' + attribute.enum_values.join('、') : '') + ' · 范围 ' + (attribute.min ?? '无下限') + ' / ' + (attribute.max ?? '无上限')));
        }
      }
    }
    profileInfo.textContent = profile ? 'model_id: ' + profile.model_id + ' · ' + profile.availability + ' · ' + profile.verification + (profile.runtime_version ? ' · ' + profile.runtime_version : '') + '。配置就绪不代表真实运行已验证。' : '暂无选定模型。人工标注不依赖 AI 配置；本页不接收 token、私有路径或命令。';
    const grants = requestedGrants();
    run.disabled = preparing || !!snapshot?.busy || !port.getHost() || !profile || profile.availability !== 'ready' || !prompt.value.trim() || !grants;
    profiles.disabled = intent.disabled = prompt.disabled = allowImage.disabled = allowObjects.disabled = preparing || !!snapshot?.busy;
    limitCrop.disabled = preparing || !!snapshot?.busy || !allowImage.checked;
    cropFields.hidden = !allowImage.checked || !limitCrop.checked;
    for (const input of Object.values(cropInputs)) { input.disabled = preparing || !!snapshot?.busy || cropFields.hidden; input.setAttribute('aria-invalid', String(!grants)); }
    scopeError.hidden = !!grants; scopeError.textContent = grants ? '' : '图像范围必须是当前 canonical 图片内的有效整数像素边界；不会提交无效范围或改为整图。';
    authorize.disabled = !checked.checked || !preview || !port.getHost() || preparing || !!snapshot?.busy || !grants;
    scopeText.textContent = '固定对象范围：' + (selectedIds(state).length ? selectedIds(state).length + ' 个所选对象' : '此版本全部对象') + '；图片及 crop 以服务端授权预览为准。';
    cancel.disabled = !sessionCurrent(state) || !snapshot?.runId || snapshot.events.some(event => ['succeeded', 'failed', 'cancelled'].includes(event.type));
  }
  function updateRun() {
    if (!controller || disposed) return;
    const snapshot = controller.getSnapshot();
    if (lastWaiting !== snapshot.modelWaiting) { lastWaiting = snapshot.modelWaiting; state.activity.setKind(lastWaiting ? 'model_wait' : 'task'); }
    if (lastRun !== snapshot.runScope) { lastRun = snapshot.runScope; state.activity.setBinding({}); state.notify(); }
    progressText.textContent = snapshot.runId ? '运行 ' + snapshot.runId + ' · ' + (snapshot.events.at(-1)?.type ?? '等待运行') : '尚未启动运行';
    if (previousEvents !== snapshot.events) {
      previousEvents = snapshot.events; eventsRoot.replaceChildren();
      for (const event of snapshot.events) {
        const row = element('li'); row.append(element('span', event.seq + ' · ' + event.type + ' · ' + event.message));
        if (event.data !== null) { const details = element('details'); details.append(element('summary', '查看事件详情'), element('pre', JSON.stringify(event.data, null, 2))); row.append(details); }
        eventsRoot.append(row);
      }
    }
    if (snapshot.error) error.textContent = snapshot.error;
    if (snapshot.savedMessage) progressText.textContent += ' · ' + snapshot.savedMessage;
    candidates?.update(snapshot.candidates);
    const savedRevision = snapshot.runScope ? state.queue.getStatus(snapshot.runScope.assetRevisionId).base_revision_id : null;
    outcome.update(snapshot.runId, JSON.stringify([snapshot.events.at(-1)?.seq, snapshot.savedMessage, decisionRevision, savedRevision]));
    updateControls();
  }
  function update() {
    if (disposed) return;
    if (!sessionCurrent(state)) { invalidatePreview(); profileRead?.abort(); controller?.dispose(); candidates?.update(controller?.getSnapshot().candidates ?? []); updateControls(); return; }
    const next = options();
    if (preview && (!next || previewIdentity !== activeIdentity(next))) invalidatePreview();
    if (next) {
      const changed = currentOptions !== next; currentOptions = next;
      if (!controller) {
        controller = createRunController(next);
        candidates = mountCandidatesView(candidatesRoot, { signal: readSignal, controller, getScope: () => ({ assetId: state.assetId, context: currentOptions!.context, generation: port.getReadHost()?.getGeneration() ?? -1, writable: !!port.getHost(), current: sessionCurrent(state) }),
          focusRegion: bounds => port.getReadHost()?.focusRegion(bounds) ?? false, onDecisionRecorded() { decisionRevision++; updateRun(); } });
        disposeControllerSubscription = controller.subscribe(updateRun);
      } else if (changed) controller.update(next);
    }
    updateRun(); updateControls();
  }
  for (const input of [profiles, intent, prompt]) input.addEventListener(input === prompt ? 'input' : 'change', () => { invalidatePreview(); update(); }, { signal });
  for (const input of [allowImage, allowObjects, limitCrop, ...Object.values(cropInputs)]) input.addEventListener(input.type === 'number' ? 'input' : 'change', () => {
    if (limitCrop.checked && !cropInitialized && state.loaded) {
      cropInputs.x_max.value = String(state.loaded.media.canonical_width); cropInputs.y_max.value = String(state.loaded.media.canonical_height); cropInitialized = true;
    }
    invalidatePreview(); update();
  }, { signal });
  checked.addEventListener('change', updateControls, { signal });
  const unsubscribe = state.subscribe(update);
  function dispose() { if (disposed) return; disposed = true; profileRead?.abort(); unsubscribe(); disposeControllerSubscription?.(); candidates?.dispose(); outcome.dispose(); controller?.dispose(); consentDialog.dispose(); syncModalState(); }
  signal.addEventListener('abort', dispose, { once: true }); update(); void refreshProfiles();
  return { refreshProfiles, getRunScope: () => controller?.getSnapshot().runScope ?? null, dispose };
}
