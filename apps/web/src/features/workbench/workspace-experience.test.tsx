import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { OntologyVersion } from '../../../../../packages/contracts/generated/OntologyVersion';
import { LabelControls } from './LabelControls';

const ontology: OntologyVersion = {
  ontology_version_id: 'workspace-ontology', project_id: 'workspace-project', version_no: 1,
  guidelines_markdown: '', allow_out_of_bounds: false,
  labels: [{ label_id: 'label', name: '类别', color: '#65aadd', shortcut: '1', allowed_geometry_types: ['bbox_xyxy'], attributes: [] }],
};
afterEach(cleanup);
function mount(disabled = false) {
  const view = render(<LabelControls ontology={ontology} activeLabel="label" selectedCount={1}
    onActiveLabel={() => {}} onSetLabel={() => {}} disabled={disabled} />);
  const summary = screen.getByText('快捷键帮助');
  const help = summary.closest('details')!;
  fireEvent.click(summary);
  summary.focus();
  return { ...view, summary, help };
}

describe('workspace keyboard help consumer transitions', () => {
  it('Escape closes help and returns focus to its keyboard launcher without closing the workspace boundary', () => {
    const { container, summary, help } = mount();
    const outer = document.createElement('details');
    outer.open = true;
    outer.addEventListener('keydown', event => { if (event.key === 'Escape') outer.open = false; });
    container.parentNode!.insertBefore(outer, container);
    outer.append(container);
    try {
      expect(help.open).toBe(true);
      fireEvent.keyDown(summary, { key: 'Escape' });
      expect(help.open).toBe(false);
      expect(document.activeElement).toBe(summary);
      expect(outer.open).toBe(true);
    } finally { outer.replaceWith(container); }
  });

  it('an IME-composing Escape does not dismiss the help or move keyboard focus', () => {
    const { summary, help } = mount();
    fireEvent(summary, createEvent.keyDown(summary, { key: 'Escape', isComposing: true }));
    expect(help.open).toBe(true);
    expect(document.activeElement).toBe(summary);
  });

  it('readonly editors retain operable keyboard help while editing controls remain disabled', () => {
    const { summary, help } = mount(true);
    expect((screen.getByTestId('drawing-label') as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByTestId('batch-label-apply') as HTMLButtonElement).disabled).toBe(true);
    expect(help.open).toBe(true);
    fireEvent.keyDown(summary, { key: 'Escape' });
    expect(help.open).toBe(false);
    expect(document.activeElement).toBe(summary);
    expect((screen.getByTestId('drawing-label') as HTMLSelectElement).disabled).toBe(true);
  });
});
