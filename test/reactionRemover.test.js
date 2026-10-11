// Verrou anti-régression — suppression des réactions.
//
// Ces tests figent les trois bugs de fiabilité corrigés :
//   1. U+FE0F (variation selector) conservé dans l'emoji envoyé au DELETE
//      (avant : ❤️ était envoyé comme ❤ → 404 → l'outil annonçait « supprimé »
//      alors que la réaction restait).
//   2. Un 404 (réaction déjà absente) est un SUCCÈS, pas un échec, mais un 400
//      (emoji invalide) doit rester un ÉCHEC visible — jamais un succès silencieux.
//   3. Le scan ne collecte QUE r.me === true, et le scan serveur ignore les
//      clés du ledger (anti-fantômes) — pas de réaction re-signalée à tort.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { scanOwnReactions, deleteReactionList, removeReactionsFromChannel } from '../src/utils/reactionRemover.js';
import { scanChannelReactions, drainLedger, resumeCounts } from '../src/utils/serverReactionRemover.js';
import { countPartialChannels } from '../src/utils/serverMessageDeleter.js';
import { formatEmojiForApi } from '../src/utils/emojiUtils.js';

const neverStop = () => false;

// ─── SCAN (DM / groupe) ───────────────────────────────────────────────────────

test('scanOwnReactions ne garde que les réactions r.me === true', async () => {
  const api = {
    getDMMessages: async () => ({
      success: true,
      messages: [
        { id: 'm1', reactions: [
          { emoji: { name: '👍' }, me: true },
          { emoji: { name: '🎉' }, me: false },
          { emoji: { name: '❤️' }, me: true },
        ] },
        { id: 'm2', reactions: [] },
      ],
    }),
  };
  const { messages } = await scanOwnReactions('c1', false, api, neverStop);
  // m2 n'a aucune réaction → non inclus (seuls les messages avec au moins une
  // réaction nôtre sont remontés)
  assert.equal(messages.length, 1);
  const flat = messages.flatMap(m => m.reactions.map(r => r.emoji.name));
  assert.deepEqual(flat, ['👍', '❤️']);
});

test('scanOwnReactions pagine et s’arrête quand une page fait moins de 100', async () => {
  const pages = [
    Array.from({ length: 100 }, (_, i) => ({ id: `m${i}`, reactions: [{ emoji: { name: '👍' }, me: true }] })),
    [{ id: 'mLast', reactions: [{ emoji: { name: '🎉' }, me: true }] }],
  ];
  let call = 0;
  const api = {
    getDMMessages: async (_ch, beforeId) => {
      const page = pages[call++];
      // page 2 doit être appelée avec l'id du dernier message de la page 1
      if (call === 2) assert.equal(beforeId, 'm99');
      return { success: true, messages: page };
    },
  };
  const { messages } = await scanOwnReactions('c1', false, api, neverStop);
  assert.equal(call, 2);
  assert.equal(messages.length, 101);
});

// ─── DELETE (DM / groupe) ─────────────────────────────────────────────────────

test('deleteReactionList envoie l’emoji AVEC U+FE0F (régression clé)', async () => {
  const sent = [];
  const api = {
    removeOwnReaction: async (_ch, _msg, emoji) => { sent.push(emoji); return { success: true }; },
  };
  const result = await deleteReactionList(
    [{ id: 'm1', reactions: [{ emoji: { name: '❤️' } }] }],
    'c1', api, neverStop
  );
  assert.equal(result.removed, 1);
  assert.equal(result.failed, 0);
  // ❤️ = U+2764 U+FE0F → le DELETE doit cibler l'emoji COMPLET
  assert.deepEqual(sent, ['%E2%9D%A4%EF%B8%8F']);
});

test('deleteReactionList : 404 (noReaction) = succès (réaction déjà absente)', async () => {
  const api = {
    removeOwnReaction: async () => ({ success: false, error: 'noReaction' }),
  };
  const result = await deleteReactionList(
    [{ id: 'm1', reactions: [{ emoji: { name: '👍' } }] }],
    'c1', api, neverStop
  );
  assert.equal(result.removed, 1);
  assert.equal(result.failed, 0);
});

