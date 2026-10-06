import type { ActivityKind } from '../../../../../packages/contracts/generated/ActivityKind';
import type { ActivityInterval } from '../../../../../packages/contracts/generated/ActivityInterval';
import type { ActivitySession } from '../../../../../packages/contracts/generated/ActivitySession';

export type FocusInterval = { start_ms: number; end_ms: number; focused: boolean; last_input_ms?: number };
export function activeDuration(intervals: readonly FocusInterval[]): number {
  return intervals.reduce((sum, interval) => {
    if (!interval.focused || !Number.isFinite(interval.start_ms) || !Number.isFinite(interval.end_ms)) return sum;
    const end = interval.last_input_ms === undefined ? interval.end_ms : Math.min(interval.end_ms, interval.last_input_ms + 60_000);
    return sum + Math.max(0, end - interval.start_ms);
  }, 0);
}
export type ActivityStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export class ActivityCollector {
  currentSession = crypto.randomUUID();
  private enabled = false;
  private focused = true;
  private kind: ActivityKind = 'task';
  private anchor = 0;
  private lastInput = 0;
  private highWater = 0;
  private sessions: ActivitySession[] = [];
  private listeners = new Set<() => void>();
  private revision = 0;
  readonly storageKey: string;
  constructor(readonly projectId: string, readonly actorId: string, private readonly clock: () => number = () => performance.now(), private readonly storage?: ActivityStorage) {
    this.storageKey = `weblabel:activity:v1:${encodeURIComponent(projectId)}:${encodeURIComponent(actorId)}`;
    const saved = storage?.getItem(this.storageKey);
    if (saved) {
      const parsed: unknown = JSON.parse(saved);
      if (!parsed || typeof parsed !== 'object' || !('schema_version' in parsed) || parsed.schema_version !== 1 || !('sessions' in parsed) || !Array.isArray(parsed.sessions)) throw new Error('Invalid local activity journal');
      const kinds: Record<ActivityKind, true> = { task: true, annotation: true, correction: true, review: true, switch: true, model_wait: true };
      const sessionIds = new Set<string>();
      this.sessions = parsed.sessions.map((value: unknown): ActivitySession => {
        if (!value || typeof value !== 'object' || !('session_id' in value) || typeof value.session_id !== 'string' || !value.session_id || value.session_id.length > 128 || sessionIds.has(value.session_id) || !('version' in value) || !Number.isSafeInteger(value.version) || (value.version as number) < 0 || !('intervals' in value) || !Array.isArray(value.intervals) || value.intervals.length > 10_000) throw new Error('Invalid local activity session');
        sessionIds.add(value.session_id);
        let total = 0;
        const intervals = value.intervals.map((item: unknown, index: number): ActivityInterval => {
          if (!item || typeof item !== 'object' || !('seq' in item) || item.seq !== index || !('kind' in item) || typeof item.kind !== 'string' || !Object.hasOwn(kinds, item.kind) || !('duration_ms' in item) || !Number.isSafeInteger(item.duration_ms) || (item.duration_ms as number) <= 0 || (item.duration_ms as number) > 86_400_000) throw new Error('Invalid local activity interval');
          total += item.duration_ms as number;
          if (total > 86_400_000) throw new Error('Local activity session exceeds one day');
          return { seq: index, kind: item.kind as ActivityKind, duration_ms: item.duration_ms as number };
        });
        return { session_id: value.session_id, version: value.version as number, intervals };
      });
    }
  }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getRevision = (): number => this.revision;
  isEnabled(): boolean { return this.enabled; }
  getKind(): ActivityKind { return this.kind; }
  private now(): number {
    const sample = this.clock();
    if (!Number.isFinite(sample)) throw new Error('Invalid monotonic clock');
    this.highWater = Math.max(this.highWater, Math.floor(sample));
    return this.highWater;
  }
  private notify(): void { this.revision++; for (const listener of this.listeners) listener(); }
  setEnabled(enabled: boolean): void {
    this.commit(); this.enabled = enabled; this.anchor = this.lastInput = this.now(); this.notify();
  }
  setFocused(focused: boolean): void {
    this.commit(); this.focused = focused; this.anchor = this.lastInput = this.now(); this.notify();
  }
  setKind(kind: ActivityKind): void { this.commit(); this.kind = kind; this.notify(); }
  interact(kind: ActivityKind = this.kind): void {
    const now = this.now();
    if (kind !== this.kind || now > this.lastInput + 60_000) this.commit();
    const changed = kind !== this.kind;
    this.kind = kind;
    this.lastInput = now;
    if (changed) this.notify();
  }
  commit(): void {
    const now = this.now();
    const end = this.kind === 'model_wait' ? now : Math.min(now, this.lastInput + 60_000);
    const duration = this.enabled && this.focused ? Math.max(0, end - this.anchor) : 0;
    this.anchor = now;
    if (!duration) return;
    let session = this.sessions.find((item) => item.session_id === this.currentSession);
    if (!session) { session = { session_id: this.currentSession, version: 0, intervals: [] }; this.sessions.push(session); }
    if (session.intervals.length >= 10_000 || session.intervals.reduce((sum, item) => sum + item.duration_ms, 0) + duration > 86_400_000) {
      this.enabled = false;
      this.notify();
      throw new Error('Activity session limit reached; stop and export before starting a new session');
    }
    session.intervals.push({ seq: session.intervals.length, kind: this.kind, duration_ms: duration });
    this.storage?.setItem(this.storageKey, JSON.stringify({ schema_version: 1, sessions: this.sessions }));
    this.notify();
  }
  snapshot(): ActivitySession[] { return structuredClone(this.sessions); }
  totals(): Record<ActivityKind, number> {
    const result: Record<ActivityKind, number> = { task: 0, annotation: 0, correction: 0, review: 0, switch: 0, model_wait: 0 };
    for (const session of this.sessions) for (const interval of session.intervals) result[interval.kind] += interval.duration_ms;
    return result;
  }
  acknowledge(sessionId: string, version: number): void {
    const session = this.sessions.find((item) => item.session_id === sessionId);
    if (!session || !Number.isSafeInteger(version) || version < session.version) throw new Error('Invalid activity acknowledgement');
    session.version = version;
    this.storage?.setItem(this.storageKey, JSON.stringify({ schema_version: 1, sessions: this.sessions }));
    this.notify();
  }
  clear(): void {
    this.enabled = false;
    this.sessions = [];
    this.currentSession = crypto.randomUUID();
    this.storage?.removeItem(this.storageKey);
    this.anchor = this.lastInput = this.now();
    this.notify();
  }
}
