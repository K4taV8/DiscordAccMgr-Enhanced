import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from '../node_modules/fflate/esm/browser.js';
import { importDiscordPackage, normalizeChannelType } from '../src/services/packageImporter.service.js';

// Un export Discord de 394 Mo echouait avec « Array buffer allocation failed » :
// l'archive etait lue d'un bloc (file.arrayBuffer) puis decompressee entierement
// en memoire (unzipSync). On lit donc desormais le fichier PAR BLOCS. Ce test
// verrouille ce contrat : un fichier qui n'expose QUE slice() doit suffire.
// (Un vrai File/Blob expose les deux ; ne garder que slice() prouve qu'on ne
//depend plus d'une allocation globale.)

const USER_ID = '123456789012345678';

function buildDiscordZip() {
  return zipSync({
    'account/user.json': strToU8(JSON.stringify({ id: USER_ID, username: 'tester', global_name: 'Testeur' })),
    'messages/index.json': strToU8(JSON.stringify({ '111111111111111111': 'general' })),
    'messages/c111111111111111111/channel.json': strToU8(JSON.stringify({ id: '111111111111111111', name: 'general', type: 0, guild: { id: '999999999999999999', name: 'Serveur' } })),
    'messages/c111111111111111111/messages.json': strToU8(JSON.stringify([
      { ID: '1001', Timestamp: '2024-01-01T00:00:00.000Z', Contents: 'bonjour', Attachments: '' },
      { ID: '1002', Timestamp: '2024-01-02T00:00:00.000Z', Contents: 'salut', Attachments: '' },
    ])),
    'messages/c222222222222222222/channel.json': strToU8(JSON.stringify({ id: '222222222222222222', type: 1, recipients: [{ id: '333333333333333333', username: 'bob' }] })),
    'messages/c222222222222222222/messages.json': strToU8(JSON.stringify([
      { ID: '2001', Timestamp: '2024-02-01T00:00:00.000Z', Contents: 'en prive', Attachments: '' },
    ])),
    'servers/999999999999999999/guild.json': strToU8(JSON.stringify({ id: '999999999999999999', name: 'Serveur' })),
    'programs/ignored.json': strToU8('{"noise":true}'),
  });
}

// Regression : les fixtures ci-dessus ecrivaient ID en CHAINE, ce que ne fait
// jamais Discord. Sur le vrai export, ID et ChannelID sont en MAJUSCULES et
// sans guillemets. Un snowflake de 18-19 chiffres lu comme nombre depasse la
// precision du double : il revenait arrondi, et la suppression visait ensuite
// un message inexistant. Ce ZIP reproduit le format reel, indentation comprise.
//
// Le JSON est ecrit en texte brut, PAS via JSON.stringify : un literal
// numerique de 18 chiffres serait deja arrondi par le moteur avant meme
// d'arriver dans l'archive.
function buildRealisticDiscordZip() {
  const messages = `[
  {
    "ID": 790275834681622598,
    "ChannelID": 1327342698700738652,
    "Timestamp": "2020-12-20 17:54:01",
    "Contents": "bonjour",
    "Attachments": ""
  },
  {
    "ID": 1009136231751360593,
    "ChannelID": 1327342698700738652,
    "Timestamp": "2026-04-24 11:13:52",
    "Contents": "appel manque",
    "Attachments": ""
  },
  {
    "ID": 771740196185964555,
    "ChannelID": 1327342698700738652,
    "Timestamp": "2021-01-02 03:04:05",
    "Contents": "troisieme",
    "Attachments": ""
  }
]`;
  const channel = `{
  "id": 1327342698700738652,
  "type": 1,
  "name": "bob",
  "recipients": [
    {
      "id": 333333333333333333,
      "username": "bob"
    }
  ]
}`;
  return zipSync({
    'Compte/user.json': strToU8('{\n  "id": 123456789012345678,\n  "username": "tester",\n  "global_name": "Testeur"\n}'),
    'Messages/index.json': strToU8('{\n  "1327342698700738652": "bob"\n}'),
    'Messages/c1327342698700738652/channel.json': strToU8(channel),
    'Messages/c1327342698700738652/messages.json': strToU8(messages),
  });
}