test('deleteReactionList : 400 (invalidEmoji) = ÉCHEC visible, pas un succès silencieux', async () => {
  const api = {
    removeOwnReaction: async () => ({ success: false, error: 'invalidEmoji' }),
  };
  const result = await deleteReactionList(
    [{ id: 'm1', reactions: [{ emoji: { name: '???-pas-un-emoji' } }] }],
    'c1', api, neverStop
  );
  assert.equal(result.removed, 0);
  assert.equal(result.failed, 1);
});

test('deleteReactionList : 429 → retry borné (3×) puis échec', async () => {
  let calls = 0;
  const api = {
    removeOwnReaction: async () => { calls++; return { success: false, error: 'Rate limited', retryAfter: 0 }; },
  };
  const result = await deleteReactionList(
    [{ id: 'm1', reactions: [{ emoji: { name: '👍' } }] }],
    'c1', api, neverStop
  );
  assert.equal(calls, 3);
  assert.equal(result.removed, 0);
  assert.equal(result.failed, 1);
});

// ─── SCAN (serveur) ───────────────────────────────────────────────────────────

test('scanChannelReactions filtre le ledger (anti-fantômes) et conserve U+FE0F', async () => {
  const api = {
    getChannelMessages: async () => ({
      success: true,
      messages: [
        { id: 'm1', reactions: [
          { emoji: { name: '❤️' }, me: true },   // déjà confirmée supprimée → ignorée
          { emoji: { name: '🎉' }, me: false },  // pas la nôtre → ignorée
          { emoji: { name: '😊' }, me: true },   // conservée
        ] },
      ],
    }),
  };
  const suppressed = new Set([`c1:m1:${formatEmojiForApi({ name: '❤️' })}`]);
  const log = () => {};
  const { reactions } = await scanChannelReactions(
    { id: 'c1' }, api, log, neverStop, undefined, { suppressed }
  );
  assert.equal(reactions.length, 1);
  assert.equal(reactions[0].emojiStr, formatEmojiForApi({ name: '😊' }));
  assert.equal(reactions[0].messageId, 'm1');
});

// ─── BUG-002 : annulation de scan ────────────────────────────────────────────
test('BUG-002 : scanChannelReactions remonte cancelled quand annulé en vol', async () => {
  let cancel = false;
  const page = Array.from({ length: 100 }, (_, i) => ({ id: `m${i}`, reactions: [{ emoji: { name: '👍' }, me: true }] }));
  const api = { getChannelMessages: async () => { cancel = true; return { success: true, messages: page }; } };
  const { reactions, cancelled, skipped } = await scanChannelReactions(
    { id: 'c1' }, api, () => {}, () => cancel, undefined, {}
  );
  assert.equal(cancelled, true, 'annulation ≠ scan terminé');
  assert.equal(skipped, false);
  assert.equal(reactions.length, 100, 'les réactions déjà vues sont conservées');
});

// ─── BUG-022b : flush du ledger ──────────────────────────────────────────────
test('BUG-022b : drainLedger conserve les clés si l écriture échoue', async () => {
  const pending = ['a', 'b'];
  await assert.rejects(() => drainLedger(pending, async () => { throw new Error('disk full'); }));
  assert.deepEqual(pending, ['a', 'b'], 'aucune clé perdue');
});

test('BUG-022b : drainLedger vide la file après écriture réussie', async () => {
  const pending = ['a', 'b'];
  const written = [];
  const out = await drainLedger(pending, async keys => { written.push(...keys); });
  assert.deepEqual(written, ['a', 'b']);
  assert.deepEqual(out, ['a', 'b']);
  assert.deepEqual(pending, []);
});

// ─── BUG-023b : comptes à la reprise ─────────────────────────────────────────
test('BUG-023b : resumeCounts retire les échecs de progress.done', () => {
  assert.deepEqual(resumeCounts({ done: 10, failed: 3 }), { removed: 7, failed: 3 });
  assert.deepEqual(resumeCounts({ done: 2, failed: 5 }), { removed: 0, failed: 5 });
  assert.deepEqual(resumeCounts({ done: 0, failed: 0 }), { removed: 0, failed: 0 });
  assert.deepEqual(resumeCounts(undefined), { removed: 0, failed: 0 });
});

