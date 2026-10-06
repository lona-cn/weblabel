import { expect, it } from 'vitest';
import { activeDuration, ActivityCollector } from '../../apps/web/src/features/workbench/activity';
import { bootstrap_admin_for_test, start_test_app } from '../support/app';
import type { ActivitySessionPage } from '../../packages/contracts/generated/ActivitySessionPage';
import type { ActivitySession } from '../../packages/contracts/generated/ActivitySession';
import { analyzePilot } from '../../scripts/analyze-pilot.mjs';

it('excludes unfocused and idle time beyond 60 seconds', () => {
  expect(activeDuration([{ start_ms: 0, end_ms: 1000, focused: true }, { start_ms: 1000, end_ms: 9000, focused: false }])).toBe(1000);
  let now = 0;
  const collector = new ActivityCollector('project', 'actor', () => now);
  collector.setEnabled(true);
  now = 90_000; collector.commit();
  expect(collector.totals().task).toBe(60_000);
  now = 100_000; collector.interact('correction');
  now = 101_000; collector.setFocused(false);
  now = 200_000; collector.commit();
  expect(collector.totals().correction).toBe(1000);
});

it('does not count rollback twice and keeps model waiting separate', () => {
  let now = 1000;
  const collector = new ActivityCollector('project', 'actor', () => now);
  collector.setEnabled(true);
  now = 2000; collector.interact('annotation');
  now = 1000; collector.commit();
  now = 2500; collector.setKind('model_wait');
  now = 92_500; collector.commit();
  expect(collector.totals()).toEqual({ task: 1000, annotation: 500, correction: 0, review: 0, switch: 0, model_wait: 90_000 });
});

it('is disabled by default and reloads only committed intervals into a fresh session', () => {
  const values: Record<string, string> = {};
  const storage = { getItem: (key: string) => values[key] ?? null, setItem: (key: string, value: string) => { values[key] = value; }, removeItem: (key: string) => { delete values[key]; } };
  let now = 0;
  const original = new ActivityCollector('project', 'actor', () => now, storage);
  now = 9000; original.interact(); expect(original.totals().task).toBe(0);
  original.setEnabled(true); now = 10_000; original.commit();
  const reloaded = new ActivityCollector('project', 'actor', () => 1, storage);
  expect(reloaded.currentSession).not.toBe(original.currentSession);
  expect(reloaded.isEnabled()).toBe(false);
  expect(reloaded.totals().task).toBe(1000);
  reloaded.commit(); expect(reloaded.totals().task).toBe(1000);
  const otherProject = new ActivityCollector('other', 'actor', () => 0, storage);
  expect(otherProject.totals().task).toBe(0);
});

