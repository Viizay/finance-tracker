import {
  EXPENSE_CATS, INCOME_CATS, SCHEMA_VERSION
} from './constants.js';

export function createId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().replace(/-/g, '');
  return `id${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

export function nowIso(date = new Date()) {
  return date.toISOString();
}

/** Local calendar date. UTC toISOString() shifts the day for timezones behind UTC. */
export function todayISO(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function monthKey(dateStr) {
  return String(dateStr || '').slice(0, 7);
}

export function currentMonth(date = new Date()) {
  return todayISO(date).slice(0, 7);
}

export function addMonths(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function daysInMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

export function recurringDate(templateDate, ym) {
  const wanted = Number(String(templateDate).slice(8, 10));
  const day = Math.min(wanted || 1, daysInMonth(ym));
  return `${ym}-${String(day).padStart(2, '0')}`;
}

export function roundMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

export function formatMoney(n) {
  const v = roundMoney(n);
  const abs = Math.abs(v);
  const s = abs.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  return (v < 0 ? '-$' : '$') + s;
}

export function formatPct(n) {
  if (!Number.isFinite(n)) return '—';
  return `${Math.round(n * 10) / 10}%`;
}

export function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString(undefined, { month: 'long', year: 'numeric' });
}

export function emptyState() {
  return {
    version: SCHEMA_VERSION,
    isDemo: false,
    transactions: [],
    budgets: [],
    goals: [],
    savingsBalance: 0,
    theme: 'system',
    projection: { start: 0, monthly: 500, returnPct: 7, inflation: 2.5, years: 10 },
    syncOnSave: false,
    settingsUpdatedAt: ''
  };
}

export function sanitizeText(value, max) {
  return String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, '').slice(0, max);
}

export function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

export function isSafeId(value) {
  return /^[A-Za-z0-9_-]{8,64}$/.test(String(value || ''));
}

function categoryFor(type, raw) {
  const list = type === 'income' ? INCOME_CATS : EXPENSE_CATS;
  return list.includes(raw) ? raw : (type === 'income' ? 'Other income' : 'Other');
}

function finiteIn(value, min, max) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max;
}

/**
 * One row per month from the template start through throughMonth.
 * Instances are display-only (id templateId@YYYY-MM) and are never stored.
 * The template itself is not also emitted, so a month is not counted twice.
 */
export function expandRecurring(transactions, throughMonth) {
  const out = [];
  const seen = new Set();
  for (const t of transactions || []) {
    if (!t || t.deleted) continue;
    if (!t.recurring) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
      continue;
    }
    if (!isIsoDate(t.date)) continue;
    const start = monthKey(t.date);
    const months = [];
    if (start > throughMonth) months.push(start);
    else {
      let cur = start;
      let guard = 0;
      while (cur <= throughMonth && guard < 600) {
        months.push(cur);
        cur = addMonths(cur, 1);
        guard += 1;
      }
    }
    for (const ym of months) {
      const id = `${t.id}@${ym}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        ...t,
        id,
        date: recurringDate(t.date, ym),
        recurringInstance: true,
        templateId: t.id
      });
    }
  }
  return out;
}

export function visibleTransactions(state, throughMonth) {
  return expandRecurring(state.transactions, throughMonth);
}

export function monthTotals(rows) {
  let income = 0;
  let expense = 0;
  for (const t of rows) {
    if (t.deleted) continue;
    if (t.type === 'income') income += Number(t.amount) || 0;
    else expense += Number(t.amount) || 0;
  }
  return { income: roundMoney(income), expense: roundMoney(expense), net: roundMoney(income - expense) };
}

export function spendingByCategory(rows) {
  const map = {};
  for (const t of rows) {
    if (t.deleted || t.type === 'income') continue;
    map[t.category] = roundMoney((map[t.category] || 0) + Number(t.amount));
  }
  return Object.entries(map).sort((a, b) => b[1] - a[1]);
}

