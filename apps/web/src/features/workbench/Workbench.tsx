import { useMemo, useState } from 'react';
import { Projects } from '../projects/Projects';
import type { AnnotationObject } from '../../../../../packages/contracts/generated/AnnotationObject';
import type { OntologyVersion } from '../../../../../packages/contracts/generated/OntologyVersion';
import { useRuntimeMode } from '../../app/providers';
import { AttributePanel } from './AttributePanel';
import { ObjectList } from './ObjectList';
import { Toolbar, type Tool } from './Toolbar';

export type WorkbenchStatus = 'ready' | 'loading' | 'error' | 'empty' | 'unsupported';

export const fixtureOntology: OntologyVersion = {
  ontology_version_id: 'fixture-ontology-v1', project_id: 'sample-project', version_no: 1,
  labels: [{
    label_id: 'label_person', name: '施工现场人员（安全帽、反光背心及高处作业防护检查）', color: '#2878d0', shortcut: null,
    allowed_geometry_types: ['bbox_xyxy'], attributes: [
      { key: 'helmet_state', kind: 'enum', required: true, default_value: 'unknown', enum_values: ['wearing', 'not_wearing', 'unknown'], min: null, max: null },
      { key: 'vest_visible', kind: 'boolean', required: false, default_value: null, enum_values: [], min: null, max: null },
      { key: 'confidence_note', kind: 'text', required: false, default_value: null, enum_values: [], min: null, max: null },
    ],
  }], guidelines_markdown: 'Development fixture only.', allow_out_of_bounds: false,
};

const fixtureObject: AnnotationObject = {
  object_id: 'object_person_001', label_id: 'label_person',
  geometry: { type: 'bbox_xyxy', x_min: 10, y_min: 20, x_max: 110, y_max: 220 },
  attributes: { helmet_state: 'unknown', vest_visible: true },
  origin: { type: 'manual', prediction_id: null, model_run_id: null, import_batch_id: null },
};

function useFixtureObjects(): readonly AnnotationObject[] {
  return useMemo(() => Array.from({ length: 10_000 }, (_, index) => ({
    ...fixtureObject,
    object_id: index === 0 ? fixtureObject.object_id : `object_person_${String(index + 1).padStart(5, '0')}`,
    attributes: index === 0 ? fixtureObject.attributes : { helmet_state: 'unknown' },
  })), []);
}

function ResizeControls({
  targetId,
  axis,
  decreaseName,
  increaseName,
  minimum,
  maximum,
  step,
}: {
  targetId: string;
  axis: 'width' | 'height';
  decreaseName: string;
  increaseName: string;
  minimum: number;
  maximum: number;
  step: number;
}) {
  const adjust = (delta: number) => {
    const target = document.getElementById(targetId);
    if (!target) return;
    const size = target.getBoundingClientRect()[axis];
    target.style[axis] = `${Math.max(minimum, Math.min(maximum, size + delta))}px`;
  };
  return (
    <div className="resize-controls">
      <button type="button" aria-label={decreaseName} title={`每次调整 ${step} 像素`} onClick={() => adjust(-step)}>−</button>
      <button type="button" aria-label={increaseName} title={`每次调整 ${step} 像素`} onClick={() => adjust(step)}>＋</button>
    </div>
  );
}

