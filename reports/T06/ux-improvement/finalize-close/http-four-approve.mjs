import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { start_test_app, bootstrap_admin_for_test } from '../../../../tests/support/app.ts';

const app = await start_test_app();
const evidence = { transport: 'real isolated loopback HTTP', origin: app.base_url, approvals: [] };
async function checked(client, method, path, body, status = 200) {
  const result = await client.request(method, path, body);
  assert.equal(result.status, status, `${method} ${path}: ${JSON.stringify(result.json)}`);
  return result.json;
}
async function member(admin, projectId, role) {
  const username = `close-${role}-${crypto.randomUUID()}`;
  const password = `${crypto.randomUUID()}-synthetic-pass`;
  const user = await checked(admin, 'POST', '/api/users', { username, password }, 201);
  await checked(admin, 'POST', `/api/projects/${projectId}/members`, { user_id: user.user_id, role });
  const login = await fetch(new URL('/api/session/login', app.base_url), {
    method: 'POST', headers: { origin: app.base_url, 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];
  const { csrf_token } = await login.json();
  return { userId: user.user_id, client: { request: async (method, path, body) => {
    const response = await fetch(new URL(path, app.base_url), {
      method, headers: { cookie, origin: app.base_url, 'x-csrf-token': csrf_token, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, json: await response.json() };
  } } };
}
try {
  const admin = await bootstrap_admin_for_test(app);
  const bytes = new Uint8Array(await readFile(new URL('../../../../tests/fixtures/media/orientation-1.jpg', import.meta.url)));
  const pending = [];
  for (let index = 0; index < 4; index++) {
    const project = await checked(admin, 'POST', '/api/projects', { name: `Close HTTP ${index}`, description: 'synthetic close acceptance', allow_self_review: false }, 201);
    const projectId = project.project_id;
    const ontology = await checked(admin, 'POST', `/api/projects/${projectId}/ontologies`, {
      guidelines_markdown: 'Synthetic negative review', labels: [{ label_id: 'person', name: 'Person', color: '#0099ff', shortcut: null, allowed_geometry_types: ['bbox_xyxy'], attributes: [] }],
    }, 201);
    assert.equal((await admin.upload(`/api/projects/${projectId}/assets`, bytes, `close-${index}.jpg`, undefined, 'image/jpeg')).status, 202);
    await checked(admin, 'POST', '/internal/test/jobs/drain', {});
    const assets = await checked(admin, 'GET', `/api/projects/${projectId}/assets`);
    const assetId = assets.items[0].asset_revision_id;
    const head = await checked(admin, 'GET', `/api/assets/${assetId}/annotation?ontology_version_id=${ontology.ontology_version_id}`);
    const annotator = await member(admin, projectId, 'annotator');
    const reviewer = await member(admin, projectId, 'reviewer');
    const task = await checked(admin, 'POST', `/api/projects/${projectId}/tasks`, { asset_revision_id: assetId, ontology_version_id: ontology.ontology_version_id, assignee_id: annotator.userId });
    const lease = await checked(annotator.client, 'POST', `/api/tasks/${task.task_id}/lease`, { action: 'acquire' });
    const save = await checked(annotator.client, 'PUT', `/api/assets/${assetId}/annotation`, {
      operation_id: crypto.randomUUID(), base_revision_id: head.annotation_revision_id,
      document: { ...head.document, completion: 'confirmed_negative' },
      lease: { task_id: task.task_id, fencing_token: lease.fencing_token }, suggestion_decisions: [],
    });
    const revisionId = save.revision.annotation_revision_id;
    const submission = await checked(annotator.client, 'POST', `/api/tasks/${task.task_id}/submit`, { annotation_revision_ids: [revisionId] });
    pending.push({ reviewer, projectId, taskId: task.task_id, reviewId: submission.review_id, revisionId });
  }
  evidence.approvals = await Promise.all(pending.map(async item => {
    const result = await checked(item.reviewer.client, 'POST', `/api/reviews/${item.reviewId}/decision`, {
      decision: 'approve', reason: 'Synthetic actual HTTP four writer acceptance', revision_ids: [item.revisionId],
    });
    assert.deepEqual(result.revision_ids, [item.revisionId]);
    const tasks = await checked(item.reviewer.client, 'GET', `/api/projects/${item.projectId}/tasks`);
    const durable = tasks.items.find(row => row.task_id === item.taskId);
    assert.equal(durable.review_decision, 'approve');
    assert.deepEqual(durable.revision_ids, [item.revisionId]);
    return { project_id: item.projectId, review_id: item.reviewId, revision_id: item.revisionId, status: 200, readback: 'approve' };
  }));
} finally {
  await app.stop();
}
evidence.result = 'passed';
await writeFile(new URL('http-four-approve.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence, null, 2));
