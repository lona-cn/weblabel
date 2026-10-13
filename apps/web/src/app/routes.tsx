import { lazy, Suspense, useEffect, useState } from 'react';
import { useSession } from './providers';
import { Login } from '../features/projects/Login';
import { Projects } from '../features/projects/Projects';
import { Workbench } from '../features/workbench/Workbench';
import { Datasets, type DeliveryTarget } from '../features/datasets/Datasets';
import { FixedRevisionPage } from '../features/review/FixedRevisionPage';
import type { TaskQueue } from '../features/review/workflow';
import type { Project } from '../lib/t15/api';
const DenseHarness = import.meta.env.MODE === 'test' ? lazy(() => import('../features/workbench/DenseHarness')) : null;
export function RouteView() {
  if (location.pathname.startsWith('/test-harness/')) {
    return import.meta.env.MODE === 'test' && location.pathname === '/test-harness/dense' && DenseHarness
      ? <Suspense fallback={<p>正在加载测试工作区…</p>}><DenseHarness /></Suspense>
      : <main role="alert">发行版不提供测试工作区。</main>;
  }
  return <StandardRoutes />;
}
function readRoute() {
  const query = new URLSearchParams(location.search), queue = query.get('review_queue');
  return { projectId: query.get('project_id'), dataset: query.get('dataset_view') === '1', assetId: query.get('asset_revision_id') ?? '', ontologyId: query.get('ontology_version_id') ?? '', revisionId: query.get('annotation_revision_id'), queue: queue && ['all','mine','pending','returned','closed'].includes(queue) ? queue as TaskQueue : undefined };
}
function StandardRoutes() {
  const { entry, refresh } = useSession();
  const [route, setRoute] = useState(readRoute);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  useEffect(() => { const restore = () => { setRoute(readRoute()); setNavigationError(null); }; window.addEventListener('popstate', restore); return () => window.removeEventListener('popstate', restore); }, []);
  if (entry.kind === 'checking') return <main className="session-loading" role="status">正在检查登录状态…</main>;
  if (entry.kind !== 'authenticated') return <Login key={entry.kind === 'bootstrap' ? 'bootstrap-' + entry.mode : entry.kind} />;
  const navigate = (url: URL) => { history.pushState(null, '', url); setRoute(readRoute()); setNavigationError(null); };
  const clearTarget = (url: URL) => { for (const key of ['asset_revision_id','ontology_version_id','annotation_revision_id','review_queue','task_id','dataset_view']) url.searchParams.delete(key); };
  const open = (project: Project) => { const url = new URL(location.href); clearTarget(url); url.searchParams.set('project_id', project.project_id); navigate(url); void refresh(); };
  const goProjects = () => { const url = new URL(location.href); clearTarget(url); url.searchParams.delete('project_id'); navigate(url); };
  const openDatasets = () => { const url = new URL(location.href); url.searchParams.set('project_id', route.projectId ?? ''); url.searchParams.set('dataset_view','1'); url.searchParams.delete('annotation_revision_id'); url.searchParams.delete('review_queue'); navigate(url); };
  const openWorkbench = (target?: DeliveryTarget) => {
    if (target && (!target.projectId || !target.assetRevisionId || !target.ontologyVersionId || target.mode === 'review' && !target.annotationRevisionId)) { setNavigationError('固定目标不完整，不会跳到其他图片或当前 head。'); return; }
    const url = new URL(location.href); url.searchParams.delete('dataset_view'); url.searchParams.delete('annotation_revision_id'); url.searchParams.delete('review_queue'); url.searchParams.delete('task_id');
    if (target) { url.searchParams.set('project_id',target.projectId); url.searchParams.set('asset_revision_id',target.assetRevisionId); url.searchParams.set('ontology_version_id',target.ontologyVersionId); if (target.mode === 'review') url.searchParams.set('annotation_revision_id',target.annotationRevisionId!); }
    navigate(url);
  };
  if (!route.projectId) return <Projects onOpen={open} createdUsername={entry.createdUsername} />;
  if (route.dataset) return <>{navigationError ? <p role="alert">{navigationError}</p> : null}<Datasets projectId={route.projectId} onWorkbench={openWorkbench} /></>;
  if (route.revisionId !== null) return <FixedRevisionPage key={[entry.session.user_id,route.projectId,route.assetId,route.ontologyId,route.revisionId].join(':')} projectId={route.projectId} assetId={route.assetId} ontologyId={route.ontologyId} revisionId={route.revisionId} onProjects={goProjects} onWorkbench={() => openWorkbench({projectId:route.projectId!,assetRevisionId:route.assetId,ontologyVersionId:route.ontologyId,annotationRevisionId:null,mode:'workbench'})} onReview={() => { const url = new URL(location.href); url.searchParams.delete('annotation_revision_id'); url.searchParams.delete('task_id'); url.searchParams.set('review_queue','all'); navigate(url); }} />;
  return <Workbench projectId={route.projectId} initialReviewQueue={route.queue} onProjects={goProjects} onDatasets={openDatasets} />;
}
