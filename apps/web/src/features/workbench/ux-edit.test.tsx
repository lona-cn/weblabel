import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { AnnotationObject } from '../../../../../packages/contracts/generated/AnnotationObject';
import type { OntologyVersion } from '../../../../../packages/contracts/generated/OntologyVersion';
import { AttributePanel } from './AttributePanel';
import { DraftRecoveryChoice } from './SaveStatus';
import { SessionComfort } from './SessionComfort';
const item = (id: string, attributes: AnnotationObject['attributes'], label_id = 'a'): AnnotationObject => ({ object_id: id, attributes, label_id, geometry: { type: 'bbox_xyxy', x_min: 1, x_max: 2, y_min: 1, y_max: 2 }, origin: { type: 'manual', prediction_id: null, model_run_id: null, import_batch_id: null } });
const ontology: OntologyVersion = { project_id: 'p', ontology_version_id: 'o', version_no: 1, guidelines_markdown: '', allow_out_of_bounds: false, labels: ['a', 'b'].map((label_id, index) => ({ label_id, name: label_id, color: '#ffffff', shortcut: null, allowed_geometry_types: ['bbox_xyxy'], attributes: [{ key: 'choice', kind: 'enum', required: false, default_value: null, enum_values: index ? ['y', 'z'] : ['x', 'y'], min: null, max: null }, { key: 'text', kind: 'text', required: false, default_value: null, enum_values: [], min: null, max: null }, { key: 'number', kind: 'number', required: false, default_value: null, enum_values: [], min: index ? 5 : 0, max: index ? 10 : 4 }] })) };
afterEach(() => { cleanup(); vi.useRealTimers(); });
it('intersects schemas and values without representing a batch by its first object', () => {
  const change = vi.fn(); render(<AttributePanel objects={[item('one', { choice: 'x', text: null }, 'a'), item('two', { choice: 'y', text: '' }, 'b')]} ontology={ontology} onChange={change} />);
  const choices = screen.getByTestId('attribute-choice') as HTMLSelectElement;
  expect(choices.value).toBe('mixed'); expect([...choices.options].filter(option => !option.disabled).map(option => option.textContent)).toEqual(['null（空值）', 'y']);
  expect(screen.getByTestId('attribute-number')).toBeDisabled();
  expect(change).not.toHaveBeenCalled(); fireEvent.change(choices, { target: { value: 'value:0' } }); expect(change).toHaveBeenCalledExactlyOnceWith('choice', 'y');
});
it('locks the entire selected batch and preserves missing versus null versus empty text', () => {
  const change = vi.fn(); const view = render(<AttributePanel objects={[item('one', { text: null }), item('two', {})]} ontology={ontology} locked onChange={change} />);
  expect(screen.getByTestId('attribute-text')).toBeDisabled(); expect(screen.getByTestId('attribute-text')).toHaveAttribute('placeholder', '混合值');
  view.rerender(<AttributePanel objects={[item('one', { text: '' }), item('two', { text: '' })]} ontology={ontology} onChange={change} />);
  fireEvent.blur(screen.getByTestId('attribute-text')); expect(change).not.toHaveBeenCalled();
});
it('cancels stale text drafts, respects composition and makes explicit null one command', () => {
  const change = vi.fn(), objects = [item('one', { text: 'old' })]; const view = render(<AttributePanel objects={objects} ontology={ontology} onChange={change} editContext="g0" />);
  let input = screen.getByTestId('attribute-text'); fireEvent.compositionStart(input); fireEvent.change(input, { target: { value: '中文' } }); fireEvent.keyDown(input, { key: 'Enter' }); fireEvent.blur(input); expect(change).not.toHaveBeenCalled(); fireEvent.compositionEnd(input);
  view.rerender(<AttributePanel objects={objects} ontology={ontology} onChange={change} editContext="g1" />); fireEvent.blur(input); expect(change).not.toHaveBeenCalled();
  input = screen.getByTestId('attribute-text'); fireEvent.change(input, { target: { value: 'draft' } }); fireEvent.keyDown(input, { key: 'Escape' }); fireEvent.blur(input); expect(change).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: 'pending' } }); const button = screen.getAllByRole('button', { name: '设为 null' })[0]; fireEvent.mouseDown(button); fireEvent.click(button); fireEvent.blur(input); expect(change).toHaveBeenCalledExactlyOnceWith('text', null);
});
it('keeps unsafe branches expanded and rescue-only content unread', () => {
  const choose = vi.fn(), rescue = vi.fn(), raw = { secret: 'must-not-display' }; const envelope = { asset_revision_id: 'asset', draft_id: 'draft', write_token: 'token', record: raw, sources: [] };
  const view = render(<DraftRecoveryChoice branches={[{ envelope, disposition: 'synced' }]} selected="draft" busy={false} onChoose={choose} onUseServer={choose} onRescue={rescue} canReadBranch={() => true} />);
  expect(screen.getByTestId('draft-branches').closest('details')).not.toHaveAttribute('open');
  view.rerender(<DraftRecoveryChoice branches={[{ envelope, disposition: 'rescue_only' }]} selected="draft" busy={false} onChoose={choose} onUseServer={choose} onRescue={rescue} canReadBranch={() => true} />);
  expect(screen.getByTestId('draft-branches').closest('details')).toBeNull(); expect(screen.getByTestId('draft-branches')).toBeVisible(); expect(screen.queryByText('must-not-display')).toBeNull();
  expect(screen.getByRole('button', { name: '恢复选中分支' })).toBeDisabled(); expect(screen.getByRole('button', { name: '使用服务版并仅留档选中分支' })).toBeDisabled(); fireEvent.click(screen.getByRole('button', { name: '下载选中分支原始草稿' })); expect(rescue).toHaveBeenCalledExactlyOnceWith('draft'); expect(choose).not.toHaveBeenCalled();
  view.rerender(<DraftRecoveryChoice branches={[{ envelope, disposition: 'synced' }]} selected="draft" busy={false} onChoose={choose} onUseServer={choose} onRescue={rescue} canReadBranch={() => false} />);
  expect(screen.getByTestId('draft-branches').closest('details')).toBeNull();
  expect(screen.getByRole('button', { name: '恢复选中分支' })).toBeDisabled(); expect(choose).not.toHaveBeenCalled();
});
it('defers voluntary reminders until the pointer ends without pausing or stealing focus', () => {
  vi.useFakeTimers(); const surface = document.createElement('div'); document.body.append(surface); const pause = vi.fn(); render(<SessionComfort surface={{ current: surface }} paused={false} onPause={pause} context="image" />);
  fireEvent.click(screen.getByRole('checkbox')); const input = screen.getByRole('checkbox'); input.focus(); fireEvent.pointerDown(surface, { pointerId: 1 }); act(() => vi.advanceTimersByTime(45 * 60 * 1000)); expect(screen.queryByRole('status')).toBeNull(); fireEvent.pointerUp(window, { pointerId: 1 }); expect(screen.getByRole('status')).toBeInTheDocument(); expect(input).toHaveFocus(); expect(pause).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: '关闭提醒' })); act(() => vi.advanceTimersByTime(45 * 60 * 1000)); expect(screen.queryByRole('status')).toBeNull(); surface.remove();
});
