// Verrou anti-régression — BUG-001 (portée applicative).
//
// Les verrous `isDeleting` étaient portés par chaque manager : un nettoyage de
// MP et un nettoyage de groupes pouvaient écrire en parallèle dans le même
// panneau. Un verrou global, explicite et relâché dans un `finally`, garantit
// qu'une seule opération longue pilote l'interface à la fois.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acquireOperation,
  releaseOperation,
  currentOperation,
  isOperationActive,
} from '../src/utils/operationLock.js';

test('le verrou global est libre au départ', () => {
  releaseOperation();
  assert.equal(isOperationActive(), false);
  assert.equal(currentOperation(), null);
});

test('une seule opération peut être acquise à la fois', () => {
  const first = acquireOperation('Nettoyage des MP');
  assert.ok(first, 'première acquisition acceptée');
  assert.equal(isOperationActive(), true);
  assert.equal(currentOperation(), 'Nettoyage des MP');

  assert.equal(acquireOperation('Nettoyage des groupes'), null, 'seconde acquisition refusée');
  assert.equal(currentOperation(), 'Nettoyage des MP', 'le nom du propriétaire est conservé');
  releaseOperation(first);
});

test('le verrou se relâche et redevient disponible', () => {
  const token = acquireOperation('Suppression');
  assert.ok(token);
  assert.equal(releaseOperation(token), true);
  assert.equal(isOperationActive(), false);
  const next = acquireOperation('Suivante');
  assert.ok(next, 'réacquisition après relâchement');
  releaseOperation(next);
});

test('un propriétaire ne peut pas relâcher le verrou d’un autre', () => {
  const owner = acquireOperation('A');
  const foreign = { id: 9999, name: 'B' };
  assert.equal(releaseOperation(foreign), false, 'relâchement étranger refusé');
  assert.equal(currentOperation(), 'A', 'le verrou reste au propriétaire');
  releaseOperation(owner);
});
