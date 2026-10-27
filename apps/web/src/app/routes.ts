import type { SessionController, AuthEntry } from './session';
import { readRoute } from './route-state';
import type { PageContext } from '../ui/page-context';
import { mountLoginPage } from '../features/projects/login-page';
import { mountProjectsPage } from '../features/projects/projects-page';
import { mountMemberManager } from '../features/projects/member-manager-page';
import { mountExternalProcessingPolicy } from '../features/projects/external-processing-policy';
import { mountModelProfileSettings } from '../features/ai/model-profile-settings';
import { mountWorkbenchPage } from '../features/workbench/workbench-page';
import type { ManagementMountContext } from '../features/workbench/workbench-context';
import { mountReviewPanel } from '../features/review/review-panel';
import { mountFixedRevisionPage } from '../features/review/fixed-revision-page';
import { mountDatasetsPage, type DatasetDeliveryTarget } from '../features/datasets/datasets-page';
import { mountTransfersPanel } from '../features/import-export/transfers-panel';

function mountManagement(root: HTMLElement, context: ManagementMountContext): () => void {
  const project = context.getProject();
  if (!project || project.project_id !== context.projectId || context.signal.aborted) return () => {};
  const cleanups = [
    mountMemberManager(root, { ...context, project }),
    mountExternalProcessingPolicy(root, { ...context, projectName: project.name }),
    mountModelProfileSettings(root, context),
  ];
  return () => { for (const dispose of cleanups.reverse()) dispose(); };
}
const targetKeys = ['asset_revision_id', 'ontology_version_id', 'annotation_revision_id', 'review_queue', 'task_id', 'dataset_view'];
function clearTarget(url: URL) { for (const key of targetKeys) url.searchParams.delete(key); }

/** One route owner, one page lifetime. In-flight writes remain the controllers' responsibility. */
export function mountRoutes(root: HTMLElement, session: SessionController): () => void {
  const owner = new AbortController();
  let page: AbortController | null = null, unmount: (() => void) | null = null;
  let mountedEntry: AuthEntry | null = null;
  let mountedSession: Extract<AuthEntry, { kind: 'authenticated' }>['session'] | null = null;
  let mountedUrl = '', disposed = false;
  function releasePage() {
    page?.abort(); page = null;
    const cleanup = unmount; unmount = null; cleanup?.(); root.replaceChildren();
  }
  function render(force = false) {
    if (disposed) return;
    const entry = session.getSnapshot(), url = new URL(location.href);
    const sameIdentity = entry.kind === 'authenticated' && entry.session === mountedSession;
    // The login view subscribes to its controller: retain entered credentials/focus on errors.
    if (!force && mountedUrl === url.href && (sameIdentity || entry.kind !== 'authenticated' && mountedEntry?.kind !== 'authenticated' && mountedEntry !== null)) return;
    releasePage();
    mountedEntry = entry; mountedSession = entry.kind === 'authenticated' ? entry.session : null; mountedUrl = url.href;
    const life = new AbortController(); page = life;
    const current = () => !disposed && page === life && !life.signal.aborted;
    const navigate = (next: URL) => {
      if (!current()) return;
      if (next.origin !== location.origin) throw new Error('只能在当前本地服务内导航。');
      history.pushState(null, '', next); render(true);
    };
    const route = readRoute(url);
    const context: PageContext = { session, navigate, signal: life.signal, route };
    const notice = (message: string, alert = true) => {
      const main = document.createElement('main'); main.className = 'route-notice'; main.setAttribute('role', alert ? 'alert' : 'status'); main.textContent = message; root.append(main);
    };
    if (url.pathname.startsWith('/test-harness/')) {
      if (import.meta.env.MODE === 'test' && url.pathname === '/test-harness/dense') {
        notice('正在加载测试工作区…', false);
        void import('../features/workbench/dense-harness').then(module => {
          if (!current()) return;
          root.replaceChildren(); unmount = module.mountDenseHarness(root, context);
        }).catch(reason => { if (current()) { root.replaceChildren(); notice(reason instanceof Error ? reason.message : String(reason)); } });
      } else notice('发行版不提供测试工作区。');
      return;
    }
    if (entry.kind !== 'authenticated') { unmount = mountLoginPage(root, context); return; }
    const goProjects = () => { const next = new URL(location.href); clearTarget(next); next.searchParams.delete('project_id'); navigate(next); };
    const openWorkbench = (target?: DatasetDeliveryTarget) => {
      if (!current()) return;
      if (target && (!target.projectId || !target.assetRevisionId || !target.ontologyVersionId || target.mode === 'review' && !target.annotationRevisionId)) {
        const error = document.createElement('p'); error.setAttribute('role', 'alert'); error.textContent = '固定目标不完整，不会跳到其他图片或当前 head。'; root.prepend(error); return;
      }
      const next = new URL(location.href);
      for (const key of ['dataset_view', 'annotation_revision_id', 'review_queue', 'task_id']) next.searchParams.delete(key);
      if (target) {
        next.searchParams.set('project_id', target.projectId); next.searchParams.set('asset_revision_id', target.assetRevisionId); next.searchParams.set('ontology_version_id', target.ontologyVersionId);
        if (target.mode === 'review') next.searchParams.set('annotation_revision_id', target.annotationRevisionId!);
      }
      navigate(next);
    };
    // The presence (including an empty value) of a fixed target must never become project/head navigation.
    if (!route.dataset && route.revisionId !== null && (!route.projectId || !route.assetId || !route.ontologyId || !route.revisionId)) {
      notice('固定版本入口缺少完整项目、图片、规范或 revision；不会改为当前 head。'); return;
    }
    if (!route.dataset && route.revisionId === null && route.taskId !== null && (!route.projectId || !route.assetId || !route.ontologyId || !route.taskId)) {
      notice('固定任务入口缺少完整项目、图片或规范目标；不会选择其他图片或自动领取。'); return;
    }
    if (!route.projectId) {
      unmount = mountProjectsPage(root, { ...context, createdUsername: entry.createdUsername, onOpen(project) {
        if (!current()) return;
        const next = new URL(location.href); clearTarget(next); next.searchParams.set('project_id', project.project_id); navigate(next); void session.refresh();
      } });
    } else if (route.revisionId !== null && !route.dataset) {
      unmount = mountFixedRevisionPage(root, { ...context, projectId: route.projectId, assetId: route.assetId, ontologyId: route.ontologyId, revisionId: route.revisionId, onProjects: goProjects,
        onWorkbench: () => openWorkbench({ projectId: route.projectId!, assetRevisionId: route.assetId, ontologyVersionId: route.ontologyId, annotationRevisionId: null, mode: 'workbench' }),
        onReview() { const next = new URL(location.href); next.searchParams.delete('annotation_revision_id'); next.searchParams.delete('dataset_view'); next.searchParams.delete('task_id'); next.searchParams.set('review_queue', 'all'); navigate(next); },
      });
    } else if (route.dataset) {
      unmount = mountDatasetsPage(root, { ...context, projectId: route.projectId, onWorkbench: openWorkbench });
    } else {
      unmount = mountWorkbenchPage(root, { ...context, projectId: route.projectId, initialTaskId: route.taskId, mountReview: mountReviewPanel, mountManagement, mountTransfers: mountTransfersPanel });
    }
  }
  const unsubscribe = session.subscribe(() => render());
  window.addEventListener('popstate', () => render(true), { signal: owner.signal });
  render();
  return () => { if (disposed) return; disposed = true; owner.abort(); unsubscribe(); releasePage(); };
}
