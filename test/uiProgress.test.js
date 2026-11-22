// Verrou UI — la progression des MP doit être un panneau flottant, non
// bloquant, dans le même esprit que le panneau des tâches serveur.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const APP = readFileSync(new URL('../src/styles/app.css', import.meta.url), 'utf8');

test('la progression DM est flottante, en bas à droite et non bloquante', () => {
  const regle = /\.modal-overlay\.progress-overlay\s*\{([^}]*)\}/.exec(APP);
  assert.ok(regle, 'règle .modal-overlay.progress-overlay présente');
  assert.match(regle[1], /inset:\s*auto\s+16px\s+16px\s+auto/, 'ancrée en bas à droite');
  assert.match(regle[1], /width:\s*340px/, 'même largeur que le panneau serveur');
  assert.match(regle[1], /pointer-events:\s*none/, 'le fond ne bloque pas le reste de l’app');
  assert.match(regle[1], /background:\s*transparent/, 'pas de voile plein écran');
});

test('les deux parcours DM utilisent le panneau flottant', () => {
  for (const rel of ['src/utils/messageDeleter.js', 'src/utils/reactionRemover.js']) {
    const src = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
    assert.ok(src.includes('modal-overlay progress-overlay'), `${rel} utilise progress-overlay`);
  }
});

test('les libellés de boutons héritent de la couleur du bouton', () => {
  const css = readFileSync(new URL('../src/styles/theme.css', import.meta.url), 'utf8');
  const regle = /\.btn span\s*\{([^}]*)\}/.exec(css);
  assert.ok(regle, 'règle .btn span présente');
  assert.match(regle[1], /color:\s*inherit/, 'pas de couleur globale imposée aux spans de bouton');
});
