import { useState } from 'react';
import { useSession } from './providers';
import { Login } from '../features/projects/Login';
import { Projects } from '../features/projects/Projects';
import { Workbench } from '../features/workbench/Workbench';
import type { Project } from '../lib/t15/api';

export function RouteView() {
  const { session, loading } = useSession();
  const [projectId, setProjectId] = useState(() => new URLSearchParams(location.search).get('project_id'));
  if (loading) return <main className="session-loading" role="status">正在检查登录状态…</main>;
  if (!session) return <Login />;
  const open = (project: Project) => {
    setProjectId(project.project_id);
    const url = new URL(location.href);
    url.searchParams.set('project_id', project.project_id);
    url.searchParams.delete('asset_revision_id');
    history.pushState(null, '', url);
  };
  const goProjects = () => {
    setProjectId(null);
    const url = new URL(location.href);
    url.searchParams.delete('project_id');
    url.searchParams.delete('asset_revision_id');
    history.pushState(null, '', url);
  };
  return projectId ? <Workbench projectId={projectId} onProjects={goProjects} /> : <Projects onOpen={open} />;
}