export function avgMonthlyExpense(state, months, today = new Date()) {
  const cur = currentMonth(today);
  let total = 0;
  let count = 0;
  for (let i = 0; i < months; i += 1) {
    const ym = addMonths(cur, -i);
    const { expense } = monthTotals(visibleTransactions(state, ym).filter((t) => monthKey(t.date) === ym));
    if (expense > 0 || i === 0) {
      total += expense;
      count += 1;
    }
  }
  return count ? total / count : 0;
}

export function projectSeries({ start, monthly, annualReturn, inflation, years }) {
  const yCount = Math.max(1, Math.min(50, Number(years) || 1));
  const r = (Number(annualReturn) || 0) / 100 / 12;
  const inf = (Number(inflation) || 0) / 100;
  const labels = [];
  const nominal = [];
  const real = [];
  let bal = Number(start) || 0;
  for (let y = 0; y <= yCount; y += 1) {
    if (y === 0) {
      labels.push('Now');
      nominal.push(roundMoney(bal));
      real.push(roundMoney(bal));
    } else {
      for (let m = 0; m < 12; m += 1) bal = bal * (1 + r) + (Number(monthly) || 0);
      labels.push(`Y${y}`);
      nominal.push(Math.round(bal));
      real.push(Math.round(bal / ((1 + inf) ** y)));
    }
  }
  return { labels, nominal, real };
}

export function monthsUntil(dateStr, today = new Date()) {
  if (!isIsoDate(dateStr)) return 1;
  const target = new Date(`${dateStr}T00:00:00`);
  let months = (target.getFullYear() - today.getFullYear()) * 12 + (target.getMonth() - today.getMonth());
  if (target.getDate() < today.getDate()) months -= 1;
  return Math.max(1, months);
}

export function requiredMonthly(goal, today = new Date()) {
  const remaining = Math.max(0, Number(goal.target) - Number(goal.current));
  return remaining / monthsUntil(goal.targetDate, today);
}

function touch(existing, fields, now) {
  return {
    ...existing,
    ...fields,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    deleted: false
  };
}

export function upsertTransaction(list, fields, id, now) {
  const next = list.slice();
  const payload = {
    type: fields.type === 'income' ? 'income' : 'expense',
    amount: roundMoney(fields.amount),
    category: categoryFor(fields.type, fields.category),
    date: fields.date,
    note: sanitizeText(fields.note, 120),
    recurring: !!fields.recurring
  };
  if (!(payload.amount > 0) || !isIsoDate(payload.date)) return { list, error: 'Enter a valid amount and date.' };
  if (id) {
    const idx = next.findIndex((t) => t.id === id && !String(t.id).includes('@'));
    if (idx >= 0) {
      next[idx] = touch(next[idx], { ...payload, id }, now);
      return { list: next, id };
    }
  }
  const newId = createId();
  next.push(touch(null, { ...payload, id: newId }, now));
  return { list: next, id: newId };
}

export function softDeleteById(list, id, now) {
  return list.map((row) => (row.id === id ? { ...row, deleted: true, updatedAt: now } : row));
}

export function upsertBudget(list, fields, id, now) {
  const category = categoryFor('expense', fields.category);
  const limit = roundMoney(fields.limit);
  if (!(limit > 0)) return { list, error: 'Enter a monthly limit.' };
  const next = list.slice();
  const idx = id
    ? next.findIndex((b) => b.id === id)
    : next.findIndex((b) => b.category === category && !b.deleted);
  if (idx >= 0) {
    next[idx] = touch(next[idx], { category, limit, id: next[idx].id }, now);
    return { list: next, id: next[idx].id };
  }
  const newId = createId();
  next.push(touch(null, { id: newId, category, limit }, now));
  return { list: next, id: newId };
}

