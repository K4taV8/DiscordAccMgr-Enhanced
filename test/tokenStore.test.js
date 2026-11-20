import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { createTokenStore, TOKEN_SCHEMA_VERSION } = require('../electron/tokenStore.cjs');

// R05#2 : fake safeStorage déterministe — teste le flux token sans Electron.
// encryptString → 'enc:<secret>' (Buffer) ; decryptString inverse.
function fakeSafeStorage({ available = true } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from('enc:' + s, 'utf8'),
    decryptString: (b) => {
      const s = b.toString('utf8');
      if (!s.startsWith('enc:')) throw new Error('decrypt failed');
      return s.slice(4);
    },
  };
}

const dirs = [];
function freshStore(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tokenstore-'));
  dirs.push(dir);
  const tokensPath = join(dir, 'saved_tokens.json');
  writeFileSync(tokensPath, '[]', 'utf8');
  const store = createTokenStore({ safeStorage: fakeSafeStorage(), tokensPath, ...options });
  return { store, tokensPath };
}

after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test('save then list exposes metadata only — never the token', async () => {
  const { store, tokensPath } = freshStore();
  const r = await store.save('main', 'SECRET_TOKEN');
  assert.equal(r.success, true);

  const { success, tokens } = await store.list();
  assert.equal(success, true);
  assert.deepEqual(tokens, [{ name: 'main', corrupt: false }]);

  // le secret n'apparaît ni dans la réponse, ni en clair sur disque
  assert.ok(!JSON.stringify(tokens).includes('SECRET_TOKEN'));
  const raw = readFileSync(tokensPath, 'utf8');
  assert.ok(raw.includes('enc:'));
  assert.ok(!raw.includes('SECRET_TOKEN'));
});

test('save rejects duplicate name', async () => {
  const { store } = freshStore();
  assert.equal((await store.save('main', 'A')).success, true);
  const dup = await store.save('main', 'B');
  assert.equal(dup.success, false);
  assert.match(dup.error, /existe déjà/);
});

test('resolveByName round-trips the decrypted secret', async () => {
  const { store } = freshStore();
  await store.save('main', 'SECRET_TOKEN');
  const resolved = await store.resolveByName('main');
  assert.deepEqual(resolved, { token: 'SECRET_TOKEN' });
});

test('resolveByName rejects invalid/missing names', async () => {
  const { store } = freshStore();
  assert.deepEqual(await store.resolveByName(''), { error: 'Nom de token invalide' });
  assert.deepEqual(await store.resolveByName(42), { error: 'Nom de token invalide' });
  assert.deepEqual(await store.resolveByName('nope'), { error: 'Token introuvable' });
});

test('remove and removeAll delete entries', async () => {
  const { store } = freshStore();
  await store.save('a', '1');
  await store.save('b', '2');
  assert.equal((await store.remove('a')).success, true);

  let { tokens } = await store.list();
  assert.deepEqual(tokens.map(t => t.name), ['b']);

  assert.equal((await store.removeAll()).success, true);
  ({ tokens } = await store.list());
  assert.deepEqual(tokens, []);
});

test('corrupt encrypted token is flagged, not thrown away', async () => {
  const { store, tokensPath } = freshStore();
  const bad = 'enc:' + Buffer.from('not-an-enc-prefix', 'utf8').toString('base64');
  writeFileSync(tokensPath, JSON.stringify({ schemaVersion: TOKEN_SCHEMA_VERSION, tokens: [{ name: 'bad', token: bad }] }), 'utf8');

  const { success, tokens } = await store.list();
  assert.equal(success, true);
  assert.deepEqual(tokens, [{ name: 'bad', corrupt: true }]);
});

test('legacy flat array migrates and re-encrypts when encryption is available', async () => {
  const { store, tokensPath } = freshStore();
  writeFileSync(tokensPath, JSON.stringify([{ name: 'legacy', token: 'PLAINTEXT' }]), 'utf8');

  const { success, tokens } = await store.list();
  assert.equal(success, true);
  assert.deepEqual(tokens, [{ name: 'legacy', corrupt: false }]);

  const raw = JSON.parse(readFileSync(tokensPath, 'utf8'));
  assert.equal(raw.schemaVersion, TOKEN_SCHEMA_VERSION);
  assert.ok(Array.isArray(raw.tokens));
  assert.ok(raw.tokens[0].token.startsWith('enc:'));
});

test('encryption unavailable → save/list/resolveByName all harden', async () => {
  const { store, tokensPath } = freshStore({ safeStorage: fakeSafeStorage({ available: false }) });

  const r = await store.save('x', 'TOKEN');
  assert.equal(r.success, false);
  assert.match(r.error, /indisponible/);

  writeFileSync(tokensPath, JSON.stringify([{ name: 'legacy', token: 'PLAINTEXT' }]), 'utf8');
  const { tokens } = await store.list();
  assert.deepEqual(tokens, [{ name: 'legacy', corrupt: true }]);

  assert.deepEqual(await store.resolveByName('legacy'), {
    error: 'Connexion impossible : stockage sécurisé indisponible. Sous Linux, installe libsecret.',
  });
});

test('concurrent saves are serialized — no lost update (BUG-03)', async () => {
  const { store } = freshStore();
  await Promise.all(Array.from({ length: 10 }, (_, i) => store.save('t' + i, 'TOKEN' + i)));
  const { tokens } = await store.list();
  assert.equal(tokens.length, 10);
  assert.deepEqual(tokens.map(t => t.name).sort(), Array.from({ length: 10 }, (_, i) => 't' + i).sort());
});
test('resolveByName returns the stored userId for re-login reuse', async () => {
  const { store } = freshStore();
  await store.save('main', 'SECRET_TOKEN');
  await store.setUserId('main', '432112345');
  const resolved = await store.resolveByName('main');
  assert.equal(resolved.token, 'SECRET_TOKEN');
  assert.equal(resolved.userId, '432112345');
});

test('resolveByName without stored userId keeps legacy shape', async () => {
  const { store } = freshStore();
  await store.save('main', 'SECRET_TOKEN');
  const resolved = await store.resolveByName('main');
  assert.deepEqual(resolved, { token: 'SECRET_TOKEN' });
});

test('setUserId ignores unknown names and leaves other entries intact', async () => {
  const { store } = freshStore();
  await store.save('a', '1');
  await store.save('b', '2');
  const r = await store.setUserId('nope', '99');
  assert.equal(r.success, false);
  assert.equal((await store.setUserId('a', '123')).success, true);
  const ra = await store.resolveByName('a');
  assert.equal(ra.userId, '123');
  assert.equal(ra.token, '1');
  const rb = await store.resolveByName('b');
  assert.equal(rb.userId, undefined);
  assert.equal(rb.token, '2');
});