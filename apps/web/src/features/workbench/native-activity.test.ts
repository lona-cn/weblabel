// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { nativeFixture } from './native-test-support';
import { ActivityCollector } from './activity';
import { mountActivityView } from './activity-view';

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