export function upsertGoal(list, fields, id, now) {
  const name = sanitizeText(fields.name, 60).trim();
  const target = roundMoney(fields.target);
  const current = roundMoney(fields.current || 0);
  const monthly = fields.monthlyContribution === '' || fields.monthlyContribution == null
    ? null
    : roundMoney(fields.monthlyContribution);
  if (!name || !(target > 0) || current < 0 || !isIsoDate(fields.targetDate)) {
    return { list, error: 'Check the goal name, amounts, and date.' };
  }
  if (monthly != null && monthly < 0) return { list, error: 'Contribution cannot be negative.' };
  const payload = { name, target, current, targetDate: fields.targetDate, monthlyContribution: monthly };
  const next = list.slice();
  if (id) {
    const idx = next.findIndex((g) => g.id === id);
    if (idx >= 0) {
      next[idx] = touch(next[idx], { ...payload, id }, now);
      return { list: next, id };
    }
  }
  const newId = createId();
  next.push(touch(null, { ...payload, id: newId }, now));
  return { list: next, id: newId };
}

export function tombstoneAll(state, now) {
  const stamp = (row) => (row.deleted ? row : { ...row, deleted: true, updatedAt: now });
  return {
    ...state,
    isDemo: false,
    transactions: state.transactions.map(stamp),
    budgets: state.budgets.map(stamp),
    goals: state.goals.map(stamp),
    savingsBalance: 0,
    settingsUpdatedAt: now
  };
}

export function activeRows(list) {
  return (list || []).filter((row) => row && !row.deleted);
}

function coerceTransaction(raw, errors, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(`Transaction ${index + 1} was skipped.`);
    return null;
  }
  if (raw.recurringInstance || /@[0-9]{4}-[0-9]{2}$/.test(String(raw.id || ''))) {
    errors.push(`Transaction ${index + 1} is a generated monthly copy and was skipped.`);
    return null;
  }
  const type = raw.type === 'income' ? 'income' : raw.type === 'expense' ? 'expense' : null;
  if (!type) {
    errors.push(`Transaction ${index + 1} has an invalid type.`);
    return null;
  }
  if (!finiteIn(raw.amount, 0.01, 1e12) || !isIsoDate(raw.date)) {
    errors.push(`Transaction ${index + 1} has an invalid amount or date.`);
    return null;
  }
  return {
    id: isSafeId(raw.id) ? String(raw.id) : createId(),
    type,
    amount: roundMoney(raw.amount),
    category: categoryFor(type, sanitizeText(raw.category, 40)),
    date: raw.date,
    note: sanitizeText(raw.note, 120),
    recurring: !!raw.recurring,
    deleted: !!raw.deleted,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : (typeof raw.createdAt === 'string' ? raw.createdAt : '')
  };
}

function dedupe(rows) {
  const map = new Map();
  for (const row of rows) {
    const prev = map.get(row.id);
    if (!prev || String(row.updatedAt) >= String(prev.updatedAt)) map.set(row.id, row);
  }
  return [...map.values()];
}

