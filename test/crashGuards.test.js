// Verrou anti-régression — BUG-008 : les garde-fous du main process sont
// désormais testés par COMPORTEMENT, pas par recherche de sous-chaîne dans le
// source de main.cjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { installProcessGuards } = require('../electron/crashGuards.cjs');

test('BUG-008 : une exception non capturée est journalisée sans tuer le process', () => {
  const proc = new EventEmitter();
  const entrees = [];
  const dispose = installProcessGuards({
    processRef: proc,
    journal: (...args) => entrees.push(args),
  });

  const erreur = new Error('boum');
  assert.doesNotThrow(() => proc.emit('uncaughtException', erreur), 'le process survit');
  assert.equal(entrees.length, 1);
  assert.equal(entrees[0][0], 'fatal');
  assert.equal(entrees[0][1], 'uncaughtException:');
  assert.equal(entrees[0][2], erreur);

  proc.emit('unhandledRejection', 'raison');
  assert.equal(entrees.length, 2);
  assert.equal(entrees[1][0], 'error');
  assert.equal(entrees[1][1], 'unhandledRejection:');

  dispose();
  assert.equal(proc.listenerCount('uncaughtException'), 0);
  assert.equal(proc.listenerCount('unhandledRejection'), 0);
});

test('BUG-008 : un écrivain de journal qui jette ne propage rien', () => {
  const proc = new EventEmitter();
  installProcessGuards({
    processRef: proc,
    journal: () => { throw new Error('disque plein'); },
  });
  assert.doesNotThrow(() => proc.emit('uncaughtException', new Error('origine')));
  assert.doesNotThrow(() => proc.emit('unhandledRejection', new Error('origine')));
});
