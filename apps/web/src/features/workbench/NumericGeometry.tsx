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
import type { SelectionStore } from './selection-store';

import { composeBBox, geometryDraft as draftOf, sameBBox, type GeometryDraft, type GeometryField } from './geometry-values';
/** The slice of the editor host the numeric inputs need. */
export interface NumericGeometryHost {
  getSnapshot(): AnnotationDocument | null;
  dispatch(command: EditorCommand): EditorDelta | null;
}

const GEOMETRY_FIELDS: readonly GeometryField[] = ['x', 'y', 'w', 'h'];


export function NumericGeometry({ store, host, disabled: readOnly = false, selectedIds }: { store: SelectionStore; host: NumericGeometryHost; disabled?: boolean; selectedIds?: readonly Id[] }) {
  const [objectId, setObjectId] = useState<Id | null>(null);
  const [draft, setDraft] = useState<GeometryDraft>({ x: '', y: '', w: '', h: '' });
  const [error, setError] = useState<string | null>(null);
  const selectionKey = useRef('');
  const baseline = useRef<{ asset: string; ontology: string; object: string; generation: number | null; geometry: BBox } | null>(null);
  const changed = useRef(false);
  useEffect(() => {
    const sync = (delta?: EditorDelta) => {
      const ids = selectedIds ?? store.getSelection();
      const key = JSON.stringify(ids);
      if (delta && !delta.document_changed && key === selectionKey.current) return;
      selectionKey.current = key;
      changed.current = false;
      const snapshot = host.getSnapshot();
      const object = ids.length === 1 ? snapshot?.objects.find(candidate => candidate.object_id === ids[0]) : undefined;
      if (!snapshot || !object) { baseline.current = null; setObjectId(null); setError(null); return; }
      baseline.current = { asset: snapshot.asset_revision_id, ontology: snapshot.ontology_version_id, object: object.object_id, generation: store.getGeneration(), geometry: object.geometry };
      setObjectId(object.object_id); setDraft(draftOf(object.geometry)); setError(null);
    };
    sync(); return store.subscribe(sync);
  }, [store, host, selectedIds]);

  const update = (field: GeometryField, value: string) => {
    const next = { ...draft, [field]: value };
    changed.current = true; setDraft(next);
    const snapshot = host.getSnapshot();
    if (snapshot) { const result = composeBBox(next, snapshot.coordinate_space); setError('error' in result ? result.error : null); }
  };
  const commitDraft = () => {
    if (readOnly || !changed.current || !baseline.current || objectId === null) return;
    const before = baseline.current;
    const snapshot = host.getSnapshot();
    const ids = store.getSelection();
    const current = snapshot?.objects.find(object => object.object_id === before.object);
    if (!snapshot || !current || ids.length !== 1 || ids[0] !== before.object || snapshot.asset_revision_id !== before.asset || snapshot.ontology_version_id !== before.ontology || store.getGeneration() !== before.generation || !sameBBox(current.geometry, before.geometry)) {
      changed.current = false; setError('选择或文档已变化，旧几何输入已取消。'); return;
    }
    const outcome = composeBBox(draft, snapshot.coordinate_space);
    if ('error' in outcome) { setError(outcome.error); return; }
    const originalDraft = draftOf(before.geometry);
    if (draft.x === originalDraft.x && draft.w === originalDraft.w) { outcome.bbox.x_min = before.geometry.x_min; outcome.bbox.x_max = before.geometry.x_max; }
    if (draft.y === originalDraft.y && draft.h === originalDraft.h) { outcome.bbox.y_min = before.geometry.y_min; outcome.bbox.y_max = before.geometry.y_max; }
    if (sameBBox(current.geometry, outcome.bbox)) { changed.current = false; setError(null); return; }
    const delta = host.dispatch({ kind: 'replace_geometry', object_id: before.object, geometry: outcome.bbox });
    if (!delta) { setError('几何更新失败：编辑器不可用或当前禁止写入'); return; }
    if (delta.error) { setError(delta.error.code + ': ' + delta.error.message); return; }
    changed.current = false; setError(null);
  };
  const revert = () => {
    changed.current = false;
    const current = host.getSnapshot()?.objects.find(object => object.object_id === objectId);
    if (current) setDraft(draftOf(current.geometry));
    setError(null);
  };
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter') { event.preventDefault(); commitDraft(); }
    else if (event.key === 'Escape') { event.preventDefault(); revert(); }
  };
  const disabled = readOnly || objectId === null;
  return <section className="numeric-geometry" data-testid="numeric-geometry" aria-label="几何数值">
    <h3>几何 · canonical 像素</h3>
    {error ? <div role="alert" data-testid="geometry-error">{error}</div> : null}
    <div className="geometry-fields">{GEOMETRY_FIELDS.map(field => <label key={field}><span>{field + ' (px)'}</span><input data-testid={'geometry-' + field} aria-label={field + ' canonical 像素'} value={draft[field]} disabled={disabled} inputMode="decimal" onChange={event => update(field, event.target.value)} onKeyDown={handleKeyDown} /></label>)}</div>
    <button type="button" disabled={disabled} onClick={commitDraft}>应用完整几何</button><button type="button" disabled={disabled} onClick={revert}>取消几何输入</button>
    <p>{objectId === null ? '选择单个对象以查看几何' : '编辑全部 x/y/w/h 后按 Enter 或应用；切换选择、图片、撤销或重做会取消旧输入。'}</p>
  </section>;
}
