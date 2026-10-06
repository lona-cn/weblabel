import * as matchers from '@testing-library/jest-dom/matchers';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import type { AnnotationObject } from '../../../../../packages/contracts/generated/AnnotationObject';
import { ActivityPanel } from './ActivityPanel';
import { ActivityCollector } from './activity';
import { ObjectList } from './ObjectList';
import { Toolbar } from './Toolbar';
expect.extend(matchers);
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('requires explicit keyboard opt-in and excludes actual blur without capturing typed content or sending telemetry', async () => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  const network = vi.spyOn(globalThis, 'fetch');
  let now = 0;
  const collector = new ActivityCollector('project', 'actor', () => now);
  render(<main><textarea aria-label="Annotation note" /><ActivityPanel projectId="project" actorId="actor" collector={collector} /></main>);
  const user = userEvent.setup();
  const toggle = screen.getByRole('checkbox', { name: '开启本项目工时统计' });
  expect(toggle).not.toBeChecked();
  now = 1000; act(() => collector.commit());
  expect(screen.getByTestId('activity-duration-task')).toHaveTextContent('0.000 秒');
  toggle.focus(); await user.keyboard(' '); expect(toggle).toBeChecked();
  now = 2000; fireEvent.input(screen.getByRole('textbox', { name: 'Annotation note' }), { target: { value: 'PRIVATE typed content never stored' } });
  now = 3000; fireEvent.blur(window);
  now = 100_000; act(() => collector.commit());
  expect(screen.getByTestId('activity-duration-task')).toHaveTextContent('2.000 秒');
  expect(JSON.stringify(collector.snapshot())).not.toContain('PRIVATE');
  expect(network).not.toHaveBeenCalled();
  fireEvent.focus(window); now = 101_000;
  await user.selectOptions(screen.getByRole('combobox', { name: '当前工时分类' }), 'review');
  now = 102_000; act(() => collector.commit());
  expect(screen.getByTestId('activity-duration-review')).toHaveTextContent('1.000 秒');
  await user.click(screen.getByTestId('activity-clear'));
  expect(toggle).not.toBeChecked(); expect(screen.getByTestId('activity-duration-review')).toHaveTextContent('0.000 秒');
  expect(network).not.toHaveBeenCalled();
});

it('does not issue a Publish request for zero samples and stops collection on unmount', async () => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  const network = vi.spyOn(globalThis, 'fetch');
  let now = 0;
  const collector = new ActivityCollector('project', 'actor', () => now);
  const view = render(<ActivityPanel projectId="project" actorId="actor" collector={collector} />);
  await userEvent.click(screen.getByText('查看工时分类、明细与保存操作'));
  await userEvent.click(screen.getByTestId('activity-publish'));
  expect(screen.getByRole('status')).toHaveTextContent('无数据');
  expect(network).not.toHaveBeenCalled();
  await userEvent.click(screen.getByTestId('activity-opt-in'));
  now = 1000; view.unmount();
  now = 9000; collector.commit();
  expect(collector.totals().task).toBe(1000);
  expect(collector.isEnabled()).toBe(false);
});

it('preserves a corrupted journal and keeps editing usable until explicit clearing', async () => {
  let raw: string | null = '{private-corrupt-journal';
  const storage = { getItem: () => raw, setItem: (_key: string, value: string) => { raw = value; }, removeItem: () => { raw = null; } };
  const collector = new ActivityCollector('project', 'actor', () => 0, storage);
  render(<main><textarea aria-label="Annotation note" /><ActivityPanel projectId="project" actorId="actor" collector={collector} /></main>);
  expect(screen.getByTestId('activity-opt-in')).toBeDisabled();
  expect(screen.getByTestId('activity-publish')).toBeDisabled();
  expect(screen.getByRole('alert')).toBeInTheDocument();
  await userEvent.type(screen.getByRole('textbox', { name: 'Annotation note' }), 'still editable');
  expect(screen.getByRole('textbox', { name: 'Annotation note' })).toHaveValue('still editable');
  expect(raw).toBe('{private-corrupt-journal');
  expect(collector.recoveryJournal).toBe(raw);
  await userEvent.click(screen.getByTestId('activity-clear'));
  expect(raw).toBeNull(); expect(screen.getByTestId('activity-opt-in')).toBeEnabled();
  expect(screen.getByTestId('activity-opt-in')).not.toBeChecked();
});

it('stops optional collection on quota failure but preserves measured intervals for download and leaves editing usable', async () => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  let now = 0;
  const collector = new ActivityCollector('project', 'actor', () => now, { getItem: () => null, setItem: () => { throw new Error('quota exceeded'); }, removeItem: () => {} });
  render(<main><textarea aria-label="Annotation note" /><ActivityPanel projectId="project" actorId="actor" collector={collector} /></main>);
  await userEvent.click(screen.getByTestId('activity-opt-in'));
  now = 1000; act(() => collector.interact('correction'));
  expect(collector.totals().task).toBe(1000);
  expect(collector.isEnabled()).toBe(false);
  expect(screen.getByRole('alert')).toHaveTextContent('quota exceeded');
  expect(screen.getByTestId('activity-download')).toBeEnabled();
  await userEvent.type(screen.getByRole('textbox', { name: 'Annotation note' }), 'editing continues');
  expect(screen.getByRole('textbox', { name: 'Annotation note' })).toHaveValue('editing continues');
  now = 10_000; act(() => collector.commit());
  expect(collector.totals().task).toBe(1000);
});