test('les snowflakes en majuscules et sans guillemets survivent a l import', async () => {
  const parsed = await importDiscordPackage(new Blob([buildRealisticDiscordZip()], { type: 'application/zip' }));

  const ids = parsed.messages.get('1327342698700738652').map(message => message.id);
  assert.deepEqual(ids, ['790275834681622598', '1009136231751360593', '771740196185964555'], 'aucun identifiant arrondi');
  assert.ok(ids.every(id => /^\d{18,19}$/.test(id)), 'toujours 18 ou 19 chiffres');
});

test('le layout francais majuscule est accepte comme le layout anglais', async () => {
  const parsed = await importDiscordPackage(new Blob([buildRealisticDiscordZip()], { type: 'application/zip' }));
  assert.equal(parsed.channels.length, 1, 'un seul salon');
  assert.equal(parsed.channels[0].id, '1327342698700738652', 'l identifiant du salon reste exact');
  assert.equal(parsed.messages.get('1327342698700738652').length, 3, 'les messages sont rattaches');
});

// Sans ce correctif, le dernier chiffre du premier message passait de 8 a 0 :
// c etait invisible tant que les fixtures ecrivaient les ID en chaine.
test('le format reel de Discord ne perd pas le dernier chiffre', async () => {
  const parsed = await importDiscordPackage(new Blob([buildRealisticDiscordZip()], { type: 'application/zip' }));
  const [premier] = parsed.messages.get('1327342698700738652');
  assert.ok(premier.id.endsWith('598'), `identifiant intact attendu, obtenu ${premier.id}`);
  assert.notEqual(premier.id, '790275834681622700', 'et non sa version arrondie');
});

function chunkOnlyFile(bytes, name = 'package.zip') {
  const blob = new Blob([bytes]);
  return {
    name,
    size: blob.size,
    type: 'application/zip',
    slice(start, end) { return blob.slice(start, end); },
  };
}

test('l import lit le fichier par blocs, sans allocation globale', async () => {
  const parsed = await importDiscordPackage(chunkOnlyFile(buildDiscordZip()));
  assert.equal(parsed.user.id, USER_ID);
});

test('un fichier trop petit pour un bloc est lu quand meme', async () => {
  // Un export minuscule tient largement dans un seul bloc : la boucle ne doit
  // pas boucler indefiniment ni oublier de signaler la fin du flux.
  const parsed = await importDiscordPackage(chunkOnlyFile(buildDiscordZip(), 'tiny.zip'));
  assert.equal(parsed.channels.length, 2);
});

test('un vrai Blob donne toujours le package complet', async () => {
  const parsed = await importDiscordPackage(new Blob([buildDiscordZip()], { type: 'application/zip' }));

  assert.equal(parsed.user.username, 'tester');
  assert.equal(parsed.user.globalName, 'Testeur');
  assert.equal(parsed.channels.length, 2);

  // Trié par volume de messages décroissant.
  assert.equal(parsed.channels[0].id, '111111111111111111');
  assert.equal(parsed.channels[0].name, 'general');
  assert.equal(parsed.channels[0].type, 'SERVER_TEXT');
  assert.equal(parsed.channels[0].messagesCount, 2);

  const dm = parsed.channels.find(channel => channel.type === 'DM');
  assert.equal(dm.recipient.username, 'bob');
  assert.equal(dm.messagesCount, 1);

  assert.deepEqual(parsed.guilds, [{ id: '999999999999999999', name: 'Serveur', icon: null }]);
  assert.equal(parsed.totalMessages, 3);

  const messages = parsed.messages.get('111111111111111111');
  assert.equal(messages.length, 2);
  assert.equal(messages[0].id, '1001');
  assert.equal(messages[0].content, 'bonjour');
});

