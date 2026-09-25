import * as matchers from '@testing-library/jest-dom/matchers';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnnotationObject } from '../../../../../packages/contracts/generated/AnnotationObject';
import type { OntologyVersion } from '../../../../../packages/contracts/generated/OntologyVersion';
import { AttributePanel } from './AttributePanel';
import { ObjectList } from './ObjectList';
import { Workbench, fixtureOntology } from './Workbench';

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
    const ontology: OntologyVersion = {
      ...fixtureOntology,
      labels: [{ ...fixtureOntology.labels[0], attributes: [
        { key: 'helmet_state', kind: 'enum', required: true, default_value: 'unknown', enum_values: ['wearing', 'not_wearing', 'unknown'], min: null, max: null },
        { key: 'review_score', kind: 'number', required: false, default_value: null, enum_values: [], min: 0, max: 1 },
      ] }],
    };
    render(<AttributePanel object={object} ontology={ontology} />);
    expect(screen.getByTestId('attribute-helmet_state')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByTestId('attribute-helmet_state').tagName).toBe('SELECT');
    expect(screen.getByTestId('attribute-review_score')).toHaveAttribute('type', 'number');
    expect(screen.getByRole('alert', { name: /未知属性值/ })).toHaveTextContent('extra_attr: unexpected');
    expect(screen.getAllByRole('alert').length).toBeGreaterThanOrEqual(2);
  });

  it('supports keyboard focus and gives tool and object controls accessible names', async () => {
    const user = userEvent.setup();
    render(<Workbench />);
    const brand = screen.getByRole('link', { name: 'WebLabel 首页' });
    brand.focus();
    expect(brand).toHaveFocus();
    const selectTool = screen.getByRole('button', { name: '选择工具' });
    let tabCount = 0;
    while (document.activeElement !== selectTool && tabCount < 64) {
      await user.tab();
      tabCount += 1;
    }
    expect(selectTool).toHaveFocus();
    expect(screen.getByRole('toolbar', { name: '画布工具' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: '主导航' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '对象 object_person_001' })).toBeInTheDocument();
    const objectList = screen.getByRole('listbox', { name: '标注对象' });
    objectList.focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('option', { name: '对象 object_person_00002' })).toHaveAttribute('aria-selected', 'true');
    expect(objectList).toHaveAttribute('aria-activedescendant', 'object-option-object_person_00002');
    fireEvent.click(screen.getByRole('button', { name: '矩形工具' }));
    expect(screen.getByRole('button', { name: '矩形工具' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('selects fixture media and exposes working keyboard-operable resize controls', async () => {
    const user = userEvent.setup();
    render(<Workbench />);
    const media = screen.getByRole('button', { name: '现场图片 2' });
    await user.click(media);
    expect(media).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/媒体 2 \/ 3/, { selector: '.workspace-heading .eyebrow' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '开发夹具媒体预览：媒体 2，非真实图片' })).toBeInTheDocument();

    const sidebar = document.querySelector('.sidebar-resize');
    const mediaStrip = document.querySelector('.media-strip');
    const toolbar = document.querySelector('.canvas-toolbar-row');
    expect(sidebar).not.toBeNull();
    expect(mediaStrip).not.toBeNull();
    expect(toolbar).not.toBeNull();
    vi.spyOn(sidebar!, 'getBoundingClientRect').mockReturnValue({ width: 290 } as DOMRect);
    vi.spyOn(mediaStrip!, 'getBoundingClientRect').mockReturnValue({ height: 94 } as DOMRect);
    vi.spyOn(toolbar!, 'getBoundingClientRect').mockReturnValue({ height: 46 } as DOMRect);

    const widen = screen.getByRole('button', { name: '加宽对象与属性侧栏' });
    widen.focus();
    await user.keyboard('{Enter}');
    expect(sidebar).toHaveStyle({ width: '310px' });
    await user.click(screen.getByRole('button', { name: '增大媒体底片条高度' }));
    expect(mediaStrip).toHaveStyle({ height: '110px' });
    await user.click(screen.getByRole('button', { name: '增大画布工具栏高度' }));
    expect(toolbar).toHaveStyle({ height: '62px' });

    expect(screen.getByRole('button', { name: '缩小画布（渲染器未接入）' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '放大画布（渲染器未接入）' })).toBeDisabled();
  });

  it('keeps long Chinese class labels in the inspector and preserves the canvas region', () => {
    const label = '超长中文类别名称用于检查换行而不遮挡中央画布与侧栏布局'.repeat(4);
    const ontology: OntologyVersion = { ...fixtureOntology, labels: [{ ...fixtureOntology.labels[0], name: label }] };
    render(<><AttributePanel object={makeObject(1)} ontology={ontology} /><div data-testid="canvas-container" /></>);
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByTestId('canvas-container')).toBeInTheDocument();
    expect(screen.getByText(label).closest('.selected-object')).toHaveAttribute('title', label);
  });

  it('presents loading, error, empty and unsupported as separate accessible states', () => {
    const states = [
      ['loading', '正在加载媒体…', 'status'],
      ['error', '媒体加载失败。请检查本地服务后重试。', 'alert'],
      ['empty', '暂无媒体，请从项目页选择媒体。', 'status'],
      ['unsupported', '当前环境不支持 WebGPU；画布编辑不可用，对象列表仍可查看。', 'status'],
    ] as const;
    for (const [state, message, role] of states) {
      const { unmount } = render(<Workbench status={state} />);
      const stateElement = screen.getByText(message, { exact: true });
      expect(stateElement).toHaveAttribute('role', role);
      if (state === 'unsupported') {
        expect(screen.getByRole('option', { name: '对象 object_person_001' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: '矩形工具' })).toBeDisabled();
        expect(screen.getByRole('button', { name: '放大画布（渲染器未接入）' })).toBeDisabled();
      }
      unmount();
    }
    expect(new Set(states.map(([state]) => state)).size).toBe(4);
  });

  it('visibly labels fixture content as development mock and disclaims persistence', () => {
    render(<Workbench />);
    expect(screen.getAllByText('DEV MOCK').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/不会写入数据/)).toBeInTheDocument();
    expect(screen.getByText(/未连接持久化服务/)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '开发夹具媒体预览：媒体 1，非真实图片' })).toBeInTheDocument();
  });
});
