import {
  APP_PROPERTY_KEY, APP_PROPERTY_VALUE, BUDGET_HEADERS, FORMULA_ROWS,
  GOAL_HEADERS, SCHEMA_VERSION, SHEET_TITLE, TAB_NAMES, TX_HEADERS
} from './constants.js';

export function spreadsheetUrl(id) {
  return `https://docs.google.com/spreadsheets/d/${id}/edit`;
}

/** Drive file body. No permissions field: the file stays private to the creator. */
export function driveCreateBody() {
  return {
    name: SHEET_TITLE,
    mimeType: 'application/vnd.google-apps.spreadsheet',
    appProperties: {
      [APP_PROPERTY_KEY]: APP_PROPERTY_VALUE,
      schemaVersion: String(SCHEMA_VERSION)
    }
  };
}

export function discoveryQuery() {
  return [
    `appProperties has { key='${APP_PROPERTY_KEY}' and value='${APP_PROPERTY_VALUE}' }`,
    'trashed = false',
    "mimeType = 'application/vnd.google-apps.spreadsheet'"
  ].join(' and ');
}

export function planStructureRequests(spreadsheet) {
  const sheets = spreadsheet?.sheets || [];
  const titles = new Set(sheets.map((sheet) => sheet.properties?.title));
  const requests = [];
  if (!titles.has('Transactions')) {
    const first = sheets[0];
    if (!first?.properties?.sheetId && first?.properties?.sheetId !== 0) {
      throw new Error('Spreadsheet has no sheet to rename.');
    }
    requests.push({
      updateSheetProperties: {
        properties: {
          sheetId: first.properties.sheetId,
          title: 'Transactions',
          gridProperties: { frozenRowCount: 1 }
        },
        fields: 'title,gridProperties.frozenRowCount'
      }
    });
    titles.add('Transactions');
  }
  for (const title of TAB_NAMES) {
    if (title === 'Transactions') continue;
    if (!titles.has(title)) {
      requests.push({
        addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } }
      });
    }
  }
  return requests;
}

export function sheetIdMap(spreadsheet) {
  const map = {};
  for (const sheet of spreadsheet?.sheets || []) {
    map[sheet.properties.title] = sheet.properties.sheetId;
  }
  return map;
}

function rgb(hex) {
  return {
    red: parseInt(hex.slice(1, 3), 16) / 255,
    green: parseInt(hex.slice(3, 5), 16) / 255,
    blue: parseInt(hex.slice(5, 7), 16) / 255
  };
}

function headerRepeat(sheetId, columnCount) {
  return {
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: columnCount },
      cell: {
        userEnteredFormat: {
          backgroundColor: rgb('#0A84FF'),
          textFormat: { bold: true, foregroundColor: rgb('#FFFFFF') },
          horizontalAlignment: 'CENTER'
        }
      },
      fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)'
    }
  };
}

function width(sheetId, index, pixels) {
  return {
    updateDimensionProperties: {
      range: { sheetId, dimension: 'COLUMNS', startIndex: index, endIndex: index + 1 },
      properties: { pixelSize: pixels },
      fields: 'pixelSize'
    }
  };
}

function numberFormat(sheetId, column, pattern) {
  return {
    repeatCell: {
      range: { sheetId, startRowIndex: 1, endRowIndex: 5000, startColumnIndex: column, endColumnIndex: column + 1 },
      cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern } } },
      fields: 'userEnteredFormat.numberFormat'
    }
  };
}

export function planFormatRequests(ids) {
  const requests = [];
  const columns = {
    Transactions: TX_HEADERS.length,
    Budgets: BUDGET_HEADERS.length + 1,
    Goals: GOAL_HEADERS.length + 1,
    Settings: 2,
    Summary: 2
  };
  for (const [title, count] of Object.entries(columns)) {
    if (ids[title] == null) continue;
    requests.push(headerRepeat(ids[title], count));
    requests.push({
      updateSheetProperties: {
        properties: { sheetId: ids[title], gridProperties: { frozenRowCount: 1 } },
        fields: 'gridProperties.frozenRowCount'
      }
    });
  }
  if (ids.Transactions != null) {
    [220, 110, 120, 150, 120, 220, 110, 100, 200, 200].forEach((px, index) => {
      requests.push(width(ids.Transactions, index, px));
    });
    requests.push(numberFormat(ids.Transactions, 2, '#,##0.00'));
  }
  if (ids.Budgets != null) {
    requests.push(numberFormat(ids.Budgets, 2, '#,##0.00'));
    requests.push(numberFormat(ids.Budgets, 6, '#,##0.00'));
  }
  if (ids.Goals != null) {
    requests.push(numberFormat(ids.Goals, 2, '#,##0.00'));
    requests.push(numberFormat(ids.Goals, 3, '#,##0.00'));
    requests.push(numberFormat(ids.Goals, 5, '#,##0.00'));
    requests.push(numberFormat(ids.Goals, 9, '#,##0.00'));
  }
  if (ids.Summary != null) {
    requests.push(width(ids.Summary, 0, 360));
    requests.push(width(ids.Summary, 1, 180));
    requests.push(numberFormat(ids.Summary, 1, '#,##0.00'));
  }
  return requests;
}

