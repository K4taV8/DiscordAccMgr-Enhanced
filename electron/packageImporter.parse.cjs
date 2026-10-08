// Parsage et assemblage d'un export Discord — COPIE CommonJS, main process.
//
// ⚠ DUPLICATION ASSUMÉE, ET VERIFIÉE PAR UN TEST. Ce fichier reproduit, à
// l'identique, le bloc de parsing et d'assemblage de
// `src/services/packageImporter.service.js` (module ESM du renderer). Les deux
// copies ne peuvent pas être un seul fichier : le renderer est un navigateur, il
// ne peut ni `require` un `.cjs`, ni importer quoi que ce soit venant de
// `electron/`, et un `node:*` dans son bundle le casserait au premier `import`.
// Mêmes raison, même décision que pour les règles de bruit (`packageImporter.rules.cjs`).
//
// Ce qui garde les deux copies honnêtes n'est pas un commentaire : c'est le test
// `les deux copies des parseurs sont identiques au caractere pres, et assemble
// avec` (test/packageIndex.test.js), qui LIT LES DEUX FICHIERS et compare le
// texte bloc par bloc — le même principe que le test d'identité croisée des règles.
// Il est complété par le test de parité `l import par index donne le MEME resultat
// que l import par flux`, qui fait passer la MÊME archive par les deux chemins et
// compare les deux objets finaux CHAMP PAR CHAMP, dans l'ordre, clés absentes
// comprises, plus la trace des `onEntry`. Le premier voit ce qu'aucune archive ne
// peut faire MULTIPLIER (une réécriture d'une seule branche, une constante
// changée d'un côté) ; le second voit ce que le texte ne dit pas. Modifier un
// parseur d'un seul côté fait rougir au moins l'un des deux.
//
// COPIER À L'IDENTIQUE : tout ce qui suit, du premier `const USER_NAME` à la fin de
// `assemble`. Ne « factored » rien d'un côté seulement. Il n'y a que TROIS
// adaptations, et le test d'identité les énumère une par une :
//   1. `export ` retiré, et un `module.exports` à la fin (CommonJS) — c'est la
//      seule différence de FORME entre un module ESM et un module CommonJS, et le
//      test la retire avant de comparer ;
//   2. dans `assemble` seul, `throw new PackageImportError(` devient
//      `throw new Error(` (la classe vit dans le module ESM du renderer, que le
//      main process ne peut pas charger) et `packageSizeBytes: file.size || 0`
//      devient le paramètre `packageSizeBytes` (le renderer lit `file`, la copie
//      n'en a pas). Différences de CONTEXTE, pas de logique : le message est
//      identique, et `importViaIndex` passe `Number(file.size) || 0`, la même
//      valeur pour un `size` numérique. Le test normalise les deux, et ÉCHOUE si
//      l'une des deux ne trouve plus rien — une adaptation devenue inutile ne doit
//      pas continuer à masquer ce qu'elle masquerait ;
//   3. `strFromU8` de fflate remplacé par le `TextDecoder` que fflate utilise
//      lui-même — le renderer ne peut pas tirer le même module que le main
//      process, et décoder par soi-même serait une divergence de plus. Celle-ci est
//      une adaptation de CODE et non de TEXTE : ces lignes n'existent pas dans le
//      renderer, donc le test d'identité ne peut pas la voir. C'est le test de
//      parité qui la vérifie, sur une entrée qui n'est PAS du texte.
//
// WHY 2 MATÉRIALISE : `strFromU8` de fflate est exactement
// `new TextDecoder().decode(bytes)`, options par défaut, sans état entre deux
// appels (`stream` vaut false, donc le décodeur se réinitialise). Le même
// décodeur est donc construit ici, et le test de parité le vérifie sur une entrée
// qui n'est PAS du texte — les 700 avatars PNG du vrai export passent tous par là.

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
const SNOWFLAKE_FIELDS = 'id|channel_?id|guild_?id|user_?id|message_?id|owner_?id|recipient_?id';
const SNOWFLAKE_JSON_RE = new RegExp(`([{,]\\s*)"(${SNOWFLAKE_FIELDS})":\\s*(\\d+)`, 'gi');

// Sections localisées par motif, quelle que soit la langue de l'archive.
const CHANNEL_ENTRY = /(?:^|\/)(c?\d+)\/channel\.json$/i;
const MESSAGES_ENTRY = /(?:^|\/)(c?\d+)\/messages\.(?:json|csv)$/i;
const GUILD_ENTRY = /(?:^|\/)(\d+)\/guild\.json$/i;

// COPIE : `strFromU8` de fflate est ce `TextDecoder` la, options par defaut.
// Il est partage et sans etat entre deux `decode()`, comme celui de fflate.
//
// COPIE : les octets recus sont le `Buffer` de zlib, VUE dans un tampon plus
// grand que son contenu (cf. electron/packageImporter.service.cjs). On rend donc
// la VUE et non `bytes.buffer` : decoder la vue donne exactement les octets de
// l'entree, alors que decoder le slab complet donnerait les 64 Kio du pool.
//
// SANS DECODEUR, ON LEVE — on ne rend pas une chaine vide. Le repli ecrit plus tot
// rendait `''`, et c'est le pire mode de defaussance possible pour ce fichier :
// `parseEntry` teste le NOM avant de parser, donc un `messages.json` decode en `''`
// donnerait `[]`, et TOUS les messages de l'archive disparaîtraient sans signal.
// Un environnement sans `TextDecoder` est un environnement degrade ; mieux vaut une
// archive refusee avec un motif nomme qu'un import a moitie construit. Le test
// « sans TextDecoder, la copie des parseurs LEVE » charge ce fichier dans un
// contexte V8 neuf, ou le decodeur n'existe pas.
const td = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

