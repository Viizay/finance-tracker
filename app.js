import { CAT_EMOJI, EXPENSE_CATS, INCOME_CATS, REQUIRED_SCOPES } from './js/constants.js';
import { escapeHtml, txRowHTML } from './js/html.js';
import { createTokenStore, identifyAccount } from './js/identity.js';
import {
  activeRows, addMonths, avgMonthlyExpense, buildDemo, createId, currentMonth, importBackup,
  emptyState, formatMoney, formatPct, monthKey, monthLabel, monthTotals,
  projectSeries, requiredMonthly, monthsUntil, roundMoney, softDeleteById,
  spendingByCategory, todayISO, tombstoneAll, upsertBudget, upsertGoal,
  upsertTransaction, visibleTransactions
} from './js/model.js';
import { runSync } from './js/sync.js';
import {
  clearSession, emptyQueue, enqueue, forgetAccount, hasPersonalData, loadBase,
  loadConflicts, loadQueue, loadSession, loadSheetRecord, loadState,
  moveGuestToAccount, resolveClientId, saveBase, saveClientId, saveConflicts,
  saveQueue, saveSession, saveSheetRecord, saveState
} from './js/storage.js';

const storage = window.localStorage;
const tokenStore = createTokenStore();
const syncLock = { current: false };
let tokenClient = null;
let tokenClientId = '';
let tokenHandler = () => {};

let sessionInfo = loadSession(storage);
let accountSub = sessionInfo?.sub || null;
let state = loadState(storage, accountSub);
let queue = accountSub ? loadQueue(storage, accountSub) : emptyQueue();
let base = accountSub ? loadBase(storage, accountSub) : { rows: {}, settingsUpdatedAt: '' };
let sheetRecord = accountSub ? loadSheetRecord(storage, accountSub) : null;
let conflicts = accountSub ? loadConflicts(storage, accountSub) : [];
let pendingSession = null;

let txFilter = 'all';
let entryType = 'expense';
const charts = { categories: null, trend: null, projection: null };
let toastTimer = null;

function stamp() {
  return new Date().toISOString();
}

function persist() {
  saveState(storage, accountSub, state);
  if (!accountSub) return;
  saveQueue(storage, accountSub, queue);
  saveBase(storage, accountSub, base);
  saveConflicts(storage, accountSub, conflicts);
  if (sheetRecord) saveSheetRecord(storage, accountSub, sheetRecord);
}

function noteChange(entity, id, action) {
  if (!accountSub) return;
  queue = enqueue(storage, accountSub, {
    opId: createId(),
    entity,
    id,
    action,
    enqueuedAt: stamp()
  }) || queue;
}

function reloadAccount(sub, session) {
  accountSub = sub;
  sessionInfo = session;
  state = loadState(storage, accountSub);
  queue = accountSub ? loadQueue(storage, accountSub) : emptyQueue();
  base = accountSub ? loadBase(storage, accountSub) : { rows: {}, settingsUpdatedAt: '' };
  sheetRecord = accountSub ? loadSheetRecord(storage, accountSub) : null;
  conflicts = accountSub ? loadConflicts(storage, accountSub) : [];
}

function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

function openModal(id) { document.getElementById(id).hidden = false; }
function closeModal(id) { document.getElementById(id).hidden = true; }

function chartColors() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark' ||
    (!document.documentElement.getAttribute('data-theme') && window.matchMedia('(prefers-color-scheme: dark)').matches);
  return {
    text: '#8E8E93',
    grid: dark ? 'rgba(84,84,88,0.4)' : 'rgba(60,60,67,0.12)',
    income: '#30D158',
    expense: '#FF453A',
    blue: '#0A84FF',
    palette: ['#0A84FF', '#30D158', '#FF9F0A', '#FF453A', '#BF5AF2', '#64D2FF', '#FFD60A', '#AC8E68']
  };
}

function fillCategorySelect(select, type, selected) {
  const cats = type === 'income' ? INCOME_CATS : EXPENSE_CATS;
  select.innerHTML = cats.map((cat) => {
    const label = `${CAT_EMOJI[cat] || ''} ${cat}`.trim();
    const sel = cat === selected ? ' selected' : '';
    return `<option value="${escapeHtml(cat)}"${sel}>${escapeHtml(label)}</option>`;
  }).join('');
}

function applyTheme() {
  if (state.theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', state.theme);
  document.querySelectorAll('#theme-seg .seg').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.theme === state.theme);
  });
  setTimeout(() => {
    renderDashboard();
    renderProjection();
  }, 50);
}

function navigate(name) {
  document.querySelectorAll('.view').forEach((view) => view.classList.remove('active'));
  const view = document.getElementById(name === 'settings' ? 'view-settings' : `view-${name}`);
  if (!view) return;
  view.classList.add('active');
  document.getElementById('page-title').textContent = view.dataset.title || name;
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.nav === name);
  });
  if (name === 'dashboard') renderDashboard();
  if (name === 'add') renderTransactions();
  if (name === 'budgets') renderBudgets();
  if (name === 'savings') renderSavings();
  if (name === 'plan') {
    renderGoals();
    renderProjection();
  }
  if (name === 'settings') renderSettings();
  window.scrollTo(0, 0);
}

