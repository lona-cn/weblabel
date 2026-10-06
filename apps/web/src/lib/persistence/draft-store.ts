// T13 · draft persistence: the DraftRecord store over the injected storage
// seam, plus the native-draft rescue export (testing-contracts §8).
import type { AnnotationDocument } from '../../../../../packages/contracts/generated/AnnotationDocument';
import type {
  Clock,
  DraftRecord,
  DraftStorage,
  Id,
  NativeDraftExport,
} from './types';
import { DRAFT_SCHEMA_VERSION, StorageError, realClock } from './types';

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

/** Thin typed wrapper around the injected storage seam. */
export class DraftStore {
  constructor(private readonly storage: DraftStorage) {}

  load(asset_revision_id: Id): Promise<DraftRecord | null> {
    return this.storage.get(asset_revision_id);
  }

  async save(record: DraftRecord): Promise<DraftRecord> {
    const frozen = freezeRecord(record);
    await this.storage.put(frozen);
    return frozen;
  }

  remove(asset_revision_id: Id): Promise<void> {
    return this.storage.delete(asset_revision_id);
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
    intent_journal: record.intent_journal,
    exported_at: new Date(clock.now()).toISOString(),
  };
}

export function serializeNativeDraft(draft: NativeDraftExport): string {
  return JSON.stringify(draft);
}

/**
 * Storage seam over a real serialization boundary (JSON round-trip), also used
 * where IndexedDB is unavailable. `failNextPut` injects storage failures so the
 * quota path can be exercised through the same production code.
 */
export class InMemoryDraftStorage implements DraftStorage {
  readonly log: Array<{ method: 'get' | 'put' | 'delete'; asset_revision_id: Id }> = [];
  private records = new Map<Id, string>();
  private nextPutError: Error | null = null;

  failNextPut(error: Error): void {
    this.nextPutError = error;
  }

  async get(asset_revision_id: Id): Promise<DraftRecord | null> {
    this.log.push({ method: 'get', asset_revision_id });
    const stored = this.records.get(asset_revision_id);
    return stored === undefined ? null : (JSON.parse(stored) as DraftRecord);
  }

  async put(record: DraftRecord): Promise<void> {
    this.log.push({ method: 'put', asset_revision_id: record.asset_revision_id });
    if (this.nextPutError !== null) {
      const error = this.nextPutError;
      this.nextPutError = null;
      throw error;
    }
    this.records.set(record.asset_revision_id, JSON.stringify(record));
  }

  async delete(asset_revision_id: Id): Promise<void> {
    this.log.push({ method: 'delete', asset_revision_id });
    this.records.delete(asset_revision_id);
  }
}

const DB_NAME = 'weblabel-drafts';
const DB_VERSION = 1;
const STORE_NAME = 'drafts';

function mapIdbError(error: unknown, fallbackCode: string): StorageError {
  const name = (error as { name?: string } | null)?.name;
  const message = error instanceof Error ? error.message : String(error);
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') {
    return new StorageError({ code: 'QUOTA_EXCEEDED', message });
  }
  return new StorageError({ code: fallbackCode, message });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(mapIdbError(request.error ?? new Error('IndexedDB request failed'), 'STORAGE_FAILED'));
  });
}

/** Production storage seam over the real browser IndexedDB API. */
export class IndexedDbDraftStorage implements DraftStorage {
  constructor(private readonly factory: IDBFactory | null = globalThis.indexedDB ?? null) {}

  async get(asset_revision_id: Id): Promise<DraftRecord | null> {
    const db = await this.open();
    try {
      const store = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME);
      const record = await requestResult(store.get(asset_revision_id));
      return (record as DraftRecord | undefined) ?? null;
    } finally {
      db.close();
    }
  }

  async put(record: DraftRecord): Promise<void> {
    const db = await this.open();
    try {
      const store = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME);
      await requestResult(store.put(record as unknown as Record<string, unknown>));
    } catch (error) {
      throw error instanceof StorageError ? error : mapIdbError(error, 'STORAGE_FAILED');
    } finally {
      db.close();
    }
  }

  async delete(asset_revision_id: Id): Promise<void> {
    const db = await this.open();
    try {
      const store = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME);
      await requestResult(store.delete(asset_revision_id));
    } finally {
      db.close();
    }
  }

  private open(): Promise<IDBDatabase> {
    const factory = this.factory;
    if (factory === null) {
      return Promise.reject(
        new StorageError({
          code: 'INDEXEDDB_UNAVAILABLE',
          message: 'IndexedDB is not available in this environment',
        }),
      );
    }
    return new Promise((resolve, reject) => {
      const request = factory.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'asset_revision_id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(mapIdbError(request.error ?? new Error('IndexedDB open failed'), 'STORAGE_OPEN_FAILED'));
    });
  }
}
