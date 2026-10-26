import type { PageContext } from '../../ui/page-context';
import { reviewApi } from './api';
import { assertRevision, mountRevisionReviewView } from './revision-review-view';
import { element, actions, details, lifetime, createAuthorizedReadScope } from '../import-export/delivery-dom';
export interface FixedRevisionPageContext extends PageContext {
  projectId: string; assetId: string; ontologyId: string; revisionId: string;
  onWorkbench(): void; onReview(): void; onProjects(): void;
}
export function mountFixedRevisionPage(root: HTMLElement, context: FixedRevisionPageContext): () => void {
  const life = lifetime(context.signal); const main = element('main', undefined, 'native-delivery'); main.dataset.testid = 'fixed-revision-page';
  const action = actions(life.signal);
  const title = element('h1', '固定版本检查'); title.tabIndex = -1;
  const nav = element('nav'); nav.setAttribute('aria-label', '固定版本导航'); const workbench = action('打开此图片的当前标注', context.onWorkbench); workbench.disabled = true;
  nav.append(action('项目', context.onProjects), action('项目任务与审核队列', context.onReview), workbench);
  const status = element('p', '正在读取指定的不可变版本…'); status.setAttribute('role', 'status'); const view = element('div');
  main.append(title, nav, element('p', '此处只读并钉住指定 revision，不随当前 head 更新。批准或退回须在任务审核队列操作。'), details('固定目标与版本凭证', { project: context.projectId, asset: context.assetId, ontology: context.ontologyId, revision: context.revisionId }), status, view); root.append(main); title.focus();
  const reads = createAuthorizedReadScope(life.signal, context.session, context.projectId, () => {
    workbench.disabled = true; view.replaceChildren(); status.hidden = false; status.setAttribute('role', 'alert'); status.textContent = '当前身份或项目权限已改变；固定版本读取已停止。';
  });
  life.add(reads.dispose);
  void (async () => {
    if (!reads.current()) return;
    if (!context.projectId || !context.assetId || !context.ontologyId || !context.revisionId) throw new Error('固定版本入口缺少完整图片或规范目标，不会改为当前版本。');
    const revision = await reviewApi.revision(context.revisionId, reads.signal); if (!reads.current()) return;
    assertRevision(revision, context.revisionId, context.assetId, context.ontologyId);
    const parent = revision.parent_revision_id ? await reviewApi.revision(revision.parent_revision_id, reads.signal) : null; if (!reads.current()) return;
    if (parent) assertRevision(parent, revision.parent_revision_id!, context.assetId, context.ontologyId);
    status.hidden = true; workbench.disabled = false;
    life.add(mountRevisionReviewView(view, { projectId: context.projectId, revision, parent, issues: [], signal: reads.signal, isCurrent: reads.current }));
  })().catch(error => { if (reads.current()) { status.setAttribute('role', 'alert'); status.textContent = error instanceof Error ? error.message : '指定固定版本读取失败。'; } });
  life.add(() => main.remove()); return life.dispose;
}
