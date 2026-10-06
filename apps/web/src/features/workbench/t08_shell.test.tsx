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
import { ResizeControls } from './ResizeControls';

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
    expect(within(list).getByRole('option', { name: '对象 fixture-object-0' })).toBeInTheDocument();
    expect(within(list).queryByRole('option', { name: '对象 fixture-object-9999' })).not.toBeInTheDocument();
  });

  it('builds controls from ontology definitions and exposes invalid and unknown values', () => {
    const object = makeObject(1, { helmet_state: 'helmeted', extra_attr: 'unexpected' });
    const ontology = makeOntology('person', [
      { key: 'helmet_state', kind: 'enum', required: true, default_value: 'unknown', enum_values: ['wearing', 'not_wearing', 'unknown'], min: null, max: null },
      { key: 'review_score', kind: 'number', required: false, default_value: null, enum_values: [], min: 0, max: 1 },
    ]);
    render(<AttributePanel object={object} ontology={ontology} />);
    expect(screen.getByTestId('attribute-helmet_state')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByTestId('attribute-helmet_state').tagName).toBe('SELECT');
    expect(screen.getByTestId('attribute-review_score')).toHaveAttribute('type', 'number');
    expect(screen.getByRole('alert', { name: /未知属性值/ })).toHaveTextContent('extra_attr: unexpected');
    expect(screen.getAllByRole('alert').length).toBeGreaterThanOrEqual(2);
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
    const boxTool = screen.getByRole('button', { name: '矩形工具' });
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
    await user.click(screen.getByRole('option', { name: '对象 fixture-object-1' }));
    expect(screen.getByRole('option', { name: '对象 fixture-object-1' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: '对象 fixture-object-2' })).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps layout resizing keyboard-operable', async () => {
    const user = userEvent.setup();
    render(
      <>
        <aside id="workbench-sidebar" />
        <div id="media-strip" />
        <div id="canvas-toolbar-row" />
        <ResizeControls targetId="workbench-sidebar" axis="width" decreaseName="缩窄侧栏" increaseName="加宽侧栏" minimum={220} maximum={420} step={20} />
        <ResizeControls targetId="media-strip" axis="height" decreaseName="缩短媒体条" increaseName="增高媒体条" minimum={94} maximum={260} step={16} />
        <ResizeControls targetId="canvas-toolbar-row" axis="height" decreaseName="缩短工具栏" increaseName="增高工具栏" minimum={46} maximum={180} step={16} />
      </>,
    );
    const sidebar = document.getElementById('workbench-sidebar')!;
    const mediaStrip = document.getElementById('media-strip')!;
    const toolbar = document.getElementById('canvas-toolbar-row')!;
    vi.spyOn(sidebar, 'getBoundingClientRect').mockReturnValue({ width: 290 } as DOMRect);
    vi.spyOn(mediaStrip, 'getBoundingClientRect').mockReturnValue({ height: 94 } as DOMRect);
    vi.spyOn(toolbar, 'getBoundingClientRect').mockReturnValue({ height: 46 } as DOMRect);

    const widen = screen.getByRole('button', { name: '加宽侧栏' });
    widen.focus();
    await user.keyboard('{Enter}');
    expect(sidebar).toHaveStyle({ width: '310px' });
    await user.click(screen.getByRole('button', { name: '增高媒体条' }));
    expect(mediaStrip).toHaveStyle({ height: '110px' });
    await user.click(screen.getByRole('button', { name: '增高工具栏' }));
    expect(toolbar).toHaveStyle({ height: '62px' });
  });

  it('keeps long Chinese class labels in the inspector and preserves the canvas region', () => {
    const label = '超长中文类别名称用于检查换行而不遮挡中央画布与侧栏布局'.repeat(4);
    const ontology = makeOntology(label);
    render(<><AttributePanel object={makeObject(1)} ontology={ontology} /><div data-testid="canvas-container" /></>);
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByTestId('canvas-container')).toBeInTheDocument();
    expect(screen.getByText(label).closest('.selected-object')).toHaveAttribute('title', label);
  });

});
