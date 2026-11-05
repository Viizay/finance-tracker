import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeRows, expandRecurring, importBackup, monthTotals, normalizeLoaded,
  projectSeries, recurringDate, todayISO, tombstoneAll, upsertTransaction
} from '../js/model.js';
import { txRowHTML } from '../js/html.js';

test('starts empty and labels demo data', () => {
  const state = normalizeLoaded(null);
  assert.equal(state.transactions.length, 0);
  assert.equal(state.isDemo, false);
  const demoFile = importBackup({ transactions: [], isDemo: true });
  assert.equal(demoFile.state.isDemo, true);
});

test('monthly recurrence emits one row per month, including month-end dates', () => {
  const template = {
    id: 'rent0001', type: 'expense', amount: 1800, category: 'Housing',
    date: '2026-01-31', note: 'Rent', recurring: true, deleted: false
  };
  const rows = expandRecurring([template], '2026-03');
  assert.deepEqual(rows.map((row) => row.date), ['2026-01-31', '2026-02-28', '2026-03-31']);
  assert.equal(new Set(rows.map((row) => row.id)).size, 3);
  assert.equal(new Set(rows.map((row) => row.date.slice(0, 7))).size, 3);
  const february = monthTotals(rows.filter((row) => row.date.startsWith('2026-02')));
  assert.equal(february.expense, 1800);
  assert.equal(recurringDate('2024-01-31', '2024-02'), '2024-02-29');
});

test('editing a series updates the template instead of adding a second copy', () => {
  const first = upsertTransaction([], {
    type: 'expense', amount: 10, category: 'Food', date: '2026-01-15', note: 'Groceries', recurring: true
  }, '', '2026-01-15T00:00:00.000Z');
  const second = upsertTransaction(first.list, {
    type: 'expense', amount: 12, category: 'Food', date: '2026-01-15', note: 'Groceries', recurring: true
  }, first.id, '2026-01-16T00:00:00.000Z');
  assert.equal(activeRows(second.list).length, 1);
  assert.equal(activeRows(second.list)[0].amount, 12);
  const visible = expandRecurring(second.list, '2026-03');
  assert.equal(visible.length, 3);
  assert.equal(new Set(visible.map((row) => row.templateId)).size, 1);
});

test('import drops generated monthly copies and escapes hostile text', () => {
  const hostileId = 'abcd1234"><img src=x onerror=alert(1)>';
  const result = importBackup({
    transactions: [
      {
        id: 'template1', type: 'expense', amount: 5, category: 'Food',
        date: '2026-01-02', note: '<img src=x onerror=alert(1)>', recurring: true
      },
      {
        id: 'template1@2026-01', type: 'expense', amount: 5, category: 'Food',
        date: '2026-01-02', recurringInstance: true
      },
      { id: hostileId, type: 'nope', amount: 5, category: 'Food', date: '2026-01-02' },
      { type: 'income', amount: -4, category: 'Salary', date: '2026-01-02' }
    ],
    budgets: [{ category: 'Food', limit: 100 }],
    goals: [{ name: '<script>alert(1)</script>', target: 50, current: 0, targetDate: '2026-12-01' }]
  });
  assert.equal(result.ok, true);
  assert.equal(result.state.transactions.length, 1);
  assert.equal(result.state.transactions[0].note.includes('<img'), true);
  const html = txRowHTML({
    ...result.state.transactions[0],
    id: hostileId,
    category: '<script>alert(1)</script>'
  });
  assert.equal(/<img/i.test(html), false);
  assert.equal(/<script/i.test(html), false);
  assert.equal(html.includes('&lt;script'), true);
  assert.equal(result.state.goals[0].name.startsWith('<script>'), true);
  const goalHtml = txRowHTML({
    id: 'safeid01', type: 'expense', amount: 1, category: 'Food', date: '2026-01-01',
    note: result.state.goals[0].name
  });
  assert.equal(/<script/i.test(goalHtml), false);
});

test('import rejects a non-object and keeps prototype clean', () => {
  assert.equal(importBackup(null).ok, false);
  assert.equal(importBackup(['x']).ok, false);
  const result = importBackup({ transactions: [], __proto__: { polluted: true } });
  assert.equal(result.ok, true);
  assert.equal(({}).polluted, undefined);
});

test('local dates and zero-return projection', () => {
  assert.equal(todayISO(new Date(2026, 10, 5, 23, 30)), '2026-11-05');
  const series = projectSeries({ start: 0, monthly: 100, annualReturn: 0, inflation: 0, years: 1 });
  assert.equal(series.nominal[0], 0);
  assert.equal(series.nominal[1], 1200);
  assert.equal(series.real[1], 1200);
});

test('clearing data tombstones rows instead of forgetting them', () => {
  const state = normalizeLoaded({
    transactions: [{
      id: 'template1', type: 'expense', amount: 5, category: 'Food', date: '2026-01-02', updatedAt: '2026-01-02T00:00:00.000Z'
    }]
  });
  const cleared = tombstoneAll(state, '2026-02-01T00:00:00.000Z');
  assert.equal(activeRows(cleared.transactions).length, 0);
  assert.equal(cleared.transactions[0].deleted, true);
  assert.equal(expandRecurring(cleared.transactions, '2026-02').length, 0);
});
