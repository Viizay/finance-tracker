function json(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async text() { return JSON.stringify(body); },
    async json() { return body; }
  };
}

function colIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseA1(cell) {
  const match = /^([A-Z]+)(\d+)$/.exec(cell);
  if (!match) throw new Error(`Bad cell ${cell}`);
  return { c: colIndex(match[1]), r: Number(match[2]) - 1 };
}

function parseRange(range) {
  const [sheet, cells] = range.split('!');
  const [start, end] = cells.split(':');
  const a = parseA1(start);
  const b = end ? parseA1(end) : a;
  return { sheet, r1: a.r, c1: a.c, r2: b.r, c2: b.c };
}

function writeRange(grid, range, values) {
  const { r1, c1 } = parseRange(range);
  for (let i = 0; i < values.length; i += 1) {
    const r = r1 + i;
    while (grid.length <= r) grid.push([]);
    values[i].forEach((cell, j) => {
      grid[r][c1 + j] = cell;
    });
  }
}

function readRange(grid, range) {
  const { r1, c1, r2, c2 } = parseRange(range);
  const values = [];
  const last = Math.min(r2, (grid?.length || 1) - 1);
  for (let r = r1; r <= last; r += 1) {
    const row = [];
    for (let c = c1; c <= c2; c += 1) row.push(grid[r]?.[c] ?? '');
    values.push(row);
  }
  while (values.length && values[values.length - 1].every((cell) => cell === '' || cell == null)) values.pop();
  return values;
}

export function createMockGoogle(prefix = 'sheet') {
  const calls = [];
  const files = new Map();
  let seq = 1;
  let failPuts = 0;
  let unauthorized = false;
  let listStatus = 200;

  function sheetState(id) {
    return files.get(id);
  }

  async function fetchImpl(url, options = {}) {
    const u = new URL(url);
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    const auth = options.headers?.Authorization || '';
    calls.push({ method, pathname: u.pathname, search: u.search, body, auth });
    if (unauthorized || auth === 'Bearer expired') return json(401, { error: { message: 'invalid_token' } });

    if (u.pathname === '/drive/v3/files' && method === 'POST') {
      const id = `${prefix}_${seq}`;
      seq += 1;
      files.set(id, {
        id,
        name: body.name,
        appProperties: body.appProperties,
        createdTime: `2026-01-0${seq}T00:00:00.000Z`,
        trashed: false,
        permissions: body.permissions || null,
        sheets: [{ properties: { sheetId: 0, title: 'Sheet1' } }],
        grids: { Sheet1: [] }
      });
      return json(200, { id, name: body.name, createdTime: files.get(id).createdTime, appProperties: body.appProperties });
    }

    if (u.pathname === '/drive/v3/files' && method === 'GET') {
      if (listStatus !== 200) return json(listStatus, { error: { message: 'list denied' } });
      const list = [...files.values()].filter((file) => !file.trashed).map((file) => ({
        id: file.id,
        name: file.name,
        createdTime: file.createdTime,
        appProperties: file.appProperties,
        trashed: false
      }));
      return json(200, { files: list });
    }

    const fileGet = u.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (fileGet && method === 'GET') {
      const file = files.get(decodeURIComponent(fileGet[1]));
      if (!file) return json(404, { error: { message: 'not found' } });
      return json(200, { id: file.id, name: file.name, trashed: file.trashed, createdTime: file.createdTime, appProperties: file.appProperties });
    }

    const meta = u.pathname.match(/^\/v4\/spreadsheets\/([^/:]+)$/);
    if (meta && method === 'GET') {
      const file = files.get(decodeURIComponent(meta[1]));
      if (!file) return json(404, { error: { message: 'not found' } });
      return json(200, { sheets: file.sheets });
    }

    const batch = u.pathname.match(/^\/v4\/spreadsheets\/([^/:]+):batchUpdate$/);
    if (batch && method === 'POST') {
      const file = files.get(decodeURIComponent(batch[1]));
      let nextId = 10;
      const replies = [];
      for (const request of body.requests || []) {
        if (request.updateSheetProperties?.properties?.title) {
          const sheet = file.sheets.find((item) => item.properties.sheetId === request.updateSheetProperties.properties.sheetId);
          const previous = sheet.properties.title;
          sheet.properties.title = request.updateSheetProperties.properties.title;
          file.grids[sheet.properties.title] = file.grids[previous] || [];
          replies.push({});
        } else if (request.addSheet) {
          const title = request.addSheet.properties.title;
          const sheetId = nextId;
          nextId += 1;
          file.sheets.push({ properties: { sheetId, title } });
          file.grids[title] = [];
          replies.push({ addSheet: { properties: { sheetId, title } } });
        } else {
          replies.push({});
        }
      }
      return json(200, { replies });
    }

    const valuesBatch = u.pathname.match(/^\/v4\/spreadsheets\/([^/]+)\/values:batchUpdate$/);
    if (valuesBatch && method === 'POST') {
      const file = files.get(decodeURIComponent(valuesBatch[1]));
      for (const item of body.data || []) {
        const sheet = item.range.split('!')[0];
        if (!file.grids[sheet]) file.grids[sheet] = [];
        writeRange(file.grids[sheet], item.range, item.values);
      }
      return json(200, { totalUpdatedSheets: body.data.length });
    }

    const values = u.pathname.match(/^\/v4\/spreadsheets\/([^/]+)\/values\/(.+)$/);
    if (values && method === 'PUT') {
      if (failPuts > 0) {
        failPuts -= 1;
        return json(500, { error: { message: 'write failed' } });
      }
      if (auth === 'Bearer put-expired') return json(401, { error: { message: 'invalid_token' } });
      const file = files.get(decodeURIComponent(values[1]));
      const range = decodeURIComponent(values[2]);
      const sheet = range.split('!')[0];
      if (!file.grids[sheet]) file.grids[sheet] = [];
      writeRange(file.grids[sheet], range, body.values);
      return json(200, { updatedRange: range });
    }
    if (values && method === 'GET') {
      const file = files.get(decodeURIComponent(values[1]));
      const range = decodeURIComponent(values[2]);
      const sheet = range.split('!')[0];
      return json(200, { values: readRange(file.grids[sheet] || [], range) });
    }

    return json(404, { error: { message: `unhandled ${method} ${u.pathname}` } });
  }

  return {
    fetchImpl,
    calls,
    files,
    sheetState,
    failNextPuts(count) { failPuts = count; },
    setUnauthorized(value) { unauthorized = value; },
    setListStatus(status) { listStatus = status; }
  };
}
