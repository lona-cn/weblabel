import { useEffect, useRef, useState } from 'react';
import './import-export.css';
import { api, ApiFailure } from '../../lib/t15/api';
import { failureText } from './LossReportView';
type Props = { projectId: string; canImport: boolean; catalogLocked?: boolean; onImported: () => Promise<void> };
type Item = { item_index: number; state: string; error: string | null; error_code: string | null };
const reasons: Record<string, string> = {
  TOO_MANY_BYTES: '文件超过上传预算，请缩小文件后另行导入。',
  UNSUPPORTED_FORMAT: '仅支持静态 PNG/JPEG，文件内容和 MIME 必须一致。请转换格式后另行导入。',
  EDGE_LIMIT: '图片边长超过 4096，请缩小尺寸后另行导入。',
  PIXEL_LIMIT: '图片像素超过 16,777,216，请缩小尺寸后另行导入。',
  FILENAME_TOO_LONG: '文件名为空、包含控制字符或超过 255 UTF-8 字节，请重命名后另行导入。',
  INVALID_IMAGE: '图片损坏或不完整，请检查原文件并重新生成有效图片。',
  MULTIPLE_FRAMES: '多帧或多图媒体不受支持，请提取单张静态图片后另行导入。',
  UNSUPPORTED_COLOR: '颜色编码不支持（例如 CMYK），请转为 RGB 静态图片。',
  INVALID_ORIENTATION: 'EXIF 方向无效，请修复或转换图片。',
  STORAGE_FAILED: '存储失败，请检查本地服务及磁盘后核对已导入媒体。',
  OBJECT_STORAGE_FAILED: '原文件存储失败，请检查本地服务及磁盘。',
  OBJECT_UNAVAILABLE: '作业原文件不可读，请检查本地服务及磁盘。',
  INVALID_METADATA: '导入元数据无效，请保留诊断并检查本地服务。',
};
export function MediaImportPanel(props: Props) { return <MediaImportSession key={props.projectId} {...props} />; }
function MediaImportSession(props: Props) {
  const latest = useRef(props); latest.current = props;
  const alive = useRef(true); const single = useRef(false); const notified = useRef(false);
  // A queued job belongs to the scope that uploaded it, not a later render's identity.
  const jobCatalogRefresh = useRef(props.onImported);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [files, setFiles] = useState<File[]>([]); const [jobId, setJobId] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]); const [status, setStatus] = useState('待选择');
  const [busy, setBusy] = useState(false); const [unknownUpload, setUnknownUpload] = useState(false); const [error, setError] = useState('');
  // Observe only the acknowledged job. Unknown upload/write results are never replayed.
  useEffect(() => {
    if (!jobId || busy || props.catalogLocked || !['已排队', '处理中'].includes(status)) return;
    const timer = window.setTimeout(() => { if (alive.current) void recheck(); }, 1000);
    return () => window.clearTimeout(timer);
  }, [jobId, busy, status, props.catalogLocked]);
  async function readJob(id: string, originals: File[]) {
    try {
      const job = await api.job(id); if (!alive.current) return;
      const result = job.result; const parsed: Item[] = [];
      if (result && typeof result === 'object' && 'items' in result && Array.isArray(result.items)) {
        const indices = new Set<number>();
        for (const item of result.items) {
          if (!item || typeof item !== 'object' || !Number.isSafeInteger(item.item_index) || item.item_index < 0 || item.item_index >= originals.length || indices.has(item.item_index) || typeof item.state !== 'string' || (item.error !== null && typeof item.error !== 'string') || (item.error_code !== null && typeof item.error_code !== 'string')) throw new Error('Invalid job result');
          indices.add(item.item_index); parsed.push({ item_index: item.item_index, state: item.state, error: item.error, error_code: item.error_code });
        }
      } else if (job.state === 'succeeded' || job.state === 'failed') throw new Error('Missing job result');
      setItems(parsed); setError('');
      const succeeded = parsed.filter(item => item.state === 'succeeded').length;
      const failed = parsed.filter(item => item.state === 'failed').length;
      const terminal = ['succeeded', 'failed'].includes(job.state);
      setStatus(terminal ? (succeeded > 0 && failed > 0 ? '部分成功' : succeeded === originals.length ? '成功' : failed === originals.length ? '失败' : '状态未知') : job.state === 'queued' ? '已排队' : job.state === 'running' ? '处理中' : ['interrupted', 'cancelled', 'stopped'].includes(job.state) ? '已中断' : '状态未知');
      if (terminal && succeeded && !notified.current) {
        notified.current = true;
        try { await jobCatalogRefresh.current(); } catch (reason) { notified.current = false; if (alive.current) setError(`导入结果已确认，但媒体列表刷新失败。${failureText(reason)}`); }
      }
    } catch (reason) { if (alive.current) { setStatus('状态未知'); setError(`无法确认作业状态；重新检查只读取原作业。${failureText(reason)}`); } }
  }
  async function upload() {
    if (single.current || latest.current.catalogLocked || !latest.current.canImport || !files.length || unknownUpload || jobId) return;
    jobCatalogRefresh.current = latest.current.onImported;
    single.current = true; setBusy(true); setError(''); setStatus('正在上传'); const originals = [...files];
    try {
      const result = await api.importAssets(props.projectId, originals); if (!alive.current) return;
      if (!result || typeof result.import_job_id !== 'string' || !result.import_job_id) throw new Error('Missing upload receipt');
      setJobId(result.import_job_id); await readJob(result.import_job_id, originals);
    } catch (reason) {
      if (!alive.current) return;
      const uncertain = !(reason instanceof ApiFailure) || reason.status >= 500;
      setUnknownUpload(uncertain); setStatus(uncertain ? '状态未知' : '失败');
      setError(uncertain ? '上传结果未知，不能自动重传。请先只读刷新媒体列表核对；未收到作业编号，无法查询原作业。' : failureText(reason));
    } finally { single.current = false; if (alive.current) setBusy(false); }
  }
  async function recheck() {
    if (single.current || latest.current.catalogLocked || !jobId) return; single.current = true; setBusy(true); await readJob(jobId, files); single.current = false; if (alive.current) setBusy(false);
  }
  return <section className="asset-import-bar import-export-panel" aria-label="媒体导入" aria-busy={busy}>
    <label>媒体文件<input aria-label="媒体文件" type="file" accept="image/png,image/jpeg" multiple disabled={!props.canImport || props.catalogLocked || busy || unknownUpload || !!jobId} onChange={event => { if (latest.current.catalogLocked || single.current) return; setFiles(Array.from(event.target.files ?? [])); setItems([]); setError(''); setStatus('待上传'); }} /></label>
    <button type="button" disabled={!props.canImport || props.catalogLocked || busy || !files.length || unknownUpload || !!jobId} onClick={() => void upload()}>上传媒体</button>
    <p role="status">{status}</p>{error && <p role="alert">{error}</p>}
    <ol>{files.map((file, index) => { const item = items.find(value => value.item_index === index); return <li key={index} data-testid="media-import-item"><strong>{index + 1}. {file.name}</strong><p>{item?.state === 'succeeded' ? '成功' : item?.state === 'failed' ? '失败' : status}</p>{item?.state === 'failed' && <><p>{reasons[item.error_code ?? ''] ?? '错误种类未知，请保留诊断并核对本地服务，不要按英文消息猜测原因。'}</p><details><summary>技术诊断</summary><p>{item.error_code ?? '未知错误种类'}</p><p>{item.error}</p></details></>}</li>; })}</ol>
    {jobId && <button type="button" disabled={busy || props.catalogLocked} onClick={() => void recheck()}>重新检查状态</button>}
    {unknownUpload && <button type="button" disabled={busy || props.catalogLocked} onClick={async () => { if (single.current || latest.current.catalogLocked) return; single.current = true; setBusy(true); const refresh = latest.current.onImported; try { await refresh(); } catch (reason) { if (alive.current) setError(failureText(reason)); } finally { single.current = false; if (alive.current) setBusy(false); } }}>只读刷新媒体列表</button>}
    {jobId && ['成功', '部分成功', '失败'].includes(status) && <button type="button" disabled={busy || props.catalogLocked || !props.canImport} onClick={() => { if (single.current || latest.current.catalogLocked || !latest.current.canImport) return; setJobId(null); setFiles([]); setItems([]); setStatus('待选择'); notified.current = false; }}>选择新的导入批次</button>}
    {status === '已中断' && <p>处理已中断。先重新检查原作业与媒体列表；本服务没有取消或重试上传接口。</p>}
  </section>;
}