export function headerBatch() {
  return {
    valueInputOption: 'RAW',
    data: [
      { range: 'Transactions!A1:J1', values: [TX_HEADERS] },
      { range: 'Budgets!A1:G1', values: [[...BUDGET_HEADERS, 'spent_this_month']] },
      { range: 'Goals!A1:J1', values: [[...GOAL_HEADERS, 'remaining']] },
      { range: 'Settings!A1:B1', values: [['key', 'value']] },
      { range: 'Summary!A1:A12', values: [
        ['Finance Tracker'],
        ['Private spreadsheet for the signed-in Google account. This app does not share it.'],
        ['Month'],
        ['Income'],
        ['Spending'],
        ['Net'],
        ['Savings rate'],
        ['Savings balance'],
        ['Emergency-fund months (balance / this month spending)'],
        ['Schema version'],
        ['Last sync'],
        ['Conflict note']
      ] }
    ]
  };
}

/** Dates stay ISO text (RAW). Formulas use LEFT(date, 7), so they do not depend on locale parsing. */
export function incomeFormula() {
  return 'SUMPRODUCT((Transactions!B2:B5000="income")*(Transactions!H2:H5000<>"TRUE")*(LEFT(Transactions!E2:E5000,7)=TEXT(TODAY(),"yyyy-mm"))*(Transactions!C2:C5000))';
}

export function spendingFormula() {
  return 'SUMPRODUCT((Transactions!B2:B5000="expense")*(Transactions!H2:H5000<>"TRUE")*(LEFT(Transactions!E2:E5000,7)=TEXT(TODAY(),"yyyy-mm"))*(Transactions!C2:C5000))';
}

export function formulaBatch() {
  const summaryColumn = [
    [''],
    [''],
    ['=TEXT(TODAY(),"yyyy-mm")'],
    [`=${incomeFormula()}`],
    [`=${spendingFormula()}`],
    ['=B4-B5'],
    ['=IF(B4=0,"n/a",TEXT((B4-B5)/B4,"0.0%"))'],
    ['=IFERROR(VALUE(VLOOKUP("savings_balance",Settings!A:B,2,FALSE)),0)'],
    ['=IF(B5=0,"n/a",B8/B5)'],
    ['=IFERROR(VLOOKUP("schema_version",Settings!A:B,2,FALSE),"")'],
    ['=IFERROR(VLOOKUP("last_sync_at",Settings!A:B,2,FALSE),"")'],
    ['Google Sheets does not provide a row lock. If two devices sync the same row, the last successful write is what the spreadsheet keeps.']
  ];
  const budgetSpent = [];
  for (let row = 2; row <= FORMULA_ROWS + 1; row += 1) {
    budgetSpent.push([
      `=IF(A${row}="","",SUMPRODUCT((Transactions!$D$2:$D$5000=B${row})*(Transactions!$B$2:$B$5000="expense")*(Transactions!$H$2:$H$5000<>"TRUE")*(LEFT(Transactions!$E$2:$E$5000,7)=TEXT(TODAY(),"yyyy-mm"))*(Transactions!$C$2:$C$5000)))`
    ]);
  }
  const goalRemaining = [];
  for (let row = 2; row <= FORMULA_ROWS + 1; row += 1) {
    goalRemaining.push([`=IF(A${row}="","",MAX(0,C${row}-D${row}))`]);
  }
  return {
    valueInputOption: 'USER_ENTERED',
    data: [
      { range: 'Summary!B1:B12', values: summaryColumn },
      { range: `Budgets!G2:G${FORMULA_ROWS + 1}`, values: budgetSpent },
      { range: `Goals!J2:J${FORMULA_ROWS + 1}`, values: goalRemaining }
    ]
  };
}

export function boolCell(value) {
  return value ? 'TRUE' : 'FALSE';
}

export function transactionRows(transactions) {
  return transactions.map((row) => [
    row.id,
    row.type,
    row.amount,
    row.category,
    row.date,
    row.note || '',
    boolCell(row.recurring),
    boolCell(row.deleted),
    row.createdAt || '',
    row.updatedAt || ''
  ]);
}

export function budgetRows(budgets) {
  return budgets.map((row) => [
    row.id,
    row.category,
    row.limit,
    boolCell(row.deleted),
    row.createdAt || '',
    row.updatedAt || ''
  ]);
}

