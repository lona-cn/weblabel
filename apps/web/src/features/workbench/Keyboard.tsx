// T12 keyboard policy: one window-level key router for the editor. While a
// text input has focus or an IME composition is active, every editor shortcut
// is inert — Delete and letter shortcuts can never delete objects or switch
// tools out from under the text field. Space-pan, Esc cancellation, undo/redo
// and the tool keys are defined here; the normative summary lives in
// ToolSettings.INTERACTION_POLICY.
import { useEffect, useRef } from 'react';
import type { EditorCommand } from '../../../../../packages/contracts/generated/EditorCommand';
import type { EditorDelta } from '../../../../../packages/contracts/generated/EditorDelta';
import type { EditorTool } from '../../lib/editor/types';
import type { SelectionStore } from './SelectionLink';
import { type ToolState } from './ToolSettings';

/** The slice of the editor host the keyboard needs. */
export interface KeyboardHostPort {
  setTool(tool: EditorTool): void;
  dispatch(command: EditorCommand): EditorDelta | null;
  cancelGesture(): void;
}

/** Unmodified tool keys (event.code, so caps lock and layouts do not matter). */
const TOOL_BY_CODE: Record<string, EditorTool> = {
  KeyV: 'select',
  KeyB: 'box',
  KeyH: 'pan',
};

/** True for DOM targets that own their keyboard input (incl. IME). */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (target === null || typeof (target as HTMLElement).tagName !== 'string') return false;
  const element = target as HTMLElement;
  if (element.isContentEditable) return true;
  return (
    element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT'
  );
}

function randomObjectId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `object-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}

export function Keyboard({
  host,
  tools,
  store,
}: {
  host: KeyboardHostPort;
  tools: ToolState;
  store: SelectionStore;
}) {
  const composing = useRef(false);

  useEffect(() => {
    const handleCompositionStart = () => {
      composing.current = true;
    };
    const handleCompositionEnd = () => {
      composing.current = false;
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      // IME composition or text-field focus: the editor never sees the key.
      if (composing.current || event.isComposing || isTextEntryTarget(event.target)) return;
      const accelerator = event.ctrlKey || event.metaKey;
      if (event.key === 'Escape') {
        host.cancelGesture();
        return;
      }
      if (event.code === 'Space') {
        // Space never scrolls the workbench page; it holds a temporary pan.
        event.preventDefault();
        if (!event.repeat) tools.beginSpacePan();
        return;
      }
      if (accelerator && event.code === 'KeyZ') {
        event.preventDefault();
        host.dispatch({ kind: event.shiftKey ? 'redo' : 'undo' });
        return;
      }
      if (accelerator && !event.shiftKey && event.code === 'KeyY') {
        event.preventDefault();
        host.dispatch({ kind: 'redo' });
        return;
      }
      if (accelerator && event.code === 'KeyD') {
        event.preventDefault();
        const ids = [...store.getSelection()];
        if (ids.length > 0) {
          host.dispatch({
            kind: 'duplicate',
            object_ids: ids,
            new_ids: ids.map(() => randomObjectId()),
          });
        }
        return;
      }
      if (accelerator || event.altKey) return;
      if (event.key === 'Delete' || event.key === 'Backspace') {
        const ids = [...store.getSelection()];
        if (ids.length > 0) {
          event.preventDefault();
          host.dispatch({ kind: 'delete', object_ids: ids });
        }
        return;
      }
      if (event.shiftKey) return;
      const tool = TOOL_BY_CODE[event.code];
      if (tool !== undefined) {
        event.preventDefault();
        tools.set(tool);
      }
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') tools.endSpacePan();
    };
    const handleWindowBlur = () => {
      // Losing the window mid-hold must not leave a stuck pan mode.
      tools.endSpacePan();
    };
    window.addEventListener('compositionstart', handleCompositionStart, true);
    window.addEventListener('compositionend', handleCompositionEnd, true);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleWindowBlur);
    return () => {
      window.removeEventListener('compositionstart', handleCompositionStart, true);
      window.removeEventListener('compositionend', handleCompositionEnd, true);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, [host, tools, store]);

  return null;
}
