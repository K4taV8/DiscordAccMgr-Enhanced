import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelWindow, CHANNEL_ROW_HEIGHT, CHANNEL_OVERSCAN } from '../src/services/packageWindow.service.js';

// Le menu de gauche de la page Data Package rendait 667 salons d'un coup
// (667 noeuds + 667 images), et mon chargement progressif aggravait le cas car
// chaque lot déclenchait un rendu complet. On ne rend que la fenetre visible.

test('la fenetre couvre la zone visible', () => {
  const total = 667;
  const viewport = 836;
  const w = channelWindow({ total, scrollTop: 0, viewport, rowHeight: CHANNEL_ROW_HEIGHT, overscan: CHANNEL_OVERSCAN });
  assert.equal(w.start, 0);
  assert.ok(w.end > 15, 'au moins la hauteur visible');
});

test('defiler loin rend la bonne tranche', () => {
  // 1000e salon => scrollTop ~ 1000 * 56
  const w = channelWindow({ total: 667, scrollTop: 56 * 300, viewport: 836, rowHeight: 56, overscan: CHANNEL_OVERSCAN });
  assert.ok(w.start <= 300, 'la ligne 300 est incluse');
  assert.ok(w.start > 300 - 56, 'et pas bien au-dessus');
  assert.ok(w.end > 300, 'la fenetre va au-dela de la ligne 300');
});

test('la fenetre reste dans les bornes', () => {
  const bas = channelWindow({ total: 667, scrollTop: 999999, viewport: 836, rowHeight: 56, overscan: CHANNEL_OVERSCAN });
  assert.equal(bas.end, 667);
  assert.ok(bas.start <= 667);
  assert.ok(bas.start >= 0);
});

test('une liste vide ne produit pas de fenetre invalide', () => {
  const w = channelWindow({ total: 0, scrollTop: 0, viewport: 800, rowHeight: 56, overscan: CHANNEL_OVERSCAN });
  assert.equal(w.start, 0);
  assert.equal(w.end, 0);
  assert.equal(w.padTop, 0);
  assert.equal(w.padBottom, 0);
});

test('les tampons de defilement correspondent aux lignes hors fenetre', () => {
  const w = channelWindow({ total: 667, scrollTop: 56 * 100, viewport: 560, rowHeight: 56, overscan: 8 });
  assert.equal(w.padTop, w.start * 56);
  assert.equal(w.padBottom, (667 - w.end) * 56);
});

test('une hauteur de ligne nulle ne provoque pas de division par zero', () => {
  const w = channelWindow({ total: 10, scrollTop: 100, viewport: 300, rowHeight: 0, overscan: CHANNEL_OVERSCAN });
  assert.ok(Number.isFinite(w.start));
  assert.ok(Number.isFinite(w.end));
});