import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

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

test('extraireToken lit le token dans un IDENTIFY de gateway (voie QR remote-auth)', () => {
  // Le login par QR ne passe PAS par /api/v9/auth/* : l app web renvoie le token
  // en clair dans l IDENTIFY (op 2) du gateway. C est ce que la fenetre de login
  // intercepte desormais via Network.webSocketFrameSent.
  const identifiy = JSON.stringify({
    op: 2,
    d: {
      token: 'NzQ3NzgxMTU1NjMzNDk2MTI3.aBcD12A.XyZabcdefghijklmnopqrstuv',
      capabilities: 30717,
      properties: { os: 'Windows' },
    },
  });
  assert.equal(extraireToken(identifiy), 'NzQ3NzgxMTU1NjMzNDk2MTI3.aBcD12A.XyZabcdefghijklmnopqrstuv');
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

// La fenetre de login doit utiliser un UA coherent avec le moteur Electron. Un
// UA fige trop ancien (Chrome/130 face a Chrome 150) rend la fenetre BLANCHE :
// Discord sert une page qui ne demarre pas. Le rendu n'est pas testable hors
// Electron, mais on verrouille la source pour interdire le retour d'un UA figé.
test('fenetre login : UA derive du moteur, aucune version de Chrome figee', () => {
  const src = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  assert.ok(src.includes('getUserAgent().replace(/\\sElectron\\/'),
    'l UA de la fenetre de login doit deriver de celui d Electron (retrait du jeton Electron/)');
  assert.ok(!/Chrome\/\d+\.\d+\.\d+\.\d+/.test(src),
    'aucune version de Chrome figee en dur dans main.cjs (elle se desynchronise du moteur)');
});

// Une session neuve a chaque tentative re-telecharge ~5,8 Mo a chaque ouverture
// (~50 s). La partition doit donc etre PERSISTANTE (cache HTTP sur disque) et
// seule l AUTHEntification est purgee. `clearCache` annulerait tout le benefice.
test('fenetre login : cache HTTP persistant (partition persist:) + purge auth', () => {
  const src = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  assert.ok(src.includes("'persist:dam-discord-login'"),
    'partition persistante : le cache HTTP doit survivre entre les ouvertures');
  assert.ok(!src.includes("'discord-login-' + Date.now()"),
    'plus de partition ephemere aleatoire (cache froid a chaque ouverture)');
  assert.ok(!src.includes('.clearCache('),
    'ne JAMAIS vider le cache HTTP, sinon retour au chargement lent (~50 s)');
  assert.ok(src.includes('function prechaufferLogin('),
    'pre-chauffage du cache defini (fenetre de login rapide des le demarrage)');
  assert.ok(src.includes('prechaufferLogin();'),
    'pre-chauffage declenche au demarrage de l app');
});
