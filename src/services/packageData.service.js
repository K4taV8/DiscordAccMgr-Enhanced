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

export function buildMessageSearchIndex(messages) {
  return messages.map((message, index) => ({ index, id: String(message.id), text: `${message.content || ''} ${message.author?.username || ''}`.toLocaleLowerCase() }));
}
