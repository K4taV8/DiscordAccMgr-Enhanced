// Verrou anti-regression : crash du main process « ApplicationFlags is not a
// constructor » (bug amont de discord.js-selfbot-v13 3.4.6) + garde-fou global.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const MAIN = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');

test('correctif ApplicationFlags : le sous-module resout la classe apres patch', () => {
  const af = require('discord.js-selfbot-v13/src/util/ApplicationFlags');
  assert.equal(typeof af, 'function', 'le module de la lib exporte bien la classe');
  // Exactement ce que fait main.cjs avant de charger la lib.
  if (!af.ApplicationFlags) af.ApplicationFlags = af;
  const { ApplicationFlags } = require('discord.js-selfbot-v13/src/util/ApplicationFlags');
  assert.equal(typeof ApplicationFlags, 'function', 'le destructuring de Application.js resout la classe');
  assert.equal(new ApplicationFlags(0).bitfield, 0);
});

test('main.cjs charge discord.js via la factory testée (patch avant lib)', () => {
  assert.ok(MAIN.includes('const { Client } = loadDiscordClient();'), 'factory utilisée');
  assert.equal(MAIN.includes("require('discord.js-selfbot-v13')"), false, 'aucun chargement direct');
});

test('main.cjs installe les garde-fous testés par comportement', () => {
  assert.ok(MAIN.includes("require('./crashGuards.cjs')"), 'module de garde-fous importé');
  assert.ok(MAIN.includes('installProcessGuards({ journal: journalMain })'), 'garde-fous installés');
});

test('BUG-005 : les garde-fous écrivent dans un journal fichier borné', () => {
  assert.ok(MAIN.includes("require('./logger.cjs')"), 'module de journalisation importé');
  assert.ok(MAIN.includes('createMainLogger({'), 'journal créé avec le dossier portable');
  assert.ok(MAIN.includes('maxBytes'), 'taille bornée / rotation');
  assert.match(MAIN, /installProcessGuards\(\{ journal: journalMain \}\)/, 'le journal reçoit les deux niveaux');
});

test('BUG-004 : le miroir et l enregistrement média utilisent des flux', () => {
  assert.doesNotMatch(MAIN, /responseType: 'arraybuffer'/, 'plus de corps complet en mémoire');
  const flux = MAIN.match(/responseType: 'stream'/g) || [];
  assert.ok(flux.length >= 2, `enregistrement + miroir en flux (${flux.length})`);
});

test('BUG-006 : discordFetch ne suit aucune redirection', () => {
  const debut = MAIN.indexOf('async function discordFetch');
  const fin = MAIN.indexOf('// BUG-07', debut);
  assert.ok(debut !== -1 && fin > debut, 'discordFetch localisé');
  assert.match(MAIN.slice(debut, fin), /maxRedirects:\s*0/, 'jeton jamais transmis à un hôte de redirection');
});

test('POSSIBLE 1 : F12 vise mainWindow, pas getAllWindows()[0]', () => {
  const debut = MAIN.indexOf("ipcMain.handle('app:toggleDevTools'");
  const fin = MAIN.indexOf("ipcMain.handle('discord:getGroups'", debut);
  assert.ok(debut !== -1 && fin > debut, 'handler localisé');
  const corps = MAIN.slice(debut, fin);
  assert.match(corps, /toggleDevTools\(mainWindow\)/, 'fenêtre principale ciblée');
  assert.doesNotMatch(corps, /getAllWindows/, 'plus de sélection par ordre de création');
});

test('POSSIBLE 2 : le préchauffage login est arrêté avant toute ouverture', () => {
  const debut = MAIN.indexOf('function ouvrirLoginDiscord');
  const arret = MAIN.indexOf('arreterPrechauffageLogin();', debut);
  const fenetre = MAIN.indexOf('new BrowserWindow', debut);
  assert.ok(debut !== -1 && arret !== -1 && fenetre !== -1, 'points localisés');
  assert.ok(arret < fenetre, 'arrêt du préchauffage avant création de la fenêtre de login');
  assert.match(MAIN, /if \(loginWindowEnCours \|\| loginWindow\) return;/, 'aucun préchauffage pendant un login');
});

test('POSSIBLE 3 : connectDiscord utilise le nettoyage testé du login', () => {
  const debut = MAIN.indexOf('async function connectDiscord');
  const fin = MAIN.indexOf("ipcMain.handle('discord:connect'", debut);
  assert.ok(debut !== -1 && fin > debut, 'connectDiscord localisé');
  const corps = MAIN.slice(debut, fin);
  assert.match(corps, /loginWithTimeout\(suivant, token, LOGIN_TIMEOUT_MS\)/, 'timeout délégué');
  assert.doesNotMatch(corps, /new Promise\(\(_, rejeter\)/, 'plus de course locale non nettoyée');
});
