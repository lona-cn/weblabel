import { useEffect, useState } from 'react';
import { useSession } from './providers';
import { Login } from '../features/projects/Login';
import { Projects } from '../features/projects/Projects';
import { Workbench } from '../features/workbench/Workbench';
import { Datasets } from '../features/datasets/Datasets';
import type { Project } from '../lib/t15/api';

export function RouteView() {
  const { session, loading } = useSession();
  const [projectId, setProjectId] = useState(() => new URLSearchParams(location.search).get('project_id'));
  const [datasetView, setDatasetView] = useState(() => new URLSearchParams(location.search).get('dataset_view') === '1');
  useEffect(() => {
    const restore = () => {
      const query = new URLSearchParams(location.search);
      setProjectId(query.get('project_id'));
      setDatasetView(query.get('dataset_view') === '1');
    };
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);
  if (loading) return <main className="session-loading" role="status">正在检查登录状态…</main>;
  if (!session) return <Login />;
  const open = (project: Project) => {
    setProjectId(project.project_id);
    setDatasetView(false);
    const url = new URL(location.href);
    url.searchParams.set('project_id', project.project_id);
    url.searchParams.delete('asset_revision_id');
    url.searchParams.delete('dataset_view');
    history.pushState(null, '', url);
  };
  const goProjects = () => {
    setProjectId(null);
    setDatasetView(false);
    const url = new URL(location.href);
    url.searchParams.delete('project_id');
    url.searchParams.delete('asset_revision_id');
    url.searchParams.delete('dataset_view');
    history.pushState(null, '', url);
  };
  const openDatasets = () => {
    setDatasetView(true);
    const url = new URL(location.href);
    url.searchParams.set('project_id', projectId ?? '');
    url.searchParams.set('dataset_view', '1');
    history.pushState(null, '', url);
  };
  const openWorkbench = () => {
    setDatasetView(false);
    const url = new URL(location.href);
    url.searchParams.delete('dataset_view');
    history.pushState(null, '', url);
  };
  if (!projectId) return <Projects onOpen={open} />;
  if (datasetView) return <Datasets projectId={projectId} onWorkbench={openWorkbench} />;
  return <Workbench projectId={projectId} onProjects={goProjects} onDatasets={openDatasets} />;
}
