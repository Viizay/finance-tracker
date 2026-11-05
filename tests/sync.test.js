import test from 'node:test';
import assert from 'node:assert/strict';
import { REQUIRED_SCOPES } from '../js/constants.js';
import { grantedAll, identifyAccount, createTokenStore } from '../js/identity.js';
import { emptyState, upsertTransaction } from '../js/model.js';
import { activeRows } from '../js/model.js';
import { emptyQueue } from '../js/storage.js';
import { driveCreateBody } from '../js/sheet-schema.js';
import { runSync } from '../js/sync.js';
import { createMockGoogle } from './mock-google.js';

const SCOPES = REQUIRED_SCOPES.join(' ');

function tokenStoreFresh() {
  const store = createTokenStore(() => 0);
  store.set({ access_token: 'good', expires_in: 3600, scope: SCOPES });
  return store;
}

function sampleState() {
  const state = emptyState();
  const added = upsertTransaction(state.transactions, {
    type: 'expense', amount: 12.5, category: 'Food', date: '2026-04-02', note: 'Lunch', recurring: false
  }, '', '2026-04-02T00:00:00.000Z');
  state.transactions = added.list;
  state.savingsBalance = 100;
  state.settingsUpdatedAt = '2026-04-02T00:00:00.000Z';
  return state;
}

function txIds(file) {
  const rows = file.grids.Transactions || [];
  return rows.slice(1).map((row) => row[0]).filter(Boolean);
}

test('requested scopes are drive.file plus identity, not full Drive or all spreadsheets', () => {
  assert.equal(REQUIRED_SCOPES.includes('https://www.googleapis.com/auth/drive.file'), true);
  assert.equal(REQUIRED_SCOPES.includes('openid'), true);
  assert.equal(REQUIRED_SCOPES.some((scope) => scope === 'https://www.googleapis.com/auth/drive'), false);
  assert.equal(REQUIRED_SCOPES.some((scope) => scope.includes('/auth/spreadsheets')), false);
  assert.equal(grantedAll(SCOPES), true);
  assert.equal(grantedAll('openid email'), false);
});

