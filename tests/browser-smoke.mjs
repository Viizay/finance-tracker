import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const artifacts = '/opt/cursor/artifacts';
fs.mkdirSync(artifacts, { recursive: true });

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const prefix = '/finance-tracker';
  if (!url.pathname.startsWith(prefix)) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  let rel = decodeURIComponent(url.pathname.slice(prefix.length));
  if (rel === '' || rel.endsWith('/')) rel += '/index.html';
  if (rel.startsWith('/')) rel = rel.slice(1);
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root)) {
    res.writeHead(403);
    res.end();
    return;
  }
  fs.readFile(file, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end('missing');
      return;
    }
    const types = {
      '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
      '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.json': 'application/json'
    };
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}/finance-tracker/`;
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome-stable',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage']
});

const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('dialog', (dialog) => dialog.accept());
await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

async function shot(name) {
  await page.screenshot({ path: path.join(artifacts, name), fullPage: false });
}

try {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#dash-empty:not([hidden])');
  const emptyText = await page.$eval('#dash-empty', (el) => el.innerText);
  if (!emptyText.includes('Load demo data')) throw new Error('empty state missing demo label');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 1) throw new Error(`horizontal overflow ${overflow}`);
  await shot('empty-390x844.png');

  await page.click('[data-nav="add"]');
  await page.click('#open-entry-modal');
  await page.waitForSelector('#entry-modal:not([hidden])');
  await page.$eval('#entry-amount', (el) => { el.value = '4.50'; });
  await page.$eval('#entry-note', (el) => { el.value = 'Coffee'; });
  await page.waitForFunction(() => {
    const el = document.querySelector('#entry-form button[type="submit"]');
    const rect = el.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= window.innerHeight;
  });
  await page.click('#entry-form button[type="submit"]');
  await page.waitForFunction(() => document.body.innerText.includes('Coffee'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.innerText.includes('Coffee'));
  await shot('transaction-persisted.png');

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('finance-tracker:v1:guest')).transactions.filter((row) => !row.deleted).length);
  if (stored !== 1) throw new Error(`expected 1 stored transaction, got ${stored}`);

  await page.click('.tab[data-nav="add"]');
  await page.click('#open-entry-modal');
  await page.waitForSelector('#entry-modal:not([hidden])');
  await page.$eval('#entry-amount', (el) => { el.value = '1800'; });
  await page.$eval('#entry-date', (el) => { el.value = '2026-09-15'; });
  await page.$eval('#entry-note', (el) => { el.value = 'Rent'; });
  await page.waitForFunction(() => {
    const el = document.querySelector('#entry-recurring');
    const rect = el.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= window.innerHeight && rect.width > 0;
  });
  await page.click('#entry-recurring');
  await page.click('#entry-form button[type="submit"]');
  await page.waitForFunction(() => (document.body.innerText.match(/Rent/g) || []).length >= 3);
  const rentMonths = await page.evaluate(() => {
    const data = JSON.parse(localStorage.getItem('finance-tracker:v1:guest'));
    return data.transactions.filter((row) => row.note === 'Rent' && !row.deleted).length;
  });
  if (rentMonths !== 1) throw new Error(`recurring template stored ${rentMonths} times`);

  const backup = {
    version: 1,
    transactions: [{
      id: 'importkey1', type: 'expense', amount: 9, category: 'Food',
      date: '2026-11-01', note: '<img src=x onerror="window.__xss=1">'
    }],
    budgets: [{ id: 'budgetkey1', category: 'Food', limit: 200 }],
    goals: [{ id: 'goalkey001', name: 'Trip', target: 500, current: 20, targetDate: '2026-12-01', monthlyContribution: 40 }],
    savingsBalance: 250
  };
  const importPath = '/tmp/finance-import.json';
  fs.writeFileSync(importPath, JSON.stringify(backup));
  await page.click('#settings-btn');
  await page.waitForFunction(() => document.getElementById('toast').hidden);
  const unconfigured = await page.$eval('#google-unconfigured', (el) => el.innerText);
  if (!unconfigured.toLowerCase().includes('not configured')) throw new Error('Google UI should say it is not configured');
  await shot('settings-unconfigured.png');
  const input = await page.$('#import-file');
  await input.uploadFile(importPath);
  await page.waitForFunction(() => {
    const raw = localStorage.getItem('finance-tracker:v1:guest');
    return raw && raw.includes('importkey1') && !raw.includes('"note":"Coffee"');
  });
  const xss = await page.evaluate(() => ({
    flag: window.__xss || 0,
    images: document.querySelectorAll('img').length,
    html: document.getElementById('recent-list')?.innerHTML || ''
  }));
  if (xss.flag || xss.images || /<img/i.test(xss.html)) throw new Error(`XSS import rendered markup ${JSON.stringify(xss)}`);

  await page.click('#settings-btn');
  await page.click('#settings-demo-btn');
  await page.waitForSelector('#demo-banner:not([hidden])');
  await page.waitForFunction(() => document.getElementById('toast').hidden);
  const banner = await page.$eval('#demo-banner', (el) => el.innerText);
  if (!banner.includes('Demo data')) throw new Error('demo banner missing');
  const income = await page.$eval('#stat-income', (el) => el.textContent);
  if (!income.includes('5,200') && !income.includes('5200')) throw new Error(`demo income unexpected: ${income}`);
  await shot('demo-dashboard.png');
  await page.click('.tab[data-nav="budgets"]');
  await page.waitForSelector('.budget-item');
  await shot('budgets.png');
  await page.click('.tab[data-nav="plan"]');
  await page.waitForSelector('#proj-nominal');
  await shot('plan.png');

  await page.goto(`${base}privacy.html`, { waitUntil: 'domcontentloaded' });
  const privacy = await page.$eval('h1', (el) => el.textContent);
  if (privacy !== 'Privacy policy') throw new Error('privacy page missing');
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(async () => {
    const ready = await navigator.serviceWorker.ready;
    return !!ready;
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => navigator.serviceWorker.controller);
  const cached = await page.evaluate(async () => {
    const keys = await caches.keys();
    const cache = await caches.open(keys[0]);
    const urls = (await cache.keys()).map((request) => request.url);
    return { keys, urls };
  });
  if (!cached.urls.every((url) => url.includes('/finance-tracker/'))) {
    throw new Error(`cache URL escaped the project path ${cached.urls.join('\n')}`);
  }
  if (!cached.urls.some((url) => url.endsWith('/app.js'))) throw new Error('app.js not cached');

  await page.setOfflineMode(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#demo-banner');
  const offlineBanner = await page.$eval('#demo-banner', (el) => el.innerText);
  if (!offlineBanner.includes('Demo data')) throw new Error('offline reload lost the app');
  await shot('offline-reload.png');
  await page.setOfflineMode(false);

  if (errors.length) throw new Error(errors.join('\n'));
  console.log(JSON.stringify({ ok: true, port, cached: cached.urls.length }, null, 2));
} finally {
  await browser.close();
  server.close();
}
