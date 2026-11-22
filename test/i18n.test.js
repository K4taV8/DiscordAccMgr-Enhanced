// Verrou i18n : les chaînes françaises restent la source, l'anglais est produit
// par le dictionnaire sans toucher aux composants ni aux tests existants.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  LANGUAGES,
  getLanguage,
  normalizeLanguage,
  setLanguage,
  translateToEnglish,
  translateText,
} from '../src/i18n/index.js';

test('les deux langues sont déclarées et normalisées', () => {
  assert.deepEqual(LANGUAGES.map((l) => l.id), ['fr', 'en']);
  assert.equal(normalizeLanguage('en'), 'en');
  assert.equal(normalizeLanguage('fr'), 'fr');
  assert.equal(normalizeLanguage('pirate'), 'fr');
});

test('les libellés principaux sont traduits', () => {
  assert.equal(translateToEnglish('Se connecter'), 'Sign in');
  assert.equal(translateToEnglish('Bon retour'), 'Welcome back');
  assert.equal(translateToEnglish('Supprimer les messages'), 'Delete messages');
  assert.equal(translateToEnglish('Nettoyage des MP'), 'Cleaning DMs');
  assert.equal(translateToEnglish('Arrêter'), 'Stop');
  assert.equal(translateToEnglish('OLED Lavande'), 'OLED Lavender');
  assert.equal(translateToEnglish('Dépôt original'), 'Original repository');
});

test('les chaînes dynamiques fréquentes sont traduites', () => {
  assert.equal(translateToEnglish('Connecté en tant que kata_v8.03'), 'Signed in as kata_v8.03');
  assert.equal(translateToEnglish('3 message(s) non supprimé(s)'), '3 message(s) not deleted');
  assert.equal(translateToEnglish('2 opération(s) en échec lors du nettoyage'), '2 operation(s) failed during cleaning');
  assert.equal(translateToEnglish('4 MP traité(s) — 1 étape(s) en échec'), '4 DM(s) processed — 1 step(s) failed');
  assert.equal(translateToEnglish('Arrêté — 2 étape(s) traitée(s)'), 'Stopped — 2 step(s) processed');
  assert.equal(translateToEnglish('Retirées 6 / 6'), 'Removed 6 / 6');
});

test('une chaîne inconnue reste intacte et les espaces sont conservés', () => {
  assert.equal(translateToEnglish('kata_v8.03'), 'kata_v8.03');
  assert.equal(translateToEnglish('  Se connecter  '), '  Sign in  ');
});

test('la langue active bascule sans DOM et revient au français', () => {
  assert.equal(getLanguage(), 'fr');
  assert.equal(setLanguage('en'), 'en');
  assert.equal(translateText('Se connecter'), 'Sign in');
  assert.equal(setLanguage('fr'), 'fr');
  assert.equal(translateText('Se connecter'), 'Se connecter');
});

test('les points d’entrée de langue existent dans la page', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/styles/app.css', import.meta.url), 'utf8');
  assert.match(html, /id="languageBtnLogin"/);
  assert.match(html, /id="languageBtnRail"/);
  assert.match(html, /icon-translate/);
  assert.match(css, /bx-translate\.svg/);
});
