// React projection of SelectionStore; persistence subscribes to its committed
// document changes, not pointer previews or selection changes.
import { useEffect, useState } from 'react';
import type { SelectionStore, DeltaListener } from './selection-store';
import type { Id } from '../../../../../packages/contracts/generated/Id';


export function SelectionLink({
  store,
  onSaveNeeded,
  label = '画布选择联动',
}: {
  store: SelectionStore;
  onSaveNeeded?: DeltaListener;
  label?: string;
}) {
  const [selection, setSelection] = useState<readonly Id[]>(() => store.getSelection());
  useEffect(() => store.subscribeSelection(setSelection), [store]);
  useEffect(() => {
    if (onSaveNeeded === undefined) return undefined;
    return store.subscribeSaveNeeded(onSaveNeeded);
  }, [store, onSaveNeeded]);
  return (
    <div data-testid="selection-link" role="status" aria-live="polite" aria-label={label}>
      <span data-testid="selection-count">{selection.length}</span>
      <span data-testid="selection-ids">{selection.join(' ')}</span>
    </div>
  );
}
