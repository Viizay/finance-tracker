import { LEGACY_STORAGE_KEY, STORAGE_PREFIX } from './constants.js';
import { emptyState, normalizeLoaded } from './model.js';

export function guestKey() { return `${STORAGE_PREFIX}:guest`; }
export function userDataKey(sub) { return `${STORAGE_PREFIX}:user:${sub}`; }
export function sheetKey(sub) { return `${STORAGE_PREFIX}:sheet:${sub}`; }
export function queueKey(sub) { return `${STORAGE_PREFIX}:queue:${sub}`; }
export function baseKey(sub) { return `${STORAGE_PREFIX}:base:${sub}`; }
export function conflictsKey(sub) { return `${STORAGE_PREFIX}:conflicts:${sub}`; }
export function sessionKey() { return `${STORAGE_PREFIX}:session`; }
export function clientIdKey() { return `${STORAGE_PREFIX}:publicClientId`; }

export function accountSub(session) {
  return session && session.sub ? session.sub : null;
}

export function dataKeyFor(sub) {
  return sub ? userDataKey(sub) : guestKey();
}

export function createMemoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(key, String(value)); },
    removeItem(key) { map.delete(key); },
    keys() { return [...map.keys()]; }
  };
}

function readJson(storage, key) {
  const raw = storage.getItem(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export function migrateLegacy(storage) {
  const legacy = storage.getItem(LEGACY_STORAGE_KEY);
  if (!legacy) return;
  if (!storage.getItem(guestKey())) storage.setItem(guestKey(), legacy);
  storage.removeItem(LEGACY_STORAGE_KEY);
}

export function loadState(storage, sub) {
  migrateLegacy(storage);
  const parsed = readJson(storage, dataKeyFor(sub));
  if (!parsed) return emptyState();
  return normalizeLoaded(parsed);
}

export function saveState(storage, sub, state) {
  storage.setItem(dataKeyFor(sub), JSON.stringify(state));
}

export function loadSession(storage) {
  const parsed = readJson(storage, sessionKey());
  if (!parsed || typeof parsed.sub !== 'string' || !parsed.sub) return null;
  return {
    sub: parsed.sub,
    email: typeof parsed.email === 'string' ? parsed.email : '',
    name: typeof parsed.name === 'string' ? parsed.name : ''
  };
}

export function saveSession(storage, session) {
  storage.setItem(sessionKey(), JSON.stringify({
    sub: session.sub,
    email: session.email || '',
    name: session.name || ''
  }));
}

export function clearSession(storage) {
  storage.removeItem(sessionKey());
}

export function emptyQueue() {
  return { ops: [] };
}

export function loadQueue(storage, sub) {
  if (!sub) return emptyQueue();
  const parsed = readJson(storage, queueKey(sub));
  if (!parsed || !Array.isArray(parsed.ops)) return emptyQueue();
  return { ops: parsed.ops };
}

export function saveQueue(storage, sub, queue) {
  if (!sub) return;
  storage.setItem(queueKey(sub), JSON.stringify({ ops: queue.ops.slice(-5000) }));
}

export function enqueue(storage, sub, op) {
  if (!sub) return;
  const queue = loadQueue(storage, sub);
  if (queue.ops.some((item) => item.opId === op.opId)) return queue;
  queue.ops.push(op);
  saveQueue(storage, sub, queue);
  return queue;
}

export function loadBase(storage, sub) {
  if (!sub) return { rows: {}, settingsUpdatedAt: '' };
  const parsed = readJson(storage, baseKey(sub));
  if (!parsed || typeof parsed !== 'object') return { rows: {}, settingsUpdatedAt: '' };
  return {
    rows: parsed.rows && typeof parsed.rows === 'object' ? parsed.rows : {},
    settingsUpdatedAt: typeof parsed.settingsUpdatedAt === 'string' ? parsed.settingsUpdatedAt : ''
  };
}

export function saveBase(storage, sub, base) {
  if (!sub) return;
  storage.setItem(baseKey(sub), JSON.stringify(base));
}

export function loadSheetRecord(storage, sub) {
  if (!sub) return null;
  const parsed = readJson(storage, sheetKey(sub));
  if (!parsed || typeof parsed.spreadsheetId !== 'string' || !parsed.spreadsheetId) return null;
  return {
    spreadsheetId: parsed.spreadsheetId,
    spreadsheetUrl: typeof parsed.spreadsheetUrl === 'string' ? parsed.spreadsheetUrl : '',
    schemaVersion: Number(parsed.schemaVersion) || 0,
    createdAt: parsed.createdAt || '',
    title: parsed.title || 'Finance Tracker'
  };
}

export function saveSheetRecord(storage, sub, record) {
  if (!sub || !record?.spreadsheetId) return;
  storage.setItem(sheetKey(sub), JSON.stringify(record));
}

export function loadConflicts(storage, sub) {
  if (!sub) return [];
  const parsed = readJson(storage, conflictsKey(sub));
  return Array.isArray(parsed) ? parsed : [];
}

export function saveConflicts(storage, sub, conflicts) {
  if (!sub) return;
  storage.setItem(conflictsKey(sub), JSON.stringify(conflicts.slice(-50)));
}

export function forgetAccount(storage, sub) {
  if (!sub) return;
  for (const key of [userDataKey(sub), sheetKey(sub), queueKey(sub), baseKey(sub), conflictsKey(sub)]) {
    storage.removeItem(key);
  }
}

export function hasPersonalData(state) {
  return !!(
    (state.transactions || []).some((row) => !row.deleted)
    || (state.budgets || []).some((row) => !row.deleted)
    || (state.goals || []).some((row) => !row.deleted)
    || Number(state.savingsBalance) > 0
  );
}

export function moveGuestToAccount(storage, sub) {
  const guest = loadState(storage, null);
  saveState(storage, sub, guest);
  saveState(storage, null, emptyState());
  return guest;
}

/**
 * Public OAuth client id only. Values that are not Web client IDs are rejected.
 * Stored locally so the owner can configure a device before config.js is edited.
 */
export function isPlausibleClientId(value) {
  return /^[0-9A-Za-z-]{10,}\.apps\.googleusercontent\.com$/.test(String(value || '').trim());
}

export function resolveClientId(storage, config = globalThis.FINANCE_CONFIG) {
  const fromDevice = storage.getItem(clientIdKey()) || '';
  const fromFile = config && typeof config.googleClientId === 'string' ? config.googleClientId : '';
  const chosen = (fromDevice || fromFile).trim();
  return isPlausibleClientId(chosen) ? chosen : '';
}

export function saveClientId(storage, value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    storage.removeItem(clientIdKey());
    return '';
  }
  if (!isPlausibleClientId(trimmed)) return null;
  storage.setItem(clientIdKey(), trimmed);
  return trimmed;
}
