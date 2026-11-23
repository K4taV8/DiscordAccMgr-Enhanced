// Verrou UI — la modale Info doit décrire l'outil et créditer l'auteur original.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { translateToEnglish } from '../src/i18n/index.js';

const UI = readFileSync(new URL('../src/utils/ui.js', import.meta.url), 'utf8');
const APP = readFileSync(new URL('../src/styles/app.css', import.meta.url), 'utf8');
const MAIN = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');

const DESCRIPTION = 'Application de bureau pour gérer son propre compte Discord : nettoyage, serveurs, MP, groupes, archives et médias. Basé sur Discord Account Manager, créé par Bherl1.';

test('la modale Info contient une description courte et crédite Bherl1', () => {
  assert.match(UI, /class="info-description"/, 'bloc de description présent');
  assert.ok(UI.includes(DESCRIPTION), 'description courte présente');
  assert.ok(UI.includes('Bherl1'), 'crédit auteur original présent');
  assert.ok(UI.includes('Discord Account Manager - Enhanced'), 'nom complet de l’application');
});

test('la modale Info expose le dépôt du fork et le dépôt original', () => {
  assert.match(UI, /const FORK_REPO_URL = 'https:\/\/github\.com\/K4taV8\/DiscordAccMgr-Enhanced'/, 'URL du fork renseignée');
  assert.match(UI, /const ORIGINAL_REPO_URL = 'https:\/\/github\.com\/Bherl1\/DiscordAccMgr'/, 'URL originale conservée');
  assert.match(UI, /repoLink\(FORK_REPO_URL, 'Dépôt \(fork\)'\)/, 'lien fork dans les liens');
  assert.match(UI, /authorCard\('KataV8'[^\n]+FORK_REPO_URL\)/, 'carte KataV8 liée au fork');
});

test('les liens de dépôt sont des boutons explicites, pas du texte plat', () => {
  assert.match(UI, /const repoLink =/, 'générateur de lien commun');
  assert.match(UI, /class="info-link-icon"/, 'icône de lien externe');
  assert.match(UI, /repoLink\(ORIGINAL_REPO_URL/, 'lien original généré comme bouton');
  const bloc = [...APP.matchAll(/\.info-links a\s*\{([^}]*)\}/g)]
    .map((m) => m[1])
    .find((body) => /border:/.test(body));
  assert.ok(bloc, 'règle .info-links a avec bordure');
  assert.match(bloc, /display:\s*inline-flex/, 'bouton aligné');
  assert.match(bloc, /border:\s*1px solid var\(--border-color\)/, 'bordure visible');
  assert.match(bloc, /background:\s*var\(--bg-body\)/, 'fond distinct du texte');
  assert.match(bloc, /height:\s*30px/, 'hauteur compacte');
});

test('le badge de version est carré, pas une pilule', () => {
  const bloc = [...APP.matchAll(/\.version-badge\s*\{([^}]*)\}/g)]
    .map((m) => m[1])
    .find((body) => /border-radius/.test(body));
  assert.ok(bloc, 'règle .version-badge avec rayon présente');
  assert.match(bloc, /border-radius:\s*4px/, 'rayon carré de 4 px');
  assert.doesNotMatch(bloc, /border-radius:\s*(?:999px|50%)/, 'plus de pilule');
});

test('l’ouverture externe autorise le fork et le dépôt original', () => {
  const ligne = MAIN.split('\n').find((line) => line.includes('EXTERNAL_URL_ALLOWLIST ='));
  assert.ok(ligne, 'allowlist présente');
  assert.match(ligne, /Bherl1\\\/DiscordAccMgr/, 'dépôt original autorisé');
  assert.match(ligne, /K4taV8\\\/DiscordAccMgr-Enhanced/, 'fork autorisé');
  assert.match(ligne, /https:/, 'HTTPS exigé');
});

test('le bouton de fermeture de la modale Info est compact et neutre', () => {
  assert.match(UI, /class="btn btn-secondary info-close-btn" id="infoCloseBtn"/);
  assert.ok(UI.includes('info-close-icon'), 'icône SVG de fermeture présente');
});

test('la description de la modale Info est traduite en anglais', () => {
  assert.equal(
    translateToEnglish(DESCRIPTION),
    'Desktop application for managing your own Discord account: cleaning, servers, DMs, groups, archives and media. Based on Discord Account Manager, created by Bherl1.',
  );
});
