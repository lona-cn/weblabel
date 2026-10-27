import { readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { expect, test as fixtureTest } from './fixtures';
import type { Page } from '@playwright/test';
import type { DraftBranchEnvelope, DraftRecord, SaveQueueOwner } from '../../apps/web/src/lib/persistence/types';
import { database_path_for_test, start_test_app } from '../support/app';
import { cpuSnapshot, installBrowserFaults, observeEditor, privateOrigin, proxyPage } from '../support/faults';
import type { SaveQueue } from '../../apps/web/src/lib/persistence/save-queue';
type PreparedWindow = Window & { __prepared?: { queue: SaveQueue; owner: SaveQueueOwner } };

const test = fixtureTest.extend({
  app: async ({}, use) => { const app = await start_test_app('false', 'background'); try { await use(app); } finally { await app.stop(); } },
  adminPage: async ({ page, seededProject }, use) => {
    await installBrowserFaults(page); await proxyPage(page, seededProject.apiBaseUrl);
    await page.goto(privateOrigin);
    await page.getByTestId('login-username').fill(seededProject.login.username);
    await page.getByTestId('login-password').fill(seededProject.login.password);
    await page.getByTestId('login-submit').click(); await expect(page.getByTestId('login-submit')).toHaveCount(0);
    await page.goto(`${privateOrigin}/?project_id=${seededProject.project_id}&ontology_version_id=${seededProject.ontology_version_id}`);
    await expect(page.getByTestId('asset-grid')).toBeVisible(); await observeEditor(page); await use(page);
  },
});
async function ready(page: Page) {
  await expect(page.getByTestId('gpu-status')).toHaveAttribute('data-actual-backend', 'webgpu');
  await expect(page.getByTestId('gpu-status')).toHaveAttribute('data-adapter-kind', 'hardware');
  await expect(page.getByTestId('gpu-status')).toHaveAttribute('data-device-state', 'ready');
}
async function certificate(page: Page, field: string): Promise<string> {
  return page.getByTestId('save-certificate').locator('dt').filter({ hasText: `local_commit.${field}` }).evaluate(element => {
    const value = element.nextElementSibling?.textContent; if (!value) throw new Error('Real local branch certificate absent'); return value;
  });
}
async function readBranch(page: Page, asset: string, draft: string): Promise<DraftBranchEnvelope> {
  return page.evaluate(async ({ asset, draft }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('weblabel-drafts'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try {
      if (db.version !== 2) throw new Error('Expected actual branch schema v2');
      return await new Promise<DraftBranchEnvelope>((resolve, reject) => {
        const tx = db.transaction('draft_branches', 'readonly'), request = tx.objectStore('draft_branches').get([asset, draft]);
        let row: DraftBranchEnvelope; request.onsuccess = () => { row = request.result; };
        tx.oncomplete = () => { if (!row) reject(new Error('Exact branch is missing')); else resolve(row); }; tx.onabort = tx.onerror = () => reject(tx.error);
      });
    } finally { db.close(); }
  }, { asset, draft });
}
async function choose(page: Page, draft: string) {
  const mountedBefore = await page.evaluate(() => window.__t30Faults.hosts.length);
  const radio = page.getByTestId('recovery-banner').getByRole('radio', { name: new RegExp(draft) });
  await radio.check();
  await page.getByTestId('recover-selected-branch').click();
  await page.waitForFunction(previous => window.__t30Faults.hosts.length > previous, mountedBefore);
  await ready(page);
}

test.describe('T13 offline branch acceptance', () => {
  // The existing 120s scenario deadline must include cold app/seed/login fixtures.
  test.describe.configure({ timeout: 120_000 });
test('T13 two same-context offline tabs retain independent Native documents, journals, pending payloads and exact commit identities', async ({ adminPage: page, seededProject, app }, info) => {
  const db = new DatabaseSync(database_path_for_test(app));
  try { db.prepare("INSERT INTO model_profiles(profile_id,provider_id,model_id,auth_kind,capabilities_json,availability,verification,runtime_version,verified_at,config_json,secret_ref,created_at) VALUES('profile_mock_local','mock','weblabel-mock-source-v1','none',?,'ready','mock_only','builtin-mock-1',NULL,'{}',NULL,'2026-10-06T00:00:00Z')").run(JSON.stringify({ image_input: true, tools: false, structured_output: true, bbox_output: true, attributes: true })); } finally { db.close(); }
  await page.reload(); await observeEditor(page);
  const asset = seededProject.assets.find(item => item.width === 320)!;
  const context = page.context(), second = await page.context().newPage();
  // The pages share this fixture's actual cookie session; initialize only matching CSRF, never a draft/writer identity.
  const token = await page.evaluate(() => sessionStorage.getItem('weblabel_csrf'));
  await second.addInitScript(token => { if (token) sessionStorage.setItem('weblabel_csrf', token); }, token);
  await installBrowserFaults(second); await proxyPage(second, seededProject.apiBaseUrl);
  await second.goto(`${privateOrigin}/?project_id=${seededProject.project_id}&ontology_version_id=${seededProject.ontology_version_id}`);
  await expect(second.getByTestId('asset-grid')).toBeVisible(); await observeEditor(second);
  for (const tab of [page, second]) {
    await tab.getByTestId(`asset-item-${asset.asset_revision_id}`).click(); await ready(tab);
    await expect(tab.getByTestId('tool-box')).toBeEnabled();
    await tab.getByTestId('inspector-ai').click();
    await tab.getByTestId('ai-provider').selectOption('profile_mock_local');
    await tab.getByRole('radio', { name: '检测对象' }).check(); await tab.getByTestId('ai-prompt').fill('Synthetic Engineering Mock only; retain this tab’s selected acceptance.');
    await tab.getByTestId('ai-run').click(); await tab.getByTestId('ai-consent').getByRole('checkbox').check(); await tab.getByTestId('ai-authorize').click();
    await expect(tab.locator('[data-testid^="candidate-"] input[type="checkbox"]').first()).toBeEnabled();
    await tab.locator('[data-testid^="candidate-"] input[type="checkbox"]').first().check();
  }
  await context.setOffline(true);
  for (const tab of [page, second]) await tab.route(`**/api/assets/${asset.asset_revision_id}/annotation`, async route => { if (route.request().method() === 'PUT') await route.abort('internetdisconnected'); else await route.fallback(); });
  const originals: Array<{ envelope: DraftBranchEnvelope; document: unknown; certificate: { draft_id: string; write_token: string } }> = [];
  for (const tab of [page, second]) {
    await tab.getByTestId('accept-selected').click();
    await expect(tab.getByTestId('save-status')).toHaveAttribute('data-dirty', 'true');
    await expect.poll(() => certificate(tab, 'generation')).toBe('1');
    await expect(tab.getByTestId('save-status')).toHaveAttribute('data-phase', 'save_failed');
    const accepted = await cpuSnapshot(tab);
    await tab.getByTestId('object-item-mock-object-1').click();
    await tab.getByTestId('inspector-attributes').click();
    await tab.getByTestId('attribute-helmet_state').selectOption({ label: originals.length === 0 ? 'wearing' : 'not_wearing' });
    await expect.poll(() => certificate(tab, 'generation')).toBe('2');
    const draft_id = await certificate(tab, 'draft_id'), write_token = await certificate(tab, 'write_token');
    const envelope = await readBranch(tab, asset.asset_revision_id, draft_id), document = await cpuSnapshot(tab), record = envelope.record as DraftRecord;
    expect(envelope.write_token).toBe(write_token); expect(record.document).toEqual(document);
    expect(record.intent_journal.map(row => row.intent.decision)).toEqual(['accept']);
    expect(record.pending?.request.document).toEqual(accepted); expect(record.pending?.generation).toBe(1); expect(record.pending?.request.suggestion_decisions).toEqual(record.intent_journal.map(row => row.intent));
    expect(record.pending_outcome).toBe('unknown'); expect(record.used_operation_ids).toContain(record.pending!.operation_id);
    originals.push({ envelope, document, certificate: { draft_id, write_token } });
  }
  expect(originals[0].certificate.draft_id).not.toBe(originals[1].certificate.draft_id);
  expect(originals[0].document).not.toEqual(originals[1].document);
  expect(await readBranch(second, asset.asset_revision_id, originals[0].certificate.draft_id)).toEqual(originals[0].envelope);
  await page.close(); await second.close(); await context.setOffline(false);
  const reopened: Page[] = [], forks: DraftBranchEnvelope[] = [];
  try {
    for (const original of originals) {
      const tab = await context.newPage(); reopened.push(tab); await installBrowserFaults(tab); await proxyPage(tab, seededProject.apiBaseUrl);
      await tab.addInitScript(token => { if (token) sessionStorage.setItem('weblabel_csrf', token); }, token);
      await tab.goto(`${privateOrigin}/?project_id=${seededProject.project_id}&ontology_version_id=${seededProject.ontology_version_id}`);
      await expect(tab.getByTestId('asset-grid')).toBeVisible(); await observeEditor(tab); await tab.getByTestId(`asset-item-${asset.asset_revision_id}`).click(); await ready(tab);
      await expect(tab.getByTestId('tool-box')).toBeDisabled();
      let puts = 0; tab.on('request', request => { if (request.method() === 'PUT' && request.url().includes(`/assets/${asset.asset_revision_id}/annotation`)) puts += 1; });
      await choose(tab, original.certificate.draft_id);
      await expect.poll(() => cpuSnapshot(tab)).toEqual(original.document);
      const fork = await readBranch(tab, asset.asset_revision_id, await certificate(tab, 'draft_id'));
      const record = fork.record as DraftRecord, source = original.envelope.record as DraftRecord;
      expect(fork.draft_id).not.toBe(original.certificate.draft_id); expect(fork.write_token).toBe(await certificate(tab, 'write_token'));
      expect(record.document).toEqual(source.document); expect(record.pending).toEqual(source.pending); expect(record.intent_journal).toEqual(source.intent_journal);
      expect(record.pending_owner).toEqual(source.pending_owner); expect(record.used_operation_ids).toEqual(source.used_operation_ids);
      expect(fork.sources).toContainEqual({ ...original.certificate, action: 'recover' }); expect(puts).toBe(0);
      expect(await readBranch(tab, asset.asset_revision_id, original.certificate.draft_id)).toEqual(original.envelope); forks.push(fork);
    }
    await choose(reopened[0], originals[1].certificate.draft_id);
    await expect.poll(() => cpuSnapshot(reopened[0])).toEqual(originals[1].document);
    expect(await readBranch(reopened[0], asset.asset_revision_id, forks[0].draft_id)).toEqual(forks[0]);
    await reopened[0].screenshot({ path: info.outputPath('two-tab-explicit-selection.png'), fullPage: true });
    await writeFile(info.outputPath('two-tab-branches.json'), JSON.stringify({ same_context: true, origin: privateOrigin, actual_native_backend: 'hardware_webgpu', real_model_calls: 0, engineering_mock_runs: 2, originals, forks }, null, 2));
  } finally { await Promise.all(reopened.map(tab => tab.close())); }
});
});

test('T13 actual never-dispatched prepared fork retains outcome and cannot borrow historical retry permission', async ({ adminPage: page, seededProject }, info) => {
  const asset = seededProject.assets.find(item => item.width === 320)!;
  await page.addInitScript(async () => {
    // Observe the public production owner boundary: this controlled grant models a task-preparation barrier, not a security scenario.
    const modulePath = '/src/lib/persistence/save-queue.ts'; const { SaveQueue } = await import(modulePath);
    const original = SaveQueue.prototype.setWriteOwner;
    SaveQueue.prototype.setWriteOwner = function(this: SaveQueue, owner: SaveQueueOwner) { original.call(this, owner); const state = window as PreparedWindow; state.__prepared = { queue: this, owner }; };
  });
  await page.reload(); await observeEditor(page); await page.getByTestId('asset-grid').waitFor();
  await page.getByTestId('asset-item-' + asset.asset_revision_id).click(); await ready(page);
  let puts = 0; page.on('request', request => { if (request.method() === 'PUT' && request.url().includes('/assets/' + asset.asset_revision_id + '/annotation')) puts += 1; });
  await page.evaluate(asset => { const state = window as PreparedWindow; const captured = state.__prepared!; captured.queue.subscribe(asset, () => { if (captured.queue.getStatus(asset).saving) captured.owner.canPrepareOperation = () => false; }); }, asset.asset_revision_id);
  await page.getByTestId('completion-state').selectOption('complete');
  await expect.poll(() => page.evaluate(asset => { const state = window as PreparedWindow; const record = state.__prepared?.queue.toRecord(asset); return record?.pending && record.pending_outcome === 'prepared' && record.writes_paused === true; }, asset.asset_revision_id)).toBe(true);
  await expect.poll(() => certificate(page, 'generation')).toBe('1');
  const sourceId = await certificate(page, 'draft_id'), source = await readBranch(page, asset.asset_revision_id, sourceId);
  expect((source.record as DraftRecord).pending).not.toBeNull(); expect(puts).toBe(0);
  await page.reload(); await observeEditor(page); await page.getByTestId('asset-item-' + asset.asset_revision_id).click(); await ready(page); await choose(page, sourceId);
  const fork = await readBranch(page, asset.asset_revision_id, await certificate(page, 'draft_id'));
  expect(fork.draft_id).not.toBe(sourceId); expect((fork.record as DraftRecord).pending_outcome).toBe('prepared'); expect((fork.record as DraftRecord).pending).toEqual((source.record as DraftRecord).pending);
  const retainedEligible = await page.evaluate(asset => { const state = window as PreparedWindow; const captured = state.__prepared!; captured.owner.canPrepareOperation = () => false; return captured.queue.canRetryRetained(asset, () => true); }, asset.asset_revision_id); expect(retainedEligible).toBe(false);
  await page.getByTestId('save-retry').click(); await page.evaluate(asset => { const state = window as PreparedWindow; return state.__prepared!.queue.whenPersisted(asset); }, asset.asset_revision_id);
  expect(puts).toBe(0); expect(await readBranch(page, asset.asset_revision_id, sourceId)).toEqual(source);
  expect((await readBranch(page, asset.asset_revision_id, fork.draft_id)).record).toMatchObject({ pending_outcome: 'prepared', pending: (source.record as DraftRecord).pending });
  await page.screenshot({ path: info.outputPath('prepared-fork.png'), fullPage: true });
  await writeFile(info.outputPath('prepared-fork.json'), JSON.stringify({ source, fork, annotation_puts: puts, external_model_calls: 0 }, null, 2));
});

test('T13 actual get failure exports complete listed raw cache with warning and no admission; lossy cache remains intact', async ({ adminPage: page, seededProject }, info) => {
  const asset = seededProject.assets.find(item => item.width === 320)!; await page.getByTestId('asset-item-' + asset.asset_revision_id).click(); await ready(page);
  const raw = { schema_version: 77, future: { nested: [1, 'untouched'], extra: { canonical: 'raw' } } };
  await page.evaluate(async ({ asset, raw }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('weblabel-drafts'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    try { await new Promise<void>((resolve, reject) => { const tx = db.transaction('draft_branches', 'readwrite'); tx.objectStore('draft_branches').put({ asset_revision_id: asset, draft_id: 'cached-json', write_token: 'cached-token', record: raw, sources: [] }); tx.objectStore('draft_branches').put({ asset_revision_id: asset, draft_id: 'cached-map', write_token: 'map-token', record: { schema_version: 77, future: new Map([['preserved', true]]) }, sources: [] }); tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); }); } finally { db.close(); }
    window.dispatchEvent(new Event('focus'));
  }, { asset: asset.asset_revision_id, raw });
  await page.getByRole('radio', { name: /cached-json/ }).check();
  const row = page.getByTestId('recovery-banner'); await expect(row.getByTestId('rescue-selected-branch')).toBeEnabled();
  const failLaterRead = async () => page.evaluate(async () => {
    // Only the adapter's later read fails; list and actual IDB values remain untouched.
    const modulePath = '/src/lib/persistence/draft-store.ts'; const { IndexedDbDraftStorage } = await import(modulePath); IndexedDbDraftStorage.prototype.get = async () => { throw new Error('owned later raw read failed'); };
  });
  await failLaterRead(); const download = page.waitForEvent('download'); await row.getByTestId('rescue-selected-branch').click();
  const saved = await download, path = info.outputPath('cached-raw.json'); await saved.saveAs(path); expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(raw);
  await expect(page.getByRole('alert').filter({ hasText: '缓存快照' })).toContainText('不是最新读取确认'); await expect(row.getByTestId('recover-selected-branch')).toBeDisabled();
  await page.reload(); await observeEditor(page); await page.getByTestId('asset-item-' + asset.asset_revision_id).click(); await ready(page); await page.getByRole('radio', { name: /cached-map/ }).check();
  const mapRow = page.getByTestId('recovery-banner'); await expect(mapRow.getByTestId('rescue-selected-branch')).toBeEnabled(); await failLaterRead();
  let extraDownloads = 0; page.on('download', () => extraDownloads += 1); await mapRow.getByTestId('rescue-selected-branch').click(); await expect(page.getByRole('alert').filter({ hasText: '无法无损表示' })).toBeVisible(); expect(extraDownloads).toBe(0);
  const preservedMap = await page.evaluate(async asset => { const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('weblabel-drafts'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); try { return await new Promise<boolean>((resolve, reject) => { const tx = db.transaction('draft_branches', 'readonly'), request = tx.objectStore('draft_branches').get([asset, 'cached-map']); request.onsuccess = () => { const record = request.result.record; resolve(record.future instanceof Map && record.future.get('preserved') === true); }; request.onerror = () => reject(request.error); }); } finally { db.close(); } }, asset.asset_revision_id); expect(preservedMap).toBe(true);
  await page.screenshot({ path: info.outputPath('cached-rescue.png'), fullPage: true });
  await writeFile(info.outputPath('cached-rescue.json'), JSON.stringify({ original_raw: raw, explicit_cached_warning: true, lossy_record_preserved: true, extra_downloads: extraDownloads, external_model_calls: 0 }, null, 2));
});

test('T13 actual v1 upgrade preserves unknown raw values under the original key without admission or normalization', async ({ page }, info) => {
  await page.goto(privateOrigin);
  const result = await page.evaluate(async () => {
    const raw = { schema_version: 77, asset_revision_id: 'raw-do-not-rewrite', unknown: new Map([['extra', { untouched: true }]]), nested: { future: [1, null, 'text'] } };
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('weblabel-drafts', 1); request.onupgradeneeded = () => request.result.createObjectStore('drafts'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    await new Promise<void>((resolve, reject) => { const tx = db.transaction('drafts', 'readwrite'); tx.objectStore('drafts').put(raw, 'original-key'); tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); }); db.close();
    const modulePath = '/src/lib/persistence/draft-store.ts', { IndexedDbDraftStorage } = await import(modulePath);
    // Browser module boundary: static Node imports cannot exercise the browser's actual IndexedDB factory.
    const rows = await new IndexedDbDraftStorage().list('original-key'), row = rows[0];
    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('weblabel-drafts'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const shape = { version: upgraded.version, stores: [...upgraded.objectStoreNames] }; upgraded.close();
    return { ...shape, count: rows.length, asset: row.asset_revision_id, draft: row.draft_id, token: row.write_token, sources: row.sources, raw_asset: row.record.asset_revision_id, schema: row.record.schema_version, unknown_map: row.record.unknown instanceof Map, unknown_value: row.record.unknown.get('extra'), nested: row.record.nested };
  });
  expect(result).toMatchObject({ version: 2, stores: ['draft_branches'], count: 1, asset: 'original-key', draft: 'legacy', sources: [], raw_asset: 'raw-do-not-rewrite', schema: 77, unknown_map: true, unknown_value: { untouched: true }, nested: { future: [1, null, 'text'] } });
  expect(result.token).toMatch(/^[0-9a-f-]{36}$/); await writeFile(info.outputPath('legacy-upgrade.json'), JSON.stringify(result, null, 2));
});

test('T13 non-string legacy key aborts the entire real upgrade and permits read-only rescue of the unchanged v1 store', async ({ page }, info) => {
  await page.goto(privateOrigin);
  const result = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('weblabel-drafts', 1); request.onupgradeneeded = () => request.result.createObjectStore('drafts'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    await new Promise<void>((resolve, reject) => { const tx = db.transaction('drafts', 'readwrite'), store = tx.objectStore('drafts'); store.put({ first: 'preserved' }, 'string-first'); store.put({ second: new Map([['unchanged', 3]]) }, ['array-key', 3]); tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); }); db.close();
    const modulePath = '/src/lib/persistence/draft-store.ts', { IndexedDbDraftStorage } = await import(modulePath), storage = new IndexedDbDraftStorage();
    // Browser module boundary: static Node imports cannot exercise the browser's actual IndexedDB factory.
    let code = ''; try { await storage.list('string-first'); } catch (error) { if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') code = error.code; else throw error; }
    const rows = await storage.readLegacyForRescue();
    const legacy = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('weblabel-drafts'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const result = { code, version: legacy.version, stores: [...legacy.objectStoreNames], keys: rows.map((row: { key: IDBValidKey }) => row.key), first: rows[0].record, second_map: rows[1].record.second instanceof Map, second_value: rows[1].record.second.get('unchanged') }; legacy.close(); return result;
  });
  expect(result).toEqual({ code: 'STORAGE_UPGRADE_FAILED', version: 1, stores: ['drafts'], keys: ['string-first', ['array-key', 3]], first: { first: 'preserved' }, second_map: true, second_value: 3 });
  await writeFile(info.outputPath('legacy-abort-rescue.json'), JSON.stringify(result, null, 2));
});

test('T13 blocked real upgrade reports rescue-and-close instead of an empty list and leaves v1 intact', async ({ page }) => {
  await page.goto(privateOrigin);
  const result = await page.evaluate(async () => {
    const old = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('weblabel-drafts', 1); request.onupgradeneeded = () => request.result.createObjectStore('drafts'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    // Browser module boundary: static Node imports cannot exercise the browser's actual IndexedDB factory.
    await new Promise<void>((resolve, reject) => { const tx = old.transaction('drafts', 'readwrite'); tx.objectStore('drafts').put({ preserved: true }, 'asset'); tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
    const modulePath = '/src/lib/persistence/draft-store.ts', { IndexedDbDraftStorage } = await import(modulePath), storage = new IndexedDbDraftStorage();
    let error: { code: string; message: string } | null = null;
    try { await storage.list('asset'); } catch (reason) { const failure = reason as { code: string; message: string }; error = { code: failure.code, message: failure.message }; }
    old.close(); const rows = await storage.readLegacyForRescue(); return { error, rows };
  });
  expect(result.error?.code).toBe('STORAGE_BLOCKED'); expect(result.error?.message).toMatch(/Rescue.*close/i);
  expect(result.rows).toEqual([{ key: 'asset', record: { preserved: true } }]);
});
