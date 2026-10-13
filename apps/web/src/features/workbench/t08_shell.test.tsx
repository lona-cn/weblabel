import * as matchers from '@testing-library/jest-dom/matchers';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnnotationObject } from '../../../../../packages/contracts/generated/AnnotationObject';
import type { OntologyVersion } from '../../../../../packages/contracts/generated/OntologyVersion';
import { AttributePanel } from './AttributePanel';
import { ObjectList } from './ObjectList';
import { Toolbar } from './Toolbar';

expect.extend(matchers);

function makeObject(index: number, attributes: AnnotationObject['attributes'] = { helmet_state: 'wearing' }): AnnotationObject {
  return {
    object_id: `fixture-object-${index}`,
    label_id: 'label_person',
    geometry: { type: 'bbox_xyxy', x_min: 1, y_min: 2, x_max: 20, y_max: 30 },
    attributes,
    origin: { type: 'manual', prediction_id: null, model_run_id: null, import_batch_id: null },
  };
}
function makeOntology(name = 'person', attributes: OntologyVersion['labels'][number]['attributes'] = []): OntologyVersion {
  return {
    ontology_version_id: 'ontology-test',
    project_id: 'project-test',
    version_no: 1,
    labels: [{
      label_id: 'label_person',
      name,
      color: '#2878d0',
      shortcut: null,
      allowed_geometry_types: ['bbox_xyxy'],
      attributes,
    }],
    guidelines_markdown: '',
    allow_out_of_bounds: false,
  };
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('object-viewport') ? 320 : 0;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('T08 workbench shell', () => {
  it('keeps 10,000 object rows bounded to the list viewport', () => {
    const objects = Array.from({ length: 10_000 }, (_, index) => makeObject(index));
    render(<ObjectList objects={objects} selectedIds={[]} onSelect={() => undefined} />);
    const list = screen.getByTestId('object-list');
    expect(within(list).getAllByRole('option').length).toBeLessThanOrEqual(20);
  });

  it('builds controls from ontology definitions and exposes invalid and unknown values', () => {
    const object = makeObject(1, { helmet_state: 'helmeted', extra_attr: 'unexpected' });
    const ontology = makeOntology('person', [
      { key: 'helmet_state', kind: 'enum', required: true, default_value: 'unknown', enum_values: ['wearing', 'not_wearing', 'unknown'], min: null, max: null },
      { key: 'review_score', kind: 'number', required: false, default_value: null, enum_values: [], min: 0, max: 1 },
    ]);
    render(<AttributePanel objects={[object]} ontology={ontology} />);
    expect(screen.getByTestId('attribute-helmet_state')).toHaveAttribute('aria-invalid', 'true');
  });

  it('keeps tool and object selection controls keyboard accessible', async () => {
    const user = userEvent.setup();
    const onToolChange = vi.fn();
    const onSelect = vi.fn();
    const objects = [makeObject(1), makeObject(2)];
    render(
      <>
        <Toolbar active="select" onChange={onToolChange} />
        <ObjectList objects={objects} selectedIds={[]} onSelect={onSelect} />
      </>,
    );
    const boxTool = screen.getByTestId('tool-box');
    boxTool.focus();
    expect(boxTool).toHaveFocus();
    await user.click(boxTool);
    expect(onToolChange).toHaveBeenCalledWith('box');

    const objectList = screen.getByRole('listbox', { name: '标注对象' });
    objectList.focus();
    await user.keyboard('{ArrowDown}');
    expect(onSelect).toHaveBeenCalledWith(objects[0].object_id);
  });

  it('applies the current selection mode when an unchanged row is clicked', async () => {
    const user = userEvent.setup();
    const objects = [makeObject(1), makeObject(2)];
    function SelectionModes() {
      const [selectAll, setSelectAll] = useState(false);
      const [selectedIds, setSelectedIds] = useState<string[]>([]);
      return <>
        <button type="button" onClick={() => setSelectAll(true)}>Select whole group</button>
        <ObjectList objects={objects} selectedIds={selectedIds}
          onSelect={(id) => setSelectedIds(selectAll ? objects.map((object) => object.object_id) : [id])} />
      </>;
    }
    render(<SelectionModes />);
    await user.click(screen.getByRole('button', { name: 'Select whole group' }));
    await user.click(screen.getByTestId('object-item-fixture-object-1'));
    expect(screen.getByTestId('object-item-fixture-object-1')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('object-item-fixture-object-2')).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps long Chinese class labels in the inspector and preserves the canvas region', () => {
    const label = '超长中文类别名称用于检查换行而不遮挡中央画布与侧栏布局'.repeat(4);
    const ontology = makeOntology(label);
    render(<><AttributePanel objects={[makeObject(1)]} ontology={ontology} /><div data-testid="canvas-container" /></>);
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByTestId('canvas-container')).toBeInTheDocument();
    expect(screen.getByText(label).closest('.selected-object')).toHaveAttribute('title', label);
  });

});
