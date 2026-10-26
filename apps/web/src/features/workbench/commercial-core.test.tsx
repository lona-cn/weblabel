import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useCallback, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnnotationObject } from '../../../../../packages/contracts/generated/AnnotationObject';
import type { AnnotationDocument } from '../../../../../packages/contracts/generated/AnnotationDocument';
import type { OntologyVersion } from '../../../../../packages/contracts/generated/OntologyVersion';
import type { EditorDelta } from '../../../../../packages/contracts/generated/EditorDelta';
import type { Scalar } from '../../../../../packages/contracts/generated/Scalar';
import { AttributePanel } from './AttributePanel';
import { ObjectList } from './ObjectList';
import { NumericGeometry } from './NumericGeometry';
import { SelectionStore } from './selection-store';
import { LabelControls } from './LabelControls';
import { categoryShortcuts } from './category-shortcuts';

const object = (id: string, x = 1): AnnotationObject => ({ object_id: id, label_id: 'car', geometry: { type: 'bbox_xyxy', x_min: x, y_min: 2, x_max: x + 10, y_max: 12 }, attributes: {}, origin: { type: 'manual', prediction_id: null, model_run_id: null, import_batch_id: null } });
const ontology: OntologyVersion = { ontology_version_id: 'ontology', project_id: 'project', version_no: 1, guidelines_markdown: '', allow_out_of_bounds: false, labels: [{ label_id: 'car', name: '车辆', color: '#ffff00', shortcut: null, allowed_geometry_types: ['bbox_xyxy'], attributes: ['enum', 'boolean', 'number', 'text'].map((kind) => ({ key: kind, kind: kind as 'enum' | 'boolean' | 'number' | 'text', required: true, default_value: null, enum_values: kind === 'enum' ? ['', 'red'] : [], min: null, max: null })) }] };
const delta = (ids: string[], generation = 0, document_changed = false): EditorDelta => ({ generation, selected_object_ids: ids, changed_objects: [], removed_object_ids: [], document_changed, repaint: true, can_undo: false, can_redo: false, suggestion_decisions: [], error: null });
const numberOntology: OntologyVersion = { ...ontology, labels: [{ ...ontology.labels[0], attributes: [{ key: 'number', kind: 'number', required: true, default_value: null, enum_values: [], min: -1, max: 1 }] }] };
const numberObject = (): AnnotationObject => ({ ...object('number-object'), attributes: { number: 0.5 } });
function NumberConsumer({ commit }: { commit: (key: string, value: Scalar) => void }) {
  const [current, setCurrent] = useState(numberObject);
  const change = useCallback((key: string, value: Scalar) => { commit(key, value); setCurrent(before => ({ ...before, attributes: { ...before.attributes, [key]: value } })); }, [commit]);
  return <AttributePanel objects={[current]} ontology={numberOntology} onChange={change} />;
}
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('object-viewport') ? 320 : 0; });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('keeps text local until Enter and does not commit again on blur', () => {
  const change = vi.fn(); render(<AttributePanel objects={[{ ...object('draft'), attributes: { text: '' } }]} ontology={ontology} onChange={change} />);
  const input = screen.getByTestId('attribute-text'); fireEvent.change(input, { target: { value: '完整文字' } });
  expect(change).not.toHaveBeenCalled(); fireEvent.keyDown(input, { key: 'Enter' }); fireEvent.blur(input);
  expect(change).toHaveBeenCalledExactlyOnceWith('text', '完整文字');
});