function rowsForMonth(ym) {
  return visibleTransactions(state, ym).filter((row) => monthKey(row.date) === ym);
}

function renderDashboard() {
  const ym = currentMonth();
  const banner = document.getElementById('demo-banner');
  banner.hidden = !state.isDemo;
  document.getElementById('month-label').textContent = monthLabel(ym);
  const hasData = activeRows(state.transactions).length > 0;
  document.getElementById('dash-empty').hidden = hasData;
  document.getElementById('dash-content').hidden = !hasData;
  if (!hasData) return;
  const totals = monthTotals(rowsForMonth(ym));
  document.getElementById('stat-income').textContent = formatMoney(totals.income);
  document.getElementById('stat-expense').textContent = formatMoney(totals.expense);
  document.getElementById('stat-net').textContent = formatMoney(totals.net);
  const rate = totals.income > 0 ? (totals.net / totals.income) * 100 : NaN;
  document.getElementById('stat-rate').textContent = totals.income > 0 ? formatPct(rate) : '—';
  const cats = spendingByCategory(rowsForMonth(ym));
  document.getElementById('cat-empty').hidden = cats.length > 0;
  const colors = chartColors();
  if (charts.categories) charts.categories.destroy();
  if (cats.length && window.Chart) {
    charts.categories = new window.Chart(document.getElementById('chart-categories'), {
      type: 'doughnut',
      data: {
        labels: cats.map((item) => item[0]),
        datasets: [{ data: cats.map((item) => item[1]), backgroundColor: colors.palette, borderWidth: 0 }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: { color: colors.text, boxWidth: 12, font: { size: 11 } } } }
      }
    });
  }
  const labels = [];
  const incomeData = [];
  const expenseData = [];
  for (let i = 11; i >= 0; i -= 1) {
    const month = addMonths(ym, -i);
    labels.push(new Date(`${month}-01T00:00:00`).toLocaleString(undefined, { month: 'short' }));
    const totalsForMonth = monthTotals(rowsForMonth(month));
    incomeData.push(totalsForMonth.income);
    expenseData.push(totalsForMonth.expense);
  }
  if (charts.trend) charts.trend.destroy();
  if (window.Chart) {
    charts.trend = new window.Chart(document.getElementById('chart-trend'), {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Income', data: incomeData, backgroundColor: colors.income, borderRadius: 4 },
          { label: 'Spending', data: expenseData, backgroundColor: colors.expense, borderRadius: 4 }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { grid: { display: false }, ticks: { color: colors.text, maxRotation: 0, font: { size: 10 } } },
          y: { grid: { color: colors.grid }, ticks: { color: colors.text, font: { size: 10 } } }
        },
        plugins: { legend: { labels: { color: colors.text, boxWidth: 12, font: { size: 11 } } } }
      }
    });
  }
  const recent = visibleTransactions(state, ym)
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date) || String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 5);
  document.getElementById('recent-list').innerHTML = recent.map(txRowHTML).join('') ||
    '<li class="tx-item"><div class="tx-meta"><div class="tx-note">No recent transactions</div></div></li>';
}

function renderTransactions() {
  let list = visibleTransactions(state, currentMonth());
  if (txFilter === 'income') list = list.filter((row) => row.type === 'income');
  else if (txFilter === 'expense') list = list.filter((row) => row.type === 'expense');
  else if (txFilter === 'recurring') list = activeRows(state.transactions).filter((row) => row.recurring);
  list = list.slice().sort((a, b) => b.date.localeCompare(a.date));
  const el = document.getElementById('tx-list');
  const empty = document.getElementById('tx-empty');
  if (!list.length) {
    el.innerHTML = '';
    empty.hidden = false;
  } else {
    empty.hidden = true;
    el.innerHTML = list.map(txRowHTML).join('');
  }
}

