// Import d'un export Discord (ZIP) — traitement 100 % local.
//
// DEUX CONTRAINTES APPRISES SUR UN VRAI EXPORT (394 Mo) :
//
// 1. L'archive est TRADUITE. Les dossiers s'appellent « Compte », « Messages »,
//    « Serveurs », « Activité »… Rien ne peut être codé en dur : on localise les
//    sections par motif, jamais par nom de dossier.
// 2. « Activité/reporting/events-…json » décompresse à 4 Go. Il IGNORE ce que
//    fait l'app : le charger tuait le renderer (fenêtre morte, même Ctrl+R ne
//    répondait plus). Donc : dossiers de bruit détectés sans accents, ET plafond
//    dur par fichier — au-delà on jette au fil de l'eau sans jamais accumuler.
//
// Le reste : lecture par blocs (plus de lecture globale d'un bloc), chaque
// entrée est parsée puis jetée, les messages retenus sont ceux que l'UI affiche.
//
// Pièges de l'API fflate, vérifiés empiriquement :
//   1. entry.ondata doit être posé AVANT entry.start(), sinon « no stream
//      handler » ;
//   2. sans entry.start(), rien n'est émis pour ce fichier.

import { Unzip, UnzipInflate, strFromU8 } from '../../node_modules/fflate/esm/browser.js';

const CHUNK_BYTES = 4 * 1024 * 1024;
// Plafond par entrée : les vrais messages.json font ~1 Mo. Au-delà, c'est du
// bruit (« Activité », « Publicités ») et on refuse de le monter en mémoire.
// Exporté pour que le test d'égalité croisée puisse comparer CE NOMBRE dans les
// deux copies : sans lui, relever le plafond du renderer seul ne rougissait
// aucun test, et le chemin par index gardait alors des entrées que le flux
// rejette — de la donnée perdue en silence.
export const MAX_ENTRY_BYTES = 128 * 1024 * 1024;

const USER_NAME = 'user.json';
const INDEX_NAME = 'index.json';
const GUILD_NAME = 'guild.json';
const CHANNEL_NAME = 'channel.json';

// Discord ecrit messages.json avec ID et ChannelID EN MAJUSCULES et sans
// guillemets. Un snowflake tient sur 18-19 chiffres : lu comme nombre il
// depasse la precision du double et se retrouve arrondi, ce qui vise ensuite
// un message inexistant. On les met donc en texte avant le JSON.parse.
// La casse est ignoree et le separateur optionnel, sinon les champs reels de
// Discord (ID, ChannelID) echappaient a la protection : elle ne s'appliquait
// qu aux noms minuscules de nos propres fixtures.
// Exporte, comme les motifs ci-dessous, pour le test de parite : la copie CJS du
// main process (electron/packageImporter.parse.cjs) porte la MEME chaine, et
// sans comparaison directe un champ retire d un seul cote cesserait d etre
// protege sans rougir aucun test. Export pur, aucun changement de comportement.
export const SNOWFLAKE_FIELDS = 'id|channel_?id|guild_?id|user_?id|message_?id|owner_?id|recipient_?id';
const SNOWFLAKE_JSON_RE = new RegExp(`([{,]\\s*)"(${SNOWFLAKE_FIELDS})":\\s*(\\d+)(?=\\s*[,}\\]])`, 'gi');

// Sections localisées par motif, quelle que soit la langue de l'archive.
// Les trois motifs sont exportes pour le test de parite des parseurs : le chemin
// par index en a une copie (electron/packageImporter.parse.cjs), et c'est le
// seul moyen de comparer les deux sur des CAS sans monter une archive entiere.
// Export pur, aucun changement de comportement.
export const CHANNEL_ENTRY = /(?:^|\/)(c?\d+)\/channel\.json$/i;
export const MESSAGES_ENTRY = /(?:^|\/)(c?\d+)\/messages\.(?:json|csv)$/i;
export const GUILD_ENTRY = /(?:^|\/)(\d+)\/guild\.json$/i;

