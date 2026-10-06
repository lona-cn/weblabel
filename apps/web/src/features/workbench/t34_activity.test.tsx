import * as matchers from '@testing-library/jest-dom/matchers';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ActivityPanel } from './ActivityPanel';
import { ActivityCollector } from './activity';
expect.extend(matchers);
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

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