function renderBudgets() {
  const spent = Object.fromEntries(spendingByCategory(rowsForMonth(currentMonth())));
  const list = document.getElementById('budget-list');
  const empty = document.getElementById('budget-empty');
  const rows = activeRows(state.budgets);
  if (!rows.length) {
    list.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  list.innerHTML = rows.map((budget) => {
    const used = spent[budget.category] || 0;
    const pct = Math.min(100, (used / budget.limit) * 100);
    let cls = 'good';
    if (pct >= 100) cls = 'over';
    else if (pct >= 80) cls = 'warn';
    return `<div class="budget-item" data-budget-id="${escapeHtml(budget.id)}">
      <div class="budget-head">
        <span class="budget-name">${escapeHtml(`${CAT_EMOJI[budget.category] || ''} ${budget.category}`.trim())}</span>
        <span class="budget-nums">${formatMoney(used)} / ${formatMoney(budget.limit)}</span>
      </div>
      <div class="progress ${cls}"><span style="width:${pct}%"></span></div>
    </div>`;
  }).join('');
}

function renderSavings() {
  document.getElementById('savings-balance').value = state.savingsBalance || '';
  const totals = monthTotals(rowsForMonth(currentMonth()));
  const rate = totals.income > 0 ? (totals.net / totals.income) * 100 : NaN;
  document.getElementById('sav-rate').textContent = totals.income > 0 ? formatPct(rate) : '—';
  const avg = avgMonthlyExpense(state, 3);
  const months = avg > 0 ? state.savingsBalance / avg : NaN;
  document.getElementById('sav-ef').textContent = Number.isFinite(months) ? String(Math.round(months * 10) / 10) : '—';
  const parts = [];
  if (!activeRows(state.transactions).length) {
    parts.push('<p>Add income and spending for feedback. The guidelines below still apply.</p>');
  } else if (totals.income <= 0) {
    parts.push('<p>Log income this month to calculate a savings rate.</p>');
  } else if (rate >= 20) {
    parts.push(`<p><span class="ok">Savings rate ${formatPct(rate)}.</span> That meets the common 20% guideline.</p>`);
  } else if (rate >= 0) {
    parts.push(`<p><span class="warn">Savings rate ${formatPct(rate)}.</span> A common long-term target is about 20%.</p>`);
  } else {
    parts.push(`<p><span class="bad">Spending is above income (${formatPct(rate)}).</span> Cover essentials before adding new goals.</p>`);
  }
  if (!state.savingsBalance) {
    parts.push('<p>Enter a savings balance to see how many months of spending it covers.</p>');
  } else if (!Number.isFinite(months) || avg <= 0) {
    parts.push('<p>More spending history is needed before emergency-fund months can be estimated.</p>');
  } else if (months >= 6) {
    parts.push(`<p><span class="ok">${Math.round(months * 10) / 10} months covered.</span> That is at the top of the common 3–6 month range.</p>`);
  } else if (months >= 3) {
    parts.push(`<p><span class="ok">${Math.round(months * 10) / 10} months covered.</span> That is inside the common 3–6 month range.</p>`);
  } else {
    parts.push(`<p><span class="warn">${Math.round(months * 10) / 10} months covered.</span> A common target is at least 3 months of spending.</p>`);
  }
  document.getElementById('feedback-body').innerHTML = parts.join('');
}

function renderGoals() {
  const list = document.getElementById('goals-list');
  const empty = document.getElementById('goals-empty');
  const rows = activeRows(state.goals);
  if (!rows.length) {
    list.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  list.innerHTML = rows.map((goal) => {
    const pct = Math.min(100, (Number(goal.current) / Number(goal.target)) * 100);
    const req = requiredMonthly(goal);
    const months = monthsUntil(goal.targetDate);
    const planned = goal.monthlyContribution == null ? '' : ` · You set aside ${formatMoney(goal.monthlyContribution)}/mo`;
    const line = pct >= 100
      ? 'Goal reached'
      : `About ${formatMoney(req)}/mo for ${months} month${months === 1 ? '' : 's'} (by ${goal.targetDate})${planned}`;
    return `<div class="goal-item" data-goal-id="${escapeHtml(goal.id)}">
      <div class="goal-head">
        <span class="goal-name">${escapeHtml(goal.name)}</span>
        <span class="goal-nums">${formatMoney(goal.current)} / ${formatMoney(goal.target)}</span>
      </div>
      <div class="progress ${pct >= 100 ? 'good' : ''}"><span style="width:${pct}%"></span></div>
      <div class="goal-req">${escapeHtml(line)}</div>
    </div>`;
  }).join('');
}

function readProjectionInputs() {
  state.projection = {
    start: roundMoney(document.getElementById('proj-start').value || 0),
    monthly: roundMoney(document.getElementById('proj-monthly').value || 0),
    returnPct: Number(document.getElementById('proj-return').value) || 0,
    inflation: Number(document.getElementById('proj-inflation').value) || 0,
    years: Number(document.getElementById('proj-years').value) || 1
  };
}

function renderProjection() {
  const fields = [
    ['proj-start', state.projection.start],
    ['proj-monthly', state.projection.monthly],
    ['proj-return', state.projection.returnPct],
    ['proj-inflation', state.projection.inflation],
    ['proj-years', state.projection.years]
  ];
  if (document.activeElement && fields.some(([id]) => document.activeElement.id === id)) {
    // Keep the in-progress edit. The input handler already stored the value.
  } else {
    for (const [id, value] of fields) {
      const el = document.getElementById(id);
      if (document.activeElement !== el) el.value = value;
    }
  }
  const series = projectSeries({
    start: state.projection.start,
    monthly: state.projection.monthly,
    annualReturn: state.projection.returnPct,
    inflation: state.projection.inflation,
    years: state.projection.years
  });
  document.getElementById('proj-nominal').textContent = formatMoney(series.nominal[series.nominal.length - 1]);
  document.getElementById('proj-real').textContent = formatMoney(series.real[series.real.length - 1]);
  const colors = chartColors();
  if (charts.projection) charts.projection.destroy();
  if (!window.Chart) return;
  charts.projection = new window.Chart(document.getElementById('chart-projection'), {
    type: 'line',
    data: {
      labels: series.labels,
      datasets: [
        { label: 'Nominal', data: series.nominal, borderColor: colors.blue, backgroundColor: 'transparent', tension: 0.25, pointRadius: 2 },
        { label: "Today's $", data: series.real, borderColor: colors.income, backgroundColor: 'transparent', borderDash: [4, 4], tension: 0.25, pointRadius: 2 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { grid: { display: false }, ticks: { color: colors.text, font: { size: 10 } } },
        y: { grid: { color: colors.grid }, ticks: { color: colors.text, font: { size: 10 } } }
      },
      plugins: { legend: { labels: { color: colors.text, boxWidth: 12, font: { size: 11 } } } }
    }
  });
}

function setSyncStatus(message) {
  const el = document.getElementById('sync-status');
  if (el) el.textContent = message;
}

function renderConflicts() {
  const el = document.getElementById('conflict-list');
  if (!conflicts.length) {
    el.innerHTML = '';
    return;
  }
  const items = conflicts.map((item, index) => {
    const name = item.entity === 'settings' ? 'Settings' : (item.local?.category || item.local?.name || item.local?.note || item.entityId);
    return `<div class="conflict">
      <p>Spreadsheet copy kept for ${escapeHtml(item.entity)} ${escapeHtml(name)}. Sheets has no row lock, so both copies had changed.</p>
      <div class="btn-row">
        <button type="button" class="btn small" data-restore-conflict="${index}">Use my version</button>
        <button type="button" class="btn small" data-dismiss-conflict="${index}">Dismiss</button>
      </div>
    </div>`;
  }).join('');
  el.innerHTML = `<h3 class="card-title">Conflicts</h3>${items}
    <button type="button" class="btn small" id="restore-all-conflicts">Use my versions</button>`;
}

function renderSettings() {
  const clientId = resolveClientId(storage);
  document.getElementById('google-unconfigured').hidden = !!clientId;
  document.getElementById('google-configured').hidden = !clientId;
  document.getElementById('sync-on-save').checked = !!state.syncOnSave;
  const signedIn = !!sessionInfo?.sub;
  const fresh = tokenStore.fresh();
  document.getElementById('google-connect').hidden = signedIn && fresh;
  document.getElementById('google-connect').textContent = signedIn ? 'Reconnect Google' : 'Connect Google';
  document.getElementById('google-sync').hidden = !signedIn;
  document.getElementById('google-signout').hidden = !signedIn;
  document.getElementById('forget-account').hidden = !signedIn;
  const openWrap = document.getElementById('open-sheet-wrap');
  if (sheetRecord?.spreadsheetUrl) {
    openWrap.hidden = false;
    const link = document.getElementById('open-sheet');
    link.href = sheetRecord.spreadsheetUrl;
  } else {
    openWrap.hidden = true;
  }
  if (!clientId) {
    setSyncStatus('Sheets sync is idle.');
  } else if (!signedIn) {
    document.getElementById('google-account').textContent = 'Not signed in. The app works on this device either way.';
    setSyncStatus('Connect Google to create a private spreadsheet in that account. Live sync has not been run in this environment.');
  } else {
    const who = sessionInfo.email || 'Google account';
    document.getElementById('google-account').textContent = fresh
      ? `Signed in as ${who}. Access token is in memory only.`
      : `Signed in as ${who}. Google access expired or is not loaded. On-device data is still here. Tap Reconnect.`;
    const pending = queue.ops.length;
    const synced = sheetRecord?.lastSyncAt ? `Last sync ${sheetRecord.lastSyncAt}.` : 'No successful sync from this device yet.';
    setSyncStatus(`${synced} Pending local changes: ${pending}.`);
  }
  renderConflicts();
}

function renderAll() {
  renderDashboard();
  renderTransactions();
  renderBudgets();
  renderSavings();
  renderGoals();
  renderProjection();
  renderSettings();
}

function findTemplate(id) {
  return state.transactions.find((row) => row.id === id) || null;
}

function openEntryModal(tx) {
  const template = tx?.templateId ? (findTemplate(tx.templateId) || tx) : tx;
  document.getElementById('entry-form').reset();
  document.getElementById('entry-id').value = template ? template.id : '';
  entryType = template ? template.type : 'expense';
  document.querySelectorAll('#entry-form .segmented .seg').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.type === entryType);
  });
  fillCategorySelect(document.getElementById('entry-category'), entryType, template && template.category);
  document.getElementById('entry-amount').value = template ? template.amount : '';
  document.getElementById('entry-date').value = template ? template.date : todayISO();
  document.getElementById('entry-note').value = template ? (template.note || '') : '';
  document.getElementById('entry-recurring').checked = !!(template && template.recurring);
  document.getElementById('entry-series-note').hidden = !(template && template.recurring);
  document.getElementById('entry-modal-title').textContent = template ? 'Edit entry' : 'Add entry';
  document.getElementById('entry-delete').hidden = !template;
  openModal('entry-modal');
  setTimeout(() => document.getElementById('entry-amount').focus(), 200);
}