export function importBackup(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['File must be a JSON object.'] };
  }
  if (!Array.isArray(raw.transactions)) {
    return { ok: false, errors: ['File is missing a transactions array.'] };
  }
  if (raw.transactions.length > 5000 || (raw.budgets || []).length > 500 || (raw.goals || []).length > 500) {
    return { ok: false, errors: ['File is too large to import.'] };
  }
  const stamped = nowIso();
  const transactions = dedupe(raw.transactions.map((row, i) => coerceTransaction(row, errors, i)).filter(Boolean))
    .map((row) => ({ ...row, updatedAt: stamped }));
  const budgets = [];
  for (const [i, row] of (Array.isArray(raw.budgets) ? raw.budgets : []).entries()) {
    if (!row || typeof row !== 'object') continue;
    if (!finiteIn(row.limit, 0.01, 1e12)) {
      errors.push(`Budget ${i + 1} was skipped.`);
      continue;
    }
    budgets.push({
      id: isSafeId(row.id) ? String(row.id) : createId(),
      category: categoryFor('expense', sanitizeText(row.category, 40)),
      limit: roundMoney(row.limit),
      deleted: !!row.deleted,
      createdAt: typeof row.createdAt === 'string' ? row.createdAt : stamped,
      updatedAt: stamped
    });
  }
  const goals = [];
  for (const [i, row] of (Array.isArray(raw.goals) ? raw.goals : []).entries()) {
    if (!row || typeof row !== 'object' || !sanitizeText(row.name, 60).trim() || !finiteIn(row.target, 0.01, 1e12) || !isIsoDate(row.targetDate)) {
      errors.push(`Goal ${i + 1} was skipped.`);
      continue;
    }
    const monthly = row.monthlyContribution == null || row.monthlyContribution === ''
      ? null
      : roundMoney(row.monthlyContribution);
    goals.push({
      id: isSafeId(row.id) ? String(row.id) : createId(),
      name: sanitizeText(row.name, 60).trim(),
      target: roundMoney(row.target),
      current: finiteIn(row.current, 0, 1e12) ? roundMoney(row.current) : 0,
      targetDate: row.targetDate,
      monthlyContribution: monthly != null && monthly >= 0 ? monthly : null,
      deleted: !!row.deleted,
      createdAt: typeof row.createdAt === 'string' ? row.createdAt : stamped,
      updatedAt: stamped
    });
  }
  const theme = ['system', 'light', 'dark'].includes(raw.theme) ? raw.theme : 'system';
  const projection = raw.projection && typeof raw.projection === 'object' ? {
    start: finiteIn(raw.projection.start, 0, 1e12) ? roundMoney(raw.projection.start) : 0,
    monthly: finiteIn(raw.projection.monthly, 0, 1e12) ? roundMoney(raw.projection.monthly) : 0,
    returnPct: finiteIn(raw.projection.returnPct, 0, 30) ? Number(raw.projection.returnPct) : 7,
    inflation: finiteIn(raw.projection.inflation, 0, 20) ? Number(raw.projection.inflation) : 2.5,
    years: finiteIn(raw.projection.years, 1, 50) ? Number(raw.projection.years) : 10
  } : emptyState().projection;
  return {
    ok: true,
    errors,
    state: {
      ...emptyState(),
      isDemo: !!raw.isDemo,
      transactions: dedupe(transactions),
      budgets: dedupe(budgets),
      goals: dedupe(goals),
      savingsBalance: finiteIn(raw.savingsBalance, 0, 1e12) ? roundMoney(raw.savingsBalance) : 0,
      theme,
      projection,
      syncOnSave: false,
      settingsUpdatedAt: stamped
    }
  };
}

export function buildDemo(today = new Date()) {
  const ym = currentMonth(today);
  const rows = [];
  const make = (type, amount, category, monthsAgo, day, note, recurring) => {
    const m = addMonths(ym, -monthsAgo);
    rows.push({
      id: createId(),
      type,
      amount,
      category,
      date: `${m}-${String(day).padStart(2, '0')}`,
      note,
      recurring: !!recurring,
      deleted: false,
      createdAt: nowIso(today),
      updatedAt: nowIso(today)
    });
  };
  make('income', 5200, 'Salary', 11, 1, 'Paycheck', true);
  make('expense', 1800, 'Housing', 11, 1, 'Rent', true);
  make('expense', 45, 'Subscriptions', 11, 5, 'Streaming', true);
  for (let i = 0; i < 6; i += 1) {
    make('expense', 420 + i * 15, 'Food', i, 12, 'Groceries', false);
    make('expense', 110 + i * 8, 'Transport', i, 8, 'Gas / transit', false);
    make('expense', 80 + (i % 3) * 40, 'Entertainment', i, 20, '', false);
    make('expense', 150, 'Utilities', i, 15, 'Electric + internet', false);
  }
  make('expense', 220, 'Shopping', 0, 3, 'Clothes', false);
  make('income', 400, 'Freelance', 1, 22, 'Side project', false);
  const nextYear = new Date(today);
  nextYear.setFullYear(nextYear.getFullYear() + 1);
  const state = emptyState();
  state.isDemo = true;
  state.transactions = rows;
  state.budgets = [
    { id: createId(), category: 'Food', limit: 500, deleted: false, createdAt: nowIso(today), updatedAt: nowIso(today) },
    { id: createId(), category: 'Entertainment', limit: 150, deleted: false, createdAt: nowIso(today), updatedAt: nowIso(today) },
    { id: createId(), category: 'Transport', limit: 200, deleted: false, createdAt: nowIso(today), updatedAt: nowIso(today) },
    { id: createId(), category: 'Shopping', limit: 200, deleted: false, createdAt: nowIso(today), updatedAt: nowIso(today) }
  ];
  state.goals = [
    {
      id: createId(), name: 'Emergency fund', target: 15000, current: 4500,
      targetDate: todayISO(nextYear), monthlyContribution: 400, deleted: false,
      createdAt: nowIso(today), updatedAt: nowIso(today)
    },
    {
      id: createId(), name: 'Vacation', target: 3000, current: 800,
      targetDate: `${addMonths(ym, 8)}-15`, monthlyContribution: 150, deleted: false,
      createdAt: nowIso(today), updatedAt: nowIso(today)
    }
  ];
  state.savingsBalance = 6200;
  state.projection = { start: 6200, monthly: 800, returnPct: 7, inflation: 2.5, years: 10 };
  state.settingsUpdatedAt = nowIso(today);
  return state;
}

