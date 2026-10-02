import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync } from '../node_modules/fflate/esm/browser.js';
import { importDiscordPackage } from '../src/services/packageImporter.service.js';
import { exportDiscordPackage } from '../src/services/packageExporter.service.js';

// L'export ne produisait qu'un .json/.txt alors que l'import exige un ZIP :
// l'aller-retour etait donc impossible. exportDiscordPackage doit reconstruire
// un ZIP au layout Discord, reimportable tel quel par importDiscordPackage.

const USER_ID = '123456789012345678';

function parsedFixture() {
  const messages = new Map();
  messages.set('111111111111111111', [
    { id: '1001', timestamp: '2024-01-01T00:00:00.000Z', content: 'bonjour', attachments: [{ url: 'https://cdn.discordapp.com/a/piece.png', fileName: 'piece.png' }] },
    { id: '1002', timestamp: '2024-01-02T00:00:00.000Z', content: 'salut', attachments: [] },
  ]);
  messages.set('222222222222222222', [
    { id: '2001', timestamp: '2024-02-01T00:00:00.000Z', content: 'en prive', attachments: [] },
  ]);
  return {
    user: { id: USER_ID, username: 'tester', globalName: 'Testeur' },
    guilds: [{ id: '999999999999999999', name: 'Serveur' }],
    channels: [
      { id: '111111111111111111', name: 'general', type: 'SERVER_TEXT', guildId: '999999999999999999', guildName: 'Serveur', guild: { id: '999999999999999999', name: 'Serveur' }, recipient: null, isLeft: false, messagesCount: 2 },
      { id: '222222222222222222', name: null, type: 'DM', guildId: null, guildName: null, guild: null, recipient: { id: '333333333333333333', username: 'bob' }, isLeft: false, messagesCount: 1 },
    ],
    messages,
    totalMessages: 3,
    packageSizeBytes: 0,
  };
}

test('export produit une archive relisible par l import', async () => {
  const zip = exportDiscordPackage(parsedFixture());
  const parsed = await importDiscordPackage(new Blob([zip], { type: 'application/zip' }));

  assert.equal(parsed.user.id, USER_ID);
  assert.equal(parsed.user.username, 'tester');
  assert.equal(parsed.totalMessages, 3);
  assert.equal(parsed.channels.length, 2);
});

test('export respecte le layout Discord attendu', () => {
  const files = unzipSync(exportDiscordPackage(parsedFixture()));

  assert.ok(files['account/user.json'], 'account/user.json present');
  assert.ok(files['messages/c111111111111111111/channel.json'], 'channel.json par salon');
  assert.ok(files['messages/c111111111111111111/messages.json'], 'messages.json par salon');
  assert.ok(files['servers/999999999999999999/guild.json'], 'guild.json par serveur');
});

test('les identifiants 18 chiffres survivent a l aller-retour', async () => {
  // Un snowflake ecrit en nombre perd sa precision : l export doit l ecrire
  // en chaine, sinon l identifiant revient tronque a l import.
  const zip = exportDiscordPackage(parsedFixture());
  const parsed = await importDiscordPackage(new Blob([zip], { type: 'application/zip' }));

  assert.deepEqual(parsed.messages.get('111111111111111111').map(m => m.id), ['1001', '1002']);
  assert.deepEqual(parsed.guilds.map(g => g.id), ['999999999999999999']);
  const dm = parsed.channels.find(channel => channel.type === 'DM');
  assert.equal(dm.recipient.id, '333333333333333333');
});

test('contenus, pieces jointes et metadonnees sont conserves', async () => {
  const zip = exportDiscordPackage(parsedFixture());
  const parsed = await importDiscordPackage(new Blob([zip], { type: 'application/zip' }));

  const first = parsed.messages.get('111111111111111111')[0];
  assert.equal(first.content, 'bonjour');
  assert.deepEqual(first.attachments.map(a => a.url), ['https://cdn.discordapp.com/a/piece.png']);

  const server = parsed.channels.find(channel => channel.type === 'SERVER_TEXT');
  assert.equal(server.name, 'general');
  assert.equal(server.guildName, 'Serveur');
});

test('un package vide donne quand meme une archive valide', () => {
  const zip = exportDiscordPackage({ user: { id: USER_ID, username: 'tester' }, guilds: [], channels: [], messages: new Map() });
  const files = unzipSync(zip);
  assert.equal(JSON.parse(new TextDecoder().decode(files['account/user.json'])).id, USER_ID);
});