test('un dossier racine optionnel (prefixe) reste gere', async () => {
  const zip = zipSync({
    'export-2024/account/user.json': strToU8(JSON.stringify({ id: USER_ID, username: 'tester' })),
    'export-2024/messages/c111111111111111111/channel.json': strToU8(JSON.stringify({ id: '111111111111111111', type: 3 })),
    'export-2024/messages/c111111111111111111/messages.csv': strToU8('ID,Timestamp,Contents,Attachments\n3001,2024-03-01T00:00:00.000Z,en groupe,\n'),
  });

  const parsed = await importDiscordPackage(chunkOnlyFile(zip));

  assert.equal(parsed.user.id, USER_ID);
  assert.equal(parsed.channels.length, 1);
  assert.equal(parsed.channels[0].type, 'GROUP');
  assert.equal(parsed.messages.get('111111111111111111')[0].content, 'en groupe');
});

test('les fichiers de bruit (__MACOSX, ._) sont ignores', async () => {
  const zip = zipSync({
    '__MACOSX/._account': strToU8('bruit'),
    'account/user.json': strToU8(JSON.stringify({ id: USER_ID, username: 'tester' })),
  });

  const parsed = await importDiscordPackage(chunkOnlyFile(zip));

  assert.equal(parsed.user.id, USER_ID);
});

test('une archive non zip est rejetee proprement', async () => {
  await assert.rejects(
    () => importDiscordPackage(chunkOnlyFile(new TextEncoder().encode('ceci n est pas un zip'))),
    /Unable to read ZIP archive/,
  );
});

test('un fichier sans tranche lisible est refuse', async () => {
  await assert.rejects(
    () => importDiscordPackage({ name: 'x.zip', size: 10 }),
    /A ZIP file is required/,
  );
});
// --- Types, recipients et avatars : le format reel de l'archive Discord ------
// Verifie dans un vrai export de 394 Mo : `channel.json` utilise des CHAINS
// pour le type ("DM", "GUILD_TEXT") et des IDS EN TEXTE pour les recipients
// (["134007...", "74778..."]). L'archive traduite ne contient AUCUNE donnee
// d'auteur : l'attribution par message est donc impossible, ce n'est pas un bug.

test('le type de salon peut etre une chaine, pas un nombre', async () => {
  const zip = zipSync({
    'Compte/user.json': strToU8(JSON.stringify({ id: USER_ID, username: 'tester' })),
    'Messages/c111111111111111111/channel.json': strToU8(JSON.stringify({ id: '111111111111111111', type: 'DM', recipients: ['222222222222222222', USER_ID] })),
    'Messages/c111111111111111111/messages.json': strToU8(JSON.stringify([{ ID: '1', Timestamp: '2024-01-01T00:00:00.000Z', Contents: 'coucou', Attachments: '' }])),
    'Messages/c222222222222222222/channel.json': strToU8(JSON.stringify({ id: '222222222222222222', type: 'GUILD_TEXT', name: 'general', guild: { id: '333333333333333333', name: 'Serveur' } })),
    'Messages/c222222222222222222/messages.json': strToU8(JSON.stringify([])),
  });

  const parsed = await importDiscordPackage(chunkOnlyFile(zip));
  const dm = parsed.channels.find(channel => channel.id === '111111111111111111');
  const server = parsed.channels.find(channel => channel.id === '222222222222222222');

  assert.equal(dm.type, 'DM', 'un MP reste un MP');
  assert.equal(server.type, 'SERVER_TEXT', 'un salon de serveur reste un salon de serveur');
});

test('les recipients lus comme ids en texte donnent le partenaire du MP', async () => {
  const zip = zipSync({
    'Compte/user.json': strToU8(JSON.stringify({ id: USER_ID, username: 'tester' })),
    'Messages/c111111111111111111/channel.json': strToU8(JSON.stringify({ id: '111111111111111111', type: 'DM', recipients: ['222222222222222222', USER_ID] })),
    'Messages/c111111111111111111/messages.json': strToU8(JSON.stringify([])),
  });

  const parsed = await importDiscordPackage(chunkOnlyFile(zip));

  assert.equal(parsed.channels[0].recipient.id, '222222222222222222', 'le partenaire est identifié');
});

