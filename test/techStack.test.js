// Verrou anti-régression — la stack technique de la modale Info ne doit plus
// être une pile de badges : chaque technologie est une ligne avec une icône.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TECH_ITEMS, techStackHtml } from '../src/utils/techStack.js';

test('la stack technique est une grille de lignes avec icônes', () => {
  const html = techStackHtml();
  assert.equal(TECH_ITEMS.length, 11, 'onze technologies');
  assert.match(html, /info-tech-grid/);
  assert.ok((html.match(/<svg/g) || []).length >= TECH_ITEMS.length, 'une icône par technologie');
  assert.ok((html.match(/info-tech-copy/g) || []).length >= TECH_ITEMS.length, 'nom + rôle');
  assert.doesNotMatch(html, /info-tags/, 'plus de badges empilés');
  assert.match(html, /Electron/);
  assert.match(html, /discord\.js-selfbot-v13/);
  assert.match(html, /node:test/);
});
