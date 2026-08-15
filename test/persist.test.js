import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ledgerKey, ledgerFilter } from '../src/utils/persist.js';

const require = createRequire(import.meta.url);
const { readJson, writeJson } = require('../electron/persist.cjs');

const tmp = () => mkdtemp(path.join(tmpdir(), 'optai-'));

test('persist write/read round-trip', async () => {
  const dir = await tmp();
  try {
    const f = path.join(dir, 'cp.json');
    await writeJson(f, { a: 1, b: [1, 2] });
    assert.deepEqual(await readJson(f), { a: 1, b: [1, 2] });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('persist readJson returns null on missing or corrupt file', async () => {
  const dir = await tmp();
  try {
    assert.equal(await readJson(path.join(dir, 'missing.json')), null);
    const f = path.join(dir, 'corrupt.json');
    await writeFile(f, '{not json');
    assert.equal(await readJson(f), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('persist write leaves no .tmp residue (atomic)', async () => {
  const dir = await tmp();
  try {
    await writeJson(path.join(dir, 'x.json'), { k: 'v' });
    assert.deepEqual(await readdir(dir), ['x.json']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('persist serializes concurrent writes to the same file (BUG-03)', async () => {
  const dir = await tmp();
  try {
    const f = path.join(dir, 'cp.json');
    await Promise.all(Array.from({ length: 20 }, (_, i) => writeJson(f, { n: i })));
    const final = await readJson(f);
    assert.ok(final && typeof final.n === 'number', 'file must be valid JSON after concurrent writes');
    assert.deepEqual(await readdir(dir), ['cp.json']); // pas de .tmp résiduel
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('ledgerKey composes channel/message/emoji', () => {
  assert.equal(ledgerKey('123', '456', 'wave:789'), '123:456:wave:789');
});

test('ledgerFilter drops expired and non-numeric entries', () => {
  const now = Date.now();
  const out = ledgerFilter({ fresh: now, stale: now - 25 * 3600 * 1000, junk: 'x' }, 24 * 3600 * 1000);
  assert.ok(out.has('fresh'));
  assert.equal(out.size, 1);
});
