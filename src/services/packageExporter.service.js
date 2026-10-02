// Export du package charge -> archive ZIP au layout Discord.
// L'export d'avant ne produisait qu'un .json/.txt alors que l'import exige un
// ZIP : l'aller-retour etait donc impossible. Ici on reconstruit exactement ce
// que importDiscordPackage sait relire (account/, messages/, servers/).

import { zipSync, strToU8 } from '../../node_modules/fflate/esm/browser.js';

// Reprise des noms de fichiers de l'import, pour ne pas diverger d'un layout a
// l'autre : un export incompatible serait pire qu'aucun export.
const CHANNEL_FILE = 'channel.json';
const MESSAGES_JSON = 'messages.json';
const USER_FILE = 'account/user.json';
const GUILD_FILE = 'guild.json';
const INDEX_FILE = 'messages/index.json';

// Types de l'import vers les types numeriques Discord.
const TYPE_BY_KIND = { DM: 1, GROUP: 3, SERVER_TEXT: 0, THREAD: 11 };

function encode(value) {
  return strToU8(JSON.stringify(value));
}

// Le salon peut porter le lien vers son serveur de deux facons selon l'origine
// de l'import : l'objet `guild` complet, ou seulement les identifiants.
function guildOf(channel) {
  if (channel.guild) return channel.guild;
  if (channel.guildId) return { id: String(channel.guildId), name: channel.guildName };
  return null;
}

function attachmentsToText(attachments) {
  return (attachments || []).map(attachment => attachment.url).filter(Boolean).join('\n');
}

// Les identifiants Discord sont des snowflakes sur 18 chiffres : ecrits en
// nombre ils perdent leur precision au JSON.parse. Tout part donc en chaine.
function toRow(message, channelId) {
  return {
    ID: String(message.id),
    ChannelID: String(channelId),
    Timestamp: String(message.timestamp),
    Contents: typeof message.content === 'string' ? message.content : '',
    Attachments: attachmentsToText(message.attachments),
  };
}

export function exportDiscordPackage(parsed) {
  if (!parsed || !parsed.user) throw new Error('Nothing to export: no package loaded.');

  const entries = {};
  const user = {
    id: String(parsed.user.id),
    username: parsed.user.username || 'Unknown user',
  };
  if (parsed.user.globalName) user.global_name = parsed.user.globalName;
  entries[USER_FILE] = encode(user);

  const channels = parsed.channels || [];
  const names = {};
  for (const channel of channels) {
    if (channel.name) names[String(channel.id)] = channel.name;
  }
  if (Object.keys(names).length) entries[INDEX_FILE] = encode(names);

  for (const channel of channels) {
    const channelId = String(channel.id);
    const dir = `messages/c${channelId}`;
    const rows = parsed.messages.get(channelId) || [];
    const guild = guildOf(channel);
    const metadata = {
      id: channelId,
      name: channel.name || undefined,
      type: TYPE_BY_KIND[channel.type] || 0,
    };
    if (guild) metadata.guild = { id: String(guild.id), name: guild.name || undefined };
    if (channel.recipient) metadata.recipients = [{ id: String(channel.recipient.id), username: channel.recipient.username || undefined }];

    entries[`${dir}/${CHANNEL_FILE}`] = encode(metadata);
    entries[`${dir}/${MESSAGES_JSON}`] = encode(rows.map(row => toRow(row, channelId)));
  }

  const guilds = parsed.guilds || [];
  for (const guild of guilds) {
    entries[`servers/${String(guild.id)}/${GUILD_FILE}`] = encode({ id: String(guild.id), name: guild.name || undefined });
  }

  return zipSync(entries, { level: 6 });
}