export function normalizeLoaded(data) {
  const base = emptyState();
  if (!data || typeof data !== 'object' || Array.isArray(data)) return base;
  const transactions = dedupe((Array.isArray(data.transactions) ? data.transactions : [])
    .map((row, index) => coerceTransaction(row, [], index))
    .filter(Boolean));
  const budgets = [];
  for (const row of Array.isArray(data.budgets) ? data.budgets : []) {
    if (!row || typeof row !== 'object' || !finiteIn(row.limit, 0.01, 1e12)) continue;
    budgets.push({
      id: isSafeId(row.id) ? String(row.id) : createId(),
      category: categoryFor('expense', sanitizeText(row.category, 40)),
      limit: roundMoney(row.limit),
      deleted: !!row.deleted,
      createdAt: typeof row.createdAt === 'string' ? row.createdAt : '',
      updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : ''
    });
  }
  const goals = [];
  for (const row of Array.isArray(data.goals) ? data.goals : []) {
    if (!row || typeof row !== 'object') continue;
    const name = sanitizeText(row.name, 60).trim();
    if (!name || !finiteIn(row.target, 0.01, 1e12) || !isIsoDate(row.targetDate)) continue;
    const monthly = row.monthlyContribution == null || row.monthlyContribution === ''
      ? null
      : roundMoney(row.monthlyContribution);
    goals.push({
      id: isSafeId(row.id) ? String(row.id) : createId(),
      name,
      target: roundMoney(row.target),
      current: finiteIn(row.current, 0, 1e12) ? roundMoney(row.current) : 0,
      targetDate: row.targetDate,
      monthlyContribution: monthly != null && monthly >= 0 ? monthly : null,
      deleted: !!row.deleted,
      createdAt: typeof row.createdAt === 'string' ? row.createdAt : '',
      updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : ''
    });
  }
  const theme = ['system', 'light', 'dark'].includes(data.theme) ? data.theme : 'system';
  const projection = data.projection && typeof data.projection === 'object' ? {
    start: finiteIn(data.projection.start, 0, 1e12) ? roundMoney(data.projection.start) : 0,
    monthly: finiteIn(data.projection.monthly, 0, 1e12) ? roundMoney(data.projection.monthly) : 0,
    returnPct: finiteIn(data.projection.returnPct, 0, 30) ? Number(data.projection.returnPct) : 7,
    inflation: finiteIn(data.projection.inflation, 0, 20) ? Number(data.projection.inflation) : 2.5,
    years: finiteIn(data.projection.years, 1, 50) ? Number(data.projection.years) : 10
  } : base.projection;
  return {
    ...base,
    isDemo: !!data.isDemo,
    transactions,
    budgets: dedupe(budgets),
    goals: dedupe(goals),
    savingsBalance: finiteIn(data.savingsBalance, 0, 1e12) ? roundMoney(data.savingsBalance) : 0,
    theme,
    projection,
    syncOnSave: !!data.syncOnSave,
    settingsUpdatedAt: typeof data.settingsUpdatedAt === 'string' ? data.settingsUpdatedAt : ''
  };
}
