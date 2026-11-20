import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

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

// Bug : la fenetre de login etait une fenetre ENFANT (`parent`) et
// `alwaysOnTop`. Sous Windows, fermer une telle fenetre peut minimiser la
// fenetre principale ; l'utilisateur croit alors a un crash. On verrouille
// l'absence de ce couplage et la restauration explicite apres le login.
test('fenetre login : pas de fenetre enfant, restauration explicite de la fenetre principale', () => {
  const src = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  const debut = src.indexOf('function ouvrirLoginDiscord');
  const fin = src.indexOf("ipcMain.handle('discord:loginNative'");
  assert.ok(debut !== -1 && fin > debut, 'bloc ouvrirLoginDiscord localisable');
  const bloc = src.slice(debut, fin);
  assert.ok(!bloc.includes('parent: mainWindow'),
    'la fenetre de login ne doit plus etre une fenetre enfant (quirk Windows de minimisation)');
  assert.ok(!bloc.includes('alwaysOnTop: true'),
    'pas de alwaysOnTop sur la fenetre de login (quirk Windows des fenetres enfants)');
  assert.ok(bloc.includes('reveillerFenetrePrincipale()'),
    'la fenetre principale est restauree/focalisee apres la fermeture du login');
  assert.ok(bloc.includes("preload: path.join(__dirname, 'preload-discord-login.cjs')"),
    'le preload anti-passkey est branche sur la fenetre de login');

  const prechauffeDebut = src.indexOf('function prechaufferLogin');
  assert.ok(prechauffeDebut !== -1, 'bloc prechaufferLogin localisable');
  const prechauffeBloc = src.slice(prechauffeDebut, prechauffeDebut + 2500);
  assert.ok(prechauffeBloc.includes("preload: path.join(__dirname, 'preload-discord-login.cjs')"),
    'le pre-chauffage charge aussi le preload (sinon Windows Hello s ouvre au demarrage)');
});

// Bug : Electron annonce le support de la "conditional mediation" WebAuthn
// (passkeys dans l'autofill) mais ouvre en realite la fenetre Windows Hello au
// chargement de Discord. Le preload neutralise cette capacite AVANT les scripts
// de la page ; les passkeys explicites restent disponibles.
test('preload login : neutralise la conditional mediation WebAuthn', async () => {
  const { SCRIPT_NEUTRALISER_PASSKEYS } = require('../electron/preload-discord-login.cjs');
  assert.equal(typeof SCRIPT_NEUTRALISER_PASSKEYS, 'string');

  class FauxPublicKeyCredential {
    static async getClientCapabilities() {
      return { conditionalGet: true, hybridTransport: true, userVerifyingPlatformAuthenticator: true };
    }
  }
  const sandbox = { window: { PublicKeyCredential: FauxPublicKeyCredential }, Promise, Object };
  vm.runInNewContext(SCRIPT_NEUTRALISER_PASSKEYS, sandbox);

  assert.equal(await sandbox.window.PublicKeyCredential.isConditionalMediationAvailable(), false,
    'isConditionalMediationAvailable doit repondre false (sinon Windows Hello s ouvre tout seul)');
  const caps = await sandbox.window.PublicKeyCredential.getClientCapabilities();
  assert.equal(caps.conditionalGet, false, 'conditionalGet doit etre desactive');
  assert.equal(caps.hybridTransport, true, 'les autres capacites WebAuthn restent intactes');
});

test('preload login : ne jette pas si l API WebAuthn est absente', () => {
  const { SCRIPT_NEUTRALISER_PASSKEYS } = require('../electron/preload-discord-login.cjs');
  const sandbox = { window: {}, Promise, Object };
  assert.doesNotThrow(() => vm.runInNewContext(SCRIPT_NEUTRALISER_PASSKEYS, sandbox));
});
