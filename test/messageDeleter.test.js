// Verrou anti-régression — suppression des messages (DM / groupe).
//
// BUG-014 :
//   1. un 429 au SCAN n'abandonne plus la suppression (retry borné) ;
//   2. en mode `quiet`, un échec est notifié au lieu de disparaître ;
//   3. un échec de suppression remonte `partial`, jamais `done` ;
//   4. les messages système (appels, type 3) sont exclus de la suppression.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { deleteDMMessages, isDeletableMessageType } from '../src/utils/messageDeleter.js';

// DOM minimal : en mode `quiet` il n'y a pas de modale, mais le code interroge
// `getElementById` et `showNotification` crée/ajoute des nœuds. Pas de jsdom
// dans ce dépôt : on fournit juste ce qui est touché.
function makeDocument() {
  const bodyChildren = [];
  const document = {
    createElement() {
      return {
        className: '',
        textContent: '',
        style: {},
        disabled: false,
        appendChild() {},
        addEventListener() {},
        remove() { this.removed = true; },
      };
    },
    getElementById() { return null; },
    body: { appendChild(el) { bodyChildren.push(el); } },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  return { document, bodyChildren };
}

async function withDocument(fn) {
  const saved = globalThis.document;
  const { document, bodyChildren } = makeDocument();
  globalThis.document = document;
  try {
    return await fn(bodyChildren);
  } finally {
    globalThis.document = saved;
  }
}

test('BUG-014 : isDeletableMessageType écarte les types système et garde les normaux', () => {
  assert.equal(isDeletableMessageType(0), true);
  assert.equal(isDeletableMessageType(19), true);
  assert.equal(isDeletableMessageType(20), true);
  assert.equal(isDeletableMessageType(3), false, 'appel');
  assert.equal(isDeletableMessageType(1), false);
  assert.equal(isDeletableMessageType(7), false);
  assert.equal(isDeletableMessageType(undefined), true, 'type absent = non filtré');
});

test('BUG-014 : les messages système (appels) sont exclus de la suppression', async () => {
  const deleted = [];
  const api = {
    getDMMessages: async () => ({
      success: true,
      currentUserId: 'u1',
      messages: [
        { id: 'm1', isDeletable: true, type: 0 },
        { id: 'call', isDeletable: true, type: 3 },
        { id: 'sys', isDeletable: true, type: 1 },
      ],
    }),
    deleteDMMessage: async (_c, id) => { deleted.push(id); return { success: true }; },
  };
  const status = await withDocument(() => deleteDMMessages({
    channelId: 'c1', username: 'x', electronAPI: api, quiet: true,
  }));
  assert.equal(status, 'done');
  assert.deepEqual(deleted, ['m1'], 'seul le message normal est tenté');
});

test('BUG-014 : un 429 au scan est retenté puis la suppression se poursuit', async () => {
  let scans = 0;
  const deleted = [];
  const api = {
    getDMMessages: async () => {
      scans++;
      // retryAfter négatif → délai quasi nul dans le test (jamais en prod).
      if (scans === 1) return { success: false, error: 'Rate limited', retryAfter: -0.999 };
      return { success: true, currentUserId: 'u1', messages: [{ id: 'm1', isDeletable: true, type: 0 }] };
    },
    deleteDMMessage: async (_c, id) => { deleted.push(id); return { success: true }; },
  };
  const status = await withDocument(() => deleteDMMessages({
    channelId: 'c1', username: 'x', electronAPI: api, quiet: true,
  }));
  assert.equal(scans, 2, 'le scan a bien été retenté');
  assert.equal(status, 'done');
  assert.deepEqual(deleted, ['m1']);
});

test('BUG-014 : en mode quiet un échec de scan est notifié (plus silencieux)', async () => {
  const api = { getDMMessages: async () => ({ success: false, error: 'No access' }) };
  let children = [];
  await withDocument(body => {
    children = body;
    return deleteDMMessages({ channelId: 'c1', username: 'x', electronAPI: api, quiet: true });
  });
  assert.equal(children.length, 1, 'une notification doit être affichée');
  assert.match(children[0].textContent, /No access/);
});

test('BUG-014 : un échec de suppression renvoie partial, jamais done', async () => {
  const api = {
    getDMMessages: async () => ({
      success: true,
      currentUserId: 'u1',
      messages: [{ id: 'm1', isDeletable: true, type: 0 }],
    }),
    deleteDMMessage: async () => ({ success: false, error: 'No access' }),
  };
  const status = await withDocument(() => deleteDMMessages({
    channelId: 'c1', username: 'x', electronAPI: api, quiet: true,
  }));
  assert.equal(status, 'partial');
});

test('BUG-002 : isStopSignal interrompt la suppression et renvoie cancelled', async () => {
  let deleted = 0;
  let calls = 0;
  const api = {
    getDMMessages: async () => ({
      success: true,
      currentUserId: 'u1',
      messages: [
        { id: 'm1', isDeletable: true, type: 0 },
        { id: 'm2', isDeletable: true, type: 0 },
        { id: 'm3', isDeletable: true, type: 0 },
      ],
    }),
    deleteDMMessage: async () => { deleted += 1; return { success: true }; },
  };
  const status = await withDocument(() => deleteDMMessages({
    channelId: 'c1',
    username: 'x',
    electronAPI: api,
    quiet: true,
    isStopSignal: () => { calls += 1; return calls >= 3; },
  }));
  assert.equal(status, 'cancelled');
  assert.equal(deleted, 0, 'aucune suppression après le signal d’arrêt');
});

test('BUG-001 : la modale de suppression utilise un identifiant unique et des compteurs scopés', () => {
  const source = fs.readFileSync(new URL('../src/utils/messageDeleter.js', import.meta.url), 'utf8');
  assert.ok(source.includes('const uid ='), 'identifiant par instance');
  assert.ok(source.includes('new ProgressBar(uid'), 'la barre reçoit cet identifiant');
  assert.ok(!source.includes("new ProgressBar('progressContainer'"), 'plus d’identifiant fixe');
  assert.ok(!source.includes("getElementById('totalCount')"), 'compteur total scopé');
  assert.ok(!source.includes("getElementById('deletedCount')"), 'compteur supprimé scopé');
  assert.ok(!source.includes("getElementById('etaText')"), 'ETA scopée');
  assert.ok(source.includes('modalOverlay?.querySelector'), 'requêtes limitées à la modale');
});