function openBudgetModal(budget) {
  document.getElementById('budget-id').value = budget ? budget.id : '';
  fillCategorySelect(document.getElementById('budget-category'), 'expense', budget && budget.category);
  document.getElementById('budget-limit').value = budget ? budget.limit : '';
  document.getElementById('budget-delete').hidden = !budget;
  document.getElementById('budget-modal-title').textContent = budget ? 'Edit budget' : 'Add budget';
  openModal('budget-modal');
}

function openGoalModal(goal) {
  document.getElementById('goal-id').value = goal ? goal.id : '';
  document.getElementById('goal-name').value = goal ? goal.name : '';
  document.getElementById('goal-target').value = goal ? goal.target : '';
  document.getElementById('goal-current').value = goal ? goal.current : 0;
  document.getElementById('goal-monthly').value = goal && goal.monthlyContribution != null ? goal.monthlyContribution : '';
  const def = new Date();
  def.setFullYear(def.getFullYear() + 1);
  document.getElementById('goal-date').value = goal ? goal.targetDate : todayISO(def);
  document.getElementById('goal-delete').hidden = !goal;
  document.getElementById('goal-modal-title').textContent = goal ? 'Edit goal' : 'Add goal';
  openModal('goal-modal');
}

function afterWrite(message) {
  persist();
  if (message) toast(message);
  renderAll();
  if (state.syncOnSave) {
    if (!accountSub) return;
    if (!tokenStore.fresh()) {
      setSyncStatus('Sync after save is waiting. Tap Reconnect. Expired access is not refreshed in the background, and on-device data was kept.');
      return;
    }
    startSync();
  }
}

