// T12 tool state and settings. The tool state is the single browser-side
// source for which tool is active (the C3 facade has no get_tool read-back),
// including the temporary space-pan override. The interaction policy below is
// normative and exercised by tests/e2e/t12_tools.spec.ts; its runtime homes are
// EditorHost (contextmenu, scroll-zoom, capture pairing) and Keyboard (keys).
import { useEffect, useState } from 'react';
import type { EditorCommand } from '../../../../../packages/contracts/generated/EditorCommand';
import type { EditorDelta } from '../../../../../packages/contracts/generated/EditorDelta';
import type { EditorTool } from '../../lib/editor/types';
import type { SelectionStore } from './SelectionLink';

/** The slice of the editor host the tool controls need. */
export interface ToolStateHost {
  setTool(tool: EditorTool): void;
}

/**
 * Tool state with a temporary space-pan override: `beginSpacePan` switches the
 * facade to the pan tool, `endSpacePan` restores the base tool. Every effective
 * change goes through the host so the Rust core can cancel in-flight gestures.
 */
export class ToolState {
  private baseTool: EditorTool;
  private spacePanActive = false;
  private readonly host: ToolStateHost;
  private readonly listeners = new Set<(tool: EditorTool) => void>();

  constructor(host: ToolStateHost, initial: EditorTool = 'select') {
    this.host = host;
    this.baseTool = initial;
  }

  /** The effective tool (a held space key wins over the base tool). */
  current(): EditorTool {
    return this.spacePanActive ? 'pan' : this.baseTool;
  }

  /** The tool restored when the space key is released. */
  base(): EditorTool {
    return this.baseTool;
  }

  set(tool: EditorTool): void {
    const previous = this.current();
    this.spacePanActive = false;
    this.baseTool = tool;
    if (this.current() !== previous) this.host.setTool(this.current());
    this.notify();
  }

  beginSpacePan(): void {
    if (this.spacePanActive) return;
    this.spacePanActive = true;
    if (this.baseTool !== 'pan') this.host.setTool('pan');
    this.notify();
  }

  endSpacePan(): void {
    if (!this.spacePanActive) return;
    this.spacePanActive = false;
    this.host.setTool(this.baseTool);
    this.notify();
  }

  subscribe(listener: (tool: EditorTool) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    const tool = this.current();
    for (const listener of this.listeners) listener(tool);
  }
}

/** The slice of the editor host the tool buttons need. */
export interface ToolSettingsHost {
  dispatch(command: EditorCommand): EditorDelta | null;
}

/**
 * Normative canvas interaction policy (T12). There is deliberately no
 * platform branch: whatever the macOS ctrl/meta conventions are, the Windows
 * defaults cannot be altered because every rule below applies identically on
 * every platform (EditorHost implements the pointer side).
 */
export const INTERACTION_POLICY = {
  contextmenu: '画布上的右键与 macOS ctrl+点击都只抑制系统菜单：不选择、不编辑、不开始手势',
  spacePan: '按住空格临时切到平移工具并可拖动画布；松开恢复之前的工具；空格从不滚动页面',
  scrollZoom: '滚轮以光标为锚点连续缩放（指数系数），缩放会取消进行中的手势，绝不修改文档',
  accelerators: 'Ctrl 与 Meta 在所有平台都同时触发撤销/重做/复制，Windows 的 Ctrl 默认行为不变',
  toolKeys: '无修饰键的 V/ B/ H 切换选择/矩形/平移工具',
  delete: 'Delete 与 Backspace 删除当前选择；文本输入与输入法组合期间一切编辑快捷键都不生效',
} as const;

export function ToolSettings({
  tools,
  host,
  store,
}: {
  tools: ToolState;
  host: ToolSettingsHost;
  store: SelectionStore;
}) {
  const [tool, setToolState] = useState<EditorTool>(() => tools.current());
  const [history, setHistory] = useState<{ canUndo: boolean; canRedo: boolean }>({
    canUndo: false,
    canRedo: false,
  });

  useEffect(() => tools.subscribe(setToolState), [tools]);
  useEffect(
    () =>
      store.subscribe((delta: EditorDelta) => {
        setHistory({ canUndo: delta.can_undo, canRedo: delta.can_redo });
      }),
    [store],
  );

  return (
    <div data-testid="tool-settings" role="toolbar" aria-label="工具设置">
      <button type="button" data-testid="tool-select" aria-pressed={tool === 'select'} onClick={() => tools.set('select')}>
        选择
      </button>
      <button type="button" data-testid="tool-box" aria-pressed={tool === 'box'} onClick={() => tools.set('box')}>
        矩形
      </button>
      <button type="button" data-testid="tool-pan" aria-pressed={tool === 'pan'} onClick={() => tools.set('pan')}>
        平移
      </button>
      <button type="button" data-testid="undo" disabled={!history.canUndo} onClick={() => host.dispatch({ kind: 'undo' })}>
        撤销
      </button>
      <button type="button" data-testid="redo" disabled={!history.canRedo} onClick={() => host.dispatch({ kind: 'redo' })}>
        重做
      </button>
    </div>
  );
}
