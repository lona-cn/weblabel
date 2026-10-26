import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Project } from '../../lib/t15/api';
import { MemberManager } from './MemberManager';
import './project-delivery.css';

type Props = { onOpen: (project: Project) => void; createdUsername: string | null };
import { fromVersion, newLabel, type AttributeDraft, type LabelDraft } from './ontology-draft';
import { createProjectController, type ProjectController, type ProjectSnapshot } from './project-controller';
export function Projects({ onOpen, createdUsername }: Props) {
  const open = useRef(onOpen); open.current = onOpen;
  const controllerRef = useRef<ProjectController | null>(null);
  const [state, setState] = useState<ProjectSnapshot | null>(null);
  const [memberProject, setMemberProject] = useState<Project | null>(null);
  useEffect(() => {
    const owned = createProjectController(project => open.current(project));
    controllerRef.current = owned;
    const unsubscribe = owned.subscribe(() => setState(owned.getSnapshot()));
    setState(owned.getSnapshot());
    void owned.listing();
    return () => {
      unsubscribe();
      owned.dispose();
      if (controllerRef.current === owned) controllerRef.current = null;
    };
  }, []);
  const active = controllerRef.current;
  if (!state || !active) return <section role="status">正在读取项目…</section>;
  const controller: ProjectController = active;
  const { projects, listingReady, name, labels, guidelines, baseline, invalidLabels, selected, versions, busy, error, notice, confirmed, unknown, creationDraft } = state;
  const canWrite = selected === null || selected.role === 'admin';
  const frozen = busy || !!unknown || (!!creationDraft && !selected) || !canWrite;
  const retryListing = controller.listing, configure = controller.configure, reconcile = controller.reconcile;
  const setName = (name: string) => controller.edit({ name });
  const setGuidelines = (guidelines: string) => controller.edit({ guidelines });
  const setLabels = (update: LabelDraft[] | ((prior: LabelDraft[]) => LabelDraft[])) => controller.edit({ labels: typeof update === 'function' ? update(controller.getSnapshot().labels) : update });
  function changeLabel(index: number, patch: Partial<LabelDraft>) { setLabels(current => current.map((label, i) => i === index ? { ...label, ...patch } : label)); }
  function changeAttribute(labelIndex: number, index: number, patch: Partial<AttributeDraft>) { setLabels(current => current.map((label, i) => i === labelIndex ? { ...label, attributes: label.attributes.map((attribute, j) => j === index ? { ...attribute, ...patch } : attribute) } : label)); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget;
    await controller.submit();
    const latest = controller.getSnapshot();
    if (latest.error && !latest.unknown) {
      const index = latest.labels.findIndex(label => latest.invalidLabels[label.id]);
      (index >= 0 ? form.querySelectorAll<HTMLElement>('[data-testid="ontology-label"]')[index]?.querySelector<HTMLInputElement>('input') : form.querySelector<HTMLInputElement>('#project-name'))?.focus();
    }
  }
  return <section className="projects-page" aria-labelledby="projects-heading">
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
    <ul className="project-cards">{projects.map(p => <li key={p.project_id}><button className="project-card" disabled={busy} onClick={() => { if (!controller.getSnapshot().busy) onOpen(p); }} aria-label={`打开项目 ${p.name}`}>{p.name} · {p.role ?? '权限未知'}</button><button type="button" disabled={busy || unknown === 'ontology' || !!confirmed} onClick={() => void configure(p)}>查看规范：{p.name}</button></li>)}</ul>
    <details className="project-create-section" open={selected !== null || projects.length === 0 ? true : undefined}><summary data-testid="project-create-toggle">{selected ? '项目规范' : '新建项目'}</summary>
    <form className="project-create" data-testid="project-create" onSubmit={submit} aria-busy={busy}>
      <h2>{selected ? `${selected.name} · 不可变规范配置` : confirmed ? '项目已创建 · 补充规范' : '创建项目'}</h2>
      <details><summary>高级配置与字节预算</summary><p>名称/属性键最多128 UTF-8字节；快捷键仅一个字节；文本默认值4096字节；指南65536字节。发布不迁移旧标注。</p></details>
      {selected ? <><p>{canWrite ? '仅管理员可发布新版本' : '只读：权限未知或不是管理员'}</p><label>查看/复制已发布版本<select disabled={busy || !!unknown} value="" onChange={e => { const v = versions.find(v => v.ontology_version_id === e.target.value); if (v) controller.copyVersion(v); }}><option value="">选择固定版本</option>{versions.map(v => <option key={v.ontology_version_id} value={v.ontology_version_id}>版本 {v.version_no}</option>)}</select></label></> : null}
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
      {selected ? <button type="button" disabled={busy || !!unknown} onClick={controller.newProject}>{creationDraft ? '返回未知创建草稿' : '返回新建项目'}</button> : null}
    </form></details>
  </section>;
}
