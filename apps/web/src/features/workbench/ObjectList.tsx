import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { AnnotationObject } from '../../../../../packages/contracts/generated/AnnotationObject';
import type { LocalObjectFlagMap } from '../../lib/editor/types';

const EMPTY_LOCAL_FLAGS: LocalObjectFlagMap = Object.freeze(Object.create(null));
const EMPTY_LABEL_NAMES: Readonly<Record<string, string>> = Object.freeze({});
const ROW_HEIGHT = 44;
type Props = {
  objects: readonly AnnotationObject[]; selectedIds: readonly string[];
  labelNames?: Readonly<Record<string, string>>;
  onSelect: (id: string, additive?: boolean) => void;
  localFlags?: LocalObjectFlagMap;
  onSetLocalFlags?: (ids: readonly string[], flags: { hidden?: boolean; locked?: boolean }) => void;
  flagsEditable?: boolean;
  status?: 'ready' | 'loading' | 'error' | 'empty' | 'unsupported';
};
type Projection = { object: AnnotationObject; ordinal: number; name: string; category: string };
type RowProps = { row: Projection; index: number; total: number; start: number; size: number; selected: boolean; hidden: boolean; locked: boolean; onSelect: Props['onSelect'] };
const ObjectRow = memo(function ObjectRow({ row, index, total, start, size, selected, hidden, locked, onSelect }: RowProps) {
  return <div id={'object-option-' + row.object.object_id} role="option" aria-setsize={total} aria-posinset={index + 1} aria-selected={selected}
    aria-label={row.name + (hidden ? '，已隐藏' : '') + (locked ? '，已锁定' : '')} data-hidden={hidden} data-locked={locked} data-testid={'object-item-' + row.object.object_id}
    className={'object-row' + (selected ? ' selected' : '')} style={{ position: 'absolute', top: start, height: size }}
    onClick={event => onSelect(row.object.object_id, event.ctrlKey || event.metaKey || event.shiftKey)}>
    <span className="object-dot" aria-hidden="true" /><span className="object-name" title={row.name}>{row.name}</span>
    <span className="object-label">{locked ? '锁定' : hidden ? '隐藏' : ''}</span>
  </div>;
});

