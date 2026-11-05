import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

test('pages assets are relative and the service worker lists them', () => {
  const files = ['index.html', 'privacy.html', 'app.js', 'sw.js', 'manifest.webmanifest', 'styles.css', 'config.js'];
  for (const file of ['index.html', 'sw.js', 'manifest.webmanifest', 'app.js', 'styles.css']) {
    const text = read(file).replace(/https?:\/\/[^\s"'`)]+/g, '');
    assert.equal(/(?:href|src|action|poster)\s*=\s*["']\/(?!\/)/.test(text), false, `${file} has a root-absolute URL`);
    assert.equal(/[^.]\/finance-tracker/.test(text), false, `${file} hardcodes the project path`);
  }
  const sw = read('sw.js');
  const assets = [...sw.matchAll(/'\.\/([^']*)'/g)].map((match) => match[1]).filter(Boolean);
  for (const asset of assets) {
    assert.equal(fs.existsSync(path.join(root, asset)), true, `missing ${asset}`);
  }
  const html = read('index.html');
  for (const src of ['config.js', 'vendor/chart.umd.min.js', 'app.js', 'styles.css', 'manifest.webmanifest']) {
    assert.equal(html.includes(src), true);
    assert.equal(sw.includes(`./${src}`) || src === 'styles.css' && sw.includes('./styles.css'), true);
  }
  assert.equal(files.every((file) => fs.existsSync(path.join(root, file)) || file === 'privacy.html'), true);
});

test('app source does not embed an owner spreadsheet id or a client secret', () => {
  const skip = new Set(['tests']);
  const banned = ['1mUpm8mEL0w3ovq-t0d1CP38srs-YsOCI53VVHaVg7cg', 'GOCSPX-', 'client_secret'];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name) || entry.name === 'vendor' || entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|html|md|css|yml|json|webmanifest)$/.test(entry.name)) {
        const text = fs.readFileSync(full, 'utf8');
        for (const word of banned) {
          assert.equal(text.includes(word), false, `${full} contains ${word}`);
        }
      }
    }
  }
  walk(root);
});
