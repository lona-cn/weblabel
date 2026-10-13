import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { download_for_test, login_at_origin_for_test, start_test_app } from '../support/app';
import { createDeliveryFixture, exportAndVerifyDelivery, freezeDelivery, mutateDeliveryHead, pollDeliveryJob } from '../support/dataset-delivery';

it('delivers every frozen asset and full document through independently parsed native, YOLO and COCO background exports', async () => {
  const app = await start_test_app('false', 'background');
  try {
    // Nine imports exercise all splits, classes, distinct patterns, multi-object rows,
    // negatives, an explicit exclusion and an outside-snapshot asset without scale traffic.
    const fixture = await createDeliveryFixture(app, 9, 2);
    const frozen = await freezeDelivery(fixture, [0, 1, 2, 3, 4, 5, 6], [7]);
    const laterId = await mutateDeliveryHead(fixture, 1);
    const later = await fixture.admin.request('POST', `/api/projects/${fixture.projectId}/dataset-versions`, { ...frozen.request, operation_id: randomUUID(), items: [{ ...frozen.request.items[1], annotation_revision_id: laterId }], excluded: [] });
    expect(later.status).toBe(422);
    expect(later.json).toMatchObject({ code: 'SNAPSHOT_NOT_APPROVED' });
    const replay = await fixture.admin.request('POST', `/api/projects/${fixture.projectId}/dataset-versions`, frozen.request);
    expect(replay.status).toBe(200); expect(replay.json).toMatchObject({ dataset_version_id: frozen.datasetId });
    const conflicting = structuredClone(frozen.request); conflicting.items[0].split = 'val';
    expect((await fixture.admin.request('POST', `/api/projects/${fixture.projectId}/dataset-versions`, conflicting)).status).toBe(409);
    for (const format of ['native', 'yolo', 'coco'] as const) {
      const receipt = await exportAndVerifyDelivery(frozen, format);
      expect(receipt).toMatchObject({ format, datasetId: frozen.datasetId, assetCount: 7, pixelChecks: 7, negativeCount: 2 });
      const result = await pollDeliveryJob(fixture.admin, receipt.jobId);
      expect((await download_for_test(fixture.reviewer, result.download_url)).status).toBe(200);
      const nonmember = await app.as_user('viewer');
      const denied = await download_for_test(nonmember, result.download_url);
      expect(denied.status).toBe(404); expect(JSON.parse(Buffer.from(denied.bytes).toString())).toMatchObject({ code: 'EXPORT_NOT_FOUND' });
      const missing = await download_for_test(fixture.admin, `/api/exports/${randomUUID()}/download`);
      expect(missing.status).toBe(404);
      const unauthenticated = await fetch(new URL(result.download_url, app.base_url)); expect(unauthenticated.status).toBe(401);
    }
    const exportPath = `/api/dataset-versions/${frozen.datasetId}/exports`;
    const intent = { operation_id: randomUUID(), format: 'native', loss_ack: false };
    const first = await fixture.admin.request<Record<string, any>>('POST', exportPath, intent); expect(first.status).toBe(202);
    const duplicate = await fixture.admin.request<Record<string, any>>('POST', exportPath, intent); expect(duplicate.status).toBe(200); expect(duplicate.json.job_id).toBe(first.json.job_id);
    expect((await fixture.admin.request('POST', exportPath, { ...intent, format: 'yolo', loss_ack: true })).status).toBe(409);
    const sameSnapshot = await fixture.admin.request<Record<string, any>>('POST', exportPath, { ...intent, operation_id: randomUUID() }); expect(sameSnapshot.status).toBe(202);
    const firstResult = await pollDeliveryJob(fixture.admin, first.json.job_id); const secondResult = await pollDeliveryJob(fixture.admin, sameSnapshot.json.job_id);
    expect(secondResult.object_sha256).toBe(firstResult.object_sha256);
    const foreign = await fixture.admin.request<Record<string, any>>('POST', '/api/projects', { name: `Foreign ${randomUUID()}`, description: 'Replay and identity scope', allow_self_review: false }); expect(foreign.status).toBe(201);
    expect((await fixture.admin.request('POST', `/api/projects/${foreign.json.project_id}/dataset-versions`, frozen.request)).status).toBe(409);
    const changedOntology = await fixture.admin.request<Record<string, any>>('POST', `/api/projects/${fixture.projectId}/ontologies`, { guidelines_markdown: 'Unrelated later ontology', labels: fixture.ontology.labels }); expect(changedOntology.status).toBe(201);
    const wrongOntology = await fixture.admin.request('POST', `/api/projects/${fixture.projectId}/dataset-versions`, { ...frozen.request, operation_id: randomUUID(), ontology_version_id: changedOntology.json.ontology_version_id });
    expect(wrongOntology.status).toBe(422); expect(wrongOntology.json).toMatchObject({ code: 'SNAPSHOT_REVISION_INVALID' });
  } finally { await app.stop(); }
}, 180_000);

