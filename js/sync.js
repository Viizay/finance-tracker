import { SCHEMA_VERSION } from './constants.js';
import { AuthExpiredError, DiscoverFailedError } from './google-api.js';
import {
  batchUpdateSpreadsheet, batchUpdateValues, createSpreadsheet, getDriveFile,
  getSpreadsheet, getValues, listFinanceSheets, updateValues
} from './google-api.js';
import { emptyQueue } from './storage.js';
import {
  budgetRows, dataRowCount, driveCreateBody, formulaBatch, goalRows, headerBatch,
  padGrid, parseBudgets, parseGoals, parseSettings, parseTransactions,
  planFormatRequests, planStructureRequests, settingsRows, sheetIdMap,
  spreadsheetUrl, transactionRows
} from './sheet-schema.js';

function canonicalTransaction(row) {
  return JSON.stringify({
    type: row.type,
    amount: Number(row.amount) || 0,
    category: row.category,
    date: row.date,
    note: row.note || '',
    recurring: !!row.recurring,
    deleted: !!row.deleted
  });
}

function canonicalBudget(row) {
  return JSON.stringify({
    category: row.category,
    limit: Number(row.limit) || 0,
    deleted: !!row.deleted
  });
}

function canonicalGoal(row) {
  return JSON.stringify({
    name: row.name,
    target: Number(row.target) || 0,
    current: Number(row.current) || 0,
    targetDate: row.targetDate,
    monthlyContribution: row.monthlyContribution == null ? null : Number(row.monthlyContribution),
    deleted: !!row.deleted
  });
}

function canonicalSettings(state) {
  return JSON.stringify({
    savingsBalance: Number(state.savingsBalance) || 0,
    theme: state.theme || 'system',
    isDemo: !!state.isDemo,
    syncOnSave: !!state.syncOnSave,
    projection: state.projection || null
  });
}

/**
 * Sheets has no revision id. "Dirty" means updatedAt is newer than the
 * timestamp we stored after the last successful sync. If both sides changed,
 * the spreadsheet copy is kept and the local copy is returned as a conflict.
 * Equal content is not a conflict, so a failed write can be retried.
 */
export function mergeRows(localRows, remoteRows, baseMap, canonical) {
  const local = new Map(localRows.map((row) => [row.id, row]));
  const remote = new Map(remoteRows.map((row) => [row.id, row]));
  const ids = [...new Set([...local.keys(), ...remote.keys()])].sort();
  const merged = [];
  const conflicts = [];
  let push = false;
  for (const id of ids) {
    const left = local.get(id) || null;
    const right = remote.get(id) || null;
    const base = baseMap[id] || '';
    if (left && right && canonical(left) === canonical(right)) {
      merged.push(left);
      continue;
    }
    const localDirty = !!(left && String(left.updatedAt || '') > base);
    const remoteDirty = !!(right && String(right.updatedAt || '') > base);
    if (left && !right) {
      merged.push(left);
      push = true;
      continue;
    }
    if (!left && right) {
      merged.push(right);
      continue;
    }
    if (localDirty && !remoteDirty) {
      merged.push(left);
      push = true;
      continue;
    }
    if (!localDirty && remoteDirty) {
      merged.push(right);
      continue;
    }
    conflicts.push({
      entityId: id,
      local: left,
      remote: right,
      reason: 'both_changed_remote_kept'
    });
    merged.push(right);
  }
  return { merged, conflicts, push };
}

export function mergeSettings(localState, remoteSettings, baseSettingsUpdatedAt) {
  const remoteState = {
    savingsBalance: remoteSettings.savingsBalance,
    theme: remoteSettings.theme,
    isDemo: remoteSettings.isDemo,
    syncOnSave: remoteSettings.syncOnSave,
    projection: remoteSettings.projection || localState.projection,
    settingsUpdatedAt: remoteSettings.settingsUpdatedAt || ''
  };
  if (canonicalSettings(localState) === canonicalSettings(remoteState)) {
    return { state: localState, conflicts: [], push: false };
  }
  const base = baseSettingsUpdatedAt || '';
  const localDirty = String(localState.settingsUpdatedAt || '') > base;
  const remoteDirty = String(remoteSettings.settingsUpdatedAt || '') > base;
  if (localDirty && !remoteDirty) return { state: localState, conflicts: [], push: true };
  if (!localDirty && remoteDirty) {
    return {
      state: { ...localState, ...remoteState },
      conflicts: [],
      push: false
    };
  }
  if (!localDirty && !remoteDirty && !base) {
    return { state: localState, conflicts: [], push: true };
  }
  return {
    state: { ...localState, ...remoteState },
    conflicts: [{
      entityId: 'settings',
      local: {
        savingsBalance: localState.savingsBalance,
        theme: localState.theme,
        isDemo: localState.isDemo,
        projection: localState.projection,
        settingsUpdatedAt: localState.settingsUpdatedAt
      },
      remote: remoteState,
      reason: 'both_changed_remote_kept'
    }],
    push: false
  };
}

