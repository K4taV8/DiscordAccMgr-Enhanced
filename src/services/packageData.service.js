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

// Mesure sur l export de 394 Mo : 2208 pieces jointes, dont 1778 images, 225
// videos, 161 audios et 44 fichiers ordinaires. L extension se lit sur le
// chemin, jamais sur la requete : les URL de Discord sont signees
// (?ex=&is=&hm=) et la signature contient des caracteres qui trompent une
// simple recherche du dernier point.
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'apng', 'jfif']);
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi', 'ogv']);
const AUDIO_EXT = new Set(['ogg', 'oga', 'mp3', 'opus', 'wav', 'm4a', 'flac', 'aac']);
const MAX_EXTENSION_LENGTH = 16;

export function attachmentExtension(url = '', fileName = '') {
  const source = String(fileName || url).split(/[?#]/)[0];
  let name = source.split('/').pop() || '';
  try { name = decodeURIComponent(name); } catch { /* nom mal echappe : on garde brut */ }
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '';
  const extension = name.slice(dot + 1).toLowerCase();
  // `decodeURIComponent` peut rendre un segment qui contient « / », « \ » ou
  // « .. » (ex. `%2F` decode) : ce n'est pas une extension, c'est une tentative
  // de traversee. On refuse aussi les extensions absurdement longues.
  if (extension.length === 0 || extension.length > MAX_EXTENSION_LENGTH) return '';
  if (/[/\\]/.test(extension) || extension.includes('..')) return '';
  return extension;
}

export function attachmentKind(url, fileName = '') {
  const ext = attachmentExtension(url, fileName);
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  return 'file';
}

export function buildMessageSearchIndex(messages) {
  return messages.map((message, index) => ({ index, id: String(message.id), text: `${message.content || ''} ${message.author?.username || ''}`.toLocaleLowerCase() }));
}
