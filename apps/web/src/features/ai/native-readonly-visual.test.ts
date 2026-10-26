// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { readonlyVisual } from './readonly-visual';
import { nativeFixture } from '../workbench/native-test-support';

afterEach(() => document.body.replaceChildren());
it('projects the exact server consent crop without padding or modifying canonical document bytes', () => {
  const f = nativeFixture(), before = JSON.stringify(f.document), crop = { type: 'bbox_xyxy' as const, x_min: 2, y_min: 3, x_max: 20, y_max: 30 };
  const visual = readonlyVisual(f.document, 'asset', [crop], [], false, crop);
  expect(visual.querySelector('svg')?.getAttribute('viewBox')).toBe('2 3 18 27'); expect(visual.querySelector('rect')?.getAttribute('stroke-dasharray')).toBe('5 3');
  expect(JSON.stringify(f.document)).toBe(before); f.dispose();
});
it('never substitutes another current asset when the fixed visual target is unavailable', () => {
  const f = nativeFixture(), visual = readonlyVisual(f.document, 'other', [f.document.objects[0].geometry], [], true);
  expect(visual.querySelector('svg,image')).toBeNull(); expect(visual.textContent).toContain('固定版本不可用'); f.dispose();
});
