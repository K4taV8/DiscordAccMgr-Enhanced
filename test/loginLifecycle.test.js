// Verrou anti-régression — point POSSIBLE 3 : au timeout de login, le client
// candidat est détruit ; si `login()` aboutit PLUS TARD, la session tardive doit
// être détruite elle aussi, sinon une connexion gateway orpheline subsiste.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loginWithTimeout } = require('../electron/loginLifecycle.cjs');

test('POSSIBLE 3 : un login rapide rend la main sans détruire le client', async () => {
  let destroys = 0;
  await loginWithTimeout({ login: async () => {}, destroy: () => { destroys += 1; } }, 'token', 100);
  assert.equal(destroys, 0);
});

test('POSSIBLE 3 : un dépassement rejette avec le message attendu', async () => {
  let destroys = 0;
  const client = { login: () => new Promise(() => {}), destroy: () => { destroys += 1; } };
  await assert.rejects(
    () => loginWithTimeout(client, 'token', 5),
    /Délai de connexion dépassé \(30 s\)/,
  );
  assert.equal(destroys, 0, 'le nettoyage immédiat reste à connectDiscord');
});

test('POSSIBLE 3 : un login qui aboutit après le timeout est détruit', async () => {
  let resoudre;
  let destroys = 0;
  const client = {
    login: () => new Promise((resolve) => { resoudre = resolve; }),
    destroy: () => { destroys += 1; },
  };
  await assert.rejects(() => loginWithTimeout(client, 'token', 5), /Délai/);
  resoudre('ok');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(destroys, 1, 'session tardive nettoyée');
});

test('POSSIBLE 3 : une erreur de login est propagée', async () => {
  await assert.rejects(
    () => loginWithTimeout({ login: () => { throw new Error('identifiants refusés'); }, destroy() {} }, 'token', 50),
    /identifiants refusés/,
  );
});
