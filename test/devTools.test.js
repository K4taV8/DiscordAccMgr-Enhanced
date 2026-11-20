// Verrou anti-régression — point POSSIBLE 1 de l'audit : pendant le préchauffage
// du login, une fenêtre CACHÉE existe. F12 doit viser la fenêtre principale,
// jamais « la première de getAllWindows() ».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { toggleDevTools } = require('../electron/devTools.cjs');

function fakeWindow(appels, nom) {
  return {
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    webContents: {
      toggleDevTools() { appels.push(nom); },
    },
  };
}

test('POSSIBLE 1 : F12 bascule les DevTools de la fenêtre principale uniquement', () => {
  const appels = [];
  const principale = fakeWindow(appels, 'principale');
  fakeWindow(appels, 'login-cache');
  assert.equal(toggleDevTools(principale), true);
  assert.deepEqual(appels, ['principale']);
});

test('POSSIBLE 1 : une fenêtre détruite est ignorée', () => {
  const appels = [];
  const fenetre = fakeWindow(appels, 'detruite');
  fenetre.destroyed = true;
  assert.equal(toggleDevTools(fenetre), false);
  assert.deepEqual(appels, []);
  assert.equal(toggleDevTools(null), false);
});

test('POSSIBLE 1 : un webContents absent ou qui jette ne casse rien', () => {
  assert.equal(toggleDevTools({ isDestroyed: () => false, webContents: null }), false);
  assert.equal(toggleDevTools({
    isDestroyed: () => false,
    webContents: { toggleDevTools() { throw new Error('boom'); } },
  }), false);
});
