// Verrou anti-régression — panneau de progression (BUG-001 / BUG-002).
//
// BUG-002 : une opération en lot ne pouvait PAS être arrêtée. Le panneau
// n'exposait qu'une croix « Masquer », qui retirait le panneau sans interrompre
// la boucle. Il doit désormais offrir un bouton « Arrêter » distinct, câblé sur
// un rappel d'annulation, et rester visible pendant la demande d'arrêt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  progressPanelHtml,
  showProgressPanel,
  finishProgressPanel,
  closeProgressPanel,
  isProgressPanelOpen,
} from '../src/utils/progressPanel.js';

function fakeElement() {
  const listeners = [];
  return {
    className: '',
    innerHTML: '',
    removed: false,
    children: [],
    addEventListener(type, fn) { listeners.push({ type, fn }); },
    dispatch(type, event) { for (const listener of listeners) if (listener.type === type) listener.fn(event); },
    appendChild(child) { this.children.push(child); },
    remove() { this.removed = true; },
  };
}

function withFakeDom(fn) {
  const saved = globalThis.document;
  const body = fakeElement();
  globalThis.document = {
    createElement: () => fakeElement(),
    body,
  };
  try {
    return fn(body);
  } finally {
    closeProgressPanel();
    globalThis.document = saved;
  }
}

test('BUG-002 : sans cancelable, le panneau ne montre que Masquer', () => {
  const html = progressPanelHtml({ title: 'Import', done: 1, total: 2 });
  assert.match(html, /data-progress-close/);
  assert.doesNotMatch(html, /data-progress-cancel/);
});

test('BUG-002 : cancelable ajoute un bouton Arrêter distinct de Masquer', () => {
  const html = progressPanelHtml({ title: 'Nettoyage', done: 1, total: 4, cancelable: true });
  assert.match(html, /data-progress-cancel/, 'bouton Arrêter présent');
  assert.match(html, /data-progress-close/, 'bouton Masquer conservé');
  assert.match(html, /Arrêter/);
  assert.doesNotMatch(html, /data-progress-cancel[^>]*disabled/, 'actif tant que rien n’est demandé');
});

test('BUG-002 : une annulation déjà demandée désactive le bouton', () => {
  const html = progressPanelHtml({
    title: 'Nettoyage',
    done: 1,
    total: 4,
    cancelable: true,
    cancelRequested: true,
  });
  assert.match(html, /data-progress-cancel[^>]*disabled/, 'bouton désactivé');
  assert.match(html, /Annulation/);
  assert.doesNotMatch(html, />Arrêter</);
});

test('BUG-002 : cliquer Arrêter notifie onCancel sans masquer le panneau', () => {
  withFakeDom(() => {
    let calls = 0;
    const state = showProgressPanel({
      title: 'Nettoyage des MP',
      total: 4,
      cancelable: true,
      onCancel: () => { calls += 1; },
    });
    assert.ok(state?.element, 'panneau monté');

    const click = (selector) => state.element.dispatch('click', {
      target: { closest: (wanted) => (wanted === selector ? {} : null) },
    });

    click('[data-progress-cancel]');
    assert.equal(calls, 1, 'le rappel d’annulation est appelé une fois');
    assert.equal(state.cancelRequested, true);
    assert.equal(isProgressPanelOpen(), true, 'le panneau reste visible');

    // Deuxième clic : ignoré, l'arrêt est déjà demandé.
    click('[data-progress-cancel]');
    assert.equal(calls, 1, 'pas de double demande');
  });
});

test('BUG-002 : la croix Masquer ferme toujours le panneau', () => {
  withFakeDom(() => {
    const state = showProgressPanel({ title: 'X', total: 1, cancelable: true, onCancel: () => {} });
    state.element.dispatch('click', {
      target: { closest: (wanted) => (wanted === '[data-progress-close]' ? {} : null) },
    });
    assert.equal(isProgressPanelOpen(), false);
  });
});

test('BUG-002 : un arrêt utilisateur peut être signalé comme tel', () => {
  withFakeDom(() => {
    const state = showProgressPanel({ title: 'X', total: 4, cancelable: true, onCancel: () => {} });
    finishProgressPanel({ detail: 'arrêté', status: 'cancelled', autoClose: 0 });
    assert.match(state.element.innerHTML, /is-cancelled/);
  });
});
