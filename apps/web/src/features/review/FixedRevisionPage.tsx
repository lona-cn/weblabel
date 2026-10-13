import { useEffect, useState } from 'react';
import type { AnnotationRevision } from '../../../../../packages/contracts/generated/AnnotationRevision';
import { reviewApi } from './api';
import { RevisionReviewView } from './RevisionReviewView';
export function FixedRevisionPage({ projectId, assetId, ontologyId, revisionId, onWorkbench, onReview, onProjects }: {
  projectId: string; assetId: string; ontologyId: string; revisionId: string;
  onWorkbench(): void; onReview(): void; onProjects(): void;
}) {
  const [loaded, setLoaded] = useState<{ revision: AnnotationRevision; parent: AnnotationRevision | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    setLoaded(null); setError(null);
    void (async () => {
      if (!assetId || !ontologyId || !revisionId) throw new Error('固定版本入口缺少完整图片或规范目标，不会改为当前版本。');
      const revision = await reviewApi.revision(revisionId);
      if (revision.annotation_revision_id !== revisionId || revision.document.asset_revision_id !== assetId || revision.document.ontology_version_id !== ontologyId) {
        throw new Error('固定版本与指定图片或规范不一致，不会替换为其他图片或当前 head。');
      }
      const parent = revision.parent_revision_id ? await reviewApi.revision(revision.parent_revision_id) : null;
      if (current) setLoaded({ revision, parent });
    })().catch(cause => { if (current) setError(cause instanceof Error ? cause.message : '指定固定版本读取失败。'); });
    return () => { current = false; };
  }, [projectId, assetId, ontologyId, revisionId]);
  return <main className="app-shell" data-testid="fixed-revision-page">
    <header className="topbar"><h1>固定版本检查</h1><nav aria-label="固定版本导航"><button type="button" onClick={onProjects}>项目</button><button type="button" onClick={onReview}>项目任务与审核队列</button><button type="button" disabled={!projectId || !assetId || !ontologyId || !loaded || !!error} onClick={onWorkbench}>打开此图片的当前标注</button></nav></header>
    <p>此处只读并钉住指定 revision，不随当前 head 更新。批准或退回仍须在任务审核队列操作；打开当前标注会重新读取当前版本，不改写此历史版本。</p>
    <details><summary>固定目标与版本凭证</summary><dl><dt>图片</dt><dd>{assetId}</dd><dt>规范</dt><dd>{ontologyId}</dd><dt>版本</dt><dd>{revisionId}</dd></dl></details>
    {error ? <p role="alert">{error}</p> : loaded ? <RevisionReviewView projectId={projectId} revision={loaded.revision} parent={loaded.parent} issues={[]} /> : <p role="status">正在读取指定的不可变版本…</p>}
  </main>;
}