test('un utilisateur supprime reste affiche avec son nom', async () => {
  const zip = zipSync({
    'Compte/user.json': strToU8(JSON.stringify({ id: USER_ID, username: 'tester' })),
    'Messages/c111111111111111111/channel.json': strToU8(JSON.stringify({ id: '111111111111111111', type: 'DM', recipients: ['Utilisateur supprimé', USER_ID] })),
    'Messages/c111111111111111111/messages.json': strToU8(JSON.stringify([])),
  });

  const parsed = await importDiscordPackage(chunkOnlyFile(zip));

  assert.equal(parsed.channels[0].recipient.username, 'Utilisateur supprimé');
});

test('l avatar du compte exporte est lu et transforme en URL CDN', async () => {
  const zip = zipSync({
    'Compte/user.json': strToU8(JSON.stringify({ id: USER_ID, username: 'tester', avatar_hash: 'a95b780ee6a221f82fca3dea0de7ad6b' })),
    'Messages/c111111111111111111/channel.json': strToU8(JSON.stringify({ id: '111111111111111111', type: 'DM', recipients: ['222222222222222222', USER_ID] })),
    'Messages/c111111111111111111/messages.json': strToU8(JSON.stringify([])),
  });

  const parsed = await importDiscordPackage(chunkOnlyFile(zip));

  assert.equal(parsed.user.avatar, `https://cdn.discordapp.com/avatars/${USER_ID}/a95b780ee6a221f82fca3dea0de7ad6b.png?size=128`);
});

test('les noms de remplacement de Discord sont ignores', async () => {
  const zip = zipSync({
    'Compte/user.json': strToU8(JSON.stringify({ id: USER_ID, username: 'tester' })),
    'Messages/index.json': strToU8(JSON.stringify({ '111111111111111111': 'Salon inconnu' })),
    'Messages/c111111111111111111/channel.json': strToU8(JSON.stringify({ id: '111111111111111111', type: 'DM', recipients: ['222222222222222222', USER_ID] })),
    'Messages/c111111111111111111/messages.json': strToU8(JSON.stringify([])),
  });

  const parsed = await importDiscordPackage(chunkOnlyFile(zip));

  assert.equal(parsed.channels[0].name, null, '« Salon inconnu » ne doit pas devenir le nom affiche');
});

test('un vrai nom de salon et de serveur est conserve', async () => {
  const zip = zipSync({
    'Compte/user.json': strToU8(JSON.stringify({ id: USER_ID, username: 'tester' })),
    'Messages/index.json': strToU8(JSON.stringify({ '222222222222222222': 'Salon inconnu, Les Pangolins' })),
    'Messages/c222222222222222222/channel.json': strToU8(JSON.stringify({ id: '222222222222222222', type: 'GUILD_TEXT', name: 'general', guild: { id: '333333333333333333', name: 'Les Pangolins' } })),
    'Messages/c222222222222222222/messages.json': strToU8(JSON.stringify([])),
    'Serveurs/333333333333333333/guild.json': strToU8(JSON.stringify({ id: '333333333333333333', name: 'Les Pangolins', icon: 'abc123' })),
  });

  const parsed = await importDiscordPackage(chunkOnlyFile(zip));
  const channel = parsed.channels[0];

  assert.equal(channel.name, 'general', 'le vrai nom de channel.json prime');
  assert.equal(channel.guildName, 'Les Pangolins');
  assert.equal(parsed.guilds[0].name, 'Les Pangolins');
});
// --- Noms de MP : Discord prefixe le nom dans l'index.json ------------------
// Mesure sur ton export : 347 MP sur 347 ont un nom dans index.json, sous la
// forme « Message prive avec <pseudo> ». Le nettoyage ne visait que la forme
// anglaise (« direct message with »), donc l'app affichait le prefixe entier.