// Repertoires sans rapport avec les messages. Comparaison sur le segment
// normalise (minuscules, sans accents ni ponctuation) : « Activité », « Activités »,
// « Activities », « activities_e », « Publicités », « programs » tombent tous ici.
const NOISE_PREFIXES = [
  'activit', 'publicit', 'demandesdesupport', 'demandesdesoutien', 'demandesupport',
  'program', 'advertisement', 'ads', 'ticket', 'supportticket', 'supportrequests',
];

export class PackageImportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PackageImportError';
  }
}

function normalizeSegment(segment) {
  return segment
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

export function isNoisePath(path) {
  const lower = path.toLowerCase();
  const name = lower.split('/').pop() || '';
  if (lower.startsWith('__macosx/') || name.startsWith('._') || name === '.ds_store') return true;
  // BUG-009 : le bruit de l'export est TOUJOURS un dossier de premier niveau
  // (Activite, Publicites, Demandes de soutien...). En ne testant que le premier
  // segment, un fichier legitime comme Comptes/activation.json n'est plus ecarte
  // a tort parce que son nom commence par un prefixe de bruit (« activit »).
  const first = normalizeSegment(lower.split('/')[0] || '');
  return first !== '' && NOISE_PREFIXES.some(prefix => first.startsWith(prefix));
}

// « c123456 » et « 123456 » désignent le même salon.
export function channelKey(id) {
  return String(id).replace(/^c/i, '');
}

// --- Format reel de l'archive (verifie sur un export de 394 Mo) -------------
// `channel.json` ecrit le type comme une CHAINE ("DM", "GUILD_TEXT",
// "GROUP_DM") et les recipients comme des IDS EN TEXTE (["222", "747..."]).
// L'ancienne version faisait Number(type) -> NaN, donc tous les MP etaient
// affiches comme des salons de serveur.
export function normalizeChannelType(rawType) {
  if (typeof rawType === 'string') {
    const key = rawType.trim().toUpperCase();
    if (key === 'DM') return 'DM';
    if (key === 'GROUP_DM' || key === 'GROUP') return 'GROUP';
    if (key.startsWith('GUILD_') && key.endsWith('THREAD')) return 'THREAD';
    return 'SERVER_TEXT';
  }
  const numeric = Number(rawType);
  if (numeric === 1) return 'DM';
  if (numeric === 3) return 'GROUP';
  // 10 annonce de fil, 11 fil public, 12 fil prive. Ces trois etaient.classes
  // comme des salons de serveur : l outil affichait des fils comme des canaux
  // ordinaires, et ignorait qu un fil archive refuse toute suppression.
  if (numeric === 10 || numeric === 11 || numeric === 12) return 'THREAD';
  return 'SERVER_TEXT';
}

// Un recipient peut etre un objet (export anglais) ou un id en texte, voire un
// nom (« Utilisateur supprimé ») quand Discord ne retrouve plus la personne.
export function normalizeRecipients(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(item => {
      if (typeof item === 'string') {
        const value = item.trim();
        return /^\d+$/.test(value)
          ? { id: value, username: null, avatar: cdnAvatar(value, null) }
          : { id: '', username: value || null, avatar: null };
      }
      if (item && typeof item === 'object') {
        const id = String(item.id || '');
        const avatar = item.avatar ? cdnAvatar(id, item.avatar, 64) : null;
        return { id, username: item.username || item.global_name || null, avatar };
      }
      return null;
    })
    .filter(Boolean);
}

// Discord remplit les noms qu'il n'a pas su resoudre avec ces libelles : inutile
// de les afficher comme un vrai nom de salon.
const PLACEHOLDER_NAMES = new Set([
  'salon inconnu', 'unknown channel', 'unknown', 'salon', 'channel', 'serveur inconnu',
]);

// Discord prefixe le nom d'un MP dans index.json, et le libelle change selon la
// langue du compte : « Message privé avec X », « Direct Message with X »,
// « Conversation privée avec X »... On retire le prefixe, sinon l'app affiche
// « @Message privé avec maliksync ».
const DM_NAME_PREFIX = /^(?:message\s+(?:priv[eé]|direct)\s+avec|private\s+(?:conversation|message|dm)\s+with|dm\s+with|direct\s+message\s+with|conversation\s+priv[eé]e\s+avec)\s+/i;
const UNKNOWN_PARTICIPANT = /^(?:participant\s*\(e\)\s*inconnu(?:\s*\(e\))?|participant\s+inconnu|unknown\s+participant(?:\s*\(e\))?|utilisateur\s+supprim[eé]|deleted\s+user)$/i;

export function cleanDmName(name) {
  const raw = String(name || '').trim();
  // « Salon inconnu » n'est pas un nom de MP, c'est un libelle de Discord.
  if (isPlaceholderName(raw)) return null;
  const stripped = raw.replace(DM_NAME_PREFIX, '').trim();
  if (!stripped) return null;
  if (UNKNOWN_PARTICIPANT.test(stripped)) return null;
  if (isPlaceholderName(stripped)) return null;
  return stripped;
}

// Certains libelles sont prefixes du nom du serveur : « Salon inconnu, Les
// Pangolins ». Le salon n a pas ete resolu, seul le serveur l a ete.
const PLACEHOLDER_PREFIXES = ['salon inconnu', 'unknown channel', 'serveur inconnu', 'unknown user'];

export function isPlaceholderName(name) {
  if (!name) return true;
  const lower = String(name).trim().toLowerCase();
  if (PLACEHOLDER_NAMES.has(lower)) return true;
  return PLACEHOLDER_PREFIXES.some(prefix => lower.startsWith(prefix));
}

export function cdnAvatar(userId, hash, size = 128) {
  if (!userId || !hash) return null;
  const extension = String(hash).startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/avatars/${userId}/${hash}.${extension}?size=${size}`;
}

export function cdnGuildIcon(guildId, hash, size = 128) {
  if (!guildId || !hash) return null;
  const extension = String(hash).startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/icons/${guildId}/${hash}.${extension}?size=${size}`;
}

function decodeEntities(text) {
  return String(text)
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x0*27;/gi, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// `parseSnowflakeJson`, `parseAttachments`, `parseCsv`, `parseMessagesJson` et
// `parseEntry` sont exportes pour le meme test de parite que ci-dessus : la copie
// CJS du main process (electron/packageImporter.parse.cjs) doit se comporter
// identiquement sur des CAS choisis, pas seulement sur une archive entiere.
// Export pur, aucun changement de comportement.
export function parseSnowflakeJson(text) {
  const safeText = text.replace(SNOWFLAKE_JSON_RE, '$1"$2":"$3"');
  return JSON.parse(safeText);
}

// Discord stocke les URL de pièces jointes échappées : sans déséchappement, un
// aller-retour export/import perd toutes les pièces jointes.
//
// L'archive est NON FIABLE : `new URL(url)` seul accepte n'importe quel schéma
// ou hôte (`javascript:`, `file:`, un domaine de phishing…). On n'accepte donc
// que du `https:` vers un CDN Discord. Toute autre URL garde son entrée mais
// sans lien cliquable (`url: null`), pour ne jamais exposer un lien forgé par
// l'archive. Ne jette jamais.
export function parseAttachments(value) {
  if (!value) return [];
  return decodeEntities(value)
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(raw => {
      let parsed = null;
      try { parsed = new URL(raw); } catch { parsed = null; }
      const host = parsed ? parsed.hostname.toLowerCase() : '';
      const cdn = parsed !== null
        && parsed.protocol === 'https:'
        && (host === 'cdn.discordapp.com' || host === 'media.discordapp.net' || host.endsWith('.discordapp.com'));
      const path = parsed ? parsed.pathname : raw.split(/[?#]/)[0];
      const last = path.split('/').pop() || '';
      let fileName = 'attachment';
      if (last) {
        try { fileName = decodeURIComponent(last) || 'attachment'; }
        catch { fileName = last; }
      }
      return { url: cdn ? raw : null, fileName };
    });
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i += 1; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(field); field = '';
    } else if (char === '\n' && !quoted) {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (char !== '\r') field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows.shift().map(value => value.trim());
  return rows
    .map(values => Object.fromEntries(headers.map((header, index) => [header, values[index] || ''])))
    .filter(row => row.ID && row.Timestamp)
    .map(row => ({
      id: String(row.ID),
      channelId: '',
      timestamp: String(row.Timestamp),
      content: row.Contents || '',
      attachments: parseAttachments(row.Attachments),
    }));
}

export function parseMessagesJson(text) {
  let rows;
  try { rows = parseSnowflakeJson(text); } catch { return []; }
  if (!Array.isArray(rows)) return [];
  return rows
    .filter(row => row && row.ID != null && row.Timestamp != null)
    .map(row => ({
      id: String(row.ID),
      channelId: '',
      timestamp: String(row.Timestamp),
      content: typeof row.Contents === 'string' ? row.Contents : '',
      attachments: parseAttachments(row.Attachments),
    }));
}

export function parseEntry(path, bytes) {
  const lower = path.toLowerCase();
  const name = lower.split('/').pop();
  const text = strFromU8(bytes);
  if (name === CHANNEL_NAME) return { kind: 'channel', value: parseSnowflakeJson(text) };
  if (name === 'messages.json') return { kind: 'messages', value: parseMessagesJson(text) };
  if (name === 'messages.csv') return { kind: 'messages', value: parseCsv(text) };
  if (name === GUILD_NAME) return { kind: 'guild', value: parseSnowflakeJson(text) };
  if (name === INDEX_NAME) return { kind: 'index', value: parseSnowflakeJson(text) };
  if (name === USER_NAME) return { kind: 'user', value: parseSnowflakeJson(text) };
  return null;
}

async function* readBlocks(file) {
  const total = Number(file.size) || 0;
  if (total <= 0) {
    // `file.size` vaut 0 ou n'est pas un nombre : `slice(0, MAX_SAFE_INTEGER)`
    // chargerait TOUT le flux en mémoire d'un coup. On lit par tranches
    // bornées jusqu'à épuisement, comme la boucle ci-dessous.
    let unknown = 0;
    while (true) {
      const buffer = await file.slice(unknown, unknown + CHUNK_BYTES).arrayBuffer();
      if (!buffer.byteLength) break;
      unknown += buffer.byteLength;
      yield new Uint8Array(buffer);
    }
    return;
  }
  let offset = 0;
  while (offset < total) {
    const end = Math.min(offset + CHUNK_BYTES, total);
    const buffer = await file.slice(offset, end).arrayBuffer();
    if (!buffer.byteLength) break;
    offset = end;
    yield new Uint8Array(buffer);
  }
}

// Une passe. Les entrées inutiles sont consommées puis abandonnées : sans
// start(), fflate retient leurs octets compressés en attente, ce qui annulerait
// tout le gain de mémoire.
async function collectEntries(file, onEntry, shouldStop, onRead) {
  const entries = [];
  const failures = [];
  const discarded = { noise: 0, oversized: 0 };
  let seen = 0;

  const unzipper = new Unzip(entry => {
    seen += 1;
    const path = entry.name;
    const declared = Number(entry.originalSize || 0);

    if (isNoisePath(path) || declared > MAX_ENTRY_BYTES) {
      if (!isNoisePath(path)) discarded.oversized += 1; else discarded.noise += 1;
      onEntry?.(path, 0, true);
      entry.ondata = () => {};
      entry.start();
      return;
    }

    const chunks = [];
    let size = 0;
    let overflowed = false;
    entry.ondata = (error, data, final) => {
      if (error) { failures.push(error); return; }
      if (data) {
        size += data.length;
        if (!overflowed && size > MAX_ENTRY_BYTES) {
          // Le fichier dépasse le plafond en cours de route : on stoppe
          // l'accumulation immédiatement (c'est le cas « Activité »).
          overflowed = true;
          chunks.length = 0;
          discarded.oversized += 1;
        }
        if (!overflowed) chunks.push(data);
      }
      if (!final || overflowed) return;
      const bytes = new Uint8Array(size);
      let at = 0;
      for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
      chunks.length = 0;
      try {
        const parsed = parseEntry(path, bytes);
        if (parsed) entries.push({ path, ...parsed });
      } catch (error) { failures.push(error); }
      onEntry?.(path, size, false);
    };
    entry.start();
  });
  unzipper.register(UnzipInflate);

  let read = 0;
  for await (const block of readBlocks(file)) {
    if (shouldStop()) break;
    read += block.length;
    unzipper.push(block, false);
    // Sans ce retour, l'UI reste figee pendant toute la lecture (~10 s sur
    // un export de 394 Mo) et l'import parait bloque.
    onRead?.(read, Number(file.size) || 0);
    // Point de rendement : sans lui, aucune frame n est peinte entre deux
    // blocs et la fenetre parait figee pendant toute la lecture.
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  if (!shouldStop()) unzipper.push(new Uint8Array(0), true);
  if (failures.length) throw failures[0];
  if (seen === 0) throw new Error('données ZIP invalides');
  return { entries, discarded };
}

export async function importDiscordPackage(file, { onProgress = () => {}, onEntry = () => {}, shouldStop = () => false } = {}) {
  if (!file || typeof file.slice !== 'function') throw new PackageImportError('A ZIP file is required.');

  let entries;
  let discarded;
  try {
    ({ entries, discarded } = await collectEntries(file, onEntry, shouldStop, (read, total) => {
      onProgress({ current: read, total: total || 1, stage: "Lecture du ZIP", bytes: true });
    }));
  } catch (error) {
    throw new PackageImportError(`Impossible de lire l’archive ZIP : ${error.message}`);
  }

  // Sections par motif : l'archive peut être en français (« Compte »,
  // « Messages », « Serveurs ») ou en anglais.
  const account = entries.find(entry => entry.kind === 'user');
  if (!account || !account.value || !account.value.id) {
    throw new PackageImportError('Archive Discord non reconnue : user.json est absent.');
  }

  const selfId = String(account.value.id);

  const guilds = [];
  for (const entry of entries) {
    const match = GUILD_ENTRY.exec(entry.path);
    if (!match || entry.kind !== 'guild' || !entry.value?.id) continue;
    guilds.push({
      id: String(entry.value.id),
      name: entry.value.name || 'Serveur sans nom',
      icon: cdnGuildIcon(String(entry.value.id), entry.value.icon),
    });
  }

  // L'archive contient DEUX index.json (« Serveurs/ » puis « Messages/ »).
  // Ne prendre que le premier vidait la table des noms de MP : on fusionne, le
  // premier renvoi gagne pour eviter qu'une valeur vide ecrase une vraie.
  let nameIndex = {};
  for (const entry of entries) {
    if (entry.kind !== 'index') continue;
    const value = entry.value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    for (const [key, name] of Object.entries(value)) {
      if (name && !nameIndex[key]) nameIndex[key] = name;
    }
  }

  const rowsByChannel = new Map();
  const seenMessageIds = new Map();
  for (const entry of entries) {
    if (entry.kind !== 'messages') continue;
    const match = MESSAGES_ENTRY.exec(entry.path);
    if (!match) continue;
    const key = channelKey(match[1]);
    const list = rowsByChannel.get(key) || [];
    // Un même salon peut fournir `messages.json` ET `messages.csv` : sans
    // dédoublonnage par id, chaque message serait compté (et affiché) deux
    // fois. On garde la première occurrence, dans l'ordre des entrées.
    const seen = seenMessageIds.get(key) || new Set();
    for (const message of entry.value) {
      const id = String(message.id);
      if (seen.has(id)) continue;
      seen.add(id);
      list.push({ ...message });
    }
    seenMessageIds.set(key, seen);
    rowsByChannel.set(key, list);
  }

  const channels = [];
  for (const entry of entries) {
    if (entry.kind !== 'channel') continue;
    const match = CHANNEL_ENTRY.exec(entry.path);
    if (!match) continue;
    const key = channelKey(match[1]);
    const channel = entry.value || {};
    const channelId = String(channel.id || key);
    const list = rowsByChannel.get(channelKey(channelId)) || rowsByChannel.get(key) || [];
    const type = normalizeChannelType(channel.type);
    const recipients = normalizeRecipients(channel.recipients);
    // Dans un MP, l'interlocuteur est le recipient qui n'est pas le compte
    // exporte ; sinon on garde le premier identifie.
    const partner = recipients.find(item => item.id && item.id !== selfId)
      || recipients.find(item => item.username)
      || recipients[0]
      || null;
    const indexed = nameIndex[channelId];
    const indexedName = cleanDmName(indexed);
    // Un MP s'affiche par le pseudo du correspondant : le prefixe de l'index
    // est retire, et le recipient (si connu) reste prioritaire sur le nom brut.
    const partnerName = partner?.username && !UNKNOWN_PARTICIPANT.test(partner.username) ? partner.username : null;
    const rawName = type === 'DM'
      ? (partnerName || indexedName)
      : (!isPlaceholderName(channel.name) ? channel.name : indexedName);
    const name = rawName || null;
    channels.push({
      id: channelId,
      name,
      avatar: channel.icon ? `https://cdn.discordapp.com/channel-icons/${channelId}/${channel.icon}.png?size=64` : null,
      recipient: partner,
      // La LISTE COMPLETE des destinataires, et non le seul « partner » : sur un
      // GROUP_DM, ne garder que `recipient` perdait tous les autres membres a
      // l export. `recipient` reste le partenaire affiche par l IHM ; `recipients`
      // est ce que l export reecrit. Meme bloc, au caractere pres, dans la copie
      // CommonJS (electron/packageImporter.parse.cjs) — test de parite.
      recipients,
      type,
      guildName: channel.guild?.name,
      guildId: channel.guild?.id ? String(channel.guild.id) : undefined,
      isLeft: type === 'SERVER_TEXT' && !channel.guild,
      messagesCount: list.length,
    });
    for (const message of list) message.channelId = channelId;
  }

  // Les salons sans channel.json (données partielles) ne sont pas perdues :
  // on les rattache quand même, sinon une partie des messages disparaît.
  for (const [key, list] of rowsByChannel) {
    if (channels.some(channel => channelKey(channel.id) === key)) continue;
    channels.push({ id: key, name: isPlaceholderName(nameIndex[key]) ? null : (nameIndex[key] || null), avatar: null, recipient: null, type: 'SERVER_TEXT', guildName: null, guildId: null, isLeft: false, messagesCount: list.length });
    for (const message of list) message.channelId = key;
  }

  let processed = 0;
  for (const channel of channels) {
    processed += 1;
    onProgress({ current: processed, total: channels.length || 1, channelId: channel.id, stage: 'Extraction des messages' });
  }

  const messages = new Map();
  for (const channel of channels) {
    messages.set(channel.id, rowsByChannel.get(channelKey(channel.id)) || []);
  }

  channels.sort((a, b) => b.messagesCount - a.messagesCount);
  return {
    user: {
      id: String(account.value.id),
      username: account.value.username || 'Utilisateur inconnu',
      globalName: account.value.global_name || null,
      // Ton vrai avatar est DANS l'export (Compte/user.json.avatar_hash). Sans
      // lui, toute l'app affiche les PP par defaut de Discord.
      avatar: cdnAvatar(String(account.value.id), account.value.avatar_hash),
    },
    guilds,
    channels,
    messages,
    totalMessages: channels.reduce((sum, channel) => sum + channel.messagesCount, 0),
    packageSizeBytes: file.size || 0,
    discarded,
  };
}

export function getSelectedPackageMessageKeys(selection) {
  return [...selection].map(value => {
    const [channelId, messageId] = String(value).split(':');
    return { channelId, messageId };
  }).filter(item => item.channelId && item.messageId);
}