function baseFrom(state) {
  const rows = {};
  for (const row of [...state.transactions, ...state.budgets, ...state.goals]) {
    rows[row.id] = row.updatedAt || '';
  }
  return { rows, settingsUpdatedAt: state.settingsUpdatedAt || '' };
}

async function ensurePrivateSheet({ fetchImpl, token, sheet, allowCreate, onSheet }) {
  if (sheet?.spreadsheetId) {
    try {
      const file = await getDriveFile(fetchImpl, token, sheet.spreadsheetId);
      if (file && !file.trashed) {
        const record = { ...sheet, title: file.name || sheet.title };
        if (!record.schemaVersion || record.schemaVersion < SCHEMA_VERSION) {
          await setupSpreadsheet(fetchImpl, token, record.spreadsheetId);
          record.schemaVersion = SCHEMA_VERSION;
          if (onSheet) await onSheet(record);
        }
        return record;
      }
    } catch (error) {
      if (error instanceof AuthExpiredError) throw error;
      if (error.status !== 404) throw error;
    }
  }
  let listed;
  try {
    listed = await listFinanceSheets(fetchImpl, token);
  } catch (error) {
    if (error instanceof AuthExpiredError) throw error;
    throw new DiscoverFailedError(
      'Google did not return this app’s spreadsheet list. No new spreadsheet was created. Your data on this device is unchanged.'
    );
  }
  const files = (listed?.files || []).filter((file) => !file.trashed);
  files.sort((a, b) => String(a.createdTime || '').localeCompare(String(b.createdTime || '')));
  if (files[0]) {
    const record = {
      spreadsheetId: files[0].id,
      spreadsheetUrl: spreadsheetUrl(files[0].id),
      schemaVersion: 0,
      createdAt: files[0].createdTime || '',
      title: files[0].name || 'Finance Tracker'
    };
    if (onSheet) await onSheet(record);
    await setupSpreadsheet(fetchImpl, token, record.spreadsheetId);
    record.schemaVersion = SCHEMA_VERSION;
    if (onSheet) await onSheet(record);
    return record;
  }
  if (!allowCreate) {
    throw new DiscoverFailedError('No private Finance Tracker spreadsheet was found for this account.');
  }
  const created = await createSpreadsheet(fetchImpl, token, driveCreateBody());
  const record = {
    spreadsheetId: created.id,
    spreadsheetUrl: spreadsheetUrl(created.id),
    schemaVersion: 0,
    createdAt: created.createdTime || '',
    title: created.name || 'Finance Tracker'
  };
  if (onSheet) await onSheet(record);
  await setupSpreadsheet(fetchImpl, token, created.id);
  record.schemaVersion = SCHEMA_VERSION;
  if (onSheet) await onSheet(record);
  return record;
}

async function setupSpreadsheet(fetchImpl, token, spreadsheetId) {
  let meta = await getSpreadsheet(fetchImpl, token, spreadsheetId);
  const structure = planStructureRequests(meta);
  if (structure.length) {
    await batchUpdateSpreadsheet(fetchImpl, token, spreadsheetId, structure);
    meta = await getSpreadsheet(fetchImpl, token, spreadsheetId);
  }
  const ids = sheetIdMap(meta);
  for (const title of ['Transactions', 'Budgets', 'Goals', 'Settings', 'Summary']) {
    if (ids[title] == null) throw new Error(`Spreadsheet is missing the ${title} tab.`);
  }
  const format = planFormatRequests(ids);
  if (format.length) await batchUpdateSpreadsheet(fetchImpl, token, spreadsheetId, format);
  await batchUpdateValues(fetchImpl, token, spreadsheetId, headerBatch());
  await batchUpdateValues(fetchImpl, token, spreadsheetId, formulaBatch());
}

async function pullAll(fetchImpl, token, spreadsheetId) {
  const [transactions, budgets, goals, settings] = await Promise.all([
    getValues(fetchImpl, token, spreadsheetId, 'Transactions!A1:J5000'),
    getValues(fetchImpl, token, spreadsheetId, 'Budgets!A1:F5000'),
    getValues(fetchImpl, token, spreadsheetId, 'Goals!A1:I5000'),
    getValues(fetchImpl, token, spreadsheetId, 'Settings!A1:B30')
  ]);
  return {
    transactions: parseTransactions(transactions?.values),
    budgets: parseBudgets(budgets?.values),
    goals: parseGoals(goals?.values),
    settings: parseSettings(settings?.values),
    counts: {
      transactions: dataRowCount(transactions?.values),
      budgets: dataRowCount(budgets?.values),
      goals: dataRowCount(goals?.values),
      settings: dataRowCount(settings?.values)
    }
  };
}

async function pushAll(fetchImpl, token, spreadsheetId, state, counts, lastSyncAt) {
  const tx = padGrid(transactionRows(state.transactions), 10, counts.transactions);
  const budgets = padGrid(budgetRows(state.budgets), 6, counts.budgets);
  const goals = padGrid(goalRows(state.goals), 9, counts.goals);
  const settings = padGrid(settingsRows(state, lastSyncAt), 2, Math.max(counts.settings, 8));
  if (tx.length) await updateValues(fetchImpl, token, spreadsheetId, `Transactions!A2:J${tx.length + 1}`, tx);
  if (budgets.length) await updateValues(fetchImpl, token, spreadsheetId, `Budgets!A2:F${budgets.length + 1}`, budgets);
  if (goals.length) await updateValues(fetchImpl, token, spreadsheetId, `Goals!A2:I${goals.length + 1}`, goals);
  if (settings.length) await updateValues(fetchImpl, token, spreadsheetId, `Settings!A2:B${settings.length + 1}`, settings);
}