test('le prefixe du nom d un MP est retire', async () => {
  const zip = zipSync({
    'Compte/user.json': strToU8(JSON.stringify({ id: USER_ID, username: 'tester' })),
    'Messages/index.json': strToU8(JSON.stringify({ '111111111111111111': 'Message privé avec maliksync' })),
    'Messages/c111111111111111111/channel.json': strToU8(JSON.stringify({ id: '111111111111111111', type: 'DM', recipients: ['222222222222222222', USER_ID] })),
    'Messages/c111111111111111111/messages.json': strToU8(JSON.stringify([])),
  });

  const parsed = await importDiscordPackage(chunkOnlyFile(zip));

  assert.equal(parsed.channels[0].name, 'maliksync', 'seul le pseudo reste');
});

test('la forme anglaise du prefixe est retiree aussi', async () => {
  const zip = zipSync({
    'Compte/user.json': strToU8(JSON.stringify({ id: USER_ID, username: 'tester' })),
    'Messages/index.json': strToU8(JSON.stringify({ '111111111111111111': 'Direct Message with heropete9730' })),
    'Messages/c111111111111111111/channel.json': strToU8(JSON.stringify({ id: '111111111111111111', type: 'DM', recipients: ['222222222222222222', USER_ID] })),
    'Messages/c111111111111111111/messages.json': strToU8(JSON.stringify([])),
  });

  const parsed = await importDiscordPackage(chunkOnlyFile(zip));

  assert.equal(parsed.channels[0].name, 'heropete9730');
});

test('un participant inconnu ne devient pas un nom de MP', async () => {
  const zip = zipSync({
    'Compte/user.json': strToU8(JSON.stringify({ id: USER_ID, username: 'tester' })),
    'Messages/index.json': strToU8(JSON.stringify({ '111111111111111111': 'Message privé avec Participant(e) inconnu(e)' })),
    'Messages/c111111111111111111/channel.json': strToU8(JSON.stringify({ id: '111111111111111111', type: 'DM', recipients: ['222222222222222222', USER_ID] })),
    'Messages/c111111111111111111/messages.json': strToU8(JSON.stringify([])),
  });

  const parsed = await importDiscordPackage(chunkOnlyFile(zip));

  assert.equal(parsed.channels[0].name, null, '« Participant(e) inconnu(e) » n est pas un nom');
});
test('un nom d index exploitable prime sur un correspondant supprime', async () => {
  // Mesure sur l export reel : 61 MP portaient « Utilisateur supprime » comme
  // nom de destinataire, ce qui masquait le vrai pseudo de index.json.
  const zip = zipSync({
    'Compte/user.json': strToU8(JSON.stringify({ id: USER_ID, username: 'tester' })),
    'Messages/index.json': strToU8(JSON.stringify({ '111111111111111111': 'Message privé avec maliksync' })),
    'Messages/c111111111111111111/channel.json': strToU8(JSON.stringify({ id: '111111111111111111', type: 'DM', recipients: ['Utilisateur supprimé', USER_ID] })),
    'Messages/c111111111111111111/messages.json': strToU8(JSON.stringify([])),
  });

  const parsed = await importDiscordPackage(chunkOnlyFile(zip));

  assert.equal(parsed.channels[0].name, 'maliksync');
  assert.equal(parsed.channels[0].recipient.username, 'Utilisateur supprimé', 'le destinataire reste identifiable');
});