function loadDemo() {
  if (hasPersonalData(state) && !window.confirm('Replace current data with sample demo data?')) return;
  const theme = state.theme;
  const syncOnSave = state.syncOnSave;
  state = buildDemo();
  state.theme = theme;
  state.syncOnSave = syncOnSave;
  noteChange('state', 'demo', 'replace');
  afterWrite('Demo data loaded. It is sample data, not your finances.');
  navigate('dashboard');
}

function requestGoogleAccess(clientId) {
  return new Promise((resolve, reject) => {
    const gis = window.google?.accounts?.oauth2;
    if (!gis) {
      reject(new Error('Google’s sign-in script did not load. Check the connection and try again. On-device data is unchanged.'));
      return;
    }
    if (!tokenClient || tokenClientId !== clientId) {
      tokenClientId = clientId;
      tokenClient = gis.initTokenClient({
        client_id: clientId,
        scope: REQUIRED_SCOPES.join(' '),
        callback: (response) => tokenHandler(response),
        error_callback: (error) => tokenHandler({ error: error?.type || error?.message || 'popup_failed' })
      });
    }
    tokenHandler = (response) => {
      if (!response || response.error) reject(new Error('Google sign-in was closed before access was granted.'));
      else if (gis.hasGrantedAllScopes && !gis.hasGrantedAllScopes(response, ...REQUIRED_SCOPES)) {
        reject(new Error('Grant email, profile, and Drive file access. If a box is unchecked, sync cannot tell accounts apart or create a private spreadsheet.'));
      } else resolve(response);
    };
    tokenClient.requestAccessToken();
  });
}

async function connectGoogle() {
  const clientId = resolveClientId(storage);
  if (!clientId) {
    toast('Save the public OAuth client ID first.');
    return;
  }
  try {
    const tokenResponse = await requestGoogleAccess(clientId);
    tokenStore.set(tokenResponse);
    const identified = await identifyAccount(tokenResponse, window.fetch.bind(window));
    if (!identified.ok) {
      tokenStore.clear();
      toast(identified.message);
      renderSettings();
      return;
    }
    await offerSession(identified.session);
  } catch (error) {
    tokenStore.clear();
    toast(error.message || 'Google sign-in did not finish.');
    renderSettings();
  }
}

function offerSession(session) {
  const guest = loadState(storage, null);
  const existing = loadState(storage, session.sub);
  if (accountSub === session.sub || !hasPersonalData(guest) || accountSub === session.sub) {
    if (!hasPersonalData(guest) || accountSub === session.sub) {
      activateSession(session);
      return;
    }
  }
  pendingSession = session;
  const who = session.email || 'this Google account';
  const accountHasData = hasPersonalData(existing);
  document.getElementById('migrate-copy').textContent = accountHasData
    ? `${who} already has data on this device. Guest data stays separate unless you replace that on-device copy.`
    : `This device has entries that are not in a Google account yet. Move them into ${who}?`;
  document.getElementById('migrate-move').hidden = accountHasData;
  document.getElementById('migrate-replace').hidden = !accountHasData;
  openModal('migrate-modal');
}

function activateSession(session) {
  saveSession(storage, session);
  reloadAccount(session.sub, session);
  pendingSession = null;
  closeModal('migrate-modal');
  renderAll();
  applyTheme();
  toast(`Signed in as ${session.email || 'a Google account'}. Tap Sync now to create or update your private spreadsheet.`);
}

async function signOut() {
  const token = tokenStore.get();
  tokenStore.clear();
  tokenClient = null;
  if (token && window.google?.accounts?.oauth2?.revoke) {
    await new Promise((resolve) => window.google.accounts.oauth2.revoke(token, () => resolve()));
  }
  clearSession(storage);
  reloadAccount(null, null);
  renderAll();
  applyTheme();
  toast('Signed out. This account’s on-device copy stays until you remove it. The spreadsheet was not deleted.');
}

