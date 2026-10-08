import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Le service vit dans le main process (CommonJS) : ce test ESM le charge via
// createRequire, comme le fait deja test/packageIndex.test.js pour les .cjs.
const require = createRequire(import.meta.url);
const { extraireToken, estUrlAuth, MOTIF_TOKEN } = require('../electron/discordLogin.service.cjs');

test('extraireToken lit le token d un corps JSON', () => {
  assert.equal(extraireToken('{"token":"abc.def.ghi"}'), 'abc.def.ghi');
});

test('extraireToken retombe sur la regex quand le corps n est pas du JSON pur', () => {
  assert.equal(extraireToken('préfixe "token":"x.y.z" suffixe'), 'x.y.z');
});

test('extraireToken refuse un token vide', () => {
  assert.equal(extraireToken('{"token":""}'), null);
});

test('extraireToken ne jette jamais sur une entree hostile', () => {
  assert.equal(extraireToken('<html></html>'), null);
  assert.equal(extraireToken(''), null);
  assert.equal(extraireToken(null), null);
  assert.equal(extraireToken('{"autre":1}'), null);
});

test('estUrlAuth reconnait les URL d authentification', () => {
  assert.ok(estUrlAuth('https://discord.com/api/v9/auth/mfa/totp'));
  assert.ok(estUrlAuth('https://discord.com/api/v9/auth/login'));
  assert.ok(estUrlAuth('https://discord.com/api/v9/remote-auth/...'));
  assert.ok(!estUrlAuth('https://discord.com/api/v9/channels/@me'));
});

test('MOTIF_TOKEN reconnait un user token a trois segments', () => {
  // Premier segment de 24 caracteres, comme un identifiant encode en base64 :
  // c'est la forme que le repli par scan du stockage doit accepter.
  assert.ok(MOTIF_TOKEN.test('NzQ3NzgxMTU1NjMzNDk2MTI3.aBcD12A.XyZabcdefghijklmnopqrstuv'));
});
