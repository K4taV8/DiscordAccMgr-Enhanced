// Tests des correctifs d'audit (agent A). Le service mediaMirror est teste
// fonctionnellement ; les correctifs qui vivent dans main.cjs (non chargeable
// sous Node nu : `require('electron')` echoue des le chargement) sont verrouilles
// par lecture du source, comme le fait deja `mediaMirror.test.js` pour servirMedia.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  parseByteRange,
  downloadMirror,
  readManifest,
} = require('../electron/mediaMirror.service.cjs');

const mainSrc = () => fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');

const racineTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));

// ---------------------------------------------------------------------------
// BUG-001 : persistance scopee par compte
// ---------------------------------------------------------------------------
test('BUG-001 : watermark, ledger et checkpoints sont scopes par l uid du compte', () => {
  const src = mainSrc();
  assert.ok(src.includes('watermark-${currentUid()}-${serverId}.json'), 'watermark prefixe uid');
  assert.ok(src.includes('cleaned_reactions.${currentUid()}.json'), 'ledger prefixe uid');
  assert.ok(src.includes('${op}-${currentUid()}-${serverId}.json'), 'checkpoint prefixe uid');
  assert.ok(src.includes('const cle = `${currentUid()}:${serverId}`'), 'cle channelsCache scope uid');
  assert.ok(src.includes('channelsCache.get(cle)'));
  assert.ok(src.includes('channelsCache.set(cle,'));
});

test('BUG-001 : currentUid retombe sur unknown hors connexion', () => {
  const src = mainSrc();
  assert.ok(src.includes('const currentUid = () => {'));
  assert.ok(src.includes("return id ? String(id) : 'unknown';"));
});

// ---------------------------------------------------------------------------
// BUG-008 : echec de connexion
// ---------------------------------------------------------------------------
test('BUG-008 : login borne par un timeout et candidat detruit en echec', () => {
  const src = mainSrc();
  assert.ok(src.includes('LOGIN_TIMEOUT_MS = 30000'), 'timeout de login');
  assert.ok(src.includes('await loginWithTimeout(suivant, token, LOGIN_TIMEOUT_MS)'), 'timeout délégué au module testé');
  assert.ok(src.includes('const ancien = discordClient;'), 'ancien client remplace APRES succes');
  assert.ok(src.includes('if (suivant) { try { const p = suivant.destroy();'), 'candidat detruit en echec');
});

// ---------------------------------------------------------------------------
// BUG-011 : verrou du miroir
// ---------------------------------------------------------------------------
test('BUG-011 : un seul lot de miroir a la fois', () => {
  const src = mainSrc();
  assert.ok(src.includes('let mirrorRunning = false;'));
  assert.ok(src.includes("if (mirrorRunning) return { ok: false, error: 'Téléchargement déjà en cours' };"));
  assert.match(src, /finally \{\r?\n\s*mirrorRunning = false;/);
});

// ---------------------------------------------------------------------------
// BUG-012 : taille optionnelle + progression
// ---------------------------------------------------------------------------
test('BUG-012 : sans content-length, un fichier non vide n est plus marque en erreur', async () => {
  const rootDir = racineTmp();
  try {
    const items = [{ url: 'p.png', fileName: 'p.png', kind: 'image', channelId: 'c' }];
    const transport = { head: async () => 0, get: async () => Buffer.from('abc') };
    const res = await downloadMirror({ rootDir, key: 'k', items, transport });
    assert.equal(res.done, 1);
    assert.equal(res.failed, 0);
    assert.equal(readManifest(path.join(rootDir, 'k'))['p.png'].state, 'done');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('BUG-012 : la progression compte les fichiers echoues (done+failed)', async () => {
  const rootDir = racineTmp();
  try {
    const items = [
      { url: 'a.png', fileName: 'a.png', kind: 'image', channelId: 'c' },
      { url: 'b.png', fileName: 'b.png', kind: 'image', channelId: 'c' },
    ];
    const transport = {
      head: async () => 3,
      get: async url => { if (url === 'b.png') throw new Error('boom'); return Buffer.from('abc'); },
    };
    const vus = [];
    const res = await downloadMirror({ rootDir, key: 'k', items, transport, onProgress: p => vus.push(p), concurrency: 1 });
    const dernier = vus[vus.length - 1];
    assert.equal(dernier.done, 2, 'progression = done + failed');
    assert.equal(dernier.failed, 1);
    assert.equal(res.done, 1, 'le resume final garde done = succes seuls');
    assert.equal(res.failed, 1);
    assert.equal(res.cancelled, false);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// BUG-013 : Range
// ---------------------------------------------------------------------------
test('BUG-013 : parseByteRange lit les formes valides', () => {
  assert.deepEqual(parseByteRange('bytes=0-49', 100), { start: 0, end: 49 });
  assert.deepEqual(parseByteRange('bytes=50-', 100), { start: 50, end: 99 });
  assert.deepEqual(parseByteRange('bytes=-20', 100), { start: 80, end: 99 });
  assert.deepEqual(parseByteRange('bytes=0-999', 100), { start: 0, end: 99 });
  assert.deepEqual(parseByteRange('bytes=0-0', 100), { start: 0, end: 0 });
});

test('BUG-013 : parseByteRange distingue absent, illisible et hors fichier', () => {
  assert.equal(parseByteRange(undefined, 100), null);
  assert.equal(parseByteRange('', 100), null);
  assert.equal(parseByteRange('items=0-1', 100), null);
  assert.equal(parseByteRange('bytes=200-300', 100), 'invalid');
  assert.equal(parseByteRange('bytes=5-4', 100), 'invalid');
  assert.equal(parseByteRange('bytes=-0', 100), 'invalid');
});

test('BUG-013 : servirMedia annonce 206 / Accept-Ranges et streame', () => {
  const src = mainSrc();
  assert.ok(src.includes('createReadStream('), 'flux disque au lieu de readFile complet');
  assert.ok(src.includes('Readable.toWeb('));
  assert.ok(src.includes("'Accept-Ranges': 'bytes'"));
  assert.ok(src.includes('status: 206'));
  assert.ok(src.includes('Content-Range'));
});

// ---------------------------------------------------------------------------
// BUG-020 : fenetre de login
// ---------------------------------------------------------------------------
test('BUG-020 : userAgent applique sur le webContents, pas via webPreferences', () => {
  const src = mainSrc();
  assert.ok(src.includes('win.webContents.setUserAgent('), 'UA pose sur le webContents');
  assert.ok(!src.includes("userAgent: 'Mozilla/5.0"), 'plus de webPreferences.userAgent (ignore par Electron)');
});

test('BUG-020 : la fenetre de login garde aussi will-redirect', () => {
  const src = mainSrc();
  assert.ok(src.includes("win.webContents.on('will-redirect', (event, url) => { if (!estNavigationDiscord(url)) event.preventDefault(); });"));
});

// ---------------------------------------------------------------------------
// BUG-022 : ledger
// ---------------------------------------------------------------------------
test('BUG-022 : le ledger purge a l ecriture et serialise ses ecritures', () => {
  const src = mainSrc();
  assert.ok(src.includes('const withLedgerLock = (fn) => {'), 'mutex ledger');
  assert.ok(src.includes('now - ts < LEDGER_TTL'), 'purge TTL a l ecriture');
  assert.ok(src.includes('withLedgerLock(async () => {'), 'ledgerAdd serialise');
});
