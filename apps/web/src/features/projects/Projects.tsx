import { useEffect, useState, type FormEvent } from 'react';
import { api, type Project } from '../../lib/t15/api';

type Props = { onOpen: (project: Project) => void };

export function Projects({ onOpen }: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [name, setName] = useState('');
  const [labelName, setLabelName] = useState('Object');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function reload() {
    try { setProjects((await api.projects()).items); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }
  useEffect(() => { void reload(); }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const project = await api.createProject({ name, description: '', allow_self_review: false });
      const labels = [{ label_id: crypto.randomUUID(), name: labelName.trim() || 'Object', color: '#e2763d', shortcut: null, allowed_geometry_types: ['bbox_xyxy'] as ['bbox_xyxy'], attributes: [] }];
      await api.publishOntology(project.project_id, { labels, guidelines_markdown: '' });
      await reload();
      onOpen(project);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  return <section className="projects-page" aria-labelledby="projects-heading">
    <div className="section-heading"><div><p className="eyebrow">项目空间</p><h1 id="projects-heading">项目</h1></div></div>
    <form className="project-create" data-testid="project-create" onSubmit={submit}>
      <h2>创建项目</h2>
      <label htmlFor="project-name">项目名称</label><input id="project-name" data-testid="project-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={128} required />
      <label htmlFor="new-label-name">首个类别</label><input id="new-label-name" value={labelName} onChange={(event) => setLabelName(event.target.value)} maxLength={128} required />
      <button data-testid="project-submit" type="submit" disabled={busy}>{busy ? '创建中…' : '创建项目'}</button>
    </form>
    {error ? <p role="alert" className="api-error">{error}</p> : null}
    <ul className="project-cards">{projects.map((project) => <li key={project.project_id}>
      <button className="project-card" type="button" onClick={() => onOpen(project)} aria-label={`打开项目 ${project.name}`}>
        <span className="project-icon" aria-hidden="true">WL</span><span className="project-copy"><strong>{project.name}</strong><small>{project.description || 'API 项目'} · {project.role ?? '成员'}</small></span><span aria-hidden="true">›</span>
      </button>
    </li>)}</ul>
  </section>;
}
