import test from 'node:test';
import assert from 'node:assert/strict';
import { createTokenStore } from '../js/identity.js';
import { emptyState, upsertTransaction } from '../js/model.js';
import {
  createMemoryStorage, dataKeyFor, enqueue, forgetAccount, hasPersonalData,
  isPlausibleClientId, loadSession, loadState, migrateLegacy, moveGuestToAccount,
  resolveClientId, saveClientId, saveSession, saveState, userDataKey
} from '../js/storage.js';

test('accounts do not share local data', () => {
  const storage = createMemoryStorage();
  const guest = emptyState();
  const added = upsertTransaction(guest.transactions, {
    type: 'income', amount: 100, category: 'Salary', date: '2026-01-01', note: 'A', recurring: false
  }, '', '2026-01-01T00:00:00.000Z');
  guest.transactions = added.list;
  saveState(storage, null, guest);
  saveState(storage, 'user-a', emptyState());
  const moved = moveGuestToAccount(storage, 'user-a');
  assert.equal(moved.transactions.length, 1);
  assert.equal(hasPersonalData(loadState(storage, null)), false);
  assert.equal(loadState(storage, 'user-a').transactions[0].note, 'A');
  assert.equal(hasPersonalData(loadState(storage, 'user-b')), false);
  assert.notEqual(dataKeyFor('user-a'), dataKeyFor('user-b'));
  assert.equal(storage.getItem(userDataKey('user-b')), null);
  forgetAccount(storage, 'user-a');
  assert.equal(hasPersonalData(loadState(storage, 'user-a')), false);
  assert.equal(hasPersonalData(loadState(storage, 'user-b')), false);
});

test('guest data stays put until a move is requested', () => {
  const storage = createMemoryStorage();
  const guest = emptyState();
  guest.savingsBalance = 40;
  saveState(storage, null, guest);
  saveSession(storage, { sub: 'user-b', email: 'b@example.com', name: 'B' });
  assert.equal(loadState(storage, 'user-b').savingsBalance, 0);
  assert.equal(loadState(storage, null).savingsBalance, 40);
  assert.equal(loadSession(storage).email, 'b@example.com');
});

test('legacy key moves to guest once', () => {
  const storage = createMemoryStorage({
    'finance-tracker-v1': JSON.stringify({
      transactions: [{
        id: 'legacykey1', type: 'expense', amount: 8, category: 'Food', date: '2026-03-01', note: 'Lunch'
      }],
      budgets: [], goals: [], savingsBalance: 0, theme: 'dark'
    })
  });
  migrateLegacy(storage);
  assert.equal(storage.getItem('finance-tracker-v1'), null);
  const guest = loadState(storage, null);
  assert.equal(guest.transactions[0].note, 'Lunch');
  assert.equal(guest.theme, 'dark');
});

test('access tokens are not written and client secrets are rejected', () => {
  const storage = createMemoryStorage();
  const tokens = createTokenStore(() => 1_000);
  tokens.set({ access_token: 'secret-token', expires_in: 10, scope: 'openid' });
  saveSession(storage, { sub: 'user-a', email: 'a@example.com', name: 'A' });
  const dumped = storage.keys().map((key) => storage.getItem(key)).join('\n');
  assert.equal(dumped.includes('secret-token'), false);
  assert.equal(dumped.includes('access_token'), false);
  assert.equal(tokens.get(), 'secret-token');
  tokens.clear();
  assert.equal(tokens.get(), null);
  assert.equal(isPlausibleClientId('GOCSPX-super-secret'), false);
  assert.equal(isPlausibleClientId('1234567890-abc.apps.googleusercontent.com'), true);
  assert.equal(saveClientId(storage, 'GOCSPX-super-secret'), null);
  assert.equal(resolveClientId(storage, { googleClientId: '' }), '');
  saveClientId(storage, '1234567890-abc.apps.googleusercontent.com');
  assert.equal(resolveClientId(storage, { googleClientId: '' }), '1234567890-abc.apps.googleusercontent.com');
});

test('queue ignores a repeated op id', () => {
  const storage = createMemoryStorage();
  enqueue(storage, 'user-a', { opId: 'op1', entity: 'transaction', id: 't1', action: 'upsert' });
  enqueue(storage, 'user-a', { opId: 'op1', entity: 'transaction', id: 't1', action: 'upsert' });
  enqueue(storage, 'user-a', { opId: 'op2', entity: 'transaction', id: 't1', action: 'delete' });
  const raw = JSON.parse(storage.getItem('finance-tracker:v1:queue:user-a'));
  assert.equal(raw.ops.length, 2);
});
