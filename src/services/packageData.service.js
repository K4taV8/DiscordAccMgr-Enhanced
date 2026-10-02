function cleanName(value) {
  return String(value || '').replace(/^direct message with\s*/i, '').replace(/^dm with\s*/i, '').replace(/^unknown channel(?: in .*)?$/i, '').trim();
}

export function profileAvatar(user) {
  if (!user?.id || !user?.avatar) return null;
  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${String(user.avatar).startsWith('a_') ? 'gif' : 'png'}?size=128`;
}

export function hydratePackageIdentity(rawUser = {}, users = {}) {
  const id = String(rawUser.id || rawUser.user_id || '');
  return { id, username: rawUser.username || rawUser.name || 'Utilisateur inconnu', globalName: rawUser.global_name || rawUser.globalName || null, discriminator: rawUser.discriminator || null, avatar: profileAvatar({ id, avatar: rawUser.avatar || rawUser.avatar_hash }) };
}

export function hydrateChannel(raw = {}, name = '') {
  const type = Number(raw.type);
  const resolvedName = cleanName(raw.name || name);
  const recipient = raw.recipients?.[0] || raw.recipient;
  return {
    id: String(raw.id || raw.channel_id || ''),
    name: resolvedName || (type === 1 ? `@${recipient?.username || 'Utilisateur inconnu'}` : `Salon ${raw.id || 'inconnu'}`),
    type: type === 1 ? 'DM' : type === 3 ? 'GROUP' : 'SERVER_TEXT',
    guildId: raw.guild?.id || raw.guild_id || null,
    guildName: raw.guild?.name || raw.guild_name || null,
    isLeft: type === 0 && !raw.guild,
    recipient: recipient ? { id: String(recipient.id || recipient.user_id || ''), username: recipient.username || recipient.name || null, avatar: profileAvatar(recipient) } : null,
  };
}

// Notification systeme : message sans texte ET sans piece jointe. Discord
// ecrase "Contents" pour ces lignes (notifications d'appel, appel manque,
// arrivee dans un serveur...) : l'export ne contient ni le texte ni l'appelant,
// que l'identifiant et l'horodatage. Le client Discord, lui, sait les rendre
// parce qu'il garde ces metadonnees ailleurs.
export function isSystemNotification(message) {
  if (!message) return false;
  const text = String(message.content ?? '').trim();
  const attachments = Array.isArray(message.attachments) ? message.attachments.length : 0;
  return text === '' && attachments === 0;
}

export function countSystemNotifications(messages) {
  let count = 0;
  for (const message of messages || []) if (isSystemNotification(message)) count += 1;
  return count;
}

export function buildMessageSearchIndex(messages) {
  return messages.map((message, index) => ({ index, id: String(message.id), text: `${message.content || ''} ${message.author?.username || ''}`.toLocaleLowerCase() }));
}
