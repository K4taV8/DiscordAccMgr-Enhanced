// Verrou anti-régression — reprise de la suppression de messages serveur (B1).
//
// Le curseur de reprise ne doit avancer QUE sur un vrai succès : un message
// échoué (hors 429) doit rester dans la file pour être retenté au prochain run,
// et le watermark ne doit être finalisé que si TOUT a été supprimé.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  nextDeleteCursor, deletionsComplete, isAlreadyDeleted,
  scanChannelMessages, countPartialChannels, snowflakeForDate,
} from '../src/utils/serverMessageDeleter.js';

const neverStop = () => false;

test('nextDeleteCursor avance le curseur uniquement sur un succès', () => {
  assert.equal(nextDeleteCursor(0, true), 1);
  assert.equal(nextDeleteCursor(41, true), 42);
  // échec → curseur inchangé : le message fautif sera retenté à la reprise
  assert.equal(nextDeleteCursor(41, false), 41);
  assert.equal(nextDeleteCursor(0, false), 0);
});

test('deletionsComplete exige zéro échec ET tout supprimé', () => {
  assert.equal(deletionsComplete(10, 10, 0), true);
  assert.equal(deletionsComplete(9, 10, 1), false);   // un échec
  assert.equal(deletionsComplete(9, 10, 0), false);   // incomplet
  assert.equal(deletionsComplete(10, 10, 1), false);  // échec malgré le compte
  assert.equal(deletionsComplete(0, 0, 0), true);     // rien à faire
});

test('reprise : un échec ne consomme jamais le message (pas de saut au prochain run)', () => {
  const queue = ['c:1:emoji', 'c:2:emoji', 'c:3:emoji'];
  let done = 0;
  // run 1 : succès, succès, échec
  for (const ok of [true, true, false]) {
    done = nextDeleteCursor(done, ok);
  }
  // Le curseur s'est arrêté AVANT le message échoué — rien n'est sauté.
  assert.equal(done, 2);
  assert.equal(queue[done], 'c:3:emoji');
  assert.equal(deletionsComplete(done, queue.length, 1), false);
});

test('isAlreadyDeleted : 404 « Unknown Message » / déjà absent = SUCCÈS, mais pas « Unknown Channel »', () => {
  assert.equal(isAlreadyDeleted({ success: true }), true);
  assert.equal(isAlreadyDeleted({ success: false, status: 404, error: 'Unknown Message' }), true);
  assert.equal(isAlreadyDeleted({ success: false, error: 'not found' }), true);
  // Mauvais identifiant de salon : ce n'est PAS un succès malgré le 404.
  assert.equal(isAlreadyDeleted({ success: false, status: 404, error: 'Unknown Channel' }), false);
  assert.equal(isAlreadyDeleted({ success: false, status: 403, error: 'Missing Permissions' }), false);
  assert.equal(isAlreadyDeleted({ success: false, status: 500, error: 'boom' }), false);
});

test('échec réel au milieu : le reste de la file est traité et la reprise repart du 1er échec', () => {
  const queue = ['c:0:emoji', 'c:1:emoji', 'c:2:emoji', 'c:3:emoji', 'c:4:emoji'];
  const results = [
    { success: true },                                          // 0 : supprimé
    { success: false, status: 404, error: 'Unknown Message' },  // 1 : déjà absent = succès
    { success: false, status: 500, error: 'boom' },             // 2 : PREMIER échec réel
    { success: true },                                          // 3 : traité malgré l'échec
    { success: true },                                          // 4 : traité malgré l'échec
  ];
  let done = 0;
  let deleted = 0;
  let failed = 0;
  let firstFail = -1;
  results.forEach((result, index) => {
    const ok = isAlreadyDeleted(result);
    if (ok) deleted++;
    else { failed++; if (firstFail === -1) firstFail = index; }
    // Règle de la boucle : le curseur n'avance que tant qu'aucun échec n'existe.
    done = nextDeleteCursor(done, ok && failed === 0);
  });
  // Aucun blocage : les 5 messages ont été examinés (aucun `break`).
  // 4 succès (0,1,3,4) et 1 seul échec réel (2).
  assert.equal(deleted, 4);
  assert.equal(failed, 1);
  // La reprise repart du PREMIER échec, jamais de la fin de file.
  assert.equal(firstFail, 2);
  assert.equal(done, firstFail);
  assert.equal(queue[done], 'c:2:emoji');
  assert.equal(deletionsComplete(deleted, queue.length, failed), false);
});

