import { memo, useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { AnnotationObject } from '../../../../../packages/contracts/generated/AnnotationObject';
import type { LocalObjectFlagMap } from '../../lib/editor/types';

const EMPTY_LOCAL_FLAGS: LocalObjectFlagMap = Object.freeze(Object.create(null));
const ROW_HEIGHT = 40;

type Props = {
  objects: readonly AnnotationObject[];
  selectedIds: readonly string[];
  onSelect: (id: string) => void;
  localFlags?: LocalObjectFlagMap;
  onSetLocalFlags?: (ids: readonly string[], flags: { hidden?: boolean; locked?: boolean }) => void;
  flagsEditable?: boolean;
  status?: 'ready' | 'loading' | 'error' | 'empty' | 'unsupported';
};

type RowProps = {
  objectId: string;
  labelId: string;
  index: number;
  total: number;
  start: number;
  size: number;
  selected: boolean;
  hidden: boolean;
  locked: boolean;
  onSelect: Props['onSelect'];
};

const ObjectRow = memo(function ObjectRow({ objectId, labelId, index, total, start, size, selected, hidden, locked, onSelect }: RowProps) {
  return (
    <div
      id={`object-option-${objectId}`}
      role="option"
      aria-setsize={total}
      aria-posinset={index + 1}
      aria-selected={selected}
      aria-label={`对象 ${objectId}${hidden ? '，已隐藏' : ''}${locked ? '，已锁定' : ''}`}
      data-hidden={hidden}
      data-locked={locked}
      data-testid={`object-item-${objectId}`}
      className={`object-row${selected ? ' selected' : ''}`}
      style={{ position: 'absolute', top: start, height: size }}
      onClick={() => onSelect(objectId)}
    >
      <span className="object-dot" aria-hidden="true" />
      <span className="object-name">{objectId}</span>
      <span className="object-label">{labelId}</span>
    </div>
  );
});

export function ObjectList({ objects, selectedIds, onSelect, localFlags = EMPTY_LOCAL_FLAGS, onSetLocalFlags, flagsEditable = true, status = objects.length ? 'ready' : 'empty' }: Props) {
  const selectRef = useRef(onSelect);
  useLayoutEffect(() => { selectRef.current = onSelect; }, [onSelect]);
  const selectRow = useCallback((id: string) => selectRef.current(id), []);
  const allHidden = selectedIds.length > 0 && selectedIds.every(id => localFlags[id]?.hidden);
  const someHidden = selectedIds.some(id => localFlags[id]?.hidden);
  const allLocked = selectedIds.length > 0 && selectedIds.every(id => localFlags[id]?.locked);
  const someLocked = selectedIds.some(id => localFlags[id]?.locked);
  const hiddenIds = useMemo(() => Object.keys(localFlags).filter(id => localFlags[id].hidden), [localFlags]);
  const viewportRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: objects.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => ROW_HEIGHT,
    initialRect: { width: 280, height: 320 },
    overscan: 5,
  });
  const virtualRows = virtualizer.getVirtualItems();
  const selectedIndex = objects.findIndex((object) => selectedIds.includes(object.object_id));
  const activeDescendant =
    (status === 'ready' || status === 'unsupported') &&
    selectedIndex >= 0 &&
    virtualRows.some((row) => row.index === selectedIndex)
      ? `object-option-${objects[selectedIndex].object_id}`
      : undefined;
  const message = {
    loading: '正在加载对象…',
    error: '对象加载失败，请重试。',
    empty: '暂无标注对象',
    unsupported: '当前浏览器不支持工作台画布；对象仍可查看。',
    ready: '',
  }[status];

  return (
    <section className="object-panel" aria-labelledby="object-heading">
      <div className="panel-heading"><h2 id="object-heading">对象</h2><span>{objects.length.toLocaleString('zh-CN')}</span></div>
      {onSetLocalFlags ? <div role="group" aria-label="对象显示与锁定" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: 8 }}>
        <button type="button" data-testid="object-hide-selected" aria-pressed={someHidden && !allHidden ? 'mixed' : allHidden}
          disabled={!flagsEditable || status !== 'ready' || !selectedIds.length}
          onClick={() => onSetLocalFlags(selectedIds, { hidden: !allHidden })}>{allHidden ? '显示选中' : '隐藏选中'}</button>
        <button type="button" data-testid="object-lock-selected" aria-pressed={someLocked && !allLocked ? 'mixed' : allLocked}
          disabled={!flagsEditable || status !== 'ready' || !selectedIds.length}
          onClick={() => onSetLocalFlags(selectedIds, { locked: !allLocked })}>{allLocked ? '解锁选中' : '锁定选中'}</button>
        <button type="button" data-testid="object-show-all" disabled={!flagsEditable || status !== 'ready' || !hiddenIds.length}
          onClick={() => onSetLocalFlags(hiddenIds, { hidden: false })}>显示全部</button>
      </div> : null}
      <div
        className="object-viewport"
        data-testid="object-list"
        ref={viewportRef}
        role="listbox"
        aria-label="标注对象"
        aria-busy={status === 'loading'}
        aria-activedescendant={activeDescendant}
        tabIndex={0}
        onKeyDown={(event) => {
          if ((status !== 'ready' && status !== 'unsupported') || objects.length === 0) return;
          const isHome = event.key === 'Home';
          const isEnd = event.key === 'End';
          const isArrow = event.key === 'ArrowDown' || event.key === 'ArrowUp';
          if (!isHome && !isEnd && !isArrow) return;
          const step = event.key === 'ArrowDown' ? 1 : -1;
          const nextIndex = isHome
            ? 0
            : isEnd
              ? objects.length - 1
              : selectedIndex < 0
                ? step > 0 ? 0 : objects.length - 1
                : Math.max(0, Math.min(objects.length - 1, selectedIndex + step));
          event.preventDefault();
          if (nextIndex !== selectedIndex) onSelect(objects[nextIndex].object_id);
          virtualizer.scrollToIndex(nextIndex, { align: 'auto' });
        }}
      >
        {message ? <p className={`state-message state-${status}`} role={status === 'error' ? 'alert' : 'status'}>{message}</p> : null}
        {(status === 'ready' || status === 'unsupported') && objects.length > 0 ? (
          <div className="virtual-spacer" style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualRows.map((virtualRow) => {
              const object = objects[virtualRow.index];
              return <ObjectRow key={object.object_id} objectId={object.object_id} labelId={object.label_id}
                index={virtualRow.index} total={objects.length} start={virtualRow.start} size={virtualRow.size}
                selected={selectedIds.includes(object.object_id)}
                hidden={localFlags[object.object_id]?.hidden ?? false}
                locked={localFlags[object.object_id]?.locked ?? false}
                onSelect={selectRow} />;
            })}
          </div>
        ) : null}
      </div>
    </section>
  );
}