// ─── Salons serveur sans acces / erreurs transitoires ────────────────────────
// Un salon que le compte ne peut PAS lire (403) ne doit PAS marquer tout le
// serveur en « partial » : il n'y a rien a y supprimer. Il recoit un etat
// distinct `noAccess`. Les erreurs transitoires (5xx/reseau), elles, sont
// retentees avant d'abandonner — comme le chemin DM.
test('scanChannelReactions : 403 No access marque noAccess, pas un echec de scan', async () => {
  const api = { getChannelMessages: async () => ({ success: false, error: 'No access' }) };
  const { skipped, noAccess } = await scanChannelReactions({ id: 'c1', name: 'prive' }, api, () => {}, neverStop, undefined, {});
  assert.equal(skipped, true);
  assert.equal(noAccess, true, 'salon inaccessible -> noAccess');
});

test('scanChannelReactions : une erreur transitoire est retentee avant abandon', async () => {
  let calls = 0;
  const api = {
    getChannelMessages: async () => {
      calls++;
      if (calls === 1) return { success: false, error: 'HTTP 500' };
      return { success: true, messages: [{ id: 'm1', reactions: [{ emoji: { name: '👍' }, me: true }] }] };
    },
  };
  const { skipped, reactions } = await scanChannelReactions({ id: 'c1', name: 'x' }, api, () => {}, neverStop, undefined, {});
  assert.equal(calls, 2, 'la 1re erreur est retentee');
  assert.equal(skipped, false);
  assert.equal(reactions.length, 1);
});

test('scanChannelReactions : erreurs transitoires persistantes -> skipped (pas noAccess)', async () => {
  let calls = 0;
  const api = { getChannelMessages: async () => { calls++; return { success: false, error: 'HTTP 502' }; } };
  const { skipped, noAccess } = await scanChannelReactions({ id: 'c1', name: 'x' }, api, () => {}, neverStop, undefined, {});
  assert.equal(skipped, true);
  assert.equal(noAccess, false, 'une erreur reseau reste un vrai echec de scan');
  assert.equal(calls, 3, 'trois tentatives puis abandon');
});

test('countPartialChannels ignore les salons sans acces (no-access)', () => {
  assert.equal(
    countPartialChannels({ a: { status: 'partial' }, b: { status: 'no-access' }, c: { status: 'scanned' } }),
    1,
    'seuls les vrais scans partiels comptent'
  );
});

// ─── BUG-006 : canaux partiels ───────────────────────────────────────────────
test('BUG-006 : le statut final signale les canaux non scannés et garde le checkpoint', () => {
  const src = fs.readFileSync(new URL('../src/utils/serverReactionRemover.js', import.meta.url), 'utf8');
  assert.ok(src.includes('canal(aux) non scanné(s)'), 'statut final explicite');
  assert.ok(src.includes('const partialChannelCount = () => countPartialChannels('), 'compte réutilisé');
  assert.ok(src.includes("checkpoint.phase = 'scan';"), 'reprise des canaux partiels');
});

// ─── BUG-004 : scan complet vs incomplet (DM / groupe) ───────────────────────
test('BUG-004 : scanOwnReactions signale complete:true quand tout est parcouru', async () => {
  const api = {
    getDMMessages: async () => ({
      success: true,
      messages: [{ id: 'm1', reactions: [{ emoji: { name: '👍' }, me: true }] }],
    }),
  };
  const { messages, complete } = await scanOwnReactions('c1', false, api, neverStop);
  assert.equal(complete, true);
  assert.equal(messages.length, 1);
});

test('BUG-004 : une erreur réseau persistante donne complete:false (pas une fin d’historique)', async () => {
  let calls = 0;
  const api = { getDMMessages: async () => { calls++; return { success: false, error: 'HTTP 500' }; } };
  const { messages, complete } = await scanOwnReactions('c1', false, api, neverStop);
  assert.equal(complete, false, 'scanner incomplet ne doit jamais valoir « terminé »');
  assert.deepEqual(messages, []);
  assert.equal(calls, 3, 'les erreurs sont retentées avant de conclure');
});

test('BUG-004 : un 429 au scan est retenté (Retry-After) puis le scan continue', async () => {
  let calls = 0;
  const api = {
    getDMMessages: async () => {
      calls++;
      if (calls === 1) return { success: false, error: 'Rate limited', retryAfter: -0.999 };
      return { success: true, messages: [{ id: 'm1', reactions: [{ emoji: { name: '👍' }, me: true }] }] };
    },
  };
  const { messages, complete } = await scanOwnReactions('c1', false, api, neverStop);
  assert.equal(calls, 2);
  assert.equal(complete, true);
  assert.equal(messages.length, 1);
});

