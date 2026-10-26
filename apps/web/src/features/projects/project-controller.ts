import type { OntologyVersion } from '../../../../../packages/contracts/generated/OntologyVersion';
import { api, type Project } from '../../lib/t15/api';
import { bounded, build, fromVersion, newLabel, type LabelDraft, type OntologyBody } from './ontology-draft';
import { rejected, message } from './account-dom';

export interface ProjectSnapshot {
  projects: Project[]; listingReady: boolean; name: string; labels: LabelDraft[]; guidelines: string;
  baseline: OntologyVersion | null; selected: Project | null; versions: OntologyVersion[];
  busy: boolean; error: string | null; notice: string | null; confirmed: Project | null;
  unknown: 'project' | 'ontology' | null; invalidLabels: Record<string, string>;
  creationDraft: { name: string; labels: LabelDraft[]; guidelines: string; before: string[] } | null;
}
export interface ProjectController {
  getSnapshot(): ProjectSnapshot;
  subscribe(listener: () => void): () => void;
  listing(): Promise<void>;
  configure(project: Project): Promise<void>;
  submit(): Promise<void>;
  reconcile(): Promise<void>;
  edit(next: Partial<Pick<ProjectSnapshot, 'name' | 'labels' | 'guidelines'>>): void;
  copyVersion(version: OntologyVersion): void;
  newProject(): void;
  dispose(): void;
}
/** Shared by the transitional React consumer and the native view; never owns geometry. */
export function createProjectController(onOpen: (project: Project) => void, authorized: () => boolean = () => true, signal?: AbortSignal): ProjectController {
  let state: ProjectSnapshot = { projects: [], listingReady: false, name: '', labels: [{ ...newLabel(), name: '物体' }], guidelines: '', baseline: null, selected: null, versions: [], busy: false, error: null, notice: null, confirmed: null, unknown: null, invalidLabels: {}, creationDraft: null };
  let alive = true, flight = false, publicationAck: string | null = null;
  let attempt: { body: OntologyBody; name: string; before: string[] } | null = null;
  const listeners = new Set<() => void>();
  const reads = new AbortController();
  function dispose() {
    alive = false;
    reads.abort();
    listeners.clear();
    signal?.removeEventListener('abort', dispose);
  }
  signal?.addEventListener('abort', dispose, { once: true });
  if (signal?.aborted) dispose();
  const current = () => alive && authorized();
  function patch(next: Partial<ProjectSnapshot>) { if (!current()) return; state = { ...state, ...next }; listeners.forEach(listener => listener()); }
  const frozen = () => flight || !!state.unknown || (!!state.creationDraft && !state.selected) || (state.selected !== null && state.selected.role !== 'admin');
  async function run(action: () => Promise<void>) {
    if (flight || !current()) return;
    flight = true; patch({ busy: true });
    try { await action(); } catch (reason) { patch({ error: message(reason) }); }
    finally { flight = false; patch({ busy: false }); }
  }
  async function listing() {
    await run(async () => {
      const result = await api.projects(reads.signal); if (!current()) return;
      patch({ projects: result.items, listingReady: result.next_cursor === null, error: result.next_cursor === null ? null : '项目列表不完整，不能确定创建前的基线。' });
    });
  }
  async function configure(project: Project) {
    if (state.unknown === 'ontology' || state.confirmed) return;
    await run(async () => {
      const result = await api.ontologies(project.project_id, reads.signal); if (!current()) return;
      patch({ selected: project, baseline: result.items[0] ?? null, versions: result.items, name: project.name, labels: result.items[0] ? fromVersion(result.items[0]) : [newLabel()], guidelines: result.items[0]?.guidelines_markdown ?? '', unknown: null, invalidLabels: {}, error: null, notice: null });
    });
  }
  async function submit() {
    if (frozen() || !state.listingReady || !current()) return;
    let body: OntologyBody;
    try { bounded(state.name, 128, '项目名称'); body = build(state.labels, state.guidelines); }
    catch (reason) {
      const invalidLabels: Record<string, string> = {};
      for (const label of state.labels) { try { build([label], ''); } catch (error) { invalidLabels[label.id] = message(error); } }
      patch({ invalidLabels, error: message(reason) }); return;
    }
    await run(async () => {
      patch({ error: null, notice: null, invalidLabels: {} }); publicationAck = null;
      let project = state.selected ?? state.confirmed;
      attempt = { body, name: state.name.trim(), before: project ? state.versions.map(v => v.ontology_version_id) : state.projects.map(p => p.project_id) };
      try {
        if (!project) {
          try {
            project = await api.createProject({ name: state.name, description: '', allow_self_review: false }); if (!current()) return;
            if (!project?.project_id) throw new Error('项目确认缺少 ID'); patch({ confirmed: project });
          } catch (reason) {
            if (!rejected(reason)) patch({ creationDraft: { name: state.name, labels: state.labels, guidelines: state.guidelines, before: attempt.before }, unknown: 'project' }); throw reason;
          }
          attempt.before = [];
        }
        try {
          const ack = await api.publishOntology(project.project_id, body); if (!current()) return;
          if (!ack?.ontology_version_id || ack.project_id !== project.project_id) throw new Error('发布确认缺少固定版本'); publicationAck = ack.ontology_version_id;
        } catch (reason) { if (!rejected(reason)) patch({ unknown: 'ontology' }); throw reason; }
        patch({ unknown: 'ontology', notice: '新规范已发布；旧媒体、任务和草稿仍使用固定旧版。' });
        const versions = await api.ontologies(project.project_id, reads.signal); if (!current()) return;
        if (!versions.items.some(v => v.ontology_version_id === publicationAck)) throw new Error('尚未读取到已确认的固定版本');
        patch({ versions: versions.items });
        const projects = await api.projects(reads.signal); if (!current()) return;
        patch({ projects: projects.items, unknown: null });
        if (!state.selected) { patch({ confirmed: null }); onOpen(project); }
      } catch (reason) {
        patch({ error: publicationAck ? '规范发布已确认，但后续列表刷新失败。请只读核对；不会再次发布。输入已保留。' : !rejected(reason) ? '写入结果未知，请只读核对；不会自动重发。输入已保留。' : '服务端拒绝操作，输入已保留。已创建的项目只补规范，不会重复创建。' });
      }
    });
  }
  async function reconcile() {
    if ((!state.unknown && !state.creationDraft) || !attempt) return;
    await run(async () => {
      if (state.unknown === 'project' || (state.creationDraft && state.unknown !== 'ontology')) {
        const result = await api.projects(reads.signal); if (!current()) return; patch({ projects: result.items });
        if (result.next_cursor !== null) throw new Error('项目列表不完整，创建结果仍未知。');
        const source = state.creationDraft ?? attempt!;
        const candidates = result.items.filter(p => !source.before.includes(p.project_id) && p.name === source.name.trim() && p.description === '' && !p.allow_self_review && p.role === 'admin');
        patch({ notice: `只读找到 ${candidates.length} 个候选。候选无法关联此次创建请求；如要配置已有项目，请明确选择其规范入口。`, error: '创建结果仍未知：没有服务端 operation 关联，不能认领候选或重发创建。原输入已保留。' });
      } else {
        const project = state.selected ?? state.confirmed; if (!project) throw new Error('项目结果未知');
        const result = await api.ontologies(project.project_id, reads.signal); if (!current()) return; patch({ versions: result.items });
        if (!publicationAck) throw new Error('发布结果仍未知：没有已确认的版本 ID，不会认领相似版本或重发。已发布版本仍可查看；原发布输入保留。');
        if (!result.items.some(v => v.ontology_version_id === publicationAck)) throw new Error('已确认发布，但列表尚未读取到该版本；只允许重新读取。');
        patch({ unknown: null, error: null, notice: '已按成功 ACK 的固定版本 ID 只读核对发布；不会再次发布。' });
        if (!state.selected) { patch({ confirmed: null }); onOpen(project); }
      }
    });
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    listing, configure, submit, reconcile,
    edit(next: Partial<Pick<ProjectSnapshot, 'name' | 'labels' | 'guidelines'>>) { if (!frozen()) patch(next); },
    copyVersion(version: OntologyVersion) { if (!flight && !state.unknown) patch({ baseline: version, labels: fromVersion(version), guidelines: version.guidelines_markdown, invalidLabels: {} }); },
    newProject() {
      if (flight || state.unknown === 'ontology' || state.confirmed) return;
      const draft = state.creationDraft;
      patch({ selected: null, baseline: null, name: draft?.name ?? '', labels: draft?.labels ?? [{ ...newLabel(), name: '物体' }], guidelines: draft?.guidelines ?? '', versions: [], unknown: draft ? 'project' : null, invalidLabels: {} });
    },
    dispose,
  };
}
