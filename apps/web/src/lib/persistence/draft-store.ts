// T13 · draft persistence: the DraftRecord store over the injected storage
// seam, plus the native-draft rescue export (testing-contracts §8).
import type { AnnotationDocument } from '../../../../../packages/contracts/generated/AnnotationDocument';
import type {
  DraftBranchEnvelope,
  DraftCommitReceipt,
  Clock,
  DraftRecord,
  DraftStorage,
  Id,
  NativeDraftExport,
} from './types';
import { DRAFT_SCHEMA_VERSION, StorageError, realClock } from './types';
import { validateContract } from '@weblabel/contracts/validate-browser';

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isId(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function isCounter(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function isAuthor(value: unknown): boolean {
  return value == null || isObject(value) && isId(value.actor_id) && isId(value.project_id);
}
function isIntent(value: unknown): boolean {
  return isObject(value) && isId(value.suggestion_set_id) && Array.isArray(value.change_ids) &&
    value.change_ids.every(isId) && (value.decision === 'accept' || value.decision === 'revert');
}

/** Generated wire shape first; the domain invariants cannot be expressed by that schema. */
function admitDocument(document: AnnotationDocument, asset: string, ontology: string): boolean {
  if (!validateContract('annotation_document', document).valid || document.asset_revision_id !== asset ||
    document.ontology_version_id !== ontology ||
    document.completion === 'confirmed_negative' && document.objects.length !== 0) return false;
  const ids = new Set<string>();
  for (const object of document.objects) {
    const box = object.geometry;
    if (ids.has(object.object_id) || box.x_min < 0 || box.y_min < 0 ||
      box.x_max <= box.x_min || box.y_max <= box.y_min ||
      box.x_max > document.coordinate_space.width || box.y_max > document.coordinate_space.height) return false;
    ids.add(object.object_id);
  }
  return true;
}

/** Read-only admission of disk input. Never normalizes, freezes, saves or grants authorship. */
export function admitRawDraft(value: unknown, asset?: string): asserts value is DraftRecord {
  const reject = (): never => { throw new Error('本地草稿版本或结构无效；请保留原始记录并导出救援。'); };
  if (!isObject(value) || value.schema_version !== DRAFT_SCHEMA_VERSION ||
    !isId(value.asset_revision_id) || asset !== undefined && value.asset_revision_id !== asset ||
    !isId(value.ontology_version_id) || !isId(value.base_revision_id) ||
    !isCounter(value.generation) || !isCounter(value.synced_generation) || value.synced_generation > value.generation ||
    !isCounter(value.synced_intent_seq) || !Array.isArray(value.intent_journal) || value.synced_intent_seq > value.intent_journal.length ||
    value.edit_seq !== undefined && !isCounter(value.edit_seq) ||
    !isAuthor(value.draft_owner) || !isAuthor(value.pending_owner) ||
    typeof value.updated_at !== 'string' ||
    value.writes_paused !== undefined && typeof value.writes_paused !== 'boolean' ||
    value.pending_outcome !== undefined && !['prepared', 'unknown', 'rejected'].includes(value.pending_outcome as string) ||
    value.used_operation_ids !== undefined && (!Array.isArray(value.used_operation_ids) || !value.used_operation_ids.every(isId))) reject();
  const record = value as unknown as DraftRecord;
  if (!admitDocument(record.document, record.asset_revision_id, record.ontology_version_id)) reject();
  let previousSeq = 0;
  for (const entry of record.intent_journal) {
    if (!isObject(entry) || !isCounter(entry.seq) || entry.seq <= previousSeq ||
      !isCounter(entry.generation) || entry.generation > record.generation ||
      typeof entry.recorded_at !== 'string' || !isIntent(entry.intent)) reject();
    previousSeq = entry.seq;
  }
  const pending = record.pending;
  if (pending !== null) {
    if (!isObject(pending) || !isId(pending.operation_id) || !isCounter(pending.generation) || pending.generation > record.generation ||
      !isCounter(pending.journal_seq_end) || pending.journal_seq_end > record.intent_journal.length ||
      pending.edit_seq !== undefined && (!isCounter(pending.edit_seq) || record.edit_seq !== undefined && pending.edit_seq > record.edit_seq) ||
      typeof pending.prepared_at !== 'string' || !validateContract('save_request', pending.request).valid ||
      pending.operation_id !== pending.request.operation_id || pending.request.base_revision_id !== record.base_revision_id ||
      !admitDocument(pending.request.document, record.asset_revision_id, record.ontology_version_id)) reject();
  }
  const error = record.save_error;
  if (error != null && (!isObject(error) || !['network', 'http', 'conflict'].includes(error.kind) ||
    typeof error.code !== 'string' || typeof error.message !== 'string' ||
    error.status !== null && !isCounter(error.status) || error.request_id !== null && !isId(error.request_id))) reject();
}

// Only this producer certifies nodes, after every JSON child and the node itself
// are frozen. External Object.isFrozen roots can still contain mutable children.
const certifiedFrozen = new WeakSet<object>();

/** Deep-freezes any draft-layer value (documents, intents, prepared requests). */
export function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (certifiedFrozen.has(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) {
    freezeDeep(nested);
  }
  Object.freeze(value);
  certifiedFrozen.add(value);
  return value;
}

/** Only privately certified trees can be adopted; external frozen roots are copied. */
export function immutableDocument(document: AnnotationDocument): AnnotationDocument {
  return certifiedFrozen.has(document)
    ? document
    : freezeDeep(JSON.parse(JSON.stringify(document)) as AnnotationDocument);
}

/** Deep-freezes a record so prepared payloads can never be mutated in place. */
export function freezeRecord(record: DraftRecord): DraftRecord {
  return freezeDeep(record);
}

// One module-wide lane per asset, including independent queue/storage consumers.
const lanes = new Map<Id, Promise<unknown>>();
function inLane<T>(asset: Id, run: () => Promise<T>): Promise<T> {
  const previous = lanes.get(asset) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(run);
  lanes.set(asset, next);
  void next.finally(() => { if (lanes.get(asset) === next) lanes.delete(asset); }).catch(() => {});
  return next;
}
export class DraftStore {
  constructor(private readonly storage: DraftStorage) {}
  list(asset: Id, guard: () => boolean = () => true): Promise<readonly DraftBranchEnvelope[]> {
    return inLane(asset, async () => { assertReadCurrent(guard); const result = await this.storage.list(asset, guard); assertReadCurrent(guard); return result; });
  }
  load(asset: Id, draft: Id, guard: () => boolean = () => true): Promise<DraftBranchEnvelope | null> {
    return inLane(asset, async () => { assertReadCurrent(guard); const result = await this.storage.get(asset, draft, guard); assertReadCurrent(guard); return result; });
  }
  save(envelope: DraftBranchEnvelope, guard: () => boolean = () => true): Promise<DraftBranchEnvelope | null> {
    const snapshot = structuredClone(envelope);
    snapshot.write_token = crypto.randomUUID();
    return inLane(envelope.asset_revision_id, async () => {
      if (!guard()) return null;
      const receipt = await this.storage.put(snapshot, guard);
      return receipt && receipt.asset_revision_id === snapshot.asset_revision_id && receipt.draft_id === snapshot.draft_id && receipt.write_token === snapshot.write_token ? snapshot : null;
    });
  }
  remove(asset: Id, draft: Id, guard: () => boolean = () => true): Promise<boolean> {
    return inLane(asset, async () => guard() ? this.storage.delete(asset, draft, guard) : false);
  }
}

/** Rescue download payload for an unsynced draft (testing-contracts §8). */
export function exportNativeDraft(record: DraftRecord, clock: Clock = realClock): NativeDraftExport {
  return {
    format: 'weblabel-native-draft',
    schema_version: DRAFT_SCHEMA_VERSION,
    unsynced: true,
    asset_revision_id: record.asset_revision_id,
    ontology_version_id: record.ontology_version_id,
    base_revision_id: record.base_revision_id,
    generation: record.generation,
    document: record.document,
    pending_operation_id: record.pending?.operation_id ?? null,
    pending: record.pending,
    draft_owner: record.draft_owner ?? null,
    pending_owner: record.pending_owner ?? null,
    pending_outcome: record.pending_outcome ?? (record.pending ? 'unknown' : 'prepared'),
    used_operation_ids: record.used_operation_ids ?? (record.pending ? [record.pending.operation_id] : []),
    intent_journal: record.intent_journal,
    exported_at: new Date(clock.now()).toISOString(),
  };
}

export function serializeNativeDraft(draft: NativeDraftExport): string {
  return JSON.stringify(draft);
}

/** In-memory storage has the same structured-clone and compound-key boundary as IDB. */
export class InMemoryDraftStorage implements DraftStorage {
  readonly log: Array<{ method: 'list' | 'get' | 'put' | 'delete'; asset_revision_id: Id; draft_id?: Id }> = [];
  private records = new Map<string, DraftBranchEnvelope>();
  private nextPutError: Error | null = null;
  failNextPut(error: Error): void { this.nextPutError = error; }
  private key(asset: Id, draft: Id): string { return JSON.stringify([asset, draft]); }
  async list(asset: Id, guard: () => boolean = () => true): Promise<readonly DraftBranchEnvelope[]> {
    assertReadCurrent(guard);
    this.log.push({ method: 'list', asset_revision_id: asset });
    return structuredClone([...this.records.values()].filter(row => row.asset_revision_id === asset));
  }
  async get(asset: Id, draft: Id, guard: () => boolean = () => true): Promise<DraftBranchEnvelope | null> {
    assertReadCurrent(guard);
    this.log.push({ method: 'get', asset_revision_id: asset, draft_id: draft });
    return structuredClone(this.records.get(this.key(asset, draft)) ?? null);
  }
  async put(envelope: DraftBranchEnvelope, guard: () => boolean = () => true): Promise<DraftCommitReceipt | false> {
    if (!guard()) return false;
    this.log.push({ method: 'put', asset_revision_id: envelope.asset_revision_id, draft_id: envelope.draft_id });
    if (this.nextPutError) { const error = this.nextPutError; this.nextPutError = null; throw error; }
    this.records.set(this.key(envelope.asset_revision_id, envelope.draft_id), structuredClone(envelope));
    return { asset_revision_id: envelope.asset_revision_id, draft_id: envelope.draft_id, write_token: envelope.write_token };
  }
  async delete(asset: Id, draft: Id, guard: () => boolean = () => true): Promise<boolean> {
    if (!guard()) return false;
    this.log.push({ method: 'delete', asset_revision_id: asset, draft_id: draft });
    this.records.delete(this.key(asset, draft)); return true;
  }
}
const DB_NAME = 'weblabel-drafts';
const DB_VERSION = 2;
const STORE_NAME = 'draft_branches'; 

function mapIdbError(error: unknown, fallbackCode: string): StorageError {
  const name = (error as { name?: string } | null)?.name;
  const message = error instanceof Error ? error.message : String(error);
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') {
    return new StorageError({ code: 'QUOTA_EXCEEDED', message });
  }
  return new StorageError({ code: fallbackCode, message });
}

function assertReadCurrent(guard: () => boolean): void {
  if (!guard()) throw new StorageError({ code: 'STORAGE_READ_REVOKED', message: 'Draft read owner changed' });
}

/** Production storage seam over the real browser IndexedDB API. */
export class IndexedDbDraftStorage implements DraftStorage {
  private upgradeFailed = false;
  private connectionEpoch = 0;
  constructor(private readonly factory: IDBFactory | null = globalThis.indexedDB ?? null) {}
  private async read<T>(guard: () => boolean, requestFor: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open();
    const epoch = this.connectionEpoch;
    try {
      assertReadCurrent(guard);
      const result = await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const request = requestFor(tx.objectStore(STORE_NAME));
        tx.oncomplete = () => resolve(request.result);
        tx.onabort = tx.onerror = () => reject(mapIdbError(tx.error, 'STORAGE_FAILED'));
      });
      assertReadCurrent(() => guard() && epoch === this.connectionEpoch); return result;
    } finally { db.close(); }
  }
  list(asset: Id, guard: () => boolean = () => true): Promise<readonly DraftBranchEnvelope[]> {
    return this.read(guard, store => store.index('asset_revision_id').getAll(asset));
  }
  async get(asset: Id, draft: Id, guard: () => boolean = () => true): Promise<DraftBranchEnvelope | null> {
    return (await this.read(guard, store => store.get([asset, draft]))) ?? null;
  }
  private async write(guard: () => boolean, operation: (store: IDBObjectStore) => void): Promise<boolean> {
    const db = await this.open();
    const epoch = this.connectionEpoch;
    try {
      if (!guard()) return false;
      return await new Promise<boolean>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.oncomplete = () => resolve(guard() && epoch === this.connectionEpoch);
        tx.onabort = tx.onerror = () => reject(mapIdbError(tx.error, 'STORAGE_FAILED'));
        operation(tx.objectStore(STORE_NAME));
      });
    } finally { db.close(); }
  }
  async put(envelope: DraftBranchEnvelope, guard: () => boolean = () => true): Promise<DraftCommitReceipt | false> {
    const committed = await this.write(guard, store => { store.put(envelope); });
    return committed ? { asset_revision_id: envelope.asset_revision_id, draft_id: envelope.draft_id, write_token: envelope.write_token } : false;
  }
  delete(asset: Id, draft: Id, guard: () => boolean = () => true): Promise<boolean> {
    return this.write(guard, store => { store.delete([asset, draft]); });
  }
  async readLegacyForRescue(): Promise<readonly { key: IDBValidKey; record: unknown }[]> {
    if (!this.upgradeFailed) throw new StorageError({ code: 'LEGACY_RESCUE_UNAVAILABLE', message: 'Legacy rescue is available only after an upgrade failure' });
    if (!this.factory) throw new StorageError({ code: 'INDEXEDDB_UNAVAILABLE', message: 'IndexedDB unavailable' });
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      let rejected = false;
      const request = this.factory!.open(DB_NAME);
      request.onupgradeneeded = () => request.transaction!.abort();
      request.onerror = () => reject(mapIdbError(request.error, 'LEGACY_RESCUE_FAILED'));
      request.onblocked = () => { rejected = true; reject(new StorageError({ code: 'STORAGE_BLOCKED', message: 'Close older pages after rescuing their drafts' })); };
      request.onsuccess = () => { if (rejected) request.result.close(); else resolve(request.result); };
    });
    try {
      if (db.version !== 1 || !db.objectStoreNames.contains('drafts')) throw new StorageError({ code: 'LEGACY_RESCUE_UNAVAILABLE', message: 'No legacy store remains' });
      return await new Promise((resolve, reject) => {
        const rows: { key: IDBValidKey; record: unknown }[] = [];
        const tx = db.transaction('drafts', 'readonly');
        const cursor = tx.objectStore('drafts').openCursor();
        cursor.onsuccess = () => { const row = cursor.result; if (row) { rows.push({ key: row.primaryKey, record: row.value }); row.continue(); } };
        tx.oncomplete = () => resolve(rows);
        tx.onabort = tx.onerror = () => reject(mapIdbError(tx.error, 'LEGACY_RESCUE_FAILED'));
      });
    } finally { db.close(); }
  }
  private open(): Promise<IDBDatabase> {
    if (!this.factory) return Promise.reject(new StorageError({ code: 'INDEXEDDB_UNAVAILABLE', message: 'IndexedDB unavailable' }));
    return new Promise((resolve, reject) => {
      let rejected = false;
      const fail = (error: StorageError) => { rejected = true; this.upgradeFailed = true; reject(error); };
      const request = this.factory!.open(DB_NAME, DB_VERSION);
      request.onblocked = () => fail(new StorageError({ code: 'STORAGE_BLOCKED', message: 'Rescue drafts in older pages, then close those pages to upgrade' }));
      request.onupgradeneeded = () => {
        const db = request.result, tx = request.transaction!;
        if (rejected) { tx.abort(); return; }
        const target = db.createObjectStore(STORE_NAME, { keyPath: ['asset_revision_id', 'draft_id'] });
        target.createIndex('asset_revision_id', 'asset_revision_id');
        if (db.objectStoreNames.contains('drafts')) {
          const cursor = tx.objectStore('drafts').openCursor();
          cursor.onsuccess = () => {
            const row = cursor.result;
            if (!row) { db.deleteObjectStore('drafts'); return; }
            if (typeof row.primaryKey !== 'string') { tx.abort(); return; }
            try { target.put({ asset_revision_id: row.primaryKey, draft_id: 'legacy', write_token: crypto.randomUUID(), record: row.value, sources: [] }); row.continue(); }
            catch { tx.abort(); }
          };
        }
      };
      request.onerror = () => fail(mapIdbError(request.error, 'STORAGE_UPGRADE_FAILED'));
      request.onsuccess = () => {
        const db = request.result;
        if (rejected) { db.close(); return; }
        db.onversionchange = () => { this.connectionEpoch += 1; db.close(); };
        resolve(db);
      };
    });
  }
}
