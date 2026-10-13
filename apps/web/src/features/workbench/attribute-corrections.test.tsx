import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { AttributePanel } from './AttributePanel';
import type { AnnotationObject } from '../../../../../packages/contracts/generated/AnnotationObject';
import type { OntologyVersion } from '../../../../../packages/contracts/generated/OntologyVersion';
const object: AnnotationObject = { object_id: 'one', label_id: 'label', attributes: { text: 'old', number: 2 }, geometry: { type: 'bbox_xyxy', x_min: 1, x_max: 2, y_min: 1, y_max: 2 }, origin: { type: 'manual', prediction_id: null, model_run_id: null, import_batch_id: null } };
const ontology: OntologyVersion = { project_id: 'project', ontology_version_id: 'ontology', version_no: 1, guidelines_markdown: '', allow_out_of_bounds: false, labels: [{ label_id: 'label', name: 'label', color: '#ffffff', shortcut: null, allowed_geometry_types: ['bbox_xyxy'], attributes: ['text', 'number'].map(key => ({ key, kind: key === 'number' ? 'number' : 'text', required: false, default_value: null, enum_values: [], min: key === 'number' ? 0 : null, max: key === 'number' ? 4 : null })) }] };
afterEach(cleanup);
it.each([['text', 'draft', ' ', null], ['text', 'draft', '{Enter}', null], ['number', '4', ' ', null], ['number', '0', '{Enter}', null], ['number', '5', ' ', null]] as const)('Tab then explicit action commits once: %s=%s %s', async (key, draft, activation, value) => {
  const change = vi.fn(), user = userEvent.setup();
  render(<AttributePanel objects={[object]} ontology={ontology} onChange={change} />);
  const input = screen.getByTestId('attribute-' + key);
  await user.click(input); await user.clear(input); await user.type(input, draft); await user.tab();
  expect(change).not.toHaveBeenCalled();
  expect(document.activeElement).toHaveTextContent('设为 null');
  await user.keyboard(activation);
  expect(change).toHaveBeenCalledExactlyOnceWith(key, value);
});
it('keeps a draft through both text actions and commits only when leaving the group', async () => {
  const change = vi.fn(), user = userEvent.setup(); render(<><AttributePanel objects={[object]} ontology={ontology} onChange={change} /><button>outside</button></>);
  await user.click(screen.getByTestId('attribute-text')); await user.clear(screen.getByTestId('attribute-text')); await user.type(screen.getByTestId('attribute-text'), 'draft');
  await user.tab(); await user.tab(); expect(change).not.toHaveBeenCalled();
  await user.keyboard('{Enter}'); expect(change).toHaveBeenCalledExactlyOnceWith('text', '');
  change.mockClear(); await user.click(screen.getByTestId('attribute-number')); await user.clear(screen.getByTestId('attribute-number')); await user.type(screen.getByTestId('attribute-number'), '4'); await user.tab(); expect(change).not.toHaveBeenCalled(); await user.tab(); expect(change).toHaveBeenCalledExactlyOnceWith('number', 4);
});
it('does not commit composition, Escape or stale drafts via action focus', async () => {
  const change = vi.fn(), user = userEvent.setup(); const view = render(<AttributePanel objects={[object]} ontology={ontology} onChange={change} editContext="g0" />);
  const input = screen.getByTestId('attribute-text'); await user.click(input); fireEvent.compositionStart(input); fireEvent.change(input, { target: { value: '中文' } }); await user.tab(); await user.keyboard('{Enter}'); expect(change).not.toHaveBeenCalled(); fireEvent.compositionEnd(input);
  view.rerender(<AttributePanel objects={[object]} ontology={ontology} onChange={change} editContext="g1" />);
  await user.click(screen.getByTestId('attribute-text')); await user.type(screen.getByTestId('attribute-text'), 'draft'); await user.tab(); await user.keyboard('{Escape}'); await user.tab(); await user.tab(); expect(change).not.toHaveBeenCalled();
});
