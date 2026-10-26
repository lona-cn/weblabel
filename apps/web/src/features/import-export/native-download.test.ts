// @vitest-environment jsdom
import { Blob as CompatibleBlob } from 'node:buffer';
import { webcrypto } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { downloadVerified } from './delivery-dom';
import { fileText } from './loss-report';
const bytes = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...Array<number>(18).fill(0)]);
const artifact = { download_url: '/api/exports/fixed-job/download', byte_size: 22, object_sha256: '8739c76e681f900923b900c9df0ef75cf421d39cabb54650c4b9ad19b6a76d85' };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function setup(response: Response) {
  vi.stubGlobal('Blob', CompatibleBlob); vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
  const NativeURL = URL; const revoke = vi.fn(); vi.stubGlobal('URL', class extends NativeURL { static createObjectURL() { return 'blob:verified'; } static revokeObjectURL = revoke; });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {}); return { click, revoke };
}
it('checks ZIP signature, exact bytes and SHA-256 before handing an existing artifact to download', async () => {
  const view = setup(new Response(bytes, { headers: { 'content-type': 'application/zip' } }));
  await downloadVerified(artifact, 'fixed.zip', new AbortController().signal, true); expect(view.click).toHaveBeenCalledTimes(1); expect(view.revoke).toHaveBeenCalledWith('blob:verified'); expect(fetch).toHaveBeenCalledTimes(1);
});
it('stops reading as soon as streamed bytes exceed the fixed artifact budget', async () => {
  const cancel = vi.fn(); const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(23)); }, cancel });
  const view = setup(new Response(stream, { headers: { 'content-type': 'application/zip' } }));
  await expect(downloadVerified(artifact, 'fixed.zip', new AbortController().signal, true)).rejects.toThrow('字节预算'); expect(cancel).toHaveBeenCalledTimes(1); expect(view.click).not.toHaveBeenCalled();
});
it('does not download a well-sized ZIP whose SHA-256 does not match the immutable artifact', async () => {
  const view = setup(new Response(bytes, { headers: { 'content-type': 'application/zip' } }));
  await expect(downloadVerified({ ...artifact, object_sha256: '0'.repeat(64) }, 'fixed.zip', new AbortController().signal, true)).rejects.toThrow('SHA-256'); expect(view.click).not.toHaveBeenCalled();
});
it('aborts an owned pending file read instead of keeping FileReader handlers alive', async () => {
  const owner = new AbortController(); const promise = fileText(new File(['synthetic'], 'source.json'), owner.signal); owner.abort(); await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
});