test('identity fails closed without sub or drive.file', async () => {
  const missing = await identifyAccount({ access_token: 't', scope: 'openid email profile' }, async () => {
    throw new Error('should not fetch');
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'missing_scope');
  const noSub = await identifyAccount({ access_token: 't', scope: SCOPES }, async () => ({
    status: 200, ok: true, json: async () => ({ email: 'a@example.com' })
  }));
  assert.equal(noSub.code, 'no_sub');
  const a = await identifyAccount({ access_token: 't', scope: SCOPES }, async () => ({
    status: 200, ok: true, json: async () => ({ sub: 'user-a', email: 'a@example.com' })
  }));
  const b = await identifyAccount({ access_token: 't', scope: SCOPES }, async () => ({
    status: 200, ok: true, json: async () => ({ sub: 'user-b', email: 'b@example.com' })
  }));
  assert.notEqual(a.session.sub, b.session.sub);
});

test('creates a private spreadsheet once and retries a failed write without duplicating rows', async () => {
  const google = createMockGoogle();
  google.failNextPuts(1);
  const body = driveCreateBody();
  assert.equal(body.permissions, undefined);
  assert.equal(JSON.stringify(body).includes('anyone'), false);
  assert.equal(body.appProperties.financeTracker, '1');
  let sheet = null;
  const data = sampleState();
  const queue = { ops: [{ opId: 'op1', entity: 'transaction', id: data.transactions[0].id, action: 'upsert' }] };
  const first = await runSync({
    data, queue, base: { rows: {}, settingsUpdatedAt: '' }, sheet, tokenStore: tokenStoreFresh(),
    fetchImpl: google.fetchImpl, allowCreate: true,
    onSheet: async (record) => { sheet = record; }
  });
  assert.equal(first.status, 'error');
  assert.equal(first.phase, 'write');
  assert.equal(first.queue.ops.length, 1);
  assert.equal(google.calls.filter((call) => call.method === 'POST' && call.pathname === '/drive/v3/files').length, 1);
  const created = google.calls.find((call) => call.method === 'POST' && call.pathname === '/drive/v3/files');
  assert.equal(created.body.permissions, undefined);
  assert.equal(sheet.spreadsheetId.startsWith('sheet_'), true);

  const second = await runSync({
    data: first.data, queue: first.queue, base: first.base, sheet, tokenStore: tokenStoreFresh(),
    fetchImpl: google.fetchImpl, allowCreate: true,
    onSheet: async (record) => { sheet = record; }
  });
  assert.equal(second.status, 'ok');
  assert.equal(second.queue.ops.length, 0);
  assert.equal(google.calls.filter((call) => call.method === 'POST' && call.pathname === '/drive/v3/files').length, 1);
  const file = google.sheetState(sheet.spreadsheetId);
  assert.deepEqual(txIds(file), [data.transactions[0].id]);
  assert.equal(file.sheets.map((item) => item.properties.title).includes('Transactions'), true);
  assert.equal(file.sheets.map((item) => item.properties.title).includes('Summary'), true);
  const formulaCall = google.calls.find((call) => call.body?.valueInputOption === 'USER_ENTERED');
  assert.equal(JSON.stringify(formulaCall.body).includes('SUMPRODUCT'), true);
});

test('a second account does not reuse the first spreadsheet id unless discovery finds that account’s file', async () => {
  const google = createMockGoogle();
  let sheetA = null;
  await runSync({
    data: sampleState(), queue: emptyQueue(), base: { rows: {}, settingsUpdatedAt: '' }, sheet: null,
    tokenStore: tokenStoreFresh(), fetchImpl: google.fetchImpl,
    onSheet: async (record) => { sheetA = record; }
  });
  const titles = google.sheetState(sheetA.spreadsheetId).sheets.map((item) => item.properties.title);
  assert.deepEqual(titles.filter((title) => ['Transactions', 'Budgets', 'Goals', 'Settings', 'Summary'].includes(title)).sort(),
    ['Budgets', 'Goals', 'Settings', 'Summary', 'Transactions']);
  let sheetB = null;
  const other = createMockGoogle('other');
  const resultB = await runSync({
    data: emptyState(), queue: emptyQueue(), base: { rows: {}, settingsUpdatedAt: '' }, sheet: null,
    tokenStore: tokenStoreFresh(), fetchImpl: other.fetchImpl,
    onSheet: async (record) => { sheetB = record; }
  });
  assert.equal(resultB.status, 'ok');
  assert.notEqual(sheetA.spreadsheetId, sheetB.spreadsheetId);
});

test('discovery failure does not create a spreadsheet', async () => {
  const google = createMockGoogle();
  google.setListStatus(403);
  const result = await runSync({
    data: sampleState(), queue: { ops: [{ opId: 'op1' }] }, base: { rows: {}, settingsUpdatedAt: '' },
    sheet: null, tokenStore: tokenStoreFresh(), fetchImpl: google.fetchImpl
  });
  assert.equal(result.status, 'discover_failed');
  assert.equal(google.files.size, 0);
  assert.equal(result.data.transactions.length, 1);
});

test('expired token does not wipe local data', async () => {
  const google = createMockGoogle();
  const data = sampleState();
  const expired = createTokenStore(() => 10_000);
  expired.set({ access_token: 'good', expires_in: 1, scope: SCOPES });
  const result = await runSync({
    data, queue: { ops: [{ opId: 'keep' }] }, base: { rows: {}, settingsUpdatedAt: '' }, sheet: null,
    tokenStore: expired, fetchImpl: google.fetchImpl
  });
  assert.equal(result.status, 'auth_expired');
  assert.equal(result.phase, 'token');
  assert.equal(result.data, data);
  assert.equal(google.calls.length, 0);
  assert.equal(result.queue.ops[0].opId, 'keep');

  const fresh = tokenStoreFresh();
  google.setUnauthorized(true);
  const denied = await runSync({
    data, queue: result.queue, base: { rows: {}, settingsUpdatedAt: '' }, sheet: { spreadsheetId: 'missing', schemaVersion: 1 },
    tokenStore: fresh, fetchImpl: google.fetchImpl
  });
  assert.equal(denied.status, 'auth_expired');
  assert.equal(denied.data.transactions.length, 1);
  assert.equal(fresh.get(), null);
});

test('401 during write keeps the queue and a retry does not duplicate', async () => {
  const google = createMockGoogle();
  let sheet = null;
  const data = sampleState();
  const created = await runSync({
    data, queue: emptyQueue(), base: { rows: {}, settingsUpdatedAt: '' }, sheet: null,
    tokenStore: tokenStoreFresh(), fetchImpl: google.fetchImpl,
    onSheet: async (record) => { sheet = record; }
  });
  assert.equal(created.status, 'ok');
  const edited = structuredClone(created.data);
  edited.transactions[0].amount = 20;
  edited.transactions[0].updatedAt = '2026-05-01T00:00:00.000Z';
  const queue = { ops: [{ opId: 'edit1', entity: 'transaction', id: edited.transactions[0].id, action: 'upsert' }] };
  const store = createTokenStore(() => 0);
  store.set({ access_token: 'put-expired', expires_in: 3600, scope: SCOPES });
  const failed = await runSync({
    data: edited, queue, base: created.base, sheet, tokenStore: store, fetchImpl: google.fetchImpl,
    onSheet: async (record) => { sheet = record; }
  });
  assert.equal(failed.status, 'auth_expired');
  assert.equal(failed.phase, 'write');
  assert.equal(failed.queue.ops.length, 1);
  assert.equal(failed.data.transactions[0].amount, 20);
  const retried = await runSync({
    data: failed.data, queue: failed.queue, base: failed.base, sheet, tokenStore: tokenStoreFresh(),
    fetchImpl: google.fetchImpl
  });
  assert.equal(retried.status, 'ok');
  assert.deepEqual(txIds(google.sheetState(sheet.spreadsheetId)), [edited.transactions[0].id]);
  const amount = google.sheetState(sheet.spreadsheetId).grids.Transactions.find((row) => row[0] === edited.transactions[0].id)[2];
  assert.equal(Number(amount), 20);
});

test('soft delete is uploaded and not resurrected', async () => {
  const google = createMockGoogle();
  let sheet = null;
  const data = sampleState();
  const created = await runSync({
    data, queue: emptyQueue(), base: { rows: {}, settingsUpdatedAt: '' }, sheet: null,
    tokenStore: tokenStoreFresh(), fetchImpl: google.fetchImpl,
    onSheet: async (record) => { sheet = record; }
  });
  const deleted = structuredClone(created.data);
  deleted.transactions[0].deleted = true;
  deleted.transactions[0].updatedAt = '2026-06-01T00:00:00.000Z';
  const synced = await runSync({
    data: deleted, queue: { ops: [{ opId: 'del1' }] }, base: created.base, sheet,
    tokenStore: tokenStoreFresh(), fetchImpl: google.fetchImpl
  });
  assert.equal(synced.status, 'ok');
  const row = google.sheetState(sheet.spreadsheetId).grids.Transactions.find((item) => item[0] === deleted.transactions[0].id);
  assert.equal(row[7], 'TRUE');
  assert.equal(activeRows(synced.data.transactions).length, 0);
  const again = await runSync({
    data: synced.data, queue: emptyQueue(), base: synced.base, sheet,
    tokenStore: tokenStoreFresh(), fetchImpl: google.fetchImpl
  });
  assert.equal(activeRows(again.data.transactions).length, 0);
  assert.equal(again.data.transactions[0].deleted, true);
});

test('when both sides change, the spreadsheet copy is kept and the local copy is a conflict', async () => {
  const google = createMockGoogle();
  let sheet = null;
  const data = sampleState();
  const created = await runSync({
    data, queue: emptyQueue(), base: { rows: {}, settingsUpdatedAt: '' }, sheet: null,
    tokenStore: tokenStoreFresh(), fetchImpl: google.fetchImpl,
    onSheet: async (record) => { sheet = record; }
  });
  const file = google.sheetState(sheet.spreadsheetId);
  const remoteRow = file.grids.Transactions.find((row) => row[0] === data.transactions[0].id);
  remoteRow[2] = 99;
  remoteRow[9] = '2026-07-02T00:00:00.000Z';
  const local = structuredClone(created.data);
  local.transactions[0].amount = 40;
  local.transactions[0].updatedAt = '2026-07-03T00:00:00.000Z';
  const merged = await runSync({
    data: local, queue: emptyQueue(), base: created.base, sheet,
    tokenStore: tokenStoreFresh(), fetchImpl: google.fetchImpl
  });
  assert.equal(merged.status, 'ok');
  assert.equal(merged.conflicts.length, 1);
  assert.equal(merged.conflicts[0].reason, 'both_changed_remote_kept');
  assert.equal(merged.data.transactions[0].amount, 99);
  assert.equal(merged.conflicts[0].local.amount, 40);
});

test('a newer schema blocks sync', async () => {
  const google = createMockGoogle();
  let sheet = null;
  const created = await runSync({
    data: sampleState(), queue: emptyQueue(), base: { rows: {}, settingsUpdatedAt: '' }, sheet: null,
    tokenStore: tokenStoreFresh(), fetchImpl: google.fetchImpl,
    onSheet: async (record) => { sheet = record; }
  });
  const file = google.sheetState(sheet.spreadsheetId);
  const settings = file.grids.Settings;
  const schemaRow = settings.find((row) => row[0] === 'schema_version');
  schemaRow[1] = '99';
  const blocked = await runSync({
    data: created.data, queue: { ops: [{ opId: 'x' }] }, base: created.base, sheet,
    tokenStore: tokenStoreFresh(), fetchImpl: google.fetchImpl
  });
  assert.equal(blocked.status, 'schema_too_new');
  assert.equal(blocked.data, created.data);
  assert.equal(blocked.queue.ops.length, 1);
});

test('sync lock rejects an overlapping run', async () => {
  const lock = { current: true };
  const result = await runSync({
    data: emptyState(), queue: emptyQueue(), base: { rows: {}, settingsUpdatedAt: '' }, sheet: null,
    tokenStore: tokenStoreFresh(), fetchImpl: async () => { throw new Error('should not be called'); }, lock
  });
  assert.equal(result.status, 'busy');
});