it('does not publish when the final interval checkpoint discovers a storage failure', async () => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected publication'));
  let now = 0;
  const collector = new ActivityCollector('project', 'actor', () => now, { getItem: () => null, setItem: () => { throw new Error('quota exceeded during save'); }, removeItem: () => {} });
  render(<ActivityPanel projectId="project" actorId="actor" collector={collector} />);
  await userEvent.click(screen.getByTestId('activity-opt-in'));
  now = 1000;
  await userEvent.click(screen.getByTestId('activity-publish'));
  expect(screen.getByRole('alert')).toHaveTextContent('quota exceeded during save');
  expect(network).not.toHaveBeenCalled();
  expect(collector.totals().task).toBe(1000);
  expect(screen.getByTestId('activity-download')).toBeEnabled();
  expect(screen.getByTestId('activity-publish')).toBeDisabled();
});

it('keeps foreground keyboard-only object inspection active past 60 seconds and exports intervals without keyboard or object content', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  const network = vi.spyOn(globalThis, 'fetch');
  let now = 0;
  const collector = new ActivityCollector('project', 'actor', () => now);
  const objects: AnnotationObject[] = [1, 2].map((index) => ({
    object_id: `PRIVATE-object-${index}`, label_id: 'PRIVATE-label',
    geometry: { type: 'bbox_xyxy', x_min: 1, y_min: 2, x_max: 20, y_max: 30 },
    attributes: { private_note: 'PRIVATE-attribute' },
    origin: { type: 'manual', prediction_id: null, model_run_id: null, import_batch_id: null },
  }));
  function Inspection() {
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    return <main><ObjectList objects={objects} selectedIds={selectedIds} onSelect={(id) => setSelectedIds([id])} />
      <output aria-label="Selected object">{selectedIds.join(',')}</output>
      <ActivityPanel projectId="project" actorId="actor" collector={collector} /></main>;
  }
  const view = render(<Inspection />);
  const list = screen.getByRole('listbox', { name: '标注对象' });
  const select = (time: number, key: string, objectId: string) => {
    now = time;
    fireEvent(list, new KeyboardEvent('keydown', { key, code: key, bubbles: true }));
    expect(screen.getByLabelText('Selected object')).toHaveTextContent(objectId);
  };
  list.focus();
  select(10_000, 'ArrowDown', objects[0].object_id);
  act(() => collector.commit());
  expect(collector.snapshot()).toEqual([]);
  now = 20_000;
  fireEvent.click(screen.getByTestId('activity-opt-in'));
  list.focus();
  select(50_000, 'ArrowDown', objects[1].object_id);
  select(80_000, 'Home', objects[0].object_id);
  select(110_000, 'End', objects[1].object_id);
  now = 120_000;
  act(() => collector.commit());
  expect(screen.getByTestId('activity-duration-task')).toHaveTextContent('100.000 秒');
  now = 200_000;
  act(() => collector.commit());
  expect(screen.getByTestId('activity-duration-task')).toHaveTextContent('150.000 秒');

  let downloaded: Blob | undefined;
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL(blob: Blob) { downloaded = blob; return 'blob:local-activity'; }
    static revokeObjectURL() {}
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  fireEvent.click(screen.getByTestId('activity-download'));
  const exported = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(downloaded!);
  });
  expect(JSON.parse(exported)).toEqual({
    schema_version: 1, evidence_kind: 'local_voluntary_intervals_not_a_pilot',
    project_id: 'project', actor_id: 'actor', fees_usd: null,
    sessions: [{
      session_id: collector.currentSession, version: 0,
      intervals: [{ seq: 0, kind: 'task', duration_ms: 100_000 }, { seq: 1, kind: 'task', duration_ms: 50_000 }],
    }],
  });
  expect(exported).not.toMatch(/ArrowDown|Home|End|PRIVATE|private_note|lastInput|highWater/);
  expect(network).not.toHaveBeenCalled();
  view.unmount();
});

it('does not extend keyboard time outside the surface, while unfocused or hidden, after opt-out, or after unmount', () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const network = vi.spyOn(globalThis, 'fetch');
  let now = 0;
  const collector = new ActivityCollector('project', 'actor', () => now);
  const view = render(<main><Toolbar active="select" onChange={() => {}} /><ActivityPanel projectId="project" actorId="actor" collector={collector} /></main>);
  const button = screen.getByRole('button', { name: '矩形工具' });
  fireEvent.click(screen.getByTestId('activity-opt-in'));
  now = 30_000;
  fireEvent(document.body, new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  now = 90_000; act(() => collector.commit());
  expect(collector.totals().task).toBe(60_000);
  fireEvent.blur(window);
  now = 120_000; fireEvent(button, new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  now = 150_000; act(() => collector.commit());
  expect(collector.totals().task).toBe(60_000);
  visibility.mockReturnValue('hidden'); fireEvent(document, new Event('visibilitychange'));
  now = 180_000; fireEvent(button, new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
  now = 210_000; act(() => collector.commit());
  expect(collector.totals().task).toBe(60_000);
  visibility.mockReturnValue('visible'); fireEvent(document, new Event('visibilitychange'));
  fireEvent.click(screen.getByTestId('activity-opt-in'));
  now = 240_000; fireEvent(button, new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  now = 270_000; act(() => collector.commit());
  expect(collector.totals().task).toBe(60_000);
  view.unmount();
  act(() => collector.setEnabled(true));
  now = 300_000; fireEvent(button, new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  now = 360_000; collector.commit();
  expect(collector.totals().task).toBe(120_000);
  expect(network).not.toHaveBeenCalled();
});
