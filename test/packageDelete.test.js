import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDeleteResult, describeDeleteFailure, shouldRetryDelete, summarizeDelete } from '../src/services/packageDelete.service.js';

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

// Discord renvoie des messages du type « Missing Access » ou « Missing
// Permissions », sans aucun code dedans. La regex ne voyait donc « HTTP 403 »
// que par hasard, et un vrai refus pouvait finir en « echec » : ce qui est
// exactement ce que l utilisateur a observe sur un salon ou il avait acces.
test('le statut HTTP tranche quand le message ne contient aucun code', () => {
  assert.equal(classifyDeleteResult({ success: false, status: 403, error: 'Missing Access' }), 'forbidden');
  assert.equal(classifyDeleteResult({ success: false, status: 403, error: 'Missing Permissions' }), 'forbidden');
  assert.equal(classifyDeleteResult({ success: false, status: 404, error: 'Unknown Message' }), 'missing');
  assert.equal(classifyDeleteResult({ success: false, status: 400, error: 'Invalid Form Body' }), 'failed');
  assert.equal(classifyDeleteResult({ success: false, status: 429, error: 'Rate limited' }), 'retry');
});

test('un 403 reste un refus meme quand le statut est absent', () => {
  assert.equal(classifyDeleteResult({ success: false, error: 'HTTP 403' }), 'forbidden', 'repli sur le texte');
});

test('la raison d un echec est decrite a partir du statut et du message', () => {
  assert.equal(describeDeleteFailure({ status: 400, error: 'Invalid Form Body' }), '400 Invalid Form Body');
  assert.equal(describeDeleteFailure({ status: 403, error: 'Missing Access' }), '403 Missing Access');
  assert.equal(describeDeleteFailure({ error: 'boom' }), 'boom');
  assert.equal(describeDeleteFailure({ status: 0 }), 'HTTP 0');
});

test('le resume annonce la raison des echecs', () => {
  const counts = { deleted: 2, missing: 0, forbidden: 1, failed: 3 };
  assert.match(summarizeDelete(counts).text, /^2 supprimé\(s\)/);
  assert.doesNotMatch(summarizeDelete(counts).text, /400/, 'sans raison, rien n est invente');

  const withReasons = summarizeDelete(counts, { '400 Invalid Form Body': 2, '401 Unauthorized': 1 });
  assert.match(withReasons.text, /3 échec\(s\)/);
  assert.match(withReasons.text, /400 Invalid Form Body/, 'la cause est affichee');
  assert.match(withReasons.text, /401 Unauthorized/);
});

test('beaucoup de causes distinctes restent lisibles', () => {
  const reasons = { a: 1, b: 1, c: 1, d: 1 };
  const text = summarizeDelete({ deleted: 0, missing: 0, forbidden: 0, failed: 4 }, reasons).text;
  assert.match(text, /\+2/, 'les suivantes sont resumees');
});

test('un salon inconnu n est pas un message absent', () => {
  // Compter « Unknown Channel » comme « deja absent » dissimulait le vrai
  // probleme, qui est dans l identifiant de salon de la selection.
  assert.equal(classifyDeleteResult({ success: false, status: 404, error: 'Unknown Channel' }), 'failed');
  assert.equal(classifyDeleteResult({ success: false, status: 404, error: 'Unknown Message' }), 'missing');
});

test('le resume compte chaque etat', () => {
  const summary = summarizeDelete({ deleted: 3, missing: 2, forbidden: 1, failed: 4 });
  assert.equal(summary.total, 10);
  assert.ok(summary.text.includes('3'), 'les suppressions reussies sont comptees');
  assert.ok(summary.text.includes('2'), 'les absents sont comptes');
  assert.ok(summary.text.includes('1'), 'les acces refuses sont comptes');
  assert.ok(summary.text.includes('4'), 'les echecs sont comptes');
});