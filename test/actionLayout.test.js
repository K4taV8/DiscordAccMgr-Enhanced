// Verrou UI — mode de nettoyage sur une rangée, badges de statut carrés,
// bouton Fermer neutre et lisible.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTaskActionClose } from '../src/utils/serverTaskUtils.js';

const MODE = readFileSync(new URL('../src/components/CleaningModeSelector.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../src/styles/app.css', import.meta.url), 'utf8');
const DELETE = readFileSync(new URL('../src/utils/serverMessageDeleter.js', import.meta.url), 'utf8');
const REACTION = readFileSync(new URL('../src/utils/serverReactionRemover.js', import.meta.url), 'utf8');

function blocs(css) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    out.push({
      selector: m[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim(),
      body: m[2],
    });
  }
  return out;
}
const bloc = (selector) => blocs(CSS).find((b) => b.selector === selector);

test('les 4 modes de nettoyage tiennent sur une seule rangée', () => {
  assert.match(MODE, /class="theme-grid clean-mode-grid"/, 'grille dédiée');
  const pop = bloc('.clean-mode-popover');
  assert.ok(pop, 'règle .clean-mode-popover');
  assert.match(pop.body, /width:\s*480px/, 'largeur suffisante pour 4 tuiles');
  const grid = bloc('.clean-mode-grid');
  assert.ok(grid, 'règle .clean-mode-grid');
  assert.match(grid.body, /grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)/, 'quatre colonnes');
});

test('les badges Propriétaire et Terminé reprennent le petit carré des compteurs', () => {
  const bento = bloc('.bento-badge');
  assert.ok(bento, 'règle .bento-badge');
  assert.match(bento.body, /border-radius:\s*4px/, 'badge Propriétaire carré');
  assert.doesNotMatch(bento.body, /border-radius:\s*(?:var\(--radius-pill\)|999px|50%)/, 'plus de pilule');

  const phase = bloc('.task-phase');
  assert.ok(phase, 'règle .task-phase');
  assert.match(phase.body, /border-radius:\s*4px/, 'badge de phase carré');
  assert.doesNotMatch(phase.body, /border-radius:\s*var\(--radius-sharp\)/, 'plus de rayon de carte');
});

test('le bouton Fermer redevient neutre et lisible après une tâche', () => {
  const button = {
    textContent: 'Fermer',
    className: 'btn btn-danger',
    style: { background: '#3ba55d', borderColor: '#3ba55d', color: '#ff0000' },
    disabled: true,
    onclick: null,
  };
  const onClose = () => {};
  setTaskActionClose(button, onClose);
  assert.equal(button.textContent, 'Fermer');
  assert.equal(button.className, 'btn btn-secondary');
  assert.equal(button.style.background, '');
  assert.equal(button.style.borderColor, '');
  assert.equal(button.style.color, '');
  assert.equal(button.disabled, false);
  assert.equal(button.onclick, onClose);
});

test('les deux nettoyeurs utilisent le helper au lieu d’un fond inline', () => {
  for (const source of [DELETE, REACTION]) {
    assert.doesNotMatch(source, /actionBtn\.style\.background/, 'plus de fond inline sur le bouton');
    assert.match(source, /setTaskActionClose\(actionBtn/, 'helper de fermeture utilisé');
  }
});