test('un nom de salon prefixe d un libelle de remplacement est ecarte', async () => {
  const zip = zipSync({
    'Compte/user.json': strToU8(JSON.stringify({ id: USER_ID, username: 'tester' })),
    'Messages/index.json': strToU8(JSON.stringify({ '222222222222222222': 'Salon inconnu, Les Pangolins' })),
    'Messages/c222222222222222222/channel.json': strToU8(JSON.stringify({ id: '222222222222222222', type: 'GUILD_TEXT', guild: { id: '333333333333333333', name: 'Les Pangolins' } })),
    'Messages/c222222222222222222/messages.json': strToU8(JSON.stringify([])),
  });

  const parsed = await importDiscordPackage(chunkOnlyFile(zip));

  assert.equal(parsed.channels[0].name, null, '« Salon inconnu, … » n est pas un nom de salon');
});
// Les fils (10 annonce de fil, 11 public, 12 prive) etaient classes comme des
// salons de serveur : l outil les affichait comme des canaux ordinaires et
// ignorait qu un fil archive refuse toute suppression.
test('les fils sont distingues des salons de serveur', () => {
  assert.equal(normalizeChannelType(11), 'THREAD', 'fil public');
  assert.equal(normalizeChannelType(12), 'THREAD', 'fil prive');
  assert.equal(normalizeChannelType(10), 'THREAD', "fil d'annonce");
  assert.equal(normalizeChannelType('GUILD_PUBLIC_THREAD'), 'THREAD');
  assert.equal(normalizeChannelType(0), 'SERVER_TEXT', 'un vrai salon reste un salon');
  assert.equal(normalizeChannelType(1), 'DM');
  assert.equal(normalizeChannelType(3), 'GROUP');
});

test('un fil exporte est relu comme un fil, rattache a son serveur', async () => {
  // Ecrit en texte brut : un litteral numerique de 18 chiffres serait deja
  // arrondi par le moteur avant d'arriver dans l'archive.
  const zip = zipSync({
    'Compte/user.json': strToU8('{\n  "id": 123456789012345678,\n  "username": "tester"\n}'),
    'Messages/index.json': strToU8('{\n  "222222222222222222": "FreeTheAI"\n}'),
    'Messages/c222222222222222222/channel.json': strToU8('{\n  "id": 222222222222222222,\n  "name": "FreeTheAI",\n  "type": 11,\n  "guild": {\n    "id": 999999999999999999,\n    "name": "Serveur"\n  }\n}'),
    'Messages/c222222222222222222/messages.json': strToU8('[\n  {\n    "ID": 1009136231751360593,\n    "ChannelID": 222222222222222222,\n    "Timestamp": "2026-04-24 11:13:52",\n    "Contents": "salut",\n    "Attachments": ""\n  }\n]'),
    'Serveurs/999999999999999999/guild.json': strToU8('{\n  "id": 999999999999999999,\n  "name": "Serveur"\n}'),
  });
  const parsed = await importDiscordPackage(new Blob([zip], { type: 'application/zip' }));
  const thread = parsed.channels.find(channel => channel.id === '222222222222222222');
  assert.ok(thread, 'le fil est present dans la liste');
  assert.equal(thread.type, 'THREAD');
  assert.equal(thread.guildName, 'Serveur', 'le fil reste rattache a son serveur');
  assert.equal(parsed.messages.get('222222222222222222').length, 1, 'ses messages lui sont rattaches');
});

test('les deux index.json de l archive sont fusionnes', async () => {
  // Ton export contient Serveurs/index.json (petit, lu en premier) ET
  // Messages/index.json. Prendre le premier faisait perdre tous les noms de MP.
  const zip = zipSync({
    'Compte/user.json': strToU8(JSON.stringify({ id: USER_ID, username: 'tester' })),
    'Serveurs/index.json': strToU8(JSON.stringify({ '333333333333333333': 'Les Pangolins' })),
    'Messages/index.json': strToU8(JSON.stringify({ '111111111111111111': 'Message privé avec maliksync' })),
    'Messages/c111111111111111111/channel.json': strToU8(JSON.stringify({ id: '111111111111111111', type: 'DM', recipients: ['222222222222222222', USER_ID] })),
    'Messages/c111111111111111111/messages.json': strToU8(JSON.stringify([])),
  });

  const parsed = await importDiscordPackage(chunkOnlyFile(zip));

  assert.equal(parsed.channels[0].name, 'maliksync', 'le nom du MP est retrouve');
});