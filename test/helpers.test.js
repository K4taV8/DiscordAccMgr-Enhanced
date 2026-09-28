import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { snowflakeTs, snowflakeForDate, DISCORD_EPOCH } from '../src/utils/serverMessageDeleter.js';
import { decodeQueue } from '../src/utils/serverReactionRemover.js';

const require = createRequire(import.meta.url);
const { routeKeyFor, isSnowflake, isOp, MESSAGE_BEARING_CHANNEL_TYPES, isMessageBearingChannel } = require('../electron/helpers.cjs');

test('routeKeyFor masks snowflakes in path segments', () => {
  assert.equal(routeKeyFor('/users/@me/guilds'), '/users/@me/guilds');
  assert.equal(routeKeyFor('/guilds/123456789/ack'), '/guilds/:id/ack');
  assert.equal(routeKeyFor('/channels/987654321/messages'), '/channels/:id/messages');
  assert.equal(routeKeyFor('/channels/1/messages/2/reactions/ok/@me'), '/channels/:id/messages/:id/reactions/ok/@me');
});

test('isSnowflake validates numeric ids', () => {
  assert.equal(isSnowflake('123456789012345678'), true);
  assert.equal(isSnowflake('0'), true);
  assert.equal(isSnowflake('abc'), false);
  assert.equal(isSnowflake('123abc'), false);
  assert.equal(isSnowflake(''), false);
  assert.equal(isSnowflake(123), false);
  assert.equal(isSnowflake('1'.repeat(33)), false); // > 32 chiffres
});

test('isOp only accepts known checkpoint operations', () => {
  assert.equal(isOp('removeReactions'), true);
  assert.equal(isOp('deleteMessages'), true);
  assert.equal(isOp('deleteFriend'), false);
  assert.equal(isOp(''), false);
  assert.equal(isOp(undefined), false);
});

// Le chat textuel integre d'un salon vocal (2) et d'une scene (13) s'adresse par
// l'ID du salon lui-meme : il doit donc etre scannable comme un salon texte.
test('MESSAGE_BEARING_CHANNEL_TYPES covers text, voice and stage channels', () => {
  assert.deepEqual(MESSAGE_BEARING_CHANNEL_TYPES, [0, 2, 5, 10, 11, 12, 13, 15, 16]);
});

test('isMessageBearingChannel accepts every scannable guild channel type', () => {
  for (const type of [0, 2, 5, 10, 11, 12, 13, 15, 16]) {
    assert.equal(isMessageBearingChannel(type), true, `type ${type} doit etre scannable`);
  }
});

// 1/3 : DMs et groupes ont leurs propres endpoints, jamais listes par
// getServerChannels. 4 : categorie. 14 : repertoire. Aucun chat texte.
test('isMessageBearingChannel rejects guild channels without a text chat', () => {
  for (const type of [1, 3, 4, 14]) {
    assert.equal(isMessageBearingChannel(type), false, `type ${type} ne doit pas etre scannable`);
  }
});

test('snowflakeTs / snowflakeForDate round-trip', () => {
  const d = new Date(1700000000000);
  const id = snowflakeForDate(d);
  assert.equal(snowflakeTs(id), d.getTime());
});

test('snowflakeTs extracts epoch-shifted timestamp for a known snowflake', () => {
  const ts = snowflakeTs('419511345539186688');
  assert.equal(typeof ts, 'number');
  assert.ok(Number.isFinite(ts));
  assert.ok(ts > DISCORD_EPOCH);
});

test('snowflakeForDate clamps pre-epoch dates (BUG-09)', () => {
  const id = snowflakeForDate(new Date(0));
  assert.equal(id, '0'); // borné à l'epoch Discord → pas de shift négatif
});

test('decodeQueue splits channel/message/emoji (emoji may contain colons)', () => {
  assert.deepEqual(decodeQueue('123:456:wave:789'), { channelId: '123', messageId: '456', emojiStr: 'wave:789' });
  assert.deepEqual(decodeQueue('123:456:ok'), { channelId: '123', messageId: '456', emojiStr: 'ok' });
  assert.deepEqual(decodeQueue('a:b:c:d:e'), { channelId: 'a', messageId: 'b', emojiStr: 'c:d:e' });
});
