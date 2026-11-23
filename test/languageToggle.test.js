// Verrou UI — le choix de langue n'ouvre plus de menu : un clic bascule FR ↔ EN.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toggleLanguage } from '../src/components/LanguageSelector.js';
import { getLanguage, setLanguage } from '../src/i18n/index.js';

const SOURCE = readFileSync(new URL('../src/components/LanguageSelector.js', import.meta.url), 'utf8');
const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../src/styles/app.css', import.meta.url), 'utf8');

test('un clic bascule directement du français vers l’anglais et inversement', () => {
  setLanguage('fr');
  assert.equal(toggleLanguage(), 'en');
  assert.equal(getLanguage(), 'en');
  assert.equal(toggleLanguage(), 'fr');
  assert.equal(getLanguage(), 'fr');
});

test('le sélecteur ne contient plus de popover ni de menu', () => {
  assert.doesNotMatch(SOURCE, /openLanguageSelector|closeLanguageSelector/, 'plus de fonctions de popover');
  assert.doesNotMatch(SOURCE, /theme-popover|language-switch|language-segment/, 'plus de markup de menu');
  assert.doesNotMatch(SOURCE, /aria-expanded|aria-haspopup/, 'plus d’attributs de menu');
  assert.doesNotMatch(HTML, /id="languageBtnLogin"[^>]*aria-haspopup/, 'pastille sans menu');
  assert.doesNotMatch(HTML, /id="languageBtnRail"[^>]*aria-haspopup/, 'rail sans menu');
  assert.doesNotMatch(CSS, /\.language-popover|\.language-switch|\.language-segment/, 'plus de styles de popover');
});

test('les deux boutons appellent directement le basculement', () => {
  const clics = SOURCE.match(/addEventListener\('click', toggleLanguage\)/g) || [];
  assert.equal(clics.length, 1, 'un gestionnaire commun');
  assert.match(SOURCE, /for \(const id of \['languageBtnLogin', 'languageBtnRail'\]\)/, 'les deux boutons sont branchés');
  assert.match(SOURCE, /window\.addEventListener\('languagechange', syncLanguageButtons\)/, 'les libellés se resynchronisent');
});
