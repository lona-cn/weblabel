import { afterEach, expect, it, vi } from 'vitest';
import { api, ApiFailure } from '../../lib/t15/api';
afterEach(() => { vi.unstubAllGlobals(); });
it('preserves structured loss evidence and request identity across an HTTP failure', async () => {
  const details = { loss_report: { losses: [{ field: 'attributes', reason: 'not represented' }] }, other: 'retained' };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'LOSS_ACK_REQUIRED', message: 'loss', request_id: 'request-1', details }), { status: 422 })));
  const failure = await api.request('/api/annotation-revisions/r/exports', { method: 'POST', body: '{}' }).catch(error => error);
  expect(failure).toBeInstanceOf(ApiFailure);
  expect(failure).toMatchObject({ status: 422, code: 'LOSS_ACK_REQUIRED', request_id: 'request-1', details });
});
it('does not turn ambiguous network failures into confirmed rejection or resend a write', async () => {
  const fetch = vi.fn().mockRejectedValue(new TypeError('network')); vi.stubGlobal('fetch', fetch);
  await expect(api.request('/api/annotation-import-previews/b/commit', { method: 'POST', body: '{}' })).rejects.toBeInstanceOf(TypeError);
  expect(fetch).toHaveBeenCalledTimes(1);
});
