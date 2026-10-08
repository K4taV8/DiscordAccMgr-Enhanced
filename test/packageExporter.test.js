import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, zipSync, strToU8 } from '../node_modules/fflate/esm/browser.js';
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

// --- B3 : l'export perdait l'avatar du compte et les icones de salons/serveurs.
// L'import lit `avatar_hash`, `icon` et le `avatar` du recipient : l'aller-retour
// doit les restituer a l'identique.
test('avatars et icones survivent a l aller-retour ZIP', async () => {
  const source = parsedFixture();
  source.guilds = [{ id: '999999999999999999', name: 'Serveur', icon: 'https://cdn.discordapp.com/icons/999999999999999999/0123456789abcdef0123456789abcdef.png?size=128' }];
  source.user.avatar = `https://cdn.discordapp.com/avatars/${USER_ID}/a95b780ee6a221f82fca3dea0de7ad6b.png?size=128`;
  source.channels = [
    { ...source.channels[0], avatar: 'https://cdn.discordapp.com/channel-icons/111111111111111111/fedcba9876543210fedcba9876543210.png?size=64' },
    { ...source.channels[1], recipient: { id: '333333333333333333', username: 'bob', avatar: 'https://cdn.discordapp.com/avatars/333333333333333333/aabbccddeeff00112233445566778899.png?size=64' } },
  ];

  const zip = exportDiscordPackage(source);
  const files = unzipSync(zip);
  const decode = name => JSON.parse(new TextDecoder().decode(files[name]));

  assert.equal(decode('account/user.json').avatar_hash, 'a95b780ee6a221f82fca3dea0de7ad6b', 'le hash d avatar est reexporte');
  assert.equal(decode('messages/c111111111111111111/channel.json').icon, 'fedcba9876543210fedcba9876543210', 'l icone de salon est reexportee');
  assert.equal(decode('servers/999999999999999999/guild.json').icon, '0123456789abcdef0123456789abcdef', 'l icone de serveur est reexportee');
  assert.equal(decode('messages/c222222222222222222/channel.json').recipients[0].avatar, 'aabbccddeeff00112233445566778899', 'l avatar du recipient est reexporte');

  const parsed = await importDiscordPackage(new Blob([zip], { type: 'application/zip' }));

  assert.equal(parsed.user.avatar, source.user.avatar, 'l avatar du compte est identique apres l aller-retour');
  assert.equal(parsed.guilds[0].icon, source.guilds[0].icon, 'l icone du serveur est identique');
  const server = parsed.channels.find(channel => channel.id === '111111111111111111');
  assert.equal(server.avatar, source.channels[0].avatar, 'l avatar du salon est identique');
  const dm = parsed.channels.find(channel => channel.id === '222222222222222222');
  assert.equal(dm.recipient.avatar, source.channels[1].recipient.avatar, 'l avatar du correspondant est identique');
});

// --- S1 : les membres d un groupe etaient perdus a l export. L import ne
// memorisait que `channel.recipient` (le partenaire), et l export ecrivait
// `metadata.recipients = [recipient]` : sur un GROUP_DM, les AUTRES membres
// disparaissaient au round-trip. L import memorise desormais la liste complete
// (`channel.recipients`) et l export la reecrit telle quelle.
test('un groupe a 3 membres survit a un aller-retour import puis export', async () => {
  const groupe = zipSync({
    'Compte/user.json': strToU8(JSON.stringify({ id: USER_ID, username: 'tester' })),
    'Messages/c111111111111111111/channel.json': strToU8(JSON.stringify({
      id: '111111111111111111',
      type: 'GROUP_DM',
      recipients: [
        { id: '222222222222222222', username: 'alice' },
        { id: '333333333333333333', username: 'bob' },
        { id: '444444444444444444', username: 'carol' },
      ],
    })),
    'Messages/c111111111111111111/messages.json': strToU8(JSON.stringify([
      { ID: '1', Timestamp: '2024-01-01T00:00:00.000Z', Contents: 'salut le groupe', Attachments: '' },
    ])),
  });

  const importe = await importDiscordPackage(new Blob([groupe], { type: 'application/zip' }));
  const group = importe.channels.find(channel => channel.type === 'GROUP');
  assert.ok(group, 'le groupe est importe');
  assert.equal(group.recipient.id, '222222222222222222', 'le partenaire reste disponible pour l IHM');
  assert.equal(group.recipients.length, 3, 'la liste COMPLETE des destinataires est memorisee a l import');

  const reexporte = exportDiscordPackage(importe);
  const files = unzipSync(reexporte);
  const metadata = JSON.parse(new TextDecoder().decode(files['messages/c111111111111111111/channel.json']));
  assert.equal(metadata.recipients.length, 3, 'les 3 recipients sont ecrits a l export, pas seulement le partenaire');
  assert.deepEqual(
    metadata.recipients.map(recipient => recipient.id).sort(),
    ['222222222222222222', '333333333333333333', '444444444444444444'],
    'les 3 membres sont les bons',
  );

  const relu = await importDiscordPackage(new Blob([reexporte], { type: 'application/zip' }));
  const groupeRelu = relu.channels.find(channel => channel.type === 'GROUP');
  assert.equal(groupeRelu.recipients.length, 3, 'les 3 membres survivent au round-trip complet');
});

