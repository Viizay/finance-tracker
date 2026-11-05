import { discoveryQuery } from './sheet-schema.js';

export class AuthExpiredError extends Error {
  constructor() {
    super('Google access expired');
    this.code = 'auth_expired';
    this.name = 'AuthExpiredError';
  }
}

export class DiscoverFailedError extends Error {
  constructor(message) {
    super(message);
    this.code = 'discover_failed';
    this.name = 'DiscoverFailedError';
  }
}

async function googleFetch(fetchImpl, token, url, options = {}) {
  const response = await fetchImpl(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
  }
  if (response.status === 401) throw new AuthExpiredError();
  if (!response.ok) {
    const error = new Error(body?.error?.message || `Google API ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

export function createSpreadsheet(fetchImpl, token, fileBody) {
  return googleFetch(fetchImpl, token, 'https://www.googleapis.com/drive/v3/files?fields=id,name,createdTime,appProperties', {
    method: 'POST',
    body: JSON.stringify(fileBody)
  });
}

export function getDriveFile(fetchImpl, token, fileId) {
  return googleFetch(
    fetchImpl,
    token,
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,trashed,createdTime,appProperties`
  );
}

export function listFinanceSheets(fetchImpl, token) {
  const params = new URLSearchParams({
    q: discoveryQuery(),
    spaces: 'drive',
    pageSize: '10',
    orderBy: 'createdTime',
    fields: 'files(id,name,createdTime,appProperties,trashed)'
  });
  return googleFetch(fetchImpl, token, `https://www.googleapis.com/drive/v3/files?${params.toString()}`);
}

export function getSpreadsheet(fetchImpl, token, spreadsheetId) {
  return googleFetch(
    fetchImpl,
    token,
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties`
  );
}

export function batchUpdateSpreadsheet(fetchImpl, token, spreadsheetId, requests) {
  return googleFetch(fetchImpl, token, `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ requests })
  });
}

export function batchUpdateValues(fetchImpl, token, spreadsheetId, body) {
  return googleFetch(
    fetchImpl,
    token,
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`,
    { method: 'POST', body: JSON.stringify(body) }
  );
}

export function getValues(fetchImpl, token, spreadsheetId, range) {
  return googleFetch(
    fetchImpl,
    token,
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`
  );
}

/**
 * One range, one request. Rewriting a rectangle (including blank rows past the
 * new data) is safe to retry: a second call replaces the same cells.
 * values.append is not used, because a retry would duplicate rows.
 */
export function updateValues(fetchImpl, token, spreadsheetId, range, values) {
  return googleFetch(
    fetchImpl,
    token,
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    { method: 'PUT', body: JSON.stringify({ range, majorDimension: 'ROWS', values }) }
  );
}