export function ObjectList({ objects, selectedIds, labelNames = EMPTY_LABEL_NAMES, onSelect, localFlags = EMPTY_LOCAL_FLAGS, onSetLocalFlags, flagsEditable = true, status = objects.length ? 'ready' : 'empty' }: Props) {
  const [search, setSearch] = useState('');
  const [grouped, setGrouped] = useState(false);
  const rows = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const projection: Projection[] = [];
    for (let index = 0; index < objects.length; index++) {
      const object = objects[index];
      const category = labelNames[object.label_id] ?? object.label_id;
      const name = category + ' #' + (index + 1);
      if (!query || (name + ' ' + object.label_id + ' ' + object.object_id).toLocaleLowerCase().includes(query)) projection.push({ object, ordinal: index + 1, category, name });
    }
    if (!grouped) return projection;
    const groups = new Map<string, Projection[]>();
    for (const row of projection) { const group = groups.get(row.object.label_id); if (group) group.push(row); else groups.set(row.object.label_id, [row]); }
    return [...groups.values()].flat();
  }, [objects, labelNames, search, grouped]);
  const selectRef = useRef(onSelect);
  useLayoutEffect(() => { selectRef.current = onSelect; }, [onSelect]);
  const selectRow = useCallback((id: string, additive?: boolean) => additive ? selectRef.current(id, true) : selectRef.current(id), []);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const allHidden = selectedIds.length > 0 && selectedIds.every(id => localFlags[id]?.hidden);
  const someHidden = selectedIds.some(id => localFlags[id]?.hidden);
  const allLocked = selectedIds.length > 0 && selectedIds.every(id => localFlags[id]?.locked);
  const someLocked = selectedIds.some(id => localFlags[id]?.locked);
  const hiddenIds = useMemo(() => Object.keys(localFlags).filter(id => localFlags[id].hidden), [localFlags]);
  const viewportRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => viewportRef.current, estimateSize: () => ROW_HEIGHT, getItemKey: index => rows[index].object.object_id, initialRect: { width: 280, height: 320 }, overscan: 5 });
  const virtualRows = virtualizer.getVirtualItems();
  const showOptions = (status === 'ready' || status === 'unsupported') && rows.length > 0;
  const hasRenderedOptions = showOptions && virtualRows.length > 0;
  const selectedIndex = rows.findIndex(row => selected.has(row.object.object_id));
  const activeDescendant = selectedIndex >= 0 && virtualRows.some(row => row.index === selectedIndex) ? 'object-option-' + rows[selectedIndex].object.object_id : undefined;
  const message = { loading: '正在加载对象…', error: '对象加载失败，请重试。', empty: '还没有标注对象', unsupported: '画布不可用，仍可查看对象。', ready: '' }[status];
  return <section className="object-panel" aria-labelledby="object-heading">
    <div className="panel-heading"><h2 id="object-heading">对象</h2><span>{objects.length.toLocaleString('zh-CN')}</span></div>
    <div className="object-projection-controls"><label>检索对象<input type="search" aria-label="检索对象" placeholder="名称 / 类别 / ID" value={search} onChange={event => setSearch(event.target.value)} /></label>
      <label><input type="checkbox" checked={grouped} onChange={event => setGrouped(event.target.checked)} />按类别分组</label>
      <small>{rows.length} / {objects.length} · 已选择 {selectedIds.length}（过滤不改变选择；过滤外 {selectedIds.length - rows.filter(row => selected.has(row.object.object_id)).length}）</small></div>
    {onSetLocalFlags ? <div className="object-flag-controls" role="group" aria-label="对象显示与锁定">
      <button type="button" data-testid="object-hide-selected" aria-pressed={someHidden && !allHidden ? 'mixed' : allHidden} disabled={!flagsEditable || status !== 'ready' || !selectedIds.length} onClick={() => onSetLocalFlags(selectedIds, { hidden: !allHidden })}>{allHidden ? '显示选中' : '隐藏选中'}</button>
      <button type="button" data-testid="object-lock-selected" aria-pressed={someLocked && !allLocked ? 'mixed' : allLocked} disabled={!flagsEditable || status !== 'ready' || !selectedIds.length} onClick={() => onSetLocalFlags(selectedIds, { locked: !allLocked })}>{allLocked ? '解锁选中' : '锁定选中'}</button>
      <button type="button" data-testid="object-show-all" disabled={!flagsEditable || status !== 'ready' || !hiddenIds.length} onClick={() => onSetLocalFlags(hiddenIds, { hidden: false })}>显示全部</button>
    </div> : null}
    {hasRenderedOptions && message ? <p className={'state-message state-' + status} role="status">{message}</p> : null}
    <div className="object-viewport" data-testid="object-list" ref={viewportRef} role={hasRenderedOptions ? 'listbox' : 'region'} aria-label="标注对象" aria-multiselectable={hasRenderedOptions ? true : undefined} aria-busy={status === 'loading'} aria-activedescendant={hasRenderedOptions ? activeDescendant : undefined} tabIndex={0} onKeyDown={event => {
      if (event.nativeEvent.isComposing || (status !== 'ready' && status !== 'unsupported') || !rows.length) return;
      const isHome = event.key === 'Home', isEnd = event.key === 'End', isArrow = event.key === 'ArrowDown' || event.key === 'ArrowUp';
      if (!isHome && !isEnd && !isArrow) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = isHome ? 0 : isEnd ? rows.length - 1 : selectedIndex < 0 ? step > 0 ? 0 : rows.length - 1 : Math.max(0, Math.min(rows.length - 1, selectedIndex + step));
      event.preventDefault();
      if (next !== selectedIndex) selectRow(rows[next].object.object_id, event.shiftKey || event.ctrlKey || event.metaKey);
      virtualizer.scrollToIndex(next, { align: 'auto' });
    }}>
      {!hasRenderedOptions && message ? <p className={'state-message state-' + status} role={status === 'error' ? 'alert' : 'status'}>{message}</p> : null}
      {!message && !rows.length ? <p role="status">没有匹配对象；原选择仍保留。</p> : null}
      {showOptions ? <div className="virtual-spacer" style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>{virtualRows.map(virtualRow => {
        const row = rows[virtualRow.index];
        return <ObjectRow key={row.object.object_id} row={row} index={virtualRow.index} total={rows.length} start={virtualRow.start} size={virtualRow.size} selected={selected.has(row.object.object_id)} hidden={localFlags[row.object.object_id]?.hidden ?? false} locked={localFlags[row.object.object_id]?.locked ?? false} onSelect={selectRow} />;
      })}</div> : null}
    </div>
  </section>;
}
