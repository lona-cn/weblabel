// T12 numeric geometry editing. The inputs display canonical image pixels
// (the only coordinate truth) with an explicit px unit; React only projects
// values and hands edits back through `replace_geometry`, so there is no
// second geometry truth in the browser. Invalid values keep their error
// visible and never modify the document: a failed parse or range check simply
// does not dispatch.
import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { AnnotationDocument } from '../../../../../packages/contracts/generated/AnnotationDocument';
import type { BBox } from '../../../../../packages/contracts/generated/BBox';
import type { EditorCommand } from '../../../../../packages/contracts/generated/EditorCommand';
import type { EditorDelta } from '../../../../../packages/contracts/generated/EditorDelta';
import type { Id } from '../../../../../packages/contracts/generated/Id';
import type { SelectionStore } from './SelectionLink';

/** The slice of the editor host the numeric inputs need. */
export interface NumericGeometryHost {
  getSnapshot(): AnnotationDocument | null;
  dispatch(command: EditorCommand): EditorDelta | null;
}

export type GeometryField = 'x' | 'y' | 'w' | 'h';

export type GeometryDraft = Record<GeometryField, string>;

const GEOMETRY_FIELDS: readonly GeometryField[] = ['x', 'y', 'w', 'h'];

/** A canonical pixel value: a finite number with an optional `px` suffix. */
const CANONICAL_PIXELS = /^\s*(-?\d+(?:\.\d+)?)\s*(?:px)?\s*$/;

export function parseCanonicalPixels(text: string): number | null {
  const match = CANONICAL_PIXELS.exec(text);
  if (match === null) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function draftOf(geometry: BBox): GeometryDraft {
  return {
    x: `${geometry.x_min}px`,
    y: `${geometry.y_min}px`,
    w: `${geometry.x_max - geometry.x_min}px`,
    h: `${geometry.y_max - geometry.y_min}px`,
  };
}

function sameBBox(left: BBox, right: BBox): boolean {
  return (
    left.x_min === right.x_min &&
    left.y_min === right.y_min &&
    left.x_max === right.x_max &&
    left.y_max === right.y_max
  );
}

/** Validates a draft against the canonical image; never mutates anything. */
export function composeBBox(
  draft: GeometryDraft,
  space: { width: number; height: number },
): { bbox: BBox } | { error: string } {
  const x = parseCanonicalPixels(draft.x);
  const y = parseCanonicalPixels(draft.y);
  const w = parseCanonicalPixels(draft.w);
  const h = parseCanonicalPixels(draft.h);
  if (x === null || y === null || w === null || h === null) {
    return { error: '几何值必须是像素单位的数字，例如 50 或 50px' };
  }
  if (w <= 0 || h <= 0) {
    return { error: '宽和高必须为正（bbox 需要正面积）' };
  }
  if (x < 0 || y < 0 || x + w > space.width || y + h > space.height) {
    return {
      error: `几何必须位于 canonical 图像内（0..${space.width} × 0..${space.height} px）`,
    };
  }
  return { bbox: { type: 'bbox_xyxy', x_min: x, y_min: y, x_max: x + w, y_max: y + h } };
}

export function NumericGeometry({ store, host }: { store: SelectionStore; host: NumericGeometryHost }) {
  const [objectId, setObjectId] = useState<Id | null>(null);
  const [draft, setDraft] = useState<GeometryDraft>({ x: '', y: '', w: '', h: '' });
  const [error, setError] = useState<string | null>(null);
  const editing = useRef(false);
  const selectionKey = useRef('');

  useEffect(() => {
    const sync = (delta?: EditorDelta) => {
      if (editing.current) return;
      const ids = store.getSelection();
      const key = ids.join(' ');
      // Pointermove previews stream deltas constantly: they must never
      // trigger a document snapshot (C3), so only structural changes sync.
      const structural = delta === undefined || delta.document_changed || key !== selectionKey.current;
      selectionKey.current = key;
      if (!structural) return;
      const snapshot = host.getSnapshot();
      if (ids.length !== 1 || snapshot === null) {
        setObjectId(null);
        setError(null);
        return;
      }
      const object = snapshot.objects.find((candidate) => candidate.object_id === ids[0]);
      if (object === undefined) {
        setObjectId(null);
        return;
      }
      setObjectId(object.object_id);
      setDraft(draftOf(object.geometry));
      setError(null);
    };
    sync();
    return store.subscribe(sync);
  }, [store, host]);

  const validate = (next: GeometryDraft) => {
    const snapshot = host.getSnapshot();
    const space = snapshot?.coordinate_space;
    if (snapshot === null || space === undefined) return;
    const outcome = composeBBox(next, { width: space.width, height: space.height });
    setError('error' in outcome ? outcome.error : null);
  };

  const update = (field: GeometryField, value: string) => {
    const next: GeometryDraft = { ...draft, [field]: value };
    setDraft(next);
    validate(next);
  };

  const commitDraft = () => {
    if (objectId === null) return;
    const snapshot = host.getSnapshot();
    const space = snapshot?.coordinate_space;
    if (snapshot === null || space === undefined) return;
    const outcome = composeBBox(draft, { width: space.width, height: space.height });
    if ('error' in outcome) {
      // Invalid values keep the error visible and leave the document alone.
      setError(outcome.error);
      return;
    }
    const current = snapshot.objects.find((candidate) => candidate.object_id === objectId)?.geometry;
    if (current !== undefined && sameBBox(current, outcome.bbox)) {
      setError(null);
      return;
    }
    const delta = host.dispatch({
      kind: 'replace_geometry',
      object_id: objectId,
      geometry: outcome.bbox,
    });
    if (delta === null) {
      setError('几何更新失败：编辑器不可用');
      return;
    }
    if (delta.error !== null) {
      setError(`${delta.error.code}: ${delta.error.message}`);
      return;
    }
    setError(null);
  };

  const revert = () => {
    if (objectId === null) return;
    const snapshot = host.getSnapshot();
    const object = snapshot?.objects.find((candidate) => candidate.object_id === objectId);
    if (object === undefined || snapshot === null) return;
    setDraft(draftOf(object.geometry));
    setError(null);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitDraft();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      revert();
    }
  };

  const disabled = objectId === null;
  return (
    <div data-testid="numeric-geometry">
      {error !== null ? (
        <div role="alert" data-testid="geometry-error">
          {error}
        </div>
      ) : null}
      {GEOMETRY_FIELDS.map((field) => (
        <label key={field}>
          <span>{`${field} (px)`}</span>
          <input
            data-testid={`geometry-${field}`}
            aria-label={`${field} canonical 像素`}
            value={draft[field]}
            disabled={disabled}
            inputMode="decimal"
            onChange={(event) => update(field, event.target.value)}
            onFocus={() => {
              editing.current = true;
            }}
            onBlur={() => {
              editing.current = false;
              commitDraft();
            }}
            onKeyDown={handleKeyDown}
          />
        </label>
      ))}
      {disabled ? <p data-testid="geometry-hint">选择单个对象以编辑几何</p> : null}
    </div>
  );
}
