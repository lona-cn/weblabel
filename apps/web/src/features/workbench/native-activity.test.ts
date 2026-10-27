// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { nativeFixture } from './native-test-support';
import { ActivityCollector } from './activity';
import { mountActivityView } from './activity-view';
import { api } from '../../lib/t15/api';
import type { ActivitySession } from '../../../../../packages/contracts/generated/ActivitySession';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.restoreAllMocks(); document.body.replaceChildren(); });
it('starts without telemetry or invented zero effort and clears only future bindings when scope changes', () => {
  const f = nativeFixture(), owner = new AbortController(), root = document.createElement('section'); document.body.append(root); cleanups.push(f.dispose, () => owner.abort());
  let time = 0; f.state.activity = new ActivityCollector(f.state.projectId, 'actor', () => time); vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  f.state.fixedTask = { task_id: 'task', project_id: f.state.projectId, asset_revision_id: 'asset', ontology_version_id: 'ontology' };
  mountActivityView(root, root, f.state, () => null, owner.signal);
  expect(f.state.activity.isEnabled()).toBe(false); root.dispatchEvent(new Event('input', { bubbles: true })); time = 3000; f.state.activity.commit(); expect(f.state.activity.snapshot()).toEqual([]);
  expect(root.querySelector('[data-testid=activity-duration-task]')?.textContent).toBe('未记录');
  const enabled = root.querySelector<HTMLInputElement>('[data-testid=activity-opt-in]')!; enabled.checked = true; enabled.dispatchEvent(new Event('change', { bubbles: true }));
  const binding = root.querySelector<HTMLInputElement>('[data-testid=activity-task-binding]')!; binding.checked = true; binding.dispatchEvent(new Event('change', { bubbles: true }));
  time = 5000; f.state.activity.commit(); expect(f.state.activity.snapshot()[0].intervals[0]).toMatchObject({ task_id: 'task', duration_ms: 2000 });
  f.state.assetId = 'other'; f.state.notify(); expect(f.state.activity.getBinding()).toEqual({});
  time = 6000; f.state.activity.commit(); const intervals = f.state.activity.snapshot()[0].intervals; expect(intervals[0].task_id).toBe('task'); expect(intervals.at(-1)?.task_id).toBeUndefined();
});

function activityFixture(storage?: Storage | { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }) {
  const f = nativeFixture(), owner = new AbortController(), root = document.createElement('section'), surface = document.createElement('main');
  document.body.append(surface); surface.append(root); cleanups.push(f.dispose, () => owner.abort());
  let time = 0; f.state.activity = new ActivityCollector(f.state.projectId, 'actor', () => time, storage);
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  const dispose = mountActivityView(root, surface, f.state, () => null, owner.signal); cleanups.push(dispose);
  const control = <T extends HTMLElement>(id: string) => root.querySelector<T>('[data-testid=' + id + ']')!;
  return { ...f, owner, root, surface, control, time(value: number) { time = value; } };
}
it('keeps foreground keyboard inspection active without recording keys or private input, and excludes actual blur', () => {
  const f = activityFixture(), network = vi.spyOn(api, 'request');
  expect(f.state.activity.isEnabled()).toBe(false); f.control<HTMLInputElement>('activity-opt-in').click();
  for (const [time, key] of [[30_000, 'ArrowDown'], [60_000, 'Home'], [90_000, 'End']] as const) {
    f.time(time); f.surface.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  }
  f.time(100_000); f.state.activity.commit(); expect(f.state.activity.totals().task).toBe(100_000);
  window.dispatchEvent(new Event('blur')); f.time(200_000); f.state.activity.commit();
  expect(f.state.activity.totals().task).toBe(100_000); expect(JSON.stringify(f.state.activity.snapshot())).not.toMatch(/ArrowDown|Home|End/); expect(network).not.toHaveBeenCalled();
  f.owner.abort(); f.time(300_000); f.state.activity.commit(); expect(f.state.activity.totals().task).toBe(100_000); expect(f.state.activity.isEnabled()).toBe(false);
});
it('preserves a corrupted journal for explicit rescue while leaving the editing surface operable', () => {
  let raw: string | null = '{synthetic-corrupt-journal';
  const f = activityFixture({ getItem: () => raw, setItem: (_key, value) => { raw = value; }, removeItem: () => { raw = null; } });
  const input = document.createElement('textarea'); f.surface.append(input); input.value = 'private-note'; input.dispatchEvent(new Event('input', { bubbles: true }));
  expect(f.control<HTMLInputElement>('activity-opt-in').disabled).toBe(true); expect(f.control<HTMLButtonElement>('activity-publish').disabled).toBe(true);
  expect(f.state.activity.recoveryJournal).toBe('{synthetic-corrupt-journal'); expect(input.disabled).toBe(false); expect(raw).not.toContain('private-note');
  f.control<HTMLButtonElement>('activity-clear').click(); expect(raw).toBeNull(); expect(f.control<HTMLInputElement>('activity-opt-in').disabled).toBe(false); expect(f.state.activity.isEnabled()).toBe(false);
});
it('preserves measured intervals after quota failure without attempting a server publish', () => {
  const f = activityFixture({ getItem: () => null, setItem: () => { throw new Error('synthetic quota failure'); }, removeItem() {} }), request = vi.spyOn(api, 'request');
  f.control<HTMLInputElement>('activity-opt-in').click(); f.time(1000); f.state.activity.interact('correction');
  expect(f.state.activity.totals().task).toBe(1000); expect(f.state.activity.isEnabled()).toBe(false); expect(f.root.textContent).toContain('synthetic quota failure');
  f.control<HTMLButtonElement>('activity-publish').click(); expect(request).not.toHaveBeenCalled(); expect(f.control<HTMLButtonElement>('activity-download').disabled).toBe(false);
});
it('admits only one publish flight and does not attribute a late old-actor receipt to the new identity', async () => {
  const f = activityFixture(), pending = Promise.withResolvers<ActivitySession>();
  f.control<HTMLInputElement>('activity-opt-in').click(); f.time(1000); f.state.activity.commit();
  const original = f.state.activity.snapshot()[0], acknowledge = vi.spyOn(f.state.activity, 'acknowledge');
  const request = vi.spyOn(api, 'request').mockImplementation(() => pending.promise as never);
  const publish = f.control<HTMLButtonElement>('activity-publish'); publish.click(); publish.click(); expect(request).toHaveBeenCalledTimes(1);
  f.revoke(); pending.resolve({ ...original, version: 7 }); await Promise.resolve(); await Promise.resolve();
  expect(acknowledge).not.toHaveBeenCalled(); expect(f.state.activity.snapshot()[0].version).toBe(original.version); expect(f.root.textContent).not.toContain('本人工时已保存到项目服务器');
});
