import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { MediaRevision } from '../../../../../packages/contracts/generated/MediaRevision';
import type { SaveQueue } from '../../lib/persistence/save-queue';
import { admitRawDraft } from '../../lib/persistence/draft-store';
import { classifyDraftBranches, classifyReadonlySnapshot } from '../../lib/persistence/recovery';
import type { DraftBranchEnvelope } from '../../lib/persistence/types';
export function ProjectSaveSummary({ assets, projectId, actorId, queue, onSelect }: { assets: readonly MediaRevision[]; projectId: string; actorId: string; queue: SaveQueue; onSelect(asset: MediaRevision): void }) {
  const [disk, setDisk] = useState<Record<string, DraftBranchEnvelope[]>>({});
  const [reading, setReading] = useState(true), [readError, setReadError] = useState(false), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let alive = true; setReading(true); setReadError(false);
    async function read() {
      const result: typeof disk = {};
      for (const asset of assets) {
        if (!alive) return;
        if (asset.project_id !== projectId) continue;
        try {
          const branches = await queue.readDraftBranches(asset.asset_revision_id);
          if (!alive) return;
          const retained: DraftBranchEnvelope[] = [];
          for (const branch of branches) {
            if (queue.getOwnedSummary(asset.asset_revision_id, projectId, actorId)?.draft_id === branch.draft_id) { retained.push(branch); continue; }
            const raw = branch.record;
            if (classifyReadonlySnapshot(raw, asset.asset_revision_id) === 'clean_snapshot') { retained.push(branch); continue; }
            if (!raw || typeof raw !== 'object' || !('draft_owner' in raw) || !raw.draft_owner || typeof raw.draft_owner !== 'object' || !('actor_id' in raw.draft_owner) || !('project_id' in raw.draft_owner) || typeof raw.draft_owner.actor_id !== 'string' || !raw.draft_owner.actor_id || typeof raw.draft_owner.project_id !== 'string' || !raw.draft_owner.project_id) { setReadError(true); continue; }
            if (raw.draft_owner.actor_id !== actorId || raw.draft_owner.project_id !== projectId) continue;
            retained.push(branch);
          }
          result[asset.asset_revision_id] = retained;
        } catch { if (alive) setReadError(true); }
      }
      if (alive) { setDisk(result); setReading(false); }
    }
    void read(); return () => { alive = false; };
  }, [assets, projectId, actorId, queue, refresh]);
  const subscribe = useCallback((notify: () => void) => { const releases = assets.filter(asset => asset.project_id === projectId).map(asset => queue.subscribe(asset.asset_revision_id, () => { notify(); setRefresh(value => value + 1); })); return () => releases.forEach(release => release()); }, [assets, projectId, queue]);
  const snapshot = () => JSON.stringify(assets.filter(asset => asset.project_id === projectId).map(asset => {
    const id = asset.asset_revision_id, memory = queue.getOwnedSummary(id, projectId, actorId);
    const branches = disk[id] ?? [];
    const dispositions = classifyDraftBranches(branches, memory ? queue.getDraftBranchSnapshot(id) : null);
    const retained = branches.filter(branch => classifyReadonlySnapshot(branch.record, id) !== 'clean_snapshot' && branch.draft_id !== memory?.draft_id && !['synced', 'recovered', 'archived'].includes(dispositions.get(branch.draft_id) ?? 'unresolved'));
    return [id, (memory?.pending ?? false) || retained.some(branch => dispositions.get(branch.draft_id) === 'unresolved'), (memory?.failed ?? false) || retained.some(branch => { try { admitRawDraft(branch.record, id); return !!branch.record.save_error || branch.record.pending_outcome === 'unknown'; } catch { return true; } }), retained.some(branch => dispositions.get(branch.draft_id) === 'rescue_only')];
  }));
  const rows = JSON.parse(useSyncExternalStore(subscribe, snapshot, snapshot)) as [string, boolean, boolean, boolean][];
  const pending = rows.filter(row => row[1]).length, failed = rows.filter(row => row[2]).length;
  const history = Object.values(disk).flat().filter(branch => classifyReadonlySnapshot(branch.record, branch.asset_revision_id) === 'clean_snapshot');
  return <details className="utility-panel" open={failed > 0 || readError}>
    <summary>项目保存队列 · 待同步 {pending} · 失败 {failed}</summary>
    <p>{reading ? '正在只读检查项目图片的本地分支；计数尚未完整。' : readError ? '部分本地记录读取失败或身份无法验证；计数不完整，请保留救援记录。' : '当前项目图片、当前身份的本地草稿与保存队列；待同步与失败可重叠。'}</p>
    <button type="button" disabled={reading} onClick={() => setRefresh(value => value + 1)}>重新检查本地摘要</button>
    {rows.filter(row => row[1] || row[2]).map(([id, dirty, error, rescue]) => { const asset = assets.find(item => item.asset_revision_id === id)!; return <button key={id} type="button" onClick={() => onSelect(asset)}>{asset.original_name} · {rescue ? '本地记录未知 / 需救援' : error ? '保存失败 / 结果待核对' : dirty ? '待同步' : '已同步'}</button>; })}
    {history.length > 0 && <details><summary>只读快照留档 · {history.length} 条（无待处理操作）</summary><p>仅依据本地记录的同步标记；未独立核实服务器 ACK，不认领作者，不用于恢复或赋予写权限。</p><ul>{history.map(branch => {
      admitRawDraft(branch.record, branch.asset_revision_id);
      return <li key={branch.draft_id}>规范 {branch.record.ontology_version_id} · base {branch.record.base_revision_id} · 只读留档</li>;
    })}</ul></details>}
  </details>;
}