function applySyncResult(result) {
  if (result.sheet?.spreadsheetId) {
    sheetRecord = result.sheet;
    if (accountSub) saveSheetRecord(storage, accountSub, sheetRecord);
  }
  const keepMerge = result.status === 'ok' || result.phase === 'write';
  if (keepMerge) {
    state = result.data;
    queue = result.queue;
    base = result.base;
    if (result.conflicts?.length) conflicts = conflicts.concat(result.conflicts).slice(-50);
    persist();
  }
  if (result.status === 'ok') {
    setSyncStatus(`Synced ${sheetRecord?.lastSyncAt || ''}. Pending local changes: 0.`);
    toast(result.conflicts?.length
      ? 'Synced. Some rows differed on both sides, so the spreadsheet copy was kept.'
      : 'Synced to your private spreadsheet.');
  } else if (result.status === 'auth_expired') {
    setSyncStatus('Google access expired. Tap Reconnect and approve access again. Data on this device was not cleared.');
    toast('Google access expired. On-device data is still here.');
  } else if (result.status === 'schema_too_new') {
    setSyncStatus(result.message);
    toast(result.message);
  } else if (result.status === 'discover_failed') {
    setSyncStatus(result.message);
    toast(result.message);
  } else if (result.status === 'busy') {
    setSyncStatus('A sync is already running.');
  } else if (result.status === 'error') {
    setSyncStatus(result.message || 'Sync failed. On-device data was kept.');
    toast(result.message || 'Sync failed. On-device data was kept.');
  }
  renderAll();
}

async function startSync() {
  if (!accountSub) {
    toast('Connect Google before syncing.');
    return;
  }
  if (!tokenStore.fresh()) {
    setSyncStatus('Google access expired. Tap Reconnect. Nothing on this device was deleted.');
    toast('Tap Reconnect before syncing.');
    renderSettings();
    return;
  }
  setSyncStatus('Syncing…');
  const result = await runSync({
    data: state,
    queue,
    base,
    sheet: sheetRecord,
    tokenStore,
    fetchImpl: window.fetch.bind(window),
    lock: syncLock,
    allowCreate: true,
    onSheet: async (record) => {
      sheetRecord = record;
      saveSheetRecord(storage, accountSub, record);
    }
  });
  applySyncResult(result);
}

function applyConflictLocal(item) {
  const now = stamp();
  if (item.entity === 'transaction' && item.local) {
    state.transactions = state.transactions.filter((row) => row.id !== item.local.id);
    state.transactions.push({ ...item.local, updatedAt: now, deleted: !!item.local.deleted });
  } else if (item.entity === 'budget' && item.local) {
    state.budgets = state.budgets.filter((row) => row.id !== item.local.id);
    state.budgets.push({ ...item.local, updatedAt: now });
  } else if (item.entity === 'goal' && item.local) {
    state.goals = state.goals.filter((row) => row.id !== item.local.id);
    state.goals.push({ ...item.local, updatedAt: now });
  } else if (item.entity === 'settings' && item.local) {
    state.savingsBalance = item.local.savingsBalance;
    state.theme = item.local.theme;
    state.isDemo = item.local.isDemo;
    state.projection = item.local.projection || state.projection;
    state.settingsUpdatedAt = now;
  }
  noteChange(item.entity, item.entityId, 'restore');
}

