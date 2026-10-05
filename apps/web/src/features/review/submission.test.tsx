// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import type { EditorDelta } from '../../../../../packages/contracts/generated/EditorDelta';
import { EditorHost } from '../../lib/editor/EditorHost';
import type { EditorAssetRequest, EditorFacade, PointerInput } from '../../lib/editor/types';
import type { SaveStatusSnapshot } from '../../lib/persistence/types';
import type { ReviewTask } from './api';
import { setReviewEditorLocked, submitCurrentReviewRevision } from './submission';

const task: ReviewTask = {
  task_id: 'task-1', project_id: 'project-1', asset_revision_id: 'asset-1', ontology_version_id: 'ontology-1',
  assignee_id: 'annotator-1', state: 'open', created_at: '2026-09-26T00:00:00Z', review_id: null,
  revision_ids: null, review_decision: null, review_reason: null,
};
function cleanStatus(): SaveStatusSnapshot {
  return { phase: 'synced', dirty: false, saving: false, writes_paused: false, local_generation: 7, synced_generation: 7, base_revision_id: 'revision-7', draft_exportable: true, last_error: null };
}

describe('T26 serialized review submission', () => {
  it('cancels an in-flight pointer gesture synchronously before queue flush', async () => {
    let locked = false;
    let activePointerId: number | null = 7;
    const order: string[] = [];
    const host = { cancelGesture: vi.fn(() => { activePointerId = null; order.push('cancel-gesture'); }) };
    const surface = {
      setAttribute: vi.fn(() => order.push('inert')),
      removeAttribute: vi.fn(() => order.push('unlock')),
    } as unknown as HTMLElement;
    const lockEditor = (value: boolean) => setReviewEditorLocked({
      locked: value,
      state: { get current() { return locked; }, set current(next: boolean) { locked = next; } },
      host,
      surfaces: [surface],
    });
    await submitCurrentReviewRevision({
      task,
      queue: { flush: vi.fn(async () => { expect(activePointerId).toBeNull(); expect(locked).toBe(true); }), getStatus: () => cleanStatus() },
      readHead: async () => ({ annotation_revision_id: 'revision-7' }),
      submit: vi.fn(async () => undefined),
      lockEditor,
    });
    expect(host.cancelGesture).toHaveBeenCalledTimes(1);
    expect(order.slice(0, 2)).toEqual(['inert', 'cancel-gesture']);
    expect(order.at(-1)).toBe('unlock');
  });

  it('cancels an actual captured EditorHost gesture before a late pointerup', async () => {
    let gestureActive = false;
    let attemptedMutations = 0;
    let persistedMutations = 0;
    const pointerPhases: string[] = [];
    let viewport = { scale: 1, tx: 0, ty: 0, css_width: 100, css_height: 100, dpr: 1 };
    const facade = {
      pointer: (input: PointerInput) => {
        pointerPhases.push(input.phase);
        if (input.phase === 'down') gestureActive = true;
        if (input.phase === 'cancel') gestureActive = false;
        const document_changed = input.phase === 'up' && gestureActive;
        if (document_changed) attemptedMutations += 1;
        if (input.phase === 'up') gestureActive = false;
        return { document_changed, generation: 0, selected_object_ids: [], suggestion_decisions: [], error: null, repaint: false, can_undo: false, can_redo: false } as unknown as EditorDelta;
      },
      get_viewport: () => viewport,
      set_viewport: (next: typeof viewport) => { viewport = next; },
      fit_image: () => undefined,
      render: () => undefined,
      dispose: () => undefined,
    } as unknown as EditorFacade;
    const locked = { current: false };
    const host = new EditorHost({
      facadeFactory: { create: async () => ({ facade, transfer: { method: 'copyBytes', byteLength: 400, durationMs: 0 } }) },
      scheduler: { request: () => 1, cancel: () => undefined },
      nextRequestId: () => 'test-request',
      onDelta: (delta) => { if (delta.document_changed && !locked.current) persistedMutations += 1; },
    });
    const canvas = document.createElement('canvas');
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
    const setPointerCapture = vi.fn();
    const hasPointerCapture = vi.fn(() => true);
    const releasePointerCapture = vi.fn();
    Object.defineProperties(canvas, {
      setPointerCapture: { value: setPointerCapture },
      hasPointerCapture: { value: hasPointerCapture },
      releasePointerCapture: { value: releasePointerCapture },
    });
    host.mount(canvas);
    await host.loadAsset({ media: { asset_revision_id: 'asset-1' }, ontology: {}, document: {}, frame: { width: 10, height: 10, rgba: new Uint8Array(400) }, initial_generation: 0 } as unknown as EditorAssetRequest);
    const surface = document.createElement('div');

    fireEvent.pointerDown(canvas, { pointerId: 7, button: 0, buttons: 1, clientX: 20, clientY: 20 });
    setReviewEditorLocked({ locked: true, state: locked, host, surfaces: [surface] });
    fireEvent.pointerUp(canvas, { pointerId: 7, button: 0, buttons: 0, clientX: 20, clientY: 20 });

    expect(pointerPhases).toEqual(['down', 'cancel', 'up']);
    expect(setPointerCapture).toHaveBeenCalledWith(7);
    expect(releasePointerCapture).toHaveBeenCalledWith(7);
    expect(attemptedMutations).toBe(0);
    expect(persistedMutations).toBe(0);
    setReviewEditorLocked({ locked: false, state: locked, host, surfaces: [surface] });
    host.dispose();
  });

  it('locks editing across flush, authoritative-head read, and submission', async () => {
    let locked = false;
    const submit = vi.fn(async (_revisionId: string) => { expect(locked).toBe(true); });
    await submitCurrentReviewRevision({
      task,
      queue: { flush: vi.fn(async () => undefined), getStatus: () => cleanStatus() },
      readHead: async () => { expect(locked).toBe(true); return { annotation_revision_id: 'revision-7' }; },
      submit,
      lockEditor: (value) => { locked = value; },
    });
    expect(submit).toHaveBeenCalledWith('revision-7');
    expect(locked).toBe(false);
  });

  it('rejects a head-read race if the queue becomes dirty before submission', async () => {
    let locked = false;
    let reads = 0;
    const submit = vi.fn(async () => undefined);
    const getStatus = () => {
      reads += 1;
      return reads === 1 ? cleanStatus() : { ...cleanStatus(), phase: 'unsaved' as const, dirty: true, local_generation: 8 };
    };
    await expect(submitCurrentReviewRevision({
      task,
      queue: { flush: vi.fn(async () => undefined), getStatus },
      readHead: async () => { expect(locked).toBe(true); return { annotation_revision_id: 'revision-7' }; },
      submit,
      lockEditor: (value) => { locked = value; },
    })).rejects.toThrow('读取版本期间标注发生变化');
    expect(submit).not.toHaveBeenCalled();
    expect(locked).toBe(false);
  });
});
