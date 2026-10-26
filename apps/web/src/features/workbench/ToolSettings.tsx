// React projection of the native-acknowledged tool state in tool-state.ts.
import { useEffect, useState } from 'react';
import type { EditorCommand } from '../../../../../packages/contracts/generated/EditorCommand';
import type { EditorDelta } from '../../../../../packages/contracts/generated/EditorDelta';
import type { EditorTool } from '../../lib/editor/types';
import type { SelectionStore } from './selection-store';
import type { ToolState } from './tool-state';


/** The slice of the editor host the tool buttons need. */
export interface ToolSettingsHost {
  dispatch(command: EditorCommand): EditorDelta | null;
}


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
