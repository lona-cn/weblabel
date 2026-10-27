import type { SessionController } from '../../app/session';
import { saveAuthorizationEpoch, subscribeSaveAuthorization } from '../../lib/t15/api';
import { createButton } from '../../ui/button';
import { explanations, type LossReport } from './loss-report';
import './native-delivery.css';
export function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node;
}
export function actions(signal: AbortSignal) {
  return (text: string, run: () => unknown, testId?: string): HTMLButtonElement => {
    const button = createButton({ text, testId: testId ?? '', signal, onClick: () => { void run(); } });
    if (!testId) delete button.dataset.testid;
    return button;
  };
}
export function field<T extends HTMLElement>(text: string, input: T): HTMLLabelElement { const label = element('label', text); label.append(input); return label; }
export function options(select: HTMLSelectElement, rows: readonly { value: string; text: string; disabled?: boolean }[], value = select.value) {
  const nodes = rows.map(row => { const option = element('option', row.text); option.value = row.value; option.disabled = !!row.disabled; return option; });
  select.replaceChildren(...nodes); select.value = value;
}
export function details(title: string, value: unknown): HTMLDetailsElement {
  const node = element('details'); node.append(element('summary', title), element('pre', typeof value === 'string' ? value : JSON.stringify(value, null, 2))); return node;
}
export function lossView(report: LossReport): HTMLElement {
  const section = element('section'); section.setAttribute('aria-label', '格式损失报告'); section.append(element('h3', '实际损失报告'));
  if (!report.losses.length) { section.append(element('p', '服务端报告未列出损失。')); return section; }
  const table = element('table'); const head = element('thead'), header = element('tr'), body = element('tbody');
  for (const name of ['字段', '实际影响', '技术原因']) { const cell = element('th', name); cell.scope = 'col'; header.append(cell); }
  head.append(header);
  for (const loss of report.losses) { const row = element('tr'), field = element('th', loss.field); field.scope = 'row'; row.append(field, element('td', explanations[loss.field] ?? '字段发生变化，请核对技术说明。'), element('td', loss.reason)); body.append(row); }
  table.append(head, body); section.append(table); return section;
}
export function lifetime(parent: AbortSignal) {
  const owner = new AbortController(); const cleanups: (() => void)[] = []; let disposed = false;
  function dispose() { if (disposed) return; disposed = true; owner.abort(); parent.removeEventListener('abort', dispose); for (const cleanup of cleanups.splice(0).reverse()) cleanup(); }
  if (parent.aborted) dispose(); else parent.addEventListener('abort', dispose, { once: true });
  return { signal: owner.signal, get alive() { return !disposed; }, dispose, add(cleanup: () => void) { if (disposed) cleanup(); else cleanups.push(cleanup); } };
}
export interface AuthorizedReadScope {
  readonly signal: AbortSignal;
  current(): boolean;
  revoke(): void;
  dispose(): void;
}
// Read ownership is revocable independently of POST settlement and retained ACKs.
export function createAuthorizedReadScope(parent: AbortSignal, session: SessionController, projectId: string, onRevoke: () => void): AuthorizedReadScope {
  const owned = lifetime(parent);
  const initial = session.getSnapshot();
  const identity = initial.kind === 'authenticated' ? JSON.stringify([initial.session.user_id, initial.session.platform_admin, initial.session.project_roles]) : null;
  const epoch = saveAuthorizationEpoch();
  let revoked = false;
  function revoke() {
    if (revoked) return;
    revoked = true; owned.dispose(); onRevoke();
  }
  function current() {
    if (!owned.alive || revoked) return false;
    const entry = session.getSnapshot();
    if (saveAuthorizationEpoch() === epoch && entry.kind === 'authenticated'
      && JSON.stringify([entry.session.user_id, entry.session.platform_admin, entry.session.project_roles]) === identity
      && entry.session.project_roles.some(role => role.project_id === projectId && ['admin', 'annotator', 'reviewer', 'viewer'].includes(role.role))) return true;
    revoke(); return false;
  }
  owned.add(session.subscribe(() => { current(); }));
  owned.add(subscribeSaveAuthorization(() => { current(); }));
  return { signal: owned.signal, current, revoke, dispose: owned.dispose };
}
export async function downloadVerified(artifact: { download_url: string; byte_size: number; object_sha256: string }, filename: string, signal: AbortSignal, zip: boolean, isCurrent: () => boolean = () => !signal.aborted) {
  if (signal.aborted || !isCurrent()) return;
  if (!/^\/api\/exports\/[^/]+\/download$/.test(artifact.download_url) || !/^[a-f0-9]{64}$/i.test(artifact.object_sha256) || !Number.isSafeInteger(artifact.byte_size) || artifact.byte_size < 0) throw new Error('产物下载身份、字节预算或SHA-256无效。');
  const response = await fetch(artifact.download_url, { credentials: 'same-origin', signal });
  if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`);
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) !== artifact.byte_size) throw new Error('下载声明字节数不匹配。');
  const chunks: BlobPart[] = []; let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    const abort = () => { void reader.cancel().catch(() => undefined); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      while (!signal.aborted) {
        const item = await reader.read(); if (item.done) break;
        total += item.value.byteLength;
        if (total > artifact.byte_size) { await reader.cancel(); throw new Error('下载超过固定产物字节预算。'); }
        chunks.push(item.value as BlobPart);
      }
    } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
  }
  if (signal.aborted || !isCurrent()) return;
  if (total !== artifact.byte_size) throw new Error('下载字节数不匹配。');
  const blob = new Blob(chunks, { type: response.headers.get('content-type') ?? '' }); const bytes = await blob.arrayBuffer();
  if (signal.aborted || !isCurrent()) return;
  if (zip) { const signature = new Uint8Array(bytes); if (blob.type.split(';')[0] !== 'application/zip' || signature[0] !== 80 || signature[1] !== 75 || !((signature[2] === 3 && signature[3] === 4) || (signature[2] === 5 && signature[3] === 6))) throw new Error('下载不是 ZIP 数据包。'); }
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  if (signal.aborted || !isCurrent()) return;
  if ([...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('') !== artifact.object_sha256.toLowerCase()) throw new Error('下载 SHA-256 不匹配。');
  const url = URL.createObjectURL(blob);
  try { if (signal.aborted || !isCurrent()) return; const link = element('a'); link.href = url; link.download = filename; link.click(); } finally { URL.revokeObjectURL(url); }
}
