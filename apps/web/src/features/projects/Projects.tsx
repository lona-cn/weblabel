import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { OntologyVersion } from '../../../../../packages/contracts/generated/OntologyVersion';
import { api, ApiFailure, type Project } from '../../lib/t15/api';
import { MemberManager } from './MemberManager';
import './project-delivery.css';

type Props = { onOpen: (project: Project) => void; createdUsername: string | null };
type AttributeDraft = { key: string; kind: 'enum' | 'boolean' | 'number' | 'text'; required: boolean; isNull: boolean; value: string; values: string; min: string; max: string };
type LabelDraft = { id: string; name: string; color: string; shortcut: string; attributes: AttributeDraft[] };
type Body = Pick<OntologyVersion, 'labels' | 'guidelines_markdown'>;
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const newLabel = (): LabelDraft => ({ id: crypto.randomUUID(), name: '', color: '#e2763d', shortcut: '', attributes: [] });
function bounded(text: string, max: number, name: string, required = true) {
  if ((required && !text.trim()) || bytes(text) > max) throw new Error(`${name}须为${required ? '1–' : '0–'}${max} UTF-8 字节`);
}
function numeric(text: string): number | null {
  if (text === '') return null;
  if (!text.trim() || !Number.isFinite(Number(text))) throw new Error('数值必须有限');
  return Number(text);
}
function build(labels: LabelDraft[], guidelines: string): Body {
  if (!labels.length) throw new Error('至少保留一个类别');
  bounded(guidelines, 65536, '指南', false);

  return { guidelines_markdown: guidelines, labels: labels.map(label => {
    bounded(label.name, 128, '类别名称'); bounded(label.id, 128, '类别 ID'); bounded(label.color, 32, '颜色');
    if (label.shortcut && bytes(label.shortcut) !== 1) throw new Error('快捷键须为单字节字符');
    const keys = new Set<string>();
    return { label_id: label.id, name: label.name, color: label.color, shortcut: label.shortcut || null, allowed_geometry_types: ['bbox_xyxy'] as ['bbox_xyxy'], attributes: label.attributes.map(a => {
      bounded(a.key, 128, '属性键'); if (keys.has(a.key)) throw new Error('属性键重复'); keys.add(a.key);
      const values = a.kind === 'enum' ? a.values.split('\n') : [];
      if (new Set(values).size !== values.length) throw new Error('枚举值不可重复（空字符串也计为一个选项）');
      const min = numeric(a.min); const max = numeric(a.max);
      if (min !== null && max !== null && min > max) throw new Error('最小值不能大于最大值');

      const value = a.isNull ? null : a.kind === 'boolean' ? a.value === 'true' : a.kind === 'number' ? numeric(a.value) : a.value;
      if (!a.isNull && a.kind === 'number' && value === null) throw new Error('数值默认值不能为空');
      if (a.kind === 'enum' && value !== null && !values.includes(String(value))) throw new Error('枚举默认值必须在枚举值中');
      if (a.kind === 'text' && typeof value === 'string') bounded(value, 4096, '文本默认值', false);
      if (typeof value === 'number' && ((min !== null && value < min) || (max !== null && value > max))) throw new Error('默认值超出数值范围');
      return { key: a.key, kind: a.kind, required: a.required, default_value: value, enum_values: values, min, max };
    }) };
  }) };
}
function fromVersion(version: OntologyVersion): LabelDraft[] {
  return version.labels.map(l => ({ id: l.label_id, name: l.name, color: l.color, shortcut: l.shortcut ?? '', attributes: l.attributes.map(a => ({ key: a.key, kind: a.kind, required: a.required, isNull: a.default_value === null, value: a.default_value === null ? '' : String(a.default_value), values: a.enum_values.join('\n'), min: a.min === null ? '' : String(a.min), max: a.max === null ? '' : String(a.max) })) }));
}
function rejected(reason: unknown) { return reason instanceof ApiFailure && reason.status >= 400 && reason.status < 500; }
export function Projects({ onOpen, createdUsername }: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [listingReady, setListingReady] = useState(false);
  const [name, setName] = useState('');
  const [labels, setLabels] = useState<LabelDraft[]>(() => [{ ...newLabel(), name: '物体' }]);
  const [guidelines, setGuidelines] = useState('');
  const [memberProject, setMemberProject] = useState<Project | null>(null);
  const [baseline, setBaseline] = useState<OntologyVersion | null>(null);
  const [invalidLabels, setInvalidLabels] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Project | null>(null);
  const [versions, setVersions] = useState<OntologyVersion[]>([]);
  const [busy, setBusy] = useState(false); const flight = useRef(false); const scope = useRef(0);
  const [error, setError] = useState<string | null>(null); const [notice, setNotice] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<Project | null>(null);
  const [unknown, setUnknown] = useState<'project' | 'ontology' | null>(null);
  const [creationDraft, setCreationDraft] = useState<{ name: string; labels: LabelDraft[]; guidelines: string; before: string[] } | null>(null);
  const publicationAck = useRef<string | null>(null);
  const attempted = useRef<{ body: Body; name: string; before: string[] } | null>(null);
  const canWrite = selected === null || selected.role === 'admin';
  useEffect(() => { let alive = true; api.projects().then(r => { if (alive) { setProjects(r.items); setListingReady(r.next_cursor === null); } }).catch(() => { if (alive) setError('项目列表读取失败，请重新检查'); }); return () => { alive = false; scope.current++; }; }, []);
  async function retryListing() {
    if (flight.current) return; flight.current = true; setBusy(true);
    const generation = ++scope.current;
    try { const result = await api.projects(); if (generation !== scope.current) return;
      setProjects(result.items); setListingReady(result.next_cursor === null);
      setError(result.next_cursor === null ? null : '项目列表不完整，不能确定创建前的基线。');
    } catch { if (generation === scope.current) setError('项目列表读取失败，草稿已保留。'); }
    finally { if (generation === scope.current) { flight.current = false; setBusy(false); } }
  }
  async function configure(project: Project) {
    if (flight.current || unknown === 'ontology' || confirmed) return;
    flight.current = true; const generation = ++scope.current; setBusy(true); setError(null); setNotice(null);
    try { const result = await api.ontologies(project.project_id); if (generation !== scope.current) return;
      setBaseline(result.items[0] ?? null);
      setSelected(project); setUnknown(null); setVersions(result.items); setName(project.name); setLabels(result.items[0] ? fromVersion(result.items[0]) : [newLabel()]); setGuidelines(result.items[0]?.guidelines_markdown ?? '');
    } catch { if (generation === scope.current) setError('规范读取失败；未修改草稿'); } finally { if (generation === scope.current) { flight.current = false; setBusy(false); } }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (flight.current || unknown || (!!creationDraft && !selected) || !canWrite || !listingReady) return;
    let body: Body;
    try { bounded(name, 128, '项目名称'); body = build(labels, guidelines); setInvalidLabels({}); }
    catch (reason) {
      const local: Record<string, string> = {};
      for (const label of labels) { try { build([label], ''); } catch (e) { local[label.id] = e instanceof Error ? e.message : '配置无效'; } }
      setInvalidLabels(local); setError((reason as Error).message);
      const index = labels.findIndex(l => local[l.id]);
      const field = index >= 0 ? event.currentTarget.querySelectorAll<HTMLElement>('[data-testid="ontology-label"]')[index]?.querySelector<HTMLInputElement>('input') : event.currentTarget.querySelector<HTMLInputElement>('#project-name');
      field?.focus(); return;
    }
    flight.current = true; const generation = ++scope.current; setBusy(true); setError(null); setNotice(null); publicationAck.current = null;
    let project = selected ?? confirmed;
    attempted.current = { body, name: name.trim(), before: project ? versions.map(v => v.ontology_version_id) : projects.map(p => p.project_id) };
    try {
      if (!project) {
        try { project = await api.createProject({ name, description: '', allow_self_review: false }); if (generation !== scope.current) return;
          if (!project?.project_id) throw new Error('项目确认缺少 ID'); setConfirmed(project);
        } catch (reason) { if (generation !== scope.current) return; if (!rejected(reason)) { setCreationDraft({ name, labels, guidelines, before: attempted.current.before }); setUnknown('project'); } throw reason; }
        // Creation ACK proves ownership; never create a second project on publication failure.
        attempted.current.before = [];
      }
      try { const ack = await api.publishOntology(project.project_id, body); if (generation !== scope.current) return; if (!ack?.ontology_version_id || ack.project_id !== project.project_id) throw new Error('发布确认缺少固定版本'); publicationAck.current = ack.ontology_version_id; } catch (reason) { if (generation !== scope.current) return; if (!rejected(reason)) setUnknown('ontology'); throw reason; }
      setUnknown('ontology');
      setNotice('新规范已发布；旧媒体、任务和草稿仍使用固定旧版。');
      const ontologyResult = await api.ontologies(project.project_id); if (generation !== scope.current) return; setVersions(ontologyResult.items);
      const projectResult = await api.projects(); if (generation !== scope.current) return; setProjects(projectResult.items);
      setUnknown(null);
      if (!selected) { setConfirmed(null); onOpen(project); }
    } catch (reason) { if (generation === scope.current) setError(publicationAck.current ? '规范发布已确认，但后续列表刷新失败。请只读核对；不会再次发布。输入已保留。' : !rejected(reason) ? '写入结果未知，请只读核对；不会自动重发。输入已保留。' : '服务端拒绝操作，输入已保留。已创建的项目只补规范，不会重复创建。'); }
    finally { if (generation === scope.current) { flight.current = false; setBusy(false); } }
  }
  async function reconcile() {
    if (flight.current || (!unknown && !creationDraft) || !attempted.current) return;
    flight.current = true; const generation = ++scope.current; setBusy(true);
    try {
      const attempt = attempted.current;
      if (unknown === 'project' || (creationDraft && unknown !== 'ontology')) {
        const result = await api.projects(); if (generation !== scope.current) return; setProjects(result.items);
        if (result.next_cursor !== null) throw new Error('项目列表不完整，创建结果仍未知。');
        const source = creationDraft ?? { name: attempt.name, before: attempt.before };
        const candidates = result.items.filter(p => !source.before.includes(p.project_id) && p.name === source.name.trim() && p.description === '' && p.allow_self_review === false && p.role === 'admin');
        setNotice('只读找到 ' + candidates.length + ' 个候选。候选无法关联此次创建请求；如要配置已有项目，请明确选择其规范入口。');
        setError('创建结果仍未知：没有服务端 operation 关联，不能认领候选或重发创建。原输入已保留。');
      } else {
        const project = selected ?? confirmed; if (!project) throw new Error('项目结果未知');
        const result = await api.ontologies(project.project_id); if (generation !== scope.current) return; setVersions(result.items);
        if (!publicationAck.current) {
          const candidates = result.items.filter(v => !attempt.before.includes(v.ontology_version_id) && v.guidelines_markdown === attempt.body.guidelines_markdown && JSON.stringify(v.labels.map(l => ({ label_id: l.label_id, name: l.name, color: l.color, shortcut: l.shortcut, allowed_geometry_types: l.allowed_geometry_types, attributes: l.attributes.map(a => ({ key: a.key, kind: a.kind, required: a.required, default_value: a.default_value, enum_values: a.enum_values, min: a.min, max: a.max })) }))) === JSON.stringify(attempt.body.labels));
          setNotice('只读找到 ' + candidates.length + ' 个相似版本，不能证明属于此次发布。已发布版本仍可查看；原发布输入保留。');
          throw new Error('发布结果仍未知：没有已确认的版本 ID，不会认领相似版本或重发。');
        }
        if (!result.items.some(v => v.ontology_version_id === publicationAck.current)) throw new Error('已确认发布，但列表尚未读取到该版本；只允许重新读取。');
        setUnknown(null); setError(null); setNotice('已按成功 ACK 的固定版本 ID 只读核对发布；不会再次发布。');
        if (!selected) { setConfirmed(null); onOpen(project); }
      }
    } catch (reason) { if (generation === scope.current) setError(reason instanceof Error ? reason.message : '读取失败，结果仍未知'); }
    finally { if (generation === scope.current) { flight.current = false; setBusy(false); } }
  }
  function changeLabel(index: number, patch: Partial<LabelDraft>) { setLabels(current => current.map((l, i) => i === index ? { ...l, ...patch } : l)); }
  function changeAttribute(labelIndex: number, index: number, patch: Partial<AttributeDraft>) { setLabels(current => current.map((l, i) => i === labelIndex ? { ...l, attributes: l.attributes.map((a, j) => j === index ? { ...a, ...patch } : a) } : l)); }
  const frozen = busy || !!unknown || (!!creationDraft && !selected) || !canWrite;
  return <section className="projects-page" aria-labelledby="projects-heading">
    <style>{`.projects-page .project-create input:not([type=checkbox]), .projects-page .project-create select, .projects-page .project-create textarea { width: 100%; box-sizing: border-box; min-height: 44px; } .projects-page .project-create button, .projects-page > button, .projects-page .project-cards button { min-height: 44px; } .projects-page .project-create label { display: block; margin-block: 8px; } .projects-page .project-create fieldset { max-width: 100%; box-sizing: border-box; } .projects-page .project-create input[type=checkbox] { width: 24px; height: 24px; vertical-align: middle; margin: 10px; } .projects-page .project-create :focus-visible { outline: 2px solid var(--accent, #ffce45); outline-offset: 2px; }`}</style>
    <div className="command-brand"><span className="brand-mark" aria-hidden="true">W</span><span>WebLabel</span></div>
    <h1 id="projects-heading">项目</h1>
    <ol aria-label="首次人工交付四步"><li>项目规范：定义类别与属性</li><li>导入：打开项目，导入图片及已有标注</li><li>标注保存：人工标注并确认服务端保存</li><li>交付：单图导出，或独立审核后冻结团队数据集</li></ol>
    <p>单图导出不等于已批准数据集。团队交付需另一个真实账号担任审核员；默认禁止自审核。创建账号仅限平台管理员，项目管理员按真实 user_id 添加成员。</p>
    <MemberManager key={memberProject?.project_id ?? 'platform'} project={memberProject} />
    {projects.filter(p => p.role === 'admin').map(p => <button type="button" key={p.project_id} onClick={() => setMemberProject(p)}>管理成员：{p.name}</button>)}
    {createdUsername !== null ? <p className="bootstrap-account" data-testid="bootstrap-account" role="status">本地账户已创建：<span>{createdUsername}</span>。请保存用户名，之后使用设置的密码登录。</p> : null}
    {error ? <p role="alert" className="api-error">{error}</p> : null}{notice ? <p role="status">{notice}</p> : null}
    {unknown || creationDraft ? <button type="button" disabled={busy} onClick={() => void reconcile()}>只读核对结果</button> : null}
    {creationDraft ? <p role="status">先前项目创建结果仍未知，原草稿保留；当前选择的已有项目不是此次创建的确认结果。</p> : null}
    {!listingReady ? <button type="button" disabled={busy} onClick={() => void retryListing()}>重新读取项目列表</button> : null}
    <ul className="project-cards">{projects.map(p => <li key={p.project_id}><button className="project-card" disabled={busy} onClick={() => { if (!flight.current) onOpen(p); }} aria-label={`打开项目 ${p.name}`}>{p.name} · {p.role ?? '权限未知'}</button><button type="button" disabled={busy || unknown === 'ontology' || !!confirmed} onClick={() => void configure(p)}>查看规范：{p.name}</button></li>)}</ul>
    <details className="project-create-section" open={selected !== null || projects.length === 0 ? true : undefined}><summary data-testid="project-create-toggle">{selected ? '项目规范' : '新建项目'}</summary>
    <form className="project-create" data-testid="project-create" onSubmit={submit} aria-busy={busy}>
      <h2>{selected ? `${selected.name} · 不可变规范配置` : confirmed ? '项目已创建 · 补充规范' : '创建项目'}</h2>
      <details><summary>高级配置与字节预算</summary><p>名称/属性键最多128 UTF-8字节；快捷键仅一个字节；文本默认值4096字节；指南65536字节。发布不迁移旧标注。</p></details>
      {selected ? <><p>{canWrite ? '仅管理员可发布新版本' : '只读：权限未知或不是管理员'}</p><label>查看/复制已发布版本<select disabled={busy || !!unknown} value="" onChange={e => { const v = versions.find(v => v.ontology_version_id === e.target.value); if (v) { setBaseline(v); setLabels(fromVersion(v)); setGuidelines(v.guidelines_markdown); setInvalidLabels({}); } }}><option value="">选择固定版本</option>{versions.map(v => <option key={v.ontology_version_id} value={v.ontology_version_id}>版本 {v.version_no}</option>)}</select></label></> : null}
      <fieldset disabled={frozen} style={{ minWidth: 0, border: 0 }}>
      <label htmlFor="project-name">项目名称</label><input id="project-name" data-testid="project-name" value={name} disabled={!!selected || !!confirmed} onChange={e => setName(e.target.value)} />
      {labels.map((l, i) => <fieldset data-testid="ontology-label" key={l.id} style={{ minWidth: 0, marginBlock: 16 }}><legend>类别 {i + 1}</legend><details><summary>高级类别身份</summary><small style={{ overflowWrap: 'anywhere' }}>稳定 ID：{l.id}</small></details>
        {invalidLabels[l.id] && <p className="field-error" role="alert">此类别配置：{invalidLabels[l.id]}；原输入未修改。</p>}
        <label>类别名称<input value={l.name} onChange={e => changeLabel(i, { name: e.target.value })} /></label>
        <label>颜色<input value={l.color} onChange={e => changeLabel(i, { color: e.target.value })} /></label>
        <label>快捷键<input value={l.shortcut} onChange={e => changeLabel(i, { shortcut: e.target.value })} /></label>
        {l.attributes.map((a, j) => <fieldset data-testid="ontology-attribute" key={j} style={{ minWidth: 0 }}><legend>属性 {j + 1}</legend>
          <label>属性键<input value={a.key} onChange={e => changeAttribute(i, j, { key: e.target.value })} /></label>
          <label>类型<select value={a.kind} onChange={e => changeAttribute(i, j, { kind: e.target.value as AttributeDraft['kind'], value: e.target.value === 'boolean' ? 'false' : '', values: '', min: '', max: '' })}>{Object.entries({ enum: '枚举选项', boolean: '布尔（是/否）', number: '数值', text: '文本' }).map(([k, name]) => <option key={k} value={k}>{name}</option>)}</select></label>
          <label><input type="checkbox" checked={a.required} onChange={e => changeAttribute(i, j, { required: e.target.checked })} />必填</label>
          <label><input type="checkbox" checked={a.isNull} onChange={e => changeAttribute(i, j, { isNull: e.target.checked })} />默认值为空</label>
          <label>默认值{a.kind === 'boolean' ? <select disabled={a.isNull} value={a.value} onChange={e => changeAttribute(i, j, { value: e.target.value })}><option value="false">false</option><option value="true">true</option></select> : <input disabled={a.isNull} value={a.value} onChange={e => changeAttribute(i, j, { value: e.target.value })} />}</label>
          {a.kind === 'enum' ? <><label>枚举值（每行一个）<textarea aria-describedby={'enum-options-' + i + '-' + j} value={a.values} onChange={e => changeAttribute(i, j, { values: e.target.value })} /></label><small id={'enum-options-' + i + '-' + j}>每行原样保存；空行也是一个空字符串选项。整个输入为空时表示一个空字符串选项；重复选项不可发布。</small></> : null}
          {a.kind === 'number' ? <><label>最小值<input value={a.min} onChange={e => changeAttribute(i, j, { min: e.target.value })} /></label><label>最大值<input value={a.max} onChange={e => changeAttribute(i, j, { max: e.target.value })} /></label></> : null}
          <button type="button" onClick={() => changeLabel(i, { attributes: l.attributes.filter((_, index) => index !== j) })}>删除属性</button>
        </fieldset>)}
        <button type="button" onClick={() => changeLabel(i, { attributes: [...l.attributes, { key: '', kind: 'text', required: false, isNull: true, value: '', values: '', min: '', max: '' }] })}>添加属性</button>
        <button type="button" disabled={labels.length <= 1} onClick={() => setLabels(current => current.filter((_, index) => index !== i))}>删除类别</button>
      </fieldset>)}
      <button type="button" onClick={() => setLabels(current => [...current, newLabel()])}>添加类别</button>
      <label>标注指南<textarea value={guidelines} onChange={e => setGuidelines(e.target.value)} /></label>
      <section aria-label="默认对象属性只读预览"><h3>默认对象属性预览（不创建几何）</h3>{labels.map(l => <div key={l.id}><strong>{l.name || '未命名类别'}</strong><dl>{l.attributes.map((a, j) => <div key={j}><dt>{a.key || '未命名属性'}{a.required ? ' · 必填' : ''}</dt><dd>{a.isNull ? 'null（显式空值，不是缺失）' : a.kind === 'number' ? (a.value === '' ? 'null' : a.value) : a.kind === 'text' || a.kind === 'enum' ? JSON.stringify(a.value) : a.value}</dd></div>)}</dl></div>)}</section>
      {selected && baseline && <section aria-label="发布版本差异"><h3>相对固定第 {baseline.version_no} 版</h3><ul>{labels.map(l => { const old = baseline.labels.find(v => v.label_id === l.id); return <li key={l.id}>{l.name}：{!old ? '新增类别' : JSON.stringify(fromVersion({ ...baseline, labels: [old] })[0]) === JSON.stringify(l) ? '类别与属性未变' : '类别或属性变化'}<details><summary>类别 / 属性前后核对</summary><pre>{JSON.stringify({ before: old ?? null, after: l }, null, 2)}</pre></details></li>; })}{baseline.labels.filter(l => !labels.some(d => d.id === l.label_id)).map(l => <li key={l.label_id}>删除类别：{l.name}</li>)}</ul><p>发布仅产生新的固定规范。旧图片、任务和草稿不迁移；以后选择新规范才使用新版本。</p></section>
      }
      </fieldset>
      <button data-testid="project-submit" type="submit" disabled={frozen || !listingReady}>{busy ? '处理中…' : selected ? '发布不可变新版本' : confirmed ? '仅发布规范' : '创建项目'}</button>
      {selected ? <button type="button" disabled={busy || !!unknown} onClick={() => { setSelected(null); setName(creationDraft?.name ?? ''); setLabels(creationDraft?.labels ?? [{ ...newLabel(), name: '物体' }]); setGuidelines(creationDraft?.guidelines ?? ''); setVersions([]); if (creationDraft) setUnknown('project'); }}>{creationDraft ? '返回未知创建草稿' : '返回新建项目'}</button> : null}
    </form></details>
  </section>;
}