function bind() {
  document.querySelectorAll('[data-nav]').forEach((el) => {
    el.addEventListener('click', () => navigate(el.dataset.nav));
  });
  document.getElementById('settings-btn').addEventListener('click', () => navigate('settings'));
  document.querySelectorAll('[data-tx-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      txFilter = btn.dataset.txFilter;
      document.querySelectorAll('[data-tx-filter]').forEach((item) => item.classList.toggle('active', item === btn));
      renderTransactions();
    });
  });
  document.getElementById('open-entry-modal').addEventListener('click', () => openEntryModal(null));
  document.getElementById('open-budget-modal').addEventListener('click', () => openBudgetModal(null));
  document.getElementById('open-goal-modal').addEventListener('click', () => openGoalModal(null));
  document.querySelectorAll('[data-close]').forEach((el) => {
    el.addEventListener('click', () => closeModal(el.dataset.close));
  });
  document.querySelectorAll('#entry-form .segmented .seg').forEach((btn) => {
    btn.addEventListener('click', () => {
      entryType = btn.dataset.type;
      document.querySelectorAll('#entry-form .segmented .seg').forEach((item) => item.classList.toggle('active', item === btn));
      fillCategorySelect(document.getElementById('entry-category'), entryType);
    });
  });
  document.getElementById('entry-recurring').addEventListener('change', (event) => {
    document.getElementById('entry-series-note').hidden = !event.target.checked;
  });
  document.getElementById('entry-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const id = document.getElementById('entry-id').value;
    const result = upsertTransaction(state.transactions, {
      type: entryType,
      amount: document.getElementById('entry-amount').value,
      category: document.getElementById('entry-category').value,
      date: document.getElementById('entry-date').value,
      note: document.getElementById('entry-note').value,
      recurring: document.getElementById('entry-recurring').checked
    }, id, stamp());
    if (result.error) return toast(result.error);
    state.transactions = result.list;
    noteChange('transaction', result.id, id ? 'upsert' : 'upsert');
    closeModal('entry-modal');
    afterWrite('Saved');
    navigate('add');
  });
  document.getElementById('entry-delete').addEventListener('click', () => {
    const id = document.getElementById('entry-id').value;
    const row = findTemplate(id);
    const message = row?.recurring
      ? 'Delete this monthly series? Every month of the series is removed.'
      : 'Delete this entry?';
    if (!id || !window.confirm(message)) return;
    state.transactions = softDeleteById(state.transactions, id, stamp());
    noteChange('transaction', id, 'delete');
    closeModal('entry-modal');
    afterWrite('Deleted');
  });
  function onTxClick(event) {
    const item = event.target.closest('[data-tx-id]');
    if (!item) return;
    const row = findTemplate(item.dataset.txId) || visibleTransactions(state, currentMonth()).find((tx) => tx.id === item.dataset.txId);
    if (row) openEntryModal(row);
  }
  document.getElementById('tx-list').addEventListener('click', onTxClick);
  document.getElementById('recent-list').addEventListener('click', onTxClick);
  document.getElementById('budget-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const result = upsertBudget(state.budgets, {
      category: document.getElementById('budget-category').value,
      limit: document.getElementById('budget-limit').value
    }, document.getElementById('budget-id').value, stamp());
    if (result.error) return toast(result.error);
    state.budgets = result.list;
    noteChange('budget', result.id, 'upsert');
    closeModal('budget-modal');
    afterWrite('Budget saved');
  });
  document.getElementById('budget-delete').addEventListener('click', () => {
    const id = document.getElementById('budget-id').value;
    state.budgets = softDeleteById(state.budgets, id, stamp());
    noteChange('budget', id, 'delete');
    closeModal('budget-modal');
    afterWrite('Budget deleted');
  });
  document.getElementById('budget-list').addEventListener('click', (event) => {
    const item = event.target.closest('[data-budget-id]');
    if (!item) return;
    const budget = state.budgets.find((row) => row.id === item.dataset.budgetId);
    if (budget) openBudgetModal(budget);
  });
  document.getElementById('goal-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const monthly = document.getElementById('goal-monthly').value;
    const result = upsertGoal(state.goals, {
      name: document.getElementById('goal-name').value,
      target: document.getElementById('goal-target').value,
      current: document.getElementById('goal-current').value,
      monthlyContribution: monthly === '' ? null : monthly,
      targetDate: document.getElementById('goal-date').value
    }, document.getElementById('goal-id').value, stamp());
    if (result.error) return toast(result.error);
    state.goals = result.list;
    noteChange('goal', result.id, 'upsert');
    closeModal('goal-modal');
    afterWrite('Goal saved');
  });
  document.getElementById('goal-delete').addEventListener('click', () => {
    const id = document.getElementById('goal-id').value;
    state.goals = softDeleteById(state.goals, id, stamp());
    noteChange('goal', id, 'delete');
    closeModal('goal-modal');
    afterWrite('Goal deleted');
  });
  document.getElementById('goals-list').addEventListener('click', (event) => {
    const item = event.target.closest('[data-goal-id]');
    if (!item) return;
    const goal = state.goals.find((row) => row.id === item.dataset.goalId);
    if (goal) openGoalModal(goal);
  });
  document.getElementById('save-balance-btn').addEventListener('click', () => {
    state.savingsBalance = roundMoney(document.getElementById('savings-balance').value || 0);
    state.settingsUpdatedAt = stamp();
    noteChange('settings', 'savings', 'upsert');
    afterWrite('Balance saved');
  });
  for (const id of ['proj-start', 'proj-monthly', 'proj-return', 'proj-inflation', 'proj-years']) {
    document.getElementById(id).addEventListener('change', () => {
      readProjectionInputs();
      state.settingsUpdatedAt = stamp();
      noteChange('settings', 'projection', 'upsert');
      persist();
      renderProjection();
      if (state.syncOnSave && tokenStore.fresh()) startSync();
    });
    document.getElementById(id).addEventListener('input', () => {
      readProjectionInputs();
      renderProjection();
    });
  }
  document.querySelectorAll('#theme-seg .seg').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.theme = btn.dataset.theme;
      state.settingsUpdatedAt = stamp();
      noteChange('settings', 'theme', 'upsert');
      persist();
      applyTheme();
    });
  });
  document.getElementById('load-demo-btn').addEventListener('click', loadDemo);
  document.getElementById('settings-demo-btn').addEventListener('click', loadDemo);
  document.getElementById('clear-demo-btn').addEventListener('click', () => {
    state = tombstoneAll(state, stamp());
    noteChange('state', 'clear', 'delete');
    afterWrite('Demo data cleared');
    navigate('dashboard');
  });
  document.getElementById('clear-data-btn').addEventListener('click', () => {
    if (!window.confirm('Clear transactions, budgets, and goals on this device?')) return;
    state = tombstoneAll(state, stamp());
    noteChange('state', 'clear', 'delete');
    afterWrite('Data cleared on this device');
    navigate('dashboard');
  });
  document.getElementById('export-btn').addEventListener('click', () => {
    const payload = {
      version: 1,
      exportedAt: stamp(),
      includesDeleted: true,
      isDemo: state.isDemo,
      transactions: state.transactions,
      budgets: state.budgets,
      goals: state.goals,
      savingsBalance: state.savingsBalance,
      theme: state.theme,
      projection: state.projection,
      settingsUpdatedAt: state.settingsUpdatedAt
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `finance-backup-${todayISO()}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
    toast('Exported');
  });
  document.getElementById('import-btn').addEventListener('click', () => document.getElementById('import-file').click());
  document.getElementById('import-file').addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > 2_000_000) return toast('Import failed. File is larger than 2 MB.');
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));
        const result = importBackup(data);
        if (!result.ok) return toast(result.errors[0] || 'Import failed.');
        const theme = state.theme;
        state = result.state;
        if (!data.theme) state.theme = theme;
        noteChange('state', 'import', 'replace');
        afterWrite(result.errors.length
          ? `Imported with ${result.errors.length} skipped row${result.errors.length === 1 ? '' : 's'}.`
          : 'Imported on this device. If the spreadsheet also changed, sync keeps the spreadsheet row and lists your copy under Conflicts.');
        navigate('dashboard');
      } catch {
        toast('Import failed. The file is not valid JSON.');
      }
    };
    reader.readAsText(file);
  });
  document.getElementById('save-client-id').addEventListener('click', () => {
    const saved = saveClientId(storage, document.getElementById('client-id-input').value);
    if (saved === null) return toast('That is not a public Google client ID. It should end in .apps.googleusercontent.com.');
    toast(saved ? 'Client ID saved on this device. Connecting still needs you to approve Google.' : 'Client ID cleared on this device.');
    renderSettings();
  });
  document.getElementById('google-connect').addEventListener('click', () => { connectGoogle(); });
  document.getElementById('google-sync').addEventListener('click', () => { startSync(); });
  document.getElementById('google-signout').addEventListener('click', () => { signOut(); });
  document.getElementById('forget-account').addEventListener('click', () => {
    if (!accountSub) return;
    if (!window.confirm('Remove this account’s data from this device? The Google spreadsheet is not deleted.')) return;
    forgetAccount(storage, accountSub);
    signOut();
  });
  document.getElementById('sync-on-save').addEventListener('change', (event) => {
    state.syncOnSave = !!event.target.checked;
    state.settingsUpdatedAt = stamp();
    noteChange('settings', 'syncOnSave', 'upsert');
    persist();
    renderSettings();
  });
  document.getElementById('migrate-move').addEventListener('click', () => {
    if (!pendingSession) return;
    moveGuestToAccount(storage, pendingSession.sub);
    activateSession(pendingSession);
  });
  document.getElementById('migrate-replace').addEventListener('click', () => {
    if (!pendingSession) return;
    if (!window.confirm('Replace this account’s on-device copy with the guest data? This does not delete the spreadsheet.')) return;
    moveGuestToAccount(storage, pendingSession.sub);
    activateSession(pendingSession);
  });
  document.getElementById('migrate-separate').addEventListener('click', () => {
    if (!pendingSession) return;
    activateSession(pendingSession);
  });
  document.getElementById('migrate-cancel').addEventListener('click', () => {
    pendingSession = null;
    tokenStore.clear();
    closeModal('migrate-modal');
    renderSettings();
    toast('Sign-in cancelled. Guest data was left as it was.');
  });
  document.getElementById('conflict-list').addEventListener('click', (event) => {
    if (event.target.closest('#restore-all-conflicts')) {
      const copy = conflicts.slice();
      conflicts = [];
      for (const item of copy) applyConflictLocal(item);
      persist();
      renderAll();
      toast('Local versions restored on this device. Sync uploads them if that spreadsheet row was not edited again.');
      return;
    }
    const restore = event.target.closest('[data-restore-conflict]');
    const dismiss = event.target.closest('[data-dismiss-conflict]');
    if (!restore && !dismiss) return;
    const index = Number((restore || dismiss).dataset.restoreConflict || (restore || dismiss).dataset.dismissConflict);
    const item = conflicts[index];
    if (!item) return;
    conflicts = conflicts.filter((_, itemIndex) => itemIndex !== index);
    if (restore) applyConflictLocal(item);
    persist();
    renderAll();
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.theme === 'system') applyTheme();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    ['entry-modal', 'budget-modal', 'goal-modal', 'migrate-modal'].forEach(closeModal);
  });
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').catch((error) => {
    console.warn('Service worker registration failed', error);
  });
}

bind();
applyTheme();
fillCategorySelect(document.getElementById('entry-category'), 'expense');
fillCategorySelect(document.getElementById('budget-category'), 'expense');
renderAll();
registerSW();