export function goalRows(goals) {
  return goals.map((row) => [
    row.id,
    row.name,
    row.target,
    row.current,
    row.targetDate,
    row.monthlyContribution == null ? '' : row.monthlyContribution,
    boolCell(row.deleted),
    row.createdAt || '',
    row.updatedAt || ''
  ]);
}

export function settingsRows(state, lastSyncAt) {
  return [
    ['schema_version', String(SCHEMA_VERSION)],
    ['savings_balance', String(state.savingsBalance || 0)],
    ['theme', state.theme || 'system'],
    ['is_demo', state.isDemo ? 'TRUE' : 'FALSE'],
    ['sync_on_save', state.syncOnSave ? 'TRUE' : 'FALSE'],
    ['settings_updated_at', state.settingsUpdatedAt || ''],
    ['projection', JSON.stringify(state.projection || {})],
    ['last_sync_at', lastSyncAt || '']
  ];
}

export function padGrid(rows, width, previousDataRows) {
  const blank = () => Array.from({ length: width }, () => '');
  const values = rows.map((row) => {
    const copy = row.slice(0, width);
    while (copy.length < width) copy.push('');
    return copy;
  });
  const target = Math.max(values.length, previousDataRows || 0);
  while (values.length < target) values.push(blank());
  return values;
}

function cell(row, index) {
  return row && row[index] != null ? String(row[index]) : '';
}

function isDeleted(value) {
  return String(value).toUpperCase() === 'TRUE' || value === true;
}

export function parseTransactions(values) {
  const rows = Array.isArray(values) ? values : [];
  const body = rows[0] && String(rows[0][0]).toLowerCase() === 'id' ? rows.slice(1) : rows;
  const out = [];
  for (const row of body) {
    const id = cell(row, 0).trim();
    if (!id) continue;
    const type = cell(row, 1) === 'income' ? 'income' : 'expense';
    out.push({
      id,
      type,
      amount: Number(row[2]) || 0,
      category: cell(row, 3),
      date: cell(row, 4),
      note: cell(row, 5),
      recurring: isDeleted(row[6]),
      deleted: isDeleted(row[7]),
      createdAt: cell(row, 8),
      updatedAt: cell(row, 9)
    });
  }
  return out;
}

export function parseBudgets(values) {
  const rows = Array.isArray(values) ? values : [];
  const body = rows[0] && String(rows[0][0]).toLowerCase() === 'id' ? rows.slice(1) : rows;
  const out = [];
  for (const row of body) {
    const id = cell(row, 0).trim();
    if (!id) continue;
    out.push({
      id,
      category: cell(row, 1),
      limit: Number(row[2]) || 0,
      deleted: isDeleted(row[3]),
      createdAt: cell(row, 4),
      updatedAt: cell(row, 5)
    });
  }
  return out;
}

export function parseGoals(values) {
  const rows = Array.isArray(values) ? values : [];
  const body = rows[0] && String(rows[0][0]).toLowerCase() === 'id' ? rows.slice(1) : rows;
  const out = [];
  for (const row of body) {
    const id = cell(row, 0).trim();
    if (!id) continue;
    const monthly = cell(row, 5);
    out.push({
      id,
      name: cell(row, 1),
      target: Number(row[2]) || 0,
      current: Number(row[3]) || 0,
      targetDate: cell(row, 4),
      monthlyContribution: monthly === '' ? null : Number(monthly),
      deleted: isDeleted(row[6]),
      createdAt: cell(row, 7),
      updatedAt: cell(row, 8)
    });
  }
  return out;
}

export function parseSettings(values) {
  const rows = Array.isArray(values) ? values : [];
  const body = rows[0] && String(rows[0][0]).toLowerCase() === 'key' ? rows.slice(1) : rows;
  const map = {};
  for (const row of body) {
    const key = cell(row, 0).trim();
    if (!key) continue;
    map[key] = cell(row, 1);
  }
  let projection = null;
  if (map.projection) {
    try { projection = JSON.parse(map.projection); } catch { projection = null; }
  }
  return {
    schemaVersion: Number(map.schema_version || 0),
    savingsBalance: Number(map.savings_balance) || 0,
    theme: ['system', 'light', 'dark'].includes(map.theme) ? map.theme : 'system',
    isDemo: map.is_demo === 'TRUE',
    syncOnSave: map.sync_on_save === 'TRUE',
    settingsUpdatedAt: map.settings_updated_at || '',
    projection,
    lastSyncAt: map.last_sync_at || ''
  };
}

/** Body height returned by values.get, including blank rows Google still sent back. */
export function dataRowCount(values) {
  const rows = Array.isArray(values) ? values : [];
  if (!rows.length) return 0;
  const first = String(rows[0]?.[0] || '').toLowerCase();
  const body = first === 'id' || first === 'key' ? rows.slice(1) : rows;
  return body.length;
}
