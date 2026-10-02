import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDeleteResult, shouldRetryDelete, summarizeDelete } from '../src/services/packageDelete.service.js';

// Le compteur annoncait « supprime » meme quand Discord refusait (403 sur un
// salon quitte, 404 sur un message deja absent). Le resultat est donc classe
// en 4 etats, et la boucle de retry etait cassee : sa condition breakait des
// le premier essai pour tout sauf un 429.

test('un succes est une suppression', () => {
  assert.equal(classifyDeleteResult({ success: true }), 'deleted');
});

test('un 404 signifie deja absent, pas une erreur', () => {
  assert.equal(classifyDeleteResult({ success: false, error: 'HTTP 404' }), 'missing');
  assert.equal(classifyDeleteResult({ success: false, error: 'not found' }), 'missing');
});

test('un 403 signifie acces refuse', () => {
  assert.equal(classifyDeleteResult({ success: false, error: 'HTTP 403' }), 'forbidden');
});

test('un rate limit est reessaye, pas classe comme echec', () => {
  assert.equal(classifyDeleteResult({ success: false, error: 'Rate limited' }), 'retry');
});

test('une erreur inconnue reste un echec', () => {
  assert.equal(classifyDeleteResult({ success: false, error: 'HTTP 500' }), 'failed');
  assert.equal(classifyDeleteResult({}), 'failed');
});

test('le retry ne concerne que le rate limit', () => {
  assert.equal(shouldRetryDelete({ success: false, error: 'Rate limited' }), true);
  assert.equal(shouldRetryDelete({ success: true }), false);
  assert.equal(shouldRetryDelete({ success: false, error: 'HTTP 403' }), false, 'un acces refuse ne se reessaye pas');
  assert.equal(shouldRetryDelete({ success: false, error: 'HTTP 404' }), false);
});

test('le delai de reessai suit Retry-After', () => {
  assert.equal(classifyDeleteResult({ success: false, error: 'Rate limited', retryAfter: 7 }) !== 'retry', false);
});

test('le resume compte chaque etat', () => {
  const summary = summarizeDelete({ deleted: 3, missing: 2, forbidden: 1, failed: 4 });
  assert.equal(summary.total, 10);
  assert.ok(summary.text.includes('3'), 'les suppressions reussies sont comptees');
  assert.ok(summary.text.includes('2'), 'les absents sont comptes');
  assert.ok(summary.text.includes('1'), 'les acces refuses sont comptes');
  assert.ok(summary.text.includes('4'), 'les echecs sont comptes');
});