export function Workbench({ status = 'ready' }: { status?: WorkbenchStatus }) {
  const runtimeMode = useRuntimeMode();
  const objects = useFixtureObjects();
  const [selectedId, setSelectedId] = useState<string | null>(objects[0]?.object_id ?? null);
  const [tool, setTool] = useState<Tool>('select');
  const [activePage, setActivePage] = useState<'projects' | 'workbench'>('workbench');
  const [activeMedia, setActiveMedia] = useState(0);
  const displayedObjects = status === 'empty' ? [] : objects;
  const selected = status === 'empty' ? null : objects.find((object) => object.object_id === selectedId) ?? null;

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="WebLabel 首页"><span className="brand-mark" aria-hidden="true">W</span><span>WebLabel</span></a>
        <nav aria-label="主导航" className="main-nav">
          <button type="button" aria-current={activePage === 'projects' ? 'page' : undefined} onClick={() => setActivePage('projects')}>项目</button>
          <button type="button" aria-current={activePage === 'workbench' ? 'page' : undefined} onClick={() => setActivePage('workbench')}>工作台</button>
        </nav>
        <span className="mock-badge" aria-label="开发模拟数据">{runtimeMode === 'fixture' ? 'DEV MOCK' : ''}</span>
      </header>
      <div className="workspace-heading">
        <div><p className="eyebrow" aria-live="polite">演示项目 <span aria-hidden="true">/</span> 媒体 {activeMedia + 1} / 3</p><h1>安全帽属性检查</h1></div>
        <span className="local-state">仅本地界面状态 · 未连接持久化服务</span>
      </div>
      {activePage === 'projects' ? (
        <Projects onOpen={() => setActivePage('workbench')} />
      ) : (
        <div className="workbench-grid">
          <aside id="workbench-sidebar" className="sidebar-resize" aria-label="对象与属性侧栏，可拖动或用按钮调整宽度">
            <div id="media-strip" className="media-strip" aria-label="项目媒体">
              <div className="media-strip-heading">
                <span className="eyebrow">媒体底片条</span>
                <span>3 张</span>
                <ResizeControls targetId="media-strip" axis="height" decreaseName="减小媒体底片条高度" increaseName="增大媒体底片条高度" minimum={94} maximum={260} step={16} />
                <ResizeControls targetId="workbench-sidebar" axis="width" decreaseName="缩窄对象与属性侧栏" increaseName="加宽对象与属性侧栏" minimum={220} maximum={420} step={20} />
              </div>
              {[1, 2, 3].map((media) => (
                <button
                  key={media}
                  type="button"
                  className={`media-thumb${activeMedia === media - 1 ? ' active' : ''}`}
                  aria-label={activeMedia === media - 1 ? `当前媒体：现场图片 ${media}` : `现场图片 ${media}`}
                  aria-pressed={activeMedia === media - 1}
                  onClick={() => setActiveMedia(media - 1)}
                >
                  {String(media).padStart(2, '0')}
                </button>
              ))}
            </div>
            <ObjectList objects={displayedObjects} selectedIds={selectedId ? [selectedId] : []} onSelect={setSelectedId} status={status} />
            <AttributePanel object={selected} ontology={fixtureOntology} />
          </aside>
          <section className="canvas-column" aria-label="标注画布区域">
            <div id="canvas-toolbar-row" className="canvas-toolbar-row">
              <Toolbar active={tool} disabled={status !== 'ready'} onChange={setTool} />
              <div className="canvas-actions">
                <button type="button" aria-label="缩小画布（渲染器未接入）" title="画布渲染接入后可用" disabled>−</button>
                <span>缩放未接入</span>
                <button type="button" aria-label="放大画布（渲染器未接入）" title="画布渲染接入后可用" disabled>＋</button>
                <ResizeControls targetId="canvas-toolbar-row" axis="height" decreaseName="减小画布工具栏高度" increaseName="增大画布工具栏高度" minimum={46} maximum={180} step={16} />
              </div>
            </div>
            <div className="canvas-stage" data-testid="canvas-container">
              {status === 'loading' ? <div className="canvas-state" role="status">正在加载媒体…</div> : null}
              {status === 'error' ? <div className="canvas-state error" role="alert">媒体加载失败。请检查本地服务后重试。</div> : null}
              {status === 'empty' ? <div className="canvas-state" role="status">暂无媒体，请从项目页选择媒体。</div> : null}
              {status === 'unsupported' ? <div className="canvas-state warning" role="status">当前环境不支持 WebGPU；画布编辑不可用，对象列表仍可查看。</div> : null}
              {status === 'ready' ? <div className="canvas-placeholder" role="img" aria-label={`开发夹具媒体预览：媒体 ${activeMedia + 1}，非真实图片`}><span aria-hidden="true">▧</span><strong>媒体预览占位</strong><span>开发夹具媒体 {activeMedia + 1} / 3</span><span>画布渲染由后续编辑器接入</span></div> : null}
              <div className="canvas-size-label">画布容器 · {status === 'ready' ? '适配视口' : '等待媒体'}</div>
            </div>
            <footer className="canvas-footer"><span>选择工具：{tool}</span><span>对象 {displayedObjects.length.toLocaleString('zh-CN')}</span></footer>
          </section>
          <aside className="ai-placeholder" aria-label="AI审校区域"><h2>AI 审校</h2><span className="mock-badge">DEV MOCK</span><p>AI 差异审阅将在服务与授权流程接入后可用。</p><button type="button" disabled aria-label="AI审校暂不可用">暂不可用</button></aside>
        </div>
      )}
      <footer className="app-footer">开发夹具不会写入数据。未登录 · 无后端持久化 · 无真实 AI 调用。</footer>
    </main>
  );
}
