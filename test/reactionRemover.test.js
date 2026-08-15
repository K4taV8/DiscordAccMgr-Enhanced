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
import { scanOwnReactions, deleteReactionList } from '../src/utils/reactionRemover.js';
import { scanChannelReactions } from '../src/utils/serverReactionRemover.js';
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
