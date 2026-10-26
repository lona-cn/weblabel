import type { EditorDelta } from '../../../../../packages/contracts/generated/EditorDelta';
import type { Id } from '../../../../../packages/contracts/generated/Id';
export type DeltaListener = (delta: EditorDelta) => void;
export type SelectionListener = (ids: readonly Id[]) => void;

export class SelectionStore {
  private selection: readonly Id[] = [];
  private generation: number | null = null;
  private readonly deltaListeners = new Set<DeltaListener>();
  private readonly selectionListeners = new Set<SelectionListener>();
  private readonly saveListeners = new Set<DeltaListener>();

  /** Consumes one editor delta; `document_changed` gates the save trigger. */
  publish(delta: EditorDelta): void {
    if (delta.error) return;
    if (this.selection.length !== delta.selected_object_ids.length
      || this.selection.some((id, index) => id !== delta.selected_object_ids[index])) {
      this.selection = [...delta.selected_object_ids];
    }
    this.generation = delta.generation;
    for (const listener of this.deltaListeners) listener(delta);
    for (const listener of this.selectionListeners) listener(this.selection);
    if (delta.document_changed) {
      for (const listener of this.saveListeners) listener(delta);
    }
  }

  getSelection(): readonly Id[] {
    return this.selection;
  }

  getGeneration(): number | null {
    return this.generation;
  }

  /** Every delta, for UI projections that must not trigger anything. */
  subscribe(listener: DeltaListener): () => void {
    this.deltaListeners.add(listener);
    return () => {
      this.deltaListeners.delete(listener);
    };
  }

  subscribeSelection(listener: SelectionListener): () => void {
    this.selectionListeners.add(listener);
    return () => {
      this.selectionListeners.delete(listener);
    };
  }

  /**
   * The save trigger: only deltas with `document_changed === true` arrive
   * here, one listener call per committed document change (one pointerup is
   * one committed change and therefore exactly one save request).
   */
  subscribeSaveNeeded(listener: DeltaListener): () => void {
    this.saveListeners.add(listener);
    return () => {
      this.saveListeners.delete(listener);
    };
  }
}
