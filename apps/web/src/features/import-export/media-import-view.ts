import { api, type Session } from '../../lib/t15/api';
import type { TransfersMountContext } from '../workbench/workbench-context';
import { element, actions, field, details, lifetime, createAuthorizedReadScope } from './delivery-dom';
import { diagnosticText as failureText, isAmbiguous } from './loss-report';
type Item = { item_index: number; state: string; error: string | null; error_code: string | null };
const reasons: Record<string, string> = {
  TOO_MANY_BYTES: '文件超过上传预算，请缩小后另行导入。', UNSUPPORTED_FORMAT: '仅支持静态PNG/JPEG，内容与MIME必须一致。', EDGE_LIMIT: '图片边长超过4096，请缩小尺寸后另行导入。', PIXEL_LIMIT: '图片像素超过16,777,216，请缩小后另行导入。', FILENAME_TOO_LONG: '文件名为空、包含控制字符或超过255 UTF-8字节。', INVALID_IMAGE: '图片损坏或不完整。', MULTIPLE_FRAMES: '不支持多帧媒体，请提取单张静态图片。', UNSUPPORTED_COLOR: '颜色编码不支持，请转为RGB静态图片。', INVALID_ORIENTATION: 'EXIF方向无效。', STORAGE_FAILED: '存储失败，请检查本地服务及磁盘后核对媒体。', OBJECT_STORAGE_FAILED: '原文件存储失败。', OBJECT_UNAVAILABLE: '作业原文件不可读。', INVALID_METADATA: '导入元数据无效。',
};
type MediaFileMetadata = { name: string; size: number; type: string; lastModified: number };
type MediaBatch = {
  files: readonly MediaFileMetadata[];
  jobId: string | null;
  items: Item[];
  status: string;
  unknown: boolean;
  sending: boolean;
  terminal: boolean;
  notified: boolean;
  error: string | null;
};
type MediaSession = { batch: MediaBatch | null; listeners: Set<() => void> };
// Keep only original batch metadata and settlement fencing, never File bytes.
const mediaSessions = new Map<string, MediaSession>();
export function mountMediaImportView(root: HTMLElement, context: TransfersMountContext): () => void {
  const life = lifetime(context.signal); const entry = context.session.getSnapshot();
  const actor = entry.kind === 'authenticated' ? entry.session.user_id : null;
  const key = JSON.stringify([context.projectId, actor]);
  let record = mediaSessions.get(key);
  if (!record) { record = { batch: null, listeners: new Set() }; mediaSessions.set(key, record); }
  const session = record;
  const action = actions(life.signal);
  let files: File[] = [], busy = false, timer: number | null = null;
  const section = element('section'); section.setAttribute('aria-label', '媒体导入');
  const input = element('input'); input.type = 'file'; input.accept = 'image/png,image/jpeg'; input.multiple = true; input.dataset.testid = 'media-import';
  const progress = element('progress'); progress.setAttribute('aria-label', '逐文件媒体处理进度');
  const message = element('p'); message.setAttribute('role', 'status');
  const error = element('p'); error.setAttribute('role', 'alert'); error.hidden = true;
  const list = element('ol');
  const upload = action('上传媒体', () => void send()); upload.className = 'primary';
  const recheck = action('重新检查状态', () => void observe());
  const refresh = action('只读刷新媒体列表', async () => {
    if (!current() || busy || session.batch?.sending) return;
    busy = true; render();
    try { await context.refreshAssets(); }
    catch (cause) { if (current()) showError(cause); }
    finally { busy = false; render(); }
  });
  const fresh = action('选择新的导入批次', () => {
    const batch = session.batch;
    if (!canImport() || busy || !batch?.terminal || batch.unknown || batch.sending) return;
    session.batch = null; files = []; input.value = ''; error.hidden = true; publish(); input.focus();
  });
  section.append(element('h3', '媒体导入'), element('p', '支持静态PNG/JPEG；边长≤4096，像素≤16,777,216。先导入图片；空文档不等于已确认无目标。'), field('媒体文件', input), upload, progress, message, error, list, recheck, refresh, fresh); root.append(section);
  const reads = createAuthorizedReadScope(life.signal, context.session, context.projectId, () => {
    window.clearTimeout(timer ?? undefined); timer = null; render();
  });
  life.add(reads.dispose);
  function current() { return life.alive && reads.current(); }
  function canImport() {
    const auth = context.session.getSnapshot();
    return current() && context.getScope().canUploadMedia && auth.kind === 'authenticated'
      && auth.session.project_roles.some((role: Session['project_roles'][number]) => role.project_id === context.projectId && ['admin', 'annotator'].includes(role.role));
  }
  function publish() { for (const listener of session.listeners) listener(); }
  function showError(cause: unknown) { if (!life.alive) return; const text = failureText(cause); if (session.batch) session.batch.error = text; error.hidden = false; error.textContent = text; }
  function render() {
    if (!life.alive) return;
    const batch = session.batch, active = current(), pending = busy || !!batch?.sending;
    section.setAttribute('aria-busy', String(pending));
    input.disabled = !canImport() || pending || !!batch;
    upload.disabled = input.disabled || !files.length;
    recheck.hidden = !batch?.jobId; recheck.disabled = pending || !active;
    refresh.hidden = !batch?.unknown || !!batch?.jobId; refresh.disabled = pending || !active;
    fresh.hidden = !batch?.terminal; fresh.disabled = pending || !!batch?.unknown || !canImport();
    message.textContent = !active ? '身份、项目权限或授权epoch已变化，读取和轮询已停止；原批次保留。'
      : batch ? `${batch.status}${batch.jobId ? ` · 原作业 ${batch.jobId}` : ''}${batch.unknown ? '；上传结果未知，只读核对，不重复上传。' : ''}` : files.length ? '待上传' : '待选择';
    if (batch?.error) { error.hidden = false; error.textContent = batch.error; } else error.hidden = true;
    const originals = batch?.files ?? files;
    progress.max = Math.max(1, originals.length); progress.value = batch?.items.filter(item => ['succeeded', 'failed'].includes(item.state)).length ?? 0;
    list.replaceChildren(...originals.map((file, index) => {
      const row = element('li'); row.dataset.testid = 'media-import-item';
      const item = batch?.items.find(item => item.item_index === index);
      row.append(element('strong', file.name), element('p', item?.state === 'succeeded' ? '成功' : item?.state === 'failed' ? '失败' : batch?.status ?? '待上传'));
      if (item?.state === 'failed') row.append(element('p', reasons[item.error_code ?? ''] ?? '错误种类未知，请保留诊断并核对本地服务。'), details('技术诊断', item));
      return row;
    }));
    window.clearTimeout(timer ?? undefined); timer = null;
    if (active && batch?.jobId && !pending && ['已排队', '处理中'].includes(batch.status)) timer = window.setTimeout(() => { timer = null; void observe(); }, 1000);
  }
  async function readJob(batch: MediaBatch) {
    if (!current() || !batch.jobId || session.batch !== batch) return;
    const job = await api.job(batch.jobId, reads.signal);
    if (!current() || session.batch !== batch) return;
    if (job.job_id !== batch.jobId) throw new Error('作业身份不匹配。');
    const value = job.result, parsed: Item[] = []; const seen = new Set<number>();
    if (value && typeof value === 'object' && 'items' in value && Array.isArray(value.items)) {
      for (const item of value.items) {
        if (!item || !Number.isSafeInteger(item.item_index) || item.item_index < 0 || item.item_index >= batch.files.length || seen.has(item.item_index) || typeof item.state !== 'string' || (item.error !== null && typeof item.error !== 'string') || (item.error_code !== null && typeof item.error_code !== 'string')) throw new Error('逐文件作业响应无效。');
        seen.add(item.item_index); parsed.push(item);
      }
    } else if (['succeeded', 'failed'].includes(job.state)) throw new Error('缺少逐文件作业结果。');
    const succeeded = parsed.filter(item => item.state === 'succeeded').length, failed = parsed.filter(item => item.state === 'failed').length;
    const terminal = ['succeeded', 'failed'].includes(job.state);
    batch.items = parsed; batch.error = null;
    batch.terminal = terminal && succeeded + failed === batch.files.length;
    batch.status = terminal ? succeeded > 0 && failed > 0 ? '部分成功' : succeeded === batch.files.length ? '成功' : failed === batch.files.length ? '失败' : '状态未知'
      : job.state === 'queued' ? '已排队' : job.state === 'running' ? '处理中' : ['interrupted', 'cancelled', 'stopped'].includes(job.state) ? '已中断' : '状态未知';
    publish();
    if (terminal && succeeded && !batch.notified && current()) {
      batch.notified = true;
      try { await context.refreshAssets(); }
      catch (cause) { batch.notified = false; if (current()) showError(new Error(`结果已确认，但媒体列表刷新失败。${failureText(cause)}`)); }
    }
  }
  async function send() {
    if (!canImport() || busy || session.batch || !files.length) return;
    const originals = files; files = [];
    const batch: MediaBatch = { files: originals.map(file => ({ name: file.name, size: file.size, type: file.type, lastModified: file.lastModified })), jobId: null, items: [], status: '正在上传', unknown: true, sending: true, terminal: false, notified: false, error: null };
    session.batch = batch; busy = true; error.hidden = true; publish();
    try {
      const response = await api.importAssets(context.projectId, originals);
      if (!response?.import_job_id) throw new Error('上传回执缺少作业编号。');
      batch.jobId = response.import_job_id; batch.unknown = false; batch.status = '已排队'; batch.sending = false; publish();
      if (current()) await readJob(batch);
    } catch (cause) {
      if (batch.jobId) {
        if (current()) { batch.status = '状态未知'; batch.error = `仅重新检查原作业。${failureText(cause)}`; }
      } else {
        batch.unknown = isAmbiguous(cause); batch.terminal = !batch.unknown; batch.status = batch.unknown ? '状态未知' : '失败';
        batch.error = failureText(cause);
      }
    } finally { batch.sending = false; busy = false; publish(); }
  }
  async function observe() {
    const batch = session.batch;
    if (!current() || busy || !batch?.jobId || batch.sending) return;
    busy = true; render();
    try { await readJob(batch); }
    catch (cause) { if (current() && session.batch === batch) { batch.status = '状态未知'; batch.error = `无法确认作业；只读检查原作业，不重复上传。${failureText(cause)}`; } }
    finally { busy = false; publish(); }
  }
  input.addEventListener('change', () => {
    if (!canImport() || busy || session.batch) return;
    files = Array.from(input.files ?? []); error.hidden = true; render();
  }, { signal: life.signal });
  session.listeners.add(render); life.add(() => session.listeners.delete(render));
  life.add(context.subscribe(render));
  life.add(() => { window.clearTimeout(timer ?? undefined); files = []; section.remove(); });
  render(); return life.dispose;
}