it('keeps authenticated JSON, multipart and binary transports on their exact owned origin without following redirects', async () => {
  // Real ephemeral TCP servers model hostile URL/redirect destinations. This is
  // transport isolation, not a substitute for the production API journey above.
  const origins: string[] = ['', ''];
  const hits: { path: string; cookie: string; csrf: string; body: string }[][] = [[], []];
  const servers = [0, 1].map(index => createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const hit = { path: request.url ?? '', cookie: request.headers.cookie ?? '', csrf: String(request.headers['x-csrf-token'] ?? ''), body: Buffer.concat(chunks).toString() };
    hits[index]!.push(hit);
    if (hit.path === '/api/session/login') {
      response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'weblabel_session=owned-' + index + '; HttpOnly; Path=/' });
      response.end(JSON.stringify({ csrf_token: 'csrf-' + index }));
    } else if (hit.path === '/redirect-local' || hit.path === '/redirect-foreign') {
      const destination = hit.path === '/redirect-local' ? index : 1 - index;
      response.writeHead(307, { location: origins[destination]! + '/redirect-target' }); response.end();
    } else {
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(hit));
    }
  }));
  try {
    for (let index = 0; index < servers.length; index++) {
      const ready = Promise.withResolvers<void>(); const server = servers[index]!;
      server.once('error', ready.reject); server.listen(0, '127.0.0.1', ready.resolve); await ready.promise;
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing TCP address');
      origins[index] = 'http://127.0.0.1:' + address.port;
    }
    const clients = await Promise.all(origins.map(origin => login_at_origin_for_test(origin, { username: 'owned-synthetic', password: randomUUID() })));
    for (let index = 0; index < clients.length; index++) {
      const client = clients[index]!; const foreignIndex = 1 - index; const foreign = origins[foreignIndex]!;
      const beforeForeign = hits[foreignIndex]!.length; const beforeOwn = hits[index]!.length;
      for (const path of [foreign + '/forbidden', '//' + new URL(foreign).host + '/forbidden', origins[index]!.replace('http://', 'http://blocked:secret@') + '/forbidden']) {
        await expect(client.request('POST', path, { secret: 'owned-body' })).rejects.toThrow('same-origin');
        await expect(client.upload(path, new Uint8Array([1, 2, 3]), 'owned.bin')).rejects.toThrow('same-origin');
        await expect(download_for_test(client, path)).rejects.toThrow('same-origin');
      }
      expect(hits[foreignIndex]!.length).toBe(beforeForeign); expect(hits[index]!.length).toBe(beforeOwn);
      for (const path of ['/redirect-local', '/redirect-foreign']) {
        await expect(client.request('POST', path, { secret: 'owned-body' })).rejects.toThrow();
        await expect(client.upload(path, new Uint8Array([1, 2, 3]), 'owned.bin')).rejects.toThrow();
        await expect(download_for_test(client, path)).rejects.toThrow();
      }
      expect(hits[foreignIndex]!.length).toBe(beforeForeign);
      const redirects = hits[index]!.slice(beforeOwn);
      expect(redirects.map(hit => hit.path)).toEqual(['/redirect-local', '/redirect-local', '/redirect-local', '/redirect-foreign', '/redirect-foreign', '/redirect-foreign']);
      expect(redirects.map(hit => hit.cookie)).toEqual(Array(6).fill('weblabel_session=owned-' + index));
      expect(redirects.map(hit => hit.csrf)).toEqual(['csrf-' + index, 'csrf-' + index, '', 'csrf-' + index, 'csrf-' + index, '']);
      expect(hits.flat().filter(hit => hit.path === '/redirect-target' || hit.path === '/forbidden')).toEqual([]);
      const json = await client.request<Record<string, string>>('POST', '/normal-json', { synthetic: index });
      expect(json.status).toBe(200); expect(json.json).toMatchObject({ cookie: 'weblabel_session=owned-' + index, csrf: 'csrf-' + index, body: JSON.stringify({ synthetic: index }) });
      const multipart = await client.upload<Record<string, string>>('/normal-upload', new TextEncoder().encode('owned-upload-' + index), 'owned.bin');
      expect(multipart.status).toBe(200); expect(multipart.json).toMatchObject({ cookie: 'weblabel_session=owned-' + index, csrf: 'csrf-' + index }); expect(multipart.json.body).toContain('owned-upload-' + index);
      const binary = await download_for_test(client, '/normal-download'); expect(binary.status).toBe(200);
      expect(JSON.parse(Buffer.from(binary.bytes).toString())).toMatchObject({ cookie: 'weblabel_session=owned-' + index, csrf: '' });
    }
  } finally {
    await Promise.all(servers.map(async server => {
      if (!server.listening) return;
      const closed = Promise.withResolvers<void>(); server.close(error => error ? closed.reject(error) : closed.resolve()); server.closeAllConnections(); await closed.promise;
    }));
  }
}, 20_000);
