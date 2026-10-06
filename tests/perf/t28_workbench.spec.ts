import { mkdir, writeFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { expect, test } from '../e2e/fixtures';
import type { AnnotationDocument } from '../../packages/contracts/generated/AnnotationDocument';
import type { AnnotationRevision } from '../../packages/contracts/generated/AnnotationRevision';
import type { SaveRequest } from '../../packages/contracts/generated/SaveRequest';
import type { SaveResponse } from '../../packages/contracts/generated/SaveResponse';
import type { EditorHost } from '../../apps/web/src/lib/editor/EditorHost';
import type { LocalObjectFlagMap } from '../../apps/web/src/lib/editor/types';

interface TransientObservation {
  counters: { snapshots: number; committedDocuments: number };
  serializedObjects: number;
  validationObjects: number;
  generation: number | null;
  objects: AnnotationDocument['objects'];
}

// No production hook: resolve the host which CanvasView actually mounted. Only
// snapshot methods are instrumented; both wrappers always execute the original.
async function mounted(page: Page, action: 'observe' | 'document' | 'nativeDelete' | 'consumerInvalidSelect' = 'observe', objectId = '') {
  return page.evaluate(({ action, objectId }) => {
    interface Fiber {
      type?: { name?: string }; return?: Fiber; child?: Fiber; sibling?: Fiber;
      stateNode?: { current?: Fiber }; memoizedState?: Hook; memoizedProps?: unknown;
    }
    interface Hook { memoizedState: unknown; next?: Hook }
    interface Counters { snapshots: number; committedChecks: number; committedDocuments: number }
    interface Probe { host: EditorHost; counters: Counters }
    type FiberElement = HTMLElement & { __t28Probe?: Probe };
    function owner(element: HTMLElement, name: string): Fiber {
      const key = Object.keys(element).find(key => key.startsWith('__reactFiber$'));
      if (!key) throw new Error(`No React fiber on ${element.dataset.testid}`);
      let root = (element as unknown as Record<string, Fiber>)[key];
      while (root.return) root = root.return;
      // DOM's fiber pointer can retain the previous alternate after a commit.
      // Read the committed tree, not stale props from that pointer.
      const current = root.stateNode?.current;
      if (!current) throw new Error('Committed React root not found');
      const pending = [current];
      while (pending.length) {
        const fiber = pending.pop()!;
        if (fiber.type?.name === name) return fiber;
        if (fiber.sibling) pending.push(fiber.sibling);
        if (fiber.child) pending.push(fiber.child);
      }
      throw new Error(`Actual ${name} owner not found`);
    }
    const canvas = document.querySelector<FiberElement>('[data-testid="annotation-canvas"]');
    const list = document.querySelector<HTMLElement>('[data-testid="object-list"]');
    if (!canvas || !list) throw new Error('Production Workbench is not mounted');
    const ref = owner(canvas, 'CanvasView').memoizedState?.next?.next?.memoizedState as { current: EditorHost | null };
    const host = ref.current;
    if (!host || host.status !== 'ready') throw new Error('Actual mounted host is not ready');
    if (!canvas.__t28Probe) {
      const counters: Counters = { snapshots: 0, committedChecks: 0, committedDocuments: 0 };
      const snapshot = host.getSnapshot;
      const committed = host.getCommittedSnapshot;
      host.getSnapshot = function () { counters.snapshots += 1; return snapshot.call(this); };
      host.getCommittedSnapshot = function (delta) {
        counters.committedChecks += 1;
        const document = committed.call(this, delta);
        if (document !== null) counters.committedDocuments += 1;
        return document;
      };
      canvas.__t28Probe = { host, counters };
    }
    if (canvas.__t28Probe.host !== host) throw new Error('Canvas host changed during observation');
    const delta = action === 'nativeDelete' ? host.dispatch({ kind: 'delete', object_ids: [objectId] }) : null;
    const documentSnapshot = action === 'document' ? host.getSnapshot() : null;
    const consumer = owner(list, 'ObjectList').memoizedProps as {
      objects: AnnotationDocument['objects']; selectedIds: string[]; localFlags: LocalObjectFlagMap; onSelect(id: string): void;
    };
    if (action === 'consumerInvalidSelect') consumer.onSelect(objectId);
    return {
      document: documentSnapshot, delta, error: host.error,
      objects: consumer.objects, selectedIds: consumer.selectedIds,
      consumerFlags: consumer.localFlags, nativeFlags: host.getLocalFlags(),
      generation: host.getGeneration(), counters: { ...canvas.__t28Probe.counters },
      serializedObjects: host.getSerializedInputObjects(), validationObjects: host.getValidationInputObjects(),
      adapter: host.getAdapterDiagnostics(),
    };
  }, { action, objectId });
}

async function hardwareReady(page: Page) {
  const gpu = page.getByTestId('gpu-status');
  await expect(gpu).toHaveAttribute('data-device-state', 'ready', { timeout: 30_000 });
  await expect(gpu).toHaveAttribute('data-actual-backend', 'webgpu');
  await expect(gpu).toHaveAttribute('data-adapter-kind', 'hardware');
}

async function boundedObjects(page: Page, total: number) {
  const options = page.getByTestId('object-list').getByRole('option');
  await expect(options.first()).toHaveAttribute('aria-setsize', String(total));
  const objectRows = await options.count();
  const canvasLabels = await page.getByTestId('canvas-label').count();
  expect(objectRows).toBeLessThan(100);
  expect(canvasLabels).toBeLessThanOrEqual(100);
  return { total, objectRows, canvasLabels };
}

test.use({ trace: 'on', screenshot: 'on' });

test('T28 actual Workbench: transient flags, locked native delete recovery, persisted delete and UI undo', async ({ page, seededProject }, testInfo) => {
  test.setTimeout(90_000);
  const asset = seededProject.assets.find(asset => asset.width === 320 && asset.height === 240 && asset.exif_orientation === 1);
  const other = seededProject.assets.find(item => item.asset_revision_id !== asset?.asset_revision_id);
  if (!asset || !other) throw new Error('Real synthetic media fixture requires two assets');
  const annotationPath = `/api/assets/${asset.asset_revision_id}/annotation`;
  const readHead = async () => {
    const response = await seededProject.api.request<AnnotationRevision>('GET', `${annotationPath}?ontology_version_id=${seededProject.ontology_version_id}`);
    expect(response.status).toBe(200);
    return response.json;
  };
  const initial = await readHead();
  const document: AnnotationDocument = {
    ...initial.document, completion: 'in_progress',
    objects: Array.from({ length: 2000 }, (_, index) => ({
      object_id: `t28-human-${String(index).padStart(4, '0')}`, label_id: 'label_person',
      geometry: { type: 'bbox_xyxy', x_min: 5 + (index % 50) * 6, y_min: 4 + Math.floor(index / 50) * 5.5,
        x_max: 9 + (index % 50) * 6, y_max: 8 + Math.floor(index / 50) * 5.5 },
      attributes: { helmet_state: 'unknown' },
      origin: { type: 'manual', prediction_id: null, model_run_id: null, import_batch_id: null },
    })),
  };
  const seedPayload: SaveRequest = { operation_id: crypto.randomUUID(), base_revision_id: initial.annotation_revision_id,
    document, lease: null, suggestion_decisions: [] };
  const seeded = await seededProject.api.request<SaveResponse>('PUT', annotationPath, seedPayload);
  expect(seeded.status, JSON.stringify(seeded.json)).toBe(200);
  const baseline = await readHead();
  expect(baseline.document).toEqual(document);
  expect(baseline.document.coordinate_space).toEqual({ type: 'canonical_image_pixels', width: 320, height: 240 });

  // Same real session/API fixture as e2e/fixtures, with the configured origin so
  // isolated verification never needs Main's canonical 5173 server.
  const origin = String(testInfo.project.use.baseURL ?? 'http://127.0.0.1:5173');
  await page.route(`${origin}/api/**`, async route => {
    const request = route.request();
    const incoming = new URL(request.url());
    const headers: Record<string, string> = { ...request.headers(), origin: seededProject.apiBaseUrl };
    delete headers.host;
    delete headers['content-length'];
    await route.fulfill({ response: await route.fetch({
      url: new URL(`${incoming.pathname}${incoming.search}`, seededProject.apiBaseUrl).href,
      headers, method: request.method(), postData: request.postDataBuffer() ?? undefined,
    }) });
  });
  const puts: SaveRequest[] = [];
  const putResponses: { status: number; response: SaveResponse }[] = [];
  const pendingResponses: Promise<void>[] = [];
  const browserErrors: string[] = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  page.on('request', request => {
    if (request.method() === 'PUT' && new URL(request.url()).pathname.endsWith('/annotation')) puts.push(request.postDataJSON() as SaveRequest);
  });
  page.on('response', response => {
    if (response.request().method() === 'PUT' && new URL(response.url()).pathname.endsWith('/annotation')) {
      pendingResponses.push(response.json().then(body => { putResponses.push({ status: response.status(), response: body as SaveResponse }); }));
    }
  });
  const evidence: Record<string, unknown> = { surface: 'actual production Workbench (not DenseHarness)', origin, seedPayload, baseline };
  const evidencePrefix = `reports/T28/workbench-main-${testInfo.project.name}-${testInfo.retry}-${Date.now()}`;
  await mkdir('reports/T28', { recursive: true });
  const screenshot = async (name: string) => page.screenshot({ path: `${evidencePrefix}-${name}.png`, fullPage: true });
  const idleWithoutSave = async () => {
    // Covers the real SaveQueue debounce, not only the synchronous event handler.
    await page.waitForTimeout(1000);
    expect(puts).toEqual([]);
    expect(await readHead()).toEqual(baseline);
  };
  const noTransientDocument = (before: TransientObservation, after: TransientObservation) => {
    expect(after.counters.snapshots).toBe(before.counters.snapshots);
    expect(after.counters.committedDocuments).toBe(before.counters.committedDocuments);
    expect(after.serializedObjects).toBe(before.serializedObjects);
    expect(after.validationObjects).toBe(before.validationObjects);
    expect(after.generation).toBe(before.generation);
    expect(after.objects).toEqual(baseline.document.objects);
  };
  try {
    await page.goto(origin);
    await page.getByTestId('login-username').fill(seededProject.login.username);
    await page.getByTestId('login-password').fill(seededProject.login.password);
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('login-submit')).toHaveCount(0);
    await page.goto(`${origin}/?project_id=${seededProject.project_id}&asset_revision_id=${asset.asset_revision_id}`);
    await hardwareReady(page);
    evidence.denseDom = await boundedObjects(page, 2000);
    const start = await mounted(page, 'document');
    expect(start.document).toEqual(baseline.document);
    expect(start.objects).toEqual(baseline.document.objects);
    expect(start.consumerFlags).toEqual({});
    expect(start.nativeFlags).toEqual({});
    await expect(page.getByTestId('undo')).toBeDisabled();
    await expect(page.getByTestId('redo')).toBeDisabled();
    evidence.start = start;
    await screenshot('loaded');

    const firstId = document.objects[0].object_id;
    const secondId = document.objects[1].object_id;
    const first = page.getByTestId(`object-item-${firstId}`);
    const list = page.getByTestId('object-list');
    await first.click();
    await expect(first).toHaveAttribute('aria-selected', 'true');
    await list.focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId(`object-item-${secondId}`)).toHaveAttribute('aria-selected', 'true');
    await expect(list).toHaveAttribute('aria-activedescendant', `object-option-${secondId}`);
    await page.keyboard.press('End');
    const lastId = document.objects[1999].object_id;
    await expect(page.getByTestId(`object-item-${lastId}`)).toHaveAttribute('aria-selected', 'true');
    await expect(list).toHaveAttribute('aria-activedescendant', `object-option-${lastId}`);
    await boundedObjects(page, 2000);
    await page.keyboard.press('Home');
    await expect(first).toHaveAttribute('aria-selected', 'true');
    await page.getByTestId('object-hide-selected').click();
    await expect(first).toHaveAttribute('data-hidden', 'true');
    await expect(page.getByTestId('object-hide-selected')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('object-lock-selected').click();
    await expect(first).toHaveAttribute('data-locked', 'true');
    await expect(first).toHaveAccessibleName(`对象 ${firstId}，已隐藏，已锁定`);
    const flagged = await mounted(page);
    expect(flagged.selectedIds).toEqual([firstId]);
    expect(flagged.consumerFlags).toEqual({ [firstId]: { hidden: true, locked: true } });
    expect(flagged.nativeFlags).toEqual(flagged.consumerFlags);
    noTransientDocument(start, flagged);
    await screenshot('flags');
    await page.getByTestId('object-show-all').click();
    await expect(first).toHaveAttribute('data-hidden', 'false');
    await expect(first).toHaveAttribute('data-locked', 'true');
    await expect(page.getByTestId('object-show-all')).toBeDisabled();
    await page.getByTestId('object-lock-selected').click();
    await expect(first).toHaveAttribute('data-locked', 'false');
    await expect(page.getByTestId('object-lock-selected')).toHaveAttribute('aria-pressed', 'false');
    const cleared = await mounted(page);
    expect(cleared.consumerFlags).toEqual({});
    expect(cleared.nativeFlags).toEqual({});
    noTransientDocument(start, cleared);
    await idleWithoutSave();

    // Leave flags set, then switch away and back using real media buttons.
    await page.getByTestId('object-hide-selected').click();
    await page.getByTestId('object-lock-selected').click();
    const beforeSwitch = await mounted(page);
    noTransientDocument(start, beforeSwitch);
    await page.getByTestId(`asset-item-${other.asset_revision_id}`).click();
    await hardwareReady(page);
    expect((await mounted(page)).nativeFlags).toEqual({});
    await page.getByTestId(`asset-item-${asset.asset_revision_id}`).click();
    await hardwareReady(page);
    await boundedObjects(page, 2000);
    const returned = await mounted(page, 'document');
    expect(returned.document).toEqual(baseline.document);
    expect(returned.objects).toEqual(baseline.document.objects);
    expect(returned.selectedIds).toEqual([]);
    expect(returned.consumerFlags).toEqual({});
    expect(returned.nativeFlags).toEqual({});
    await expect(first).toHaveAttribute('data-hidden', 'false');
    await expect(first).toHaveAttribute('data-locked', 'false');
    await idleWithoutSave();
    evidence.transient = { flagged, cleared, beforeSwitch, returned, puts: [...puts] };

    await first.click();
    await page.getByTestId('object-lock-selected').click();
    const beforeLockedDelete = await mounted(page);
    // Keep this direct-native error check distinct from the production keyboard
    // regression: this CanvasView's real WASM -> onDelta -> SaveQueue.
    const lockedDelete = await mounted(page, 'nativeDelete', firstId);
    expect(lockedDelete.error?.code).toBe('OBJECT_LOCKED');
    if (lockedDelete.delta) {
      expect(lockedDelete.delta.error?.code).toBe('OBJECT_LOCKED');
      expect(lockedDelete.delta.document_changed).toBe(false);
      expect(lockedDelete.delta.suggestion_decisions).toEqual([]);
    }
    noTransientDocument(beforeLockedDelete, lockedDelete);
    const lockedDocument = await mounted(page, 'document');
    expect(lockedDocument.document).toEqual(baseline.document);
    expect(lockedDelete.selectedIds).toEqual([firstId]);
    expect(lockedDelete.consumerFlags).toEqual({ [firstId]: { hidden: false, locked: true } });
    expect(lockedDelete.nativeFlags).toEqual(lockedDelete.consumerFlags);
    await expect(first).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('undo')).toBeDisabled();
    await expect(page.getByTestId('redo')).toBeDisabled();
    await expect(page.getByTestId('object-lock-selected')).toBeEnabled();
    await expect(page.getByTestId('object-hide-selected')).toBeEnabled();
    await list.focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId(`object-item-${secondId}`)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Home');
    await expect(first).toHaveAttribute('aria-selected', 'true');
    await idleWithoutSave();
    evidence.lockedDelete = { lockedDelete, lockedDocument };
    await screenshot('locked-delete-recovered');

    await page.getByTestId('object-lock-selected').click();
    await expect(first).toHaveAttribute('data-locked', 'false');
    const beforeDelete = await mounted(page);
    noTransientDocument(lockedDocument, beforeDelete);
    const nativeDelete = await mounted(page, 'nativeDelete', firstId);
    expect(nativeDelete.delta).toMatchObject({ document_changed: true, removed_object_ids: [firstId],
      selected_object_ids: [], can_undo: true, can_redo: false, suggestion_decisions: [], error: null });
    await expect(page.getByTestId('undo')).toBeEnabled();
    await expect(page.getByTestId('redo')).toBeDisabled();
    await boundedObjects(page, 1999);
    const deleted = await mounted(page, 'document');
    const deletedDocument = { ...document, objects: document.objects.slice(1) };
    expect(deleted.document).toEqual(deletedDocument);
    expect(deleted.objects).toEqual(deletedDocument.objects);
    expect(deleted.selectedIds).toEqual([]);
    expect(deleted.consumerFlags).toEqual({});
    expect(deleted.nativeFlags).toEqual({});
    expect(deleted.generation).toBe(returned.generation! + 1);
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-phase', 'synced');
    const deletedHead = await readHead();
    expect(deletedHead.document).toEqual(deletedDocument);
    expect(deletedHead.parent_revision_id).toBe(baseline.annotation_revision_id);
    expect(deletedHead.revision_no).toBe(baseline.revision_no + 1);
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ base_revision_id: baseline.annotation_revision_id, document: deletedDocument,
      suggestion_decisions: [], lease: null });
    evidence.nativeDelete = { nativeDelete, deleted, deletedHead };
    await screenshot('deleted');

    await page.getByTestId('undo').click();
    await boundedObjects(page, 2000);
    await expect(page.getByTestId('undo')).toBeDisabled();
    await expect(page.getByTestId('redo')).toBeEnabled();
    const undone = await mounted(page, 'document');
    expect(undone.document).toEqual(baseline.document);
    expect(undone.objects).toEqual(baseline.document.objects);
    expect(undone.consumerFlags).toEqual({});
    expect(undone.nativeFlags).toEqual({});
    expect(undone.generation).toBe(deleted.generation! + 1);
    expect(undone.counters.committedDocuments - returned.counters.committedDocuments).toBe(2);
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-phase', 'synced');
    const undoHead = await readHead();
    expect(undoHead.document).toEqual(baseline.document);
    expect(undoHead.parent_revision_id).toBe(deletedHead.annotation_revision_id);
    expect(undoHead.revision_no).toBe(baseline.revision_no + 2);
    expect(puts).toHaveLength(2);
    expect(puts[1]).toMatchObject({ base_revision_id: deletedHead.annotation_revision_id, document: baseline.document,
      suggestion_decisions: [], lease: null });
    await Promise.all(pendingResponses);
    expect(putResponses.map(item => item.status)).toEqual([200, 200]);
    expect(browserErrors).toEqual([]);
    evidence.undo = { undone, undoHead };
    await screenshot('undo');

    // Nonempty redo history must also survive the native error. Testing only
    // the initial empty stack would miss an error which silently clears it.
    await first.click();
    await page.getByTestId('object-lock-selected').click();
    const historyBeforeError = await mounted(page);
    const historyError = await mounted(page, 'nativeDelete', firstId);
    expect(historyError.error?.code).toBe('OBJECT_LOCKED');
    noTransientDocument(historyBeforeError, historyError);
    expect(historyError.selectedIds).toEqual([firstId]);
    expect(historyError.nativeFlags).toEqual({ [firstId]: { hidden: false, locked: true } });
    await expect(first).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('undo')).toBeDisabled();
    await expect(page.getByTestId('redo')).toBeEnabled();
    await expect(page.getByTestId('object-lock-selected')).toBeEnabled();
    await page.getByTestId('object-lock-selected').click();
    await expect(first).toHaveAttribute('data-locked', 'false');
    await expect(page.getByTestId('redo')).toBeEnabled();
    const recoveredHistory = await mounted(page, 'document');
    expect(recoveredHistory.document).toEqual(baseline.document);
    expect(recoveredHistory.objects).toEqual(baseline.document.objects);
    expect(recoveredHistory.consumerFlags).toEqual({});
    expect(recoveredHistory.nativeFlags).toEqual({});
    await page.waitForTimeout(1000);
    expect(puts).toHaveLength(2);
    expect(await readHead()).toEqual(undoHead);
    expect(browserErrors).toEqual([]);
    evidence.nonemptyHistoryError = { historyBeforeError, historyError, recoveredHistory };
    await screenshot('history-error-recovered');
    await page.getByTestId('object-lock-selected').click();
    await expect(first).toHaveAttribute('data-locked', 'true');
    const beforeRejectedSelection = await mounted(page);
    expect(beforeRejectedSelection.nativeFlags[firstId]?.locked).toBe(true);
    await mounted(page, 'consumerInvalidSelect', 't28-no-longer-present-object');
    await expect(page.getByRole('alert').filter({ hasText: 'OBJECT_NOT_FOUND' })).toBeVisible();
    await expect(first).toHaveAttribute('aria-selected', 'true');
    await expect(first).toHaveAttribute('data-locked', 'true');
    await expect(page.getByTestId('undo')).toBeDisabled();
    await expect(page.getByTestId('redo')).toBeEnabled();
    const afterRejectedSelection = await mounted(page);
    noTransientDocument(beforeRejectedSelection, afterRejectedSelection);
    expect(afterRejectedSelection.selectedIds).toEqual([firstId]);
    expect(afterRejectedSelection.nativeFlags).toEqual(beforeRejectedSelection.nativeFlags);
    await page.waitForTimeout(1000);
    expect(puts).toHaveLength(2);
    expect(await readHead()).toEqual(undoHead);
    evidence.rejectedSelection = { beforeRejectedSelection, afterRejectedSelection };
    console.log(JSON.stringify({ surface: evidence.surface, origin, objects: 2000, denseDom: evidence.denseDom,
      transientSnapshotCalls: flagged.counters.snapshots - start.counters.snapshots,
      transientPUTs: 0, lockedDelete: lockedDelete.error?.code,
      savedObjectCounts: puts.map(put => put.document.objects.length),
      committedDocuments: undone.counters.committedDocuments, adapter: undone.adapter }));
  } finally {
    await Promise.allSettled(pendingResponses);
    await writeFile(`${evidencePrefix}.raw.json`, JSON.stringify({ ...evidence, puts, putResponses, browserErrors }, null, 2));
    await testInfo.attach('actual-workbench-consumer-evidence', { path: `${evidencePrefix}.raw.json`, contentType: 'application/json' });
  }
});