export async function runSync({
  data,
  queue,
  base,
  sheet,
  tokenStore,
  fetchImpl,
  now = () => new Date(),
  lock,
  allowCreate = true,
  onSheet
}) {
  if (lock?.current) {
    return { status: 'busy', data, queue, base, sheet, conflicts: [] };
  }
  if (lock) lock.current = true;
  try {
    if (!tokenStore.fresh()) {
      return { status: 'auth_expired', phase: 'token', data, queue, base, sheet, conflicts: [] };
    }
    const token = tokenStore.get();
    let sheetRec = sheet;
    try {
      sheetRec = await ensurePrivateSheet({ fetchImpl, token, sheet: sheetRec, allowCreate, onSheet });
    } catch (error) {
      if (error instanceof AuthExpiredError) {
        tokenStore.clear();
        return { status: 'auth_expired', phase: 'discover', data, queue, base, sheet, conflicts: [] };
      }
      if (error instanceof DiscoverFailedError) {
        return { status: 'discover_failed', phase: 'discover', data, queue, base, sheet, conflicts: [], message: error.message };
      }
      return { status: 'error', phase: 'discover', data, queue, base, sheet, conflicts: [], message: error.message };
    }
    let remote;
    try {
      remote = await pullAll(fetchImpl, tokenStore.get(), sheetRec.spreadsheetId);
    } catch (error) {
      if (error instanceof AuthExpiredError) {
        tokenStore.clear();
        return { status: 'auth_expired', phase: 'read', data, queue, base, sheet: sheetRec, conflicts: [] };
      }
      return { status: 'error', phase: 'read', data, queue, base, sheet: sheetRec, conflicts: [], message: error.message };
    }
    if (remote.settings.schemaVersion > SCHEMA_VERSION) {
      return {
        status: 'schema_too_new',
        phase: 'read',
        data,
        queue,
        base,
        sheet: sheetRec,
        conflicts: [],
        message: `This spreadsheet uses schema ${remote.settings.schemaVersion}. This app understands schema ${SCHEMA_VERSION}. Nothing was changed.`
      };
    }
    const baseRows = base?.rows || {};
    const txMerge = mergeRows(data.transactions, remote.transactions, baseRows, canonicalTransaction);
    const budgetMerge = mergeRows(data.budgets, remote.budgets, baseRows, canonicalBudget);
    const goalMerge = mergeRows(data.goals, remote.goals, baseRows, canonicalGoal);
    const settingsMerge = remote.settings.schemaVersion
      ? mergeSettings(data, remote.settings, base?.settingsUpdatedAt || '')
      : { state: data, conflicts: [], push: true };
    const nextData = {
      ...settingsMerge.state,
      transactions: txMerge.merged,
      budgets: budgetMerge.merged,
      goals: goalMerge.merged
    };
    const conflicts = [
      ...txMerge.conflicts.map((item) => ({ ...item, entity: 'transaction' })),
      ...budgetMerge.conflicts.map((item) => ({ ...item, entity: 'budget' })),
      ...goalMerge.conflicts.map((item) => ({ ...item, entity: 'goal' })),
      ...settingsMerge.conflicts.map((item) => ({ ...item, entity: 'settings' }))
    ].map((item) => ({ ...item, at: now().toISOString() }));
    const shouldPush = txMerge.push || budgetMerge.push || goalMerge.push || settingsMerge.push;
    if (!shouldPush) {
      return {
        status: 'ok',
        phase: 'merge',
        data: nextData,
        queue: emptyQueue(),
        base: baseFrom(nextData),
        sheet: { ...sheetRec, schemaVersion: SCHEMA_VERSION, lastSyncAt: now().toISOString() },
        conflicts
      };
    }
    try {
      await pushAll(fetchImpl, tokenStore.get(), sheetRec.spreadsheetId, nextData, remote.counts, now().toISOString());
    } catch (error) {
      if (error instanceof AuthExpiredError) tokenStore.clear();
      return {
        status: error instanceof AuthExpiredError ? 'auth_expired' : 'error',
        phase: 'write',
        data: nextData,
        queue,
        base,
        sheet: sheetRec,
        conflicts,
        message: error.message
      };
    }
    const syncedAt = now().toISOString();
    return {
      status: 'ok',
      phase: 'write',
      data: nextData,
      queue: emptyQueue(),
      base: baseFrom(nextData),
      sheet: { ...sheetRec, schemaVersion: SCHEMA_VERSION, lastSyncAt: syncedAt },
      conflicts
    };
  } finally {
    if (lock) lock.current = false;
  }
}

export { ensurePrivateSheet };