// ─── BUG-002 : annulation de scan ────────────────────────────────────────────
test('BUG-002 : scanChannelMessages remonte cancelled quand annulé en vol', async () => {
  const recent = snowflakeForDate(new Date());
  const api = {
    getChannelMessages: async (_ch, _before, oldest) => oldest === '0'
      ? { success: true, messages: [{ id: recent }] }
      : { success: true, messages: [] },
  };
  const res = await scanChannelMessages({ id: 'c1', name: 'c1' }, 'u1', api, () => {}, () => true, undefined, null);
  assert.equal(res.cancelled, true, 'annulation ≠ scan terminé');
  assert.equal(res.skipped, false);
  assert.deepEqual(res.messages, []);
});

// ─── BUG-003 : sonde initiale ────────────────────────────────────────────────
test('BUG-003 : une sonde initiale en échec marque le canal skipped (pas « scanné vide »)', async () => {
  let calls = 0;
  const api = { getChannelMessages: async () => { calls++; return { success: false, error: 'No access' }; } };
  const res = await scanChannelMessages({ id: 'c1', name: 'c1' }, 'u1', api, () => {}, neverStop, undefined, null);
  assert.equal(res.skipped, true, 'no access ⇒ repris au prochain run');
  assert.deepEqual(res.messages, []);
  assert.equal(calls, 1, 'no access : pas de retry inutile');
});

test('BUG-003 : une exception réseau sur la sonde marque aussi skipped', async () => {
  const api = { getChannelMessages: async () => { throw new Error('timeout'); } };
  const res = await scanChannelMessages({ id: 'c1', name: 'c1' }, 'u1', api, () => {}, neverStop, undefined, null);
  assert.equal(res.skipped, true);
});

test('BUG-003 : succès + liste vide = canal réellement vide (scanned, skipped false)', async () => {
  const api = {
    getChannelMessages: async (_ch, _before, oldest) => ({ success: true, messages: [] }),
  };
  const res = await scanChannelMessages({ id: 'c1', name: 'c1' }, 'u1', api, () => {}, neverStop, undefined, null);
  assert.equal(res.skipped, false);
  assert.equal(res.cancelled, false);
  assert.deepEqual(res.messages, []);
});

test('BUG-003 : un 429 sur la sonde est retenté (retryAfter) avant abandon', async () => {
  const recent = snowflakeForDate(new Date());
  let probes = 0;
  const api = {
    getChannelMessages: async (_ch, _before, oldest) => {
      if (oldest !== '0') return { success: true, messages: [] };
      probes++;
      return probes < 3
        ? { success: false, error: 'Rate limited', retryAfter: 0.001 }
        : { success: true, messages: [{ id: recent }] };
    },
  };
  const res = await scanChannelMessages({ id: 'c1', name: 'c1' }, 'u1', api, () => {}, neverStop, undefined, null);
  assert.equal(probes, 3, '2 échecs 429 puis succès');
  assert.equal(res.skipped, false);
});

// ─── BUG-006 : canaux partiels ───────────────────────────────────────────────
test('BUG-006 : countPartialChannels ne compte que les canaux « partial »', () => {
  assert.equal(countPartialChannels({ a: { status: 'scanned' }, b: { status: 'partial' }, c: { status: 'pending' } }), 1);
  assert.equal(countPartialChannels({}), 0);
  assert.equal(countPartialChannels(null), 0);
});

test('BUG-006 : le statut final signale les canaux non scannés et garde le checkpoint', () => {
  const src = fs.readFileSync(new URL('../src/utils/serverMessageDeleter.js', import.meta.url), 'utf8');
  assert.ok(src.includes('canal(aux) non scanné(s)'), 'statut final explicite');
  assert.ok(src.includes('const partialChannelCount = () => countPartialChannels('), 'compte réutilisé');
  assert.ok(src.includes("checkpoint.phase = 'scan';"), 'reprise des canaux partiels');
});