test('scanOwnReactions couvre TOUT l historique au-dela de 2000 (plus d incomplet a tort)', async () => {
  // 2550 messages = 25 pages pleines de 100, puis une page finale de 50.
  let call = 0;
  const api = {
    getDMMessages: async () => {
      call++;
      if (call <= 25) return { success: true, messages: Array.from({ length: 100 }, (_, i) => ({ id: `m${call * 100 + i}`, reactions: [] })) };
      return { success: true, messages: Array.from({ length: 50 }, (_, i) => ({ id: `z${i}`, reactions: [] })) };
    },
  };
  const { complete } = await scanOwnReactions('c1', false, api, neverStop);
  assert.equal(complete, true, 'un historique de 2550 messages doit etre parcouru en entier (pas de plafond a 2000)');
  assert.equal(call, 26, 'les 26 pages doivent etre lues');
});

test('BUG-004 : atteindre le plafond de securite marque complete:false', async () => {
  // Mock qui renvoie TOUJOURS une page pleine : le scan ne peut sortir que par
  // le plafond (injecte petit uniquement pour le test).
  let call = 0;
  const api = { getDMMessages: async () => { call++; return { success: true, messages: Array.from({ length: 100 }, (_, i) => ({ id: `m${call}-${i}`, reactions: [] })) }; } };
  const { complete } = await scanOwnReactions('c1', false, api, neverStop, { maxMessages: 300 });
  assert.equal(complete, false, 'le plafond doit être signalé, pas silencieux');
  assert.equal(call, 3, 'le scan s arrete au plafond (300 / 100)');
});

// ─── BUG-006 : la modale doit exister AVANT la construction de ProgressBar ────
//
// `ProgressBar` lit `#progressContainer` au constructeur ET dans create() : si
// la modale n'est pas encore rattachée au document, `getElementById` rend null
// et create() lève. Ce stub ne résout un id QUE s'il est dans le document, ce
// qui reproduit exactement la régression (builder la barre avant appendChild).
function makeDom() {
  const registry = new Map();
  const bodyChildren = [];
  const register = (el) => {
    if (el.id) registry.set(el.id, el);
    (el._children || []).forEach(register);
  };
  const unregister = (el) => {
    if (el.id && registry.get(el.id) === el) registry.delete(el.id);
    (el._children || []).forEach(unregister);
  };
  const makeEl = () => {
    const el = {
      id: '', className: '', textContent: '', disabled: false, style: {},
      _children: [], _inDoc: false,
      appendChild(c) { this._children.push(c); if (this._inDoc) register(c); return c; },
      setAttribute() {}, addEventListener() {},
      remove() { this._inDoc = false; unregister(this); },
    };
    Object.defineProperty(el, 'innerHTML', {
      set(html) {
        el._children = [];
        for (const m of html.matchAll(/id="([^"]+)"/g)) { const c = makeEl(); c.id = m[1]; el._children.push(c); }
        if (el._inDoc) register(el);
      },
      get() { return ''; },
    });
    return el;
  };
  const document = {
    createElement: () => makeEl(),
    getElementById: (id) => registry.get(id) || null,
    body: { appendChild(el) { el._inDoc = true; bodyChildren.push(el); register(el); return el; } },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  return { document, bodyChildren, registry };
}

async function withDom(fn) {
  const saved = globalThis.document;
  const dom = makeDom();
  globalThis.document = dom.document;
  try { return await fn(dom); } finally { globalThis.document = saved; }
}

test('BUG-006 (régression) : hors quiet, la modale est rattachée AVANT create()', async () => {
  const api = { getDMMessages: async () => ({ success: true, messages: [] }) };
  await withDom(async ({ bodyChildren, registry }) => {
    await removeReactionsFromChannel({ channelId: 'c1', channelName: 'x', electronAPI: api, onComplete: () => {} });
    assert.equal(bodyChildren.length, 1, 'la modale est rattachée au document');
    assert.ok(registry.get('progressContainer'), 'ProgressBar a bien trouvé #progressContainer');
  });
});

test('BUG-006 : en mode quiet, aucune modale n est créée ni ajoutée', async () => {
  const api = { getDMMessages: async () => ({ success: true, messages: [] }) };
  await withDom(async ({ bodyChildren }) => {
    await removeReactionsFromChannel({ channelId: 'c1', channelName: 'x', electronAPI: api, quiet: true, onComplete: () => {} });
    assert.equal(bodyChildren.length, 0, 'aucune modale en mode lot');
  });
});