describe('commercial manual editor consumer boundaries', () => {
  it('accepts present required null keys in all four attribute kinds, but reports absent required keys', () => {
    const item = object('one');
    item.attributes = { enum: null, boolean: null, number: null, text: null };
    const view = render(<AttributePanel objects={[item]} ontology={ontology} onChange={() => {}} />);
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
    view.rerender(<AttributePanel objects={[{ ...item, attributes: {} }]} ontology={ontology} onChange={() => {}} />);
    expect(screen.getAllByRole('alert')).toHaveLength(4);
  });

  it('projects semantic names and canonical document ordinals without changing selection while searching', () => {
    const select = vi.fn();
    render(<ObjectList objects={[object('first'), object('second')]} selectedIds={['second']} labelNames={{ car: '车辆' }} onSelect={select} />);
    expect(screen.getByTestId('object-item-second').textContent).toContain('车辆 #2');
    fireEvent.change(screen.getByRole('searchbox', { name: '检索对象' }), { target: { value: 'first' } });
    expect(screen.queryByTestId('object-item-second')).toBeNull();
    expect(select).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('searchbox', { name: '检索对象' }), { target: { value: '' } });
    expect(screen.getByTestId('object-item-second').getAttribute('aria-selected')).toBe('true');
  });

  it('cancels a focused geometry draft when selection changes instead of writing the old object on blur', () => {
    const store = new SelectionStore();
    store.publish(delta(['first']));
    const document: AnnotationDocument = { schema_version: 1, asset_revision_id: 'asset', ontology_version_id: 'ontology', coordinate_space: { type: 'canonical_image_pixels', width: 100, height: 100 }, completion: 'in_progress', objects: [object('first'), object('second', 20)] };
    const dispatch = vi.fn(() => delta(['second'], 1, true));
    render(<NumericGeometry store={store} host={{ getSnapshot: () => document, dispatch }} />);
    const input = screen.getByTestId('geometry-x');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '7.125' } });
    act(() => store.publish(delta(['second'])));
    fireEvent.blur(input);
    expect(dispatch).not.toHaveBeenCalled();
    expect((screen.getByTestId('geometry-x') as HTMLInputElement).value).toBe('20px');
  });

  it('keeps false distinct from null and permits an empty enum member', () => {
    const change = vi.fn();
    const item = { ...object('one'), attributes: { enum: null, boolean: null, number: null, text: null } };
    render(<AttributePanel objects={[item]} ontology={ontology} onChange={change} />);
    fireEvent.change(screen.getByTestId('attribute-boolean'), { target: { value: 'false' } });
    expect(change).toHaveBeenLastCalledWith('boolean', false);
    const empty = screen.getByRole('option', { name: '空字符串' }) as HTMLOptionElement;
    fireEvent.change(screen.getByTestId('attribute-enum'), { target: { value: empty.value } });
    expect(change).toHaveBeenLastCalledWith('enum', '');
  });

  it('does not commit intermediate geometry fields and applies a complete decimal box once', () => {
    const store = new SelectionStore(); store.publish(delta(['one']));
    const document: AnnotationDocument = { schema_version: 1, asset_revision_id: 'asset', ontology_version_id: 'ontology', coordinate_space: { type: 'canonical_image_pixels', width: 100, height: 100 }, completion: 'in_progress', objects: [object('one')] };
    const dispatch = vi.fn(() => delta(['one'], 1, true));
    render(<NumericGeometry store={store} host={{ getSnapshot: () => document, dispatch }} />);
    for (const [field, value] of Object.entries({ x: '89.5', y: '89.25', w: '10.5', h: '10.75' })) {
      const input = screen.getByTestId(`geometry-${field}`);
      fireEvent.focus(input); fireEvent.change(input, { target: { value } }); fireEvent.blur(input);
    }
    expect(dispatch).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByTestId('geometry-h'), { key: 'Enter' });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ kind: 'replace_geometry', object_id: 'one', geometry: { type: 'bbox_xyxy', x_min: 89.5, y_min: 89.25, x_max: 100, y_max: 100 } });
  });

  it('keeps conflicting shortcuts unbound while categories remain selectable and applying a batch is explicit', () => {
    const labels = [
      { ...ontology.labels[0], label_id: 'one', shortcut: 'b' },
      { ...ontology.labels[0], label_id: 'two', shortcut: 'q' },
      { ...ontology.labels[0], label_id: 'three', shortcut: 'Q' },
      { ...ontology.labels[0], label_id: 'four', shortcut: '7' },
    ];
    const fixed = { ...ontology, labels };
    expect(categoryShortcuts(fixed).bindings).toEqual({ '7': 'four' });
    const apply = vi.fn(), choose = vi.fn();
    render(<LabelControls ontology={fixed} activeLabel="one" onActiveLabel={choose} selectedCount={2} onSetLabel={apply} disabled={false} />);
    fireEvent.change(screen.getByTestId('drawing-label'), { target: { value: 'three' } });
    expect(choose).toHaveBeenCalledWith('three');
    expect(apply).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('batch-label'), { target: { value: 'four' } });
    expect(apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('batch-label-apply'));
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith('four');
  });

  it('lets readers inspect a selected decimal geometry but rejects Enter or button mutation', () => {
    const store = new SelectionStore();
    const document: AnnotationDocument = { schema_version: 1, asset_revision_id: 'asset', ontology_version_id: 'ontology', coordinate_space: { type: 'canonical_image_pixels', width: 100, height: 100 }, completion: 'in_progress', objects: [object('one', 1.125)] };
    const dispatch = vi.fn(() => delta(['one']));
    render(<NumericGeometry store={store} host={{ getSnapshot: () => document, dispatch }} selectedIds={['one']} disabled />);
    expect((screen.getByTestId('geometry-x') as HTMLInputElement).value).toBe('1.125px');
    fireEvent.keyDown(screen.getByTestId('geometry-x'), { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: '应用完整几何' }));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('preserves a cleared decimal draft through real key entry and commits 0.25 only once on Enter then blur', async () => {
    const user = userEvent.setup(), commit = vi.fn();
    render(<NumberConsumer commit={commit} />);
    const input = screen.getByTestId('attribute-number') as HTMLInputElement;
    await user.clear(input); await user.type(input, '0.25');
    expect(input.value).toBe('0.25'); expect(commit).not.toHaveBeenCalled();
    await user.keyboard('{Enter}'); await user.tab();
    expect(commit).toHaveBeenCalledTimes(1); expect(commit).toHaveBeenCalledWith('number', 0.25);
    expect(input.value).toBe('0.25');
  });

  it('keeps 0. and a bare negative sign editable without conversion, then commits a negative decimal on blur', async () => {
    const user = userEvent.setup(), commit = vi.fn();
    render(<NumberConsumer commit={commit} />);
    const input = screen.getByTestId('attribute-number') as HTMLInputElement;
    await user.clear(input); await user.type(input, '0.');
    expect(input.value).toBe('0.'); expect(commit).not.toHaveBeenCalled();
    await user.clear(input); await user.type(input, '-');
    expect(input.value).toBe('-'); expect(screen.queryByRole('alert')).toBeNull();
    await user.type(input, '.25'); await user.tab();
    expect(commit).not.toHaveBeenCalled();
    await user.tab();
    expect(commit).toHaveBeenCalledTimes(1); expect(commit).toHaveBeenCalledWith('number', -0.25);
  });

  it.each(['', '-', '2', 'Infinity', '1e999'])('validates finite/range or empty draft %j at commit without converting it to null or a transient value', async raw => {
    const user = userEvent.setup(), commit = vi.fn();
    render(<NumberConsumer commit={commit} />);
    const input = screen.getByTestId('attribute-number') as HTMLInputElement;
    await user.clear(input); if (raw) await user.type(input, raw);
    expect(commit).not.toHaveBeenCalled(); expect(screen.queryByRole('alert')).toBeNull();
    await user.keyboard('{Enter}');
    expect(commit).not.toHaveBeenCalled(); expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.value).toBe(raw);
  });

  it('clearing a number is not a null mutation; explicit null cancels the pending draft', async () => {
    const user = userEvent.setup(), commit = vi.fn();
    render(<NumberConsumer commit={commit} />);
    const input = screen.getByTestId('attribute-number') as HTMLInputElement;
    await user.clear(input); expect(input.value).toBe(''); expect(commit).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '设为 null' }));
    expect(commit).toHaveBeenCalledTimes(1); expect(commit).toHaveBeenCalledWith('number', null);
    expect(input.value).toBe(''); expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each(['selection', 'document-generation', 'host-port', 'scope', 'read-only'] as const)('cancels a focused number draft when the %s identity changes and never submits it to either context', async transition => {
    const user = userEvent.setup(), first = vi.fn(), second = vi.fn(), current = numberObject();
    const view = render(<AttributePanel objects={[current]} ontology={numberOntology} onChange={first} editContext="session:host:selection:g0" />);
    const input = screen.getByTestId('attribute-number') as HTMLInputElement;
    await user.clear(input); await user.type(input, '0.75');
    view.rerender(<AttributePanel objects={[transition === 'selection' ? { ...current, object_id: 'other' } : transition === 'document-generation' ? { ...current, attributes: { ...current.attributes } } : current]} ontology={transition === 'scope' ? { ...numberOntology, ontology_version_id: 'other-scope' } : numberOntology}
    onChange={transition === 'host-port' ? second : first} disabled={transition === 'read-only'} editContext={transition === 'document-generation' ? 'session:host:selection:g1' : transition === 'host-port' ? 'session:new-host:selection:g0' : 'session:host:selection:g0'} />);
    const active = screen.getByTestId('attribute-number') as HTMLInputElement;
    expect(active.value).toBe('0.5');
    fireEvent.keyDown(active, { key: 'Enter' }); fireEvent.blur(active);
    expect(first).not.toHaveBeenCalled(); expect(second).not.toHaveBeenCalled();
  });

  it('preserves a number draft across an unrelated render in the same explicit edit context and uses the latest callback', async () => {
    const user = userEvent.setup(), first = vi.fn(), latest = vi.fn(), current = numberObject();
    const view = render(<AttributePanel objects={[current]} ontology={numberOntology} onChange={first} editContext="stable-context" />);
    const input = screen.getByTestId('attribute-number') as HTMLInputElement;
    await user.clear(input); await user.type(input, '0.75');
    view.rerender(<AttributePanel objects={[{ ...current, attributes: { ...current.attributes } }]} ontology={numberOntology} onChange={latest} editContext="stable-context" />);
    expect((screen.getByTestId('attribute-number') as HTMLInputElement).value).toBe('0.75');
    await user.keyboard('{Enter}');
    expect(first).not.toHaveBeenCalled(); expect(latest).toHaveBeenCalledTimes(1); expect(latest).toHaveBeenCalledWith('number', 0.75);
  });
});