const strFromU8 = (dat) => {
  // Lève AU COUP DE L EMPLOI, et non au chargement : l'erreur doit rester
  // rattachable a l'archive en cours de lecture, pas casser le chargement du
  // module — donc pas du pilote de l'import entier.
  if (!td) throw new Error('TextDecoder absent : le decodage UTF-8 est impossible, et l import est refuse plutot que de perdre des messages en silence.');
  return td.decode(dat);
};

// « c123456 » et « 123456 » désignent le même salon.
function channelKey(id) {
  return String(id).replace(/^c/i, '');
}

// --- Format reel de l'archive (verifie sur un export de 394 Mo) -------------
// `channel.json` ecrit le type comme une CHAINE ("DM", "GUILD_TEXT",
// "GROUP_DM") et les recipients comme des IDS EN TEXTE (["222", "747..."]).
// L'ancienne version faisait Number(type) -> NaN, donc tous les MP etaient
// affiches comme des salons de serveur.
function normalizeChannelType(rawType) {
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
function normalizeRecipients(raw) {
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

function cleanDmName(name) {
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

function isPlaceholderName(name) {
  if (!name) return true;
  const lower = String(name).trim().toLowerCase();
  if (PLACEHOLDER_NAMES.has(lower)) return true;
  return PLACEHOLDER_PREFIXES.some(prefix => lower.startsWith(prefix));
}

function cdnAvatar(userId, hash, size = 128) {
  if (!userId || !hash) return null;
  const extension = String(hash).startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/avatars/${userId}/${hash}.${extension}?size=${size}`;
}

function cdnGuildIcon(guildId, hash, size = 128) {
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

function parseSnowflakeJson(text) {
  const safeText = text.replace(SNOWFLAKE_JSON_RE, '$1"$2":"$3"');
  return JSON.parse(safeText);
}

// Discord stocke les URL de pièces jointes échappées : sans déséchappement, un
// aller-retour export/import perd toutes les pièces jointes.
function parseAttachments(value) {
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

function parseCsv(text) {
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

function parseMessagesJson(text) {
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

// COPIE de `parseEntry` de src/services/packageImporter.service.js. Les octets
// qu'elle recoit viennent, sur le chemin par index, du `Buffer` de zlib : le
// decodage en.text est ce qui les libere, et le resultat ne contient donc AUCUNE
// vue sur ce tampon.
function parseEntry(path, bytes) {
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

// --- Assemblage : des entrees parsees au package affiche ---------------------
//
// COPIE du bloc d'assemblage de `importDiscordPackage`, meme ordre de parcours,
// meme tri, memes cles — y compris les cles ABSENTES, qui sont une difference
// d'etat comme les autres :
//
//   - un salon du parcours nominal se voit mettre `guildId: undefined` — la cle
//     existe, la valeur est absente — la ou le salon RAJOUTE pour des donnees
//     partielles porte `guildId: null`. Les deux sont distincts pour `deepEqual`,
//     et `undefined` disparaitrait si ce bloc etait reecrit avec un objet construit
//     par etapes ;
//   - `isLeft`, `recipient`, `guildName`, `messagesCount` : memes cles, meme ordre.
//
// Le tri final `channels.sort((a, b) => b.messagesCount - a.messagesCount)` est
// STABLE en V8, donc l'ordre d'egalite vient de l'ordre de remplissage : le
// parcours des entrees ne peut pas, lui, changer.
function assemble(entries, { packageSizeBytes = 0, discarded = { noise: 0, oversized: 0 }, onProgress = () => {} } = {}) {
  // Sections par motif : l'archive peut être en français (« Compte »,
  // « Messages », « Serveurs ») ou en anglais.
  const account = entries.find(entry => entry.kind === 'user');
  if (!account || !account.value || !account.value.id) {
    throw new Error('Unrecognized Discord package: user.json is missing.');
  }

  const selfId = String(account.value.id);

  const guilds = [];
  for (const entry of entries) {
    const match = GUILD_ENTRY.exec(entry.path);
    if (!match || entry.kind !== 'guild' || !entry.value?.id) continue;
    guilds.push({
      id: String(entry.value.id),
      name: entry.value.name || 'Unnamed server',
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
      username: account.value.username || 'Unknown user',
      globalName: account.value.global_name || null,
      // Ton vrai avatar est DANS l'export (Compte/user.json.avatar_hash). Sans
      // lui, toute l'app affiche les PP par defaut de Discord.
      avatar: cdnAvatar(String(account.value.id), account.value.avatar_hash),
    },
    guilds,
    channels,
    messages,
    totalMessages: channels.reduce((sum, channel) => sum + channel.messagesCount, 0),
    packageSizeBytes,
    discarded,
  };
}

module.exports = {
  parseEntry,
  assemble,
  // Exportes pour le test de parite : ils permettent de comparer les deux copies
  // sur des CAS, sans passer par une archive entiere. `importViaIndex` n'en a pas
  // besoin — il passe par `parseEntry` et `assemble`.
  SNOWFLAKE_FIELDS,
  CHANNEL_ENTRY,
  MESSAGES_ENTRY,
  GUILD_ENTRY,
  channelKey,
  normalizeChannelType,
  normalizeRecipients,
  cleanDmName,
  isPlaceholderName,
  cdnAvatar,
  cdnGuildIcon,
  parseSnowflakeJson,
  parseAttachments,
  parseCsv,
  parseMessagesJson,
};
