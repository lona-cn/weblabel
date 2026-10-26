import type { ModelProfile } from '../../../../../packages/contracts/generated/ModelProfile';
import type { OntologyVersion } from '../../../../../packages/contracts/generated/OntologyVersion';
import type { RunContext } from '../../../../../packages/contracts/generated/RunContext';
import type { RunIntent } from '../../../../../packages/contracts/generated/RunIntent';
import type { AiConsentResponse } from '../../../../../packages/contracts/generated/AiConsentResponse';
import type { RunController, RunControllerOptions, ConsentPreview, RunScope, CandidateEntry } from './run-controller';
import { createRunController } from './run-controller';
import { mountCandidatesView } from './candidates-view';
import { mountOutcomeView } from './outcome-view';
import { readonlyVisual } from './readonly-visual';
import { api, csrfToken } from '../../lib/t15/api';
import type { EditorPort } from '../workbench/editor-port';
import { reportError, selectedIds, sessionCurrent, type WorkspaceState } from '../workbench/workspace-state';
import { action, element, labeled, option } from '../workbench/view-elements';

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
  const progress = element('section'); progress.setAttribute('aria-label', 'AI 运行进度'); progress.dataset.testid = 'ai-run-progress';
  const eventsRoot = element('ol'), progressText = element('p'); progressText.setAttribute('role', 'status'); progressText.dataset.testid = 'ai-status';
  const consent = element('section'); consent.dataset.testid = 'ai-consent'; consent.hidden = true;
  const checked = element('input'); checked.type = 'checkbox'; const consentBody = element('div');
  const candidatesRoot = element('section'); candidatesRoot.setAttribute('aria-label', 'AI 建议与问题'); const outcomeRoot = element('section');
  let profileList: readonly ModelProfile[] = [], controller: RunController | null = null, disposeControllerSubscription: (() => void) | null = null;
  let lastReady: { context: RunContext; ontology: OntologyVersion } | null = null, preview: ConsentPreview | null = null, previewIdentity: string | null = null;
  let preparing = false, preparation = 0, decisionRevision = 0, disposed = false, previousEvents: unknown = null, currentOptions: RunControllerOptions | null = null;
  let profileRead: AbortController | null = null, candidates: { update(entries: readonly CandidateEntry[]): void; dispose(): void } | null = null;
  let lastWaiting = false, lastRun: RunScope | null = null;
  let hashedHost = state.host, hashedGeneration: number | null | undefined, objectHashes: Record<string, string> = {}, selectedProjection: readonly string[] = [], ruleOntology: OntologyVersion | null = null;
  const outcome = mountOutcomeView(outcomeRoot, { signal: readSignal, isCurrent: () => sessionCurrent(state), navigate });
  const invalidatePreview = () => { preparation++; preview = null; previewIdentity = null; checked.checked = false; consent.hidden = true; };
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
    if (!lastReady) return null;
    const fixed = lastReady, asset = state.assetId;
    const selectedProfile = profileList.find(profile => profile.profile_id === profiles.value) ?? null;
    if (currentOptions?.context === fixed.context && currentOptions.ontology === fixed.ontology && currentOptions.asset_revision_id === asset
      && currentOptions.profile === selectedProfile && currentOptions.intent === intent.value && currentOptions.prompt === prompt.value && currentOptions.csrfToken === csrfToken()) return currentOptions;
    return { asset_revision_id: asset, profile: selectedProfile, context: fixed.context, ontology: fixed.ontology,
      intent: intent.value as RunIntent, prompt: prompt.value, grants: { allow_image: true, allow_object_context: true, preview_crop: null }, saveQueue: state.queue, csrfToken: csrfToken(),
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
      consentBody.replaceChildren(element('h3', '确认本次授权'), element('p', '费用未知；取消运行不保证退款。'));
      const provider = value.profile.provider_id;
      consentBody.append(element('p', provider === 'detector_local' ? '本地检测：授权图像只在本机检测进程与本地权重之间处理。' : provider === 'mock' ? '模拟渠道，不是真实模型。' : provider === 'claude_local' ? '启动官方 native 客户端；授权内容可流向官方远端服务，本地启动不等于本地推理。' : '外部 API：授权指令、图像范围与对象详情将经服务端发送到 ' + provider + '。'));
      const frozen = controller!.getPreviewSnapshot(value.preview_id);
      if (value.grants.allow_image) {
        const visual = readonlyVisual(frozen?.document ?? null, value.context.asset_revision_id, value.grants.preview_crop ? [value.grants.preview_crop] : [], [], false, value.grants.preview_crop ?? undefined);
        const caption = visual.querySelector('figcaption');
        if (caption) caption.textContent = value.grants.preview_crop ? '服务端实际授权 crop，仅此原始 canonical 像素范围；只读 SVG，不是编辑器。' : '服务端实际授权整张 canonical 图片；只读 SVG，不是编辑器。';
        consentBody.append(visual);
      } else consentBody.append(element('p', '服务器未授权读取图像。'));
      const dl = element('dl');
      for (const [label, text] of [['服务商 / 完整 model_id', provider + ' · ' + value.profile.model_id], ['项目', value.context.project_id], ['图片版本', value.context.asset_revision_id], ['标注版本', value.context.annotation_revision_id], ['规范版本', value.context.ontology_version_id],
        ['图片访问', value.grants.allow_image ? value.grants.preview_crop ? JSON.stringify(value.grants.preview_crop) : '整张 canonical 图片' : '不读取图片'], ['对象详情', value.grants.allow_object_context ? value.context.selected_object_ids.length ? value.context.selected_object_ids.join(', ') : '固定版本全部对象' : '不读取对象详情'], ['有效期', value.expires_at], ['指令', value.prompt]]) dl.append(element('dt', label), element('dd', text));
      consentBody.append(dl);
      if (value.grants.allow_object_context && frozen) for (const object of frozen.document.objects) if (!value.context.selected_object_ids.length || value.context.selected_object_ids.includes(object.object_id)) consentBody.append(element('p', object.object_id + ': ' + JSON.stringify(object.attributes)));
      consent.hidden = false; checked.checked = false;
    }).catch(reason => { if (!disposed) error.textContent = reportError(reason); }).finally(() => { preparing = false; if (!disposed) updateControls(); });
  });
  const authorize = action('授权并开始', 'ai-authorize', signal, () => {
    const next = options();
    if (!controller || !preview || !checked.checked || !next || previewIdentity !== activeIdentity(next) || !port.getHost() || preparing) return;
    const fixed = preview; checked.checked = false; consent.hidden = true; preview = null;
    void controller.run(fixed);
  });
  const cancelPreview = action('取消授权预览', 'ai-consent-cancel', signal, invalidatePreview);
  const cancel = action('取消运行', 'ai-cancel', signal, () => { if (sessionCurrent(state)) void controller?.cancel(); });
  consent.append(consentBody, labeled('我已确认以上范围，同意本次运行。仅本次授权；范围变化或过期后须重新确认。', checked), authorize, cancelPreview);
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
  root.append(element('h2', 'AI 审校'), rules, labeled('模型预设', profiles), profileInfo, action('只读重新检查模型列表', 'ai-profiles-refresh', signal, () => void refreshProfiles()), labeled('任务', intent), labeled('指令', prompt), scopeText, run, consent, error, progress, candidatesRoot, outcomeRoot);
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
    run.disabled = preparing || !!snapshot?.busy || !port.getHost() || !profile || profile.availability !== 'ready' || !prompt.value.trim();
    profiles.disabled = intent.disabled = prompt.disabled = preparing || !!snapshot?.busy;
    authorize.disabled = !checked.checked || !preview || !port.getHost() || preparing || !!snapshot?.busy;
    scopeText.textContent = '固定对象范围：' + (selectedIds(state).length ? selectedIds(state).length + ' 个所选对象' : '此版本全部对象') + '；图片及 crop 以服务端授权预览为准。';
    cancel.disabled = !sessionCurrent(state) || !snapshot?.runId || snapshot.events.some(event => ['succeeded', 'failed', 'cancelled'].includes(event.type));
  }
  function updateRun() {
    if (!controller || disposed) return;
    const snapshot = controller.getSnapshot();
    if (lastWaiting !== snapshot.modelWaiting) { lastWaiting = snapshot.modelWaiting; state.activity.setKind(lastWaiting ? 'model_wait' : 'task'); }
    if (lastRun !== snapshot.runScope) { lastRun = snapshot.runScope; state.activity.setBinding({}); state.notify(); }
    progressText.textContent = snapshot.runId ? '运行 ' + snapshot.runId + ' · ' + (snapshot.events.at(-1)?.type ?? '等待运行') : '尚未启动运行';
    if (previousEvents !== snapshot.events) { previousEvents = snapshot.events; eventsRoot.replaceChildren(); for (const event of snapshot.events) eventsRoot.append(element('li', event.seq + ' · ' + event.type + ' · ' + JSON.stringify(event))); }
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
    if (next) {
      if (preview && previewIdentity !== activeIdentity(next)) invalidatePreview();
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
  checked.addEventListener('change', updateControls, { signal });
  const unsubscribe = state.subscribe(update);
  function dispose() { if (disposed) return; disposed = true; profileRead?.abort(); unsubscribe(); disposeControllerSubscription?.(); candidates?.dispose(); outcome.dispose(); controller?.dispose(); }
  signal.addEventListener('abort', dispose, { once: true }); update(); void refreshProfiles();
  return { refreshProfiles, getRunScope: () => controller?.getSnapshot().runScope ?? null, dispose };
}