it('persists real actor-owned project checkpoints with immutable prefixes, CAS, auth and pagination', async () => {
  const app = await start_test_app();
  try {
    const admin = await bootstrap_admin_for_test(app);
    const viewer = await app.as_user('viewer');
    const session = await viewer.request<{ user_id: string; project_roles: { project_id: string }[] }>('GET', '/api/session');
    const projectId = session.json.project_roles[0]!.project_id;
    const base = `/api/projects/${projectId}/activity-sessions`;
    const first = { expected_version: 0, intervals: [{ seq: 0, kind: 'annotation', duration_ms: 1200 }] };
    const created = await viewer.request<ActivitySession>('PUT', `${base}/session-a`, first);
    expect(created.status).toBe(200); expect(created.json.version).toBe(1);
    const replay = await viewer.request<ActivitySession>('PUT', `${base}/session-a`, first);
    expect(replay.status).toBe(200); expect(replay.json.version).toBe(1);
    const appended = { expected_version: 1, intervals: [...first.intervals, { seq: 1, kind: 'model_wait', duration_ms: 2000 }] };
    const updated = await viewer.request<ActivitySession>('PUT', `${base}/session-a`, appended);
    expect(updated.status).toBe(200); expect(updated.json.version).toBe(2);
    expect((await viewer.request('PUT', `${base}/session-a`, { ...appended, expected_version: 0, intervals: [...appended.intervals, { seq: 2, kind: 'review', duration_ms: 100 }] })).status).toBe(409);
    expect((await viewer.request('PUT', `${base}/session-a`, { expected_version: 2, intervals: [{ seq: 0, kind: 'annotation', duration_ms: 999 }] })).status).toBe(409);
    expect((await viewer.request('PUT', `${base}/session-b`, first)).status).toBe(200);
    const page = await viewer.request<ActivitySessionPage>('GET', `${base}?limit=1`);
    expect(page.status).toBe(200); expect(page.json.items).toEqual([updated.json]); expect(page.json.next_cursor).toBe('session-a');
    const next = await viewer.request<ActivitySessionPage>('GET', `${base}?limit=1&cursor=${page.json.next_cursor}`);
    expect(next.json.items.map((item) => item.session_id)).toEqual(['session-b']); expect(next.json.next_cursor).toBeNull();
    const stranger = await app.as_user('reviewer');
    expect((await stranger.request('GET', base)).status).toBe(403);
    expect((await stranger.request('PUT', `${base}/session-a`, first)).status).toBe(403);
    const other = await stranger.request<{ user_id: string }>('GET', '/api/session');
    expect((await admin.request('POST', `/api/projects/${projectId}/members`, { user_id: other.json.user_id, role: 'reviewer' })).status).toBe(200);
    const own = await stranger.request<ActivitySessionPage>('GET', base);
    expect(own.status).toBe(200); expect(own.json.items).toEqual([]);
    expect((await stranger.request('PUT', `${base}/session-a`, first)).status).toBe(200);
    expect((await viewer.request<ActivitySessionPage>('GET', base)).json.items[0]!.intervals).toEqual(appended.intervals);
    expect((await fetch(new URL(base, app.base_url))).status).toBe(401);
    const username = `csrf-${crypto.randomUUID()}`, password = crypto.randomUUID();
    expect((await admin.request('POST', '/api/users', { username, password })).status).toBe(201);
    const login = await fetch(new URL('/api/session/login', app.base_url), { method: 'POST', headers: { origin: app.base_url, 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!.split(';', 1)[0]!;
    expect((await fetch(new URL(`${base}/session-c`, app.base_url), { method: 'PUT', headers: { cookie, origin: app.base_url, 'content-type': 'application/json' }, body: JSON.stringify(first) })).status).toBe(403);
    for (const intervals of [
      [{ seq: 0, kind: 'typing_contents', duration_ms: 1 }],
      [{ seq: 0, kind: 'task', duration_ms: -1 }],
      [{ seq: 0, kind: 'task', duration_ms: 1.5 }],
      [{ seq: 0, kind: 'task', duration_ms: 0 }],
      [{ seq: 1, kind: 'task', duration_ms: 100 }],
      [{ seq: 0, kind: 'task', duration_ms: 100 }, { seq: 0, kind: 'review', duration_ms: 100 }],
      [{ seq: 0, kind: 'task', duration_ms: 86_400_001 }],
    ]) expect((await viewer.request('PUT', `${base}/invalid`, { expected_version: 0, intervals })).status).toBe(422);
    const concurrent = await Promise.all([300, 400].map((duration_ms) => viewer.request<ActivitySession>('PUT', `${base}/session-a`, { expected_version: 2, intervals: [...appended.intervals, { seq: 2, kind: 'review', duration_ms }] })));
    expect(concurrent.map((result) => result.status).sort()).toEqual([200, 409]);
    expect((await viewer.request('GET', `${base}?limit=101`)).status).toBe(422);
  } finally { await app.stop(); }
}, 30_000);

it('counts every missing GT object including objects AI never proposed and preserves unknown quality/cost', async () => {
  const sample = {
    sample_id: 'image-1', sample_unit: 'image', image_id: 'image-1', image_sha256: 'a'.repeat(64), task_id: 'task-1',
    seed: 'public-seed', synthetic: true, auditor: 'independent-auditor', quality_method: 'full-GT-inventory',
    arm: 'this_tool_same_AI', ai_configuration: 'fixed-config',
    durations_ms: { task: 100, annotation: 200, correction: 300, review: 400, switch: 500, model_wait: 9000 },
    ground_truth_object_ids: ['found', 'proposed-but-missed', 'never-proposed-and-missed'],
    final_ground_truth_object_ids: ['found'], ai_proposed_ground_truth_object_ids: ['found', 'proposed-but-missed'],
    wrong_objects: null, wrong_labels: 1, wrong_attributes: 0, returned_tasks: null, reviewed_tasks: null, fees_usd: null,
  };
  const report = analyzePilot({ schema_version: 1, samples: [sample] });
  const metrics = report.arms.this_tool_same_AI;
  expect(metrics.human_total_ms).toBe(1500); expect(metrics.durations_ms.model_wait).toBe(9000);
  expect(metrics.active_total_ms).toBe(10_500);
  expect(metrics.missed_objects).toBe(2); expect(metrics.ai_never_proposed_gt).toBe(1);
  expect(report.records[0].missed_object_ids).toEqual(['proposed-but-missed', 'never-proposed-and-missed']);
  expect(metrics.fees_usd).toBeNull(); expect(metrics.wrong_objects).toBeNull(); expect(metrics.return_rate).toBeNull();
  expect(analyzePilot({ schema_version: 1, samples: [sample, { ...sample, sample_id: 'image-2', fees_usd: 5 }] }).arms.this_tool_same_AI.fees_usd).toBeNull();
  expect(report.roi).toBeNull(); expect(report.conclusion).toBeNull();
  expect(() => analyzePilot({ schema_version: 1, samples: [sample, { ...sample, arm: 'current_tool_same_AI', ai_configuration: 'different-config' }] })).toThrow();
  expect(() => analyzePilot({ schema_version: 1, samples: [{ ...sample, final_ground_truth_object_ids: ['not-in-gt'] }] })).toThrow();
  expect(() => analyzePilot({ schema_version: 1, samples: [{ ...sample, fees_usd: Number.NaN }] })).toThrow();
  expect(() => analyzePilot({ schema_version: 1, samples: [{ ...sample, durations_ms: { ...sample.durations_ms, task: Number.MAX_SAFE_INTEGER } }] })).toThrow();
  expect(() => analyzePilot({ schema_version: 1, samples: [{ ...sample, fees_usd: 1e308 }, { ...sample, sample_id: 'image-2', fees_usd: 1e308 }] })).toThrow();
});

it('reports noData rather than ROI when no pilot samples exist', async () => {
  const report = analyzePilot({ schema_version: 1, samples: [] });
  expect(report.status).toBe('noData'); expect(report.roi).toBeNull(); expect(report.conclusion).toBeNull();
  expect(report.goal_human_time_reduction).toBe(0.3);
  for (const arm of ['human_only', 'current_tool_same_AI', 'this_tool_same_AI']) {
    expect(report.arms[arm].samples).toBe(0); expect(report.arms[arm].fees_usd).toBeNull(); expect(report.arms[arm].return_rate).toBeNull();
  }
});

it('handles idle threshold boundaries, refocus, a new cleared session and corrupt local data', () => {
  let now = 0;
  const collector = new ActivityCollector('project', 'actor', () => now);
  collector.setEnabled(true);
  now = 59_999; collector.commit(); now = 60_001; collector.commit();
  expect(collector.totals().task).toBe(60_000);
  now = 80_000; collector.setFocused(false); now = 90_000; collector.setFocused(true);
  now = 90_001; collector.setKind('switch'); now = 90_002; collector.commit();
  expect(collector.totals().task).toBe(60_001); expect(collector.totals().switch).toBe(1);
  const session = collector.currentSession; collector.clear(); expect(collector.currentSession).not.toBe(session);
  const corrupt = new ActivityCollector('project', 'actor', () => now, { getItem: () => '{corrupt', setItem: () => { throw new Error('must not overwrite'); }, removeItem: () => {} });
  expect(corrupt.isEnabled()).toBe(false); expect(corrupt.problem).not.toBeNull(); expect(corrupt.recoveryJournal).toBe('{corrupt');
  expect(() => corrupt.setEnabled(true)).toThrow(); corrupt.commit(); expect(corrupt.snapshot()).toEqual([]);
  corrupt.clear(); expect(corrupt.problem).toBeNull();
  const denied = new ActivityCollector('project', 'actor', () => now, () => { throw new Error('storage denied'); });
  expect(denied.problem).not.toBeNull(); expect(denied.isEnabled()).toBe(false);
  let saved: string | null = null;
  const cannotClear = new ActivityCollector('project', 'actor', () => now, { getItem: () => saved, setItem: (_key, value) => { saved = value; }, removeItem: () => { throw new Error('delete denied'); } });
  cannotClear.setEnabled(true); now += 1000; cannotClear.commit();
  const journal = saved;
  expect(() => cannotClear.clear()).toThrow();
  expect(cannotClear.isEnabled()).toBe(false); expect(saved).toBe(journal); expect(cannotClear.totals().task).toBe(1000);
});
