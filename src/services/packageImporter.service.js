import { unzipSync, strFromU8 } from '../../node_modules/fflate/esm/browser.js';

const SKIPPED_PREFIXES = ['activity/', 'activities_e/', 'activities_w/', 'programs/'];

export class PackageImportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PackageImportError';
  }
}

function isJunkPath(path) {
  const name = path.split('/').pop() || '';
  return path.startsWith('__MACOSX/') || name.startsWith('._') || name === '.DS_Store';
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
}

function parseSnowflakeJson(text) {
  const fields = 'id|channel_id|guild_id|user_id|message_id|owner_id|recipient_id';
  const safeText = text.replace(new RegExp(`([{,]\\s*)"(${fields})":\\s*(\\d+)`, 'g'), '$1"$2":"$3"');
  return JSON.parse(safeText);
}

function parseAttachments(value) {
  if (!value) return [];
  return String(value)
    .split(/[\\s,]+/)
    .filter(Boolean)
    .map(url => {
      try {
        const parsed = new URL(url);
        return { url, fileName: decodeURIComponent(parsed.pathname.split('/').pop() || 'attachment') };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
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

function readBlob(blob) {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Unable to read archive'));
    reader.readAsArrayBuffer(blob);
  });
}

function buildIndex(files) {
  const index = new Map();
  Object.keys(files).forEach(path => {
    if (!isJunkPath(path)) index.set(path.toLowerCase(), path);
  });
  return index;
}

function sniffStructure(index) {
  let account = null;
  let prefix = '';
  for (const path of index.keys()) {
    if (!path.endsWith('/user.json')) continue;
    const parts = path.split('/');
    if (parts.length === 2) { account = parts[0]; break; }
    if (parts.length === 3) { prefix = `${parts[0]}/`; account = parts[1]; break; }
  }
  if (!account) return null;

  let messages = null;
  for (const path of index.keys()) {
    if (prefix && !path.startsWith(prefix)) continue;
    const relative = prefix ? path.slice(prefix.length) : path;
    const slash = relative.indexOf('/');
    if (slash < 0) continue;
    const head = relative.slice(0, slash);
    const tail = relative.slice(slash + 1);
    if (head !== account && /^c?\d+\/(channel\.json|messages\.(json|csv))$/.test(tail)) {
      messages = head;
      break;
    }
  }
  let servers = null;
  for (const path of index.keys()) {
    if (prefix && !path.startsWith(prefix)) continue;
    const parts = (prefix ? path.slice(prefix.length) : path).split('/');
    if (parts.length === 3 && /^\d+$/.test(parts[1]) && parts[2] === 'guild.json' && parts[0] !== account && parts[0] !== messages) {
      servers = parts[0];
      break;
    }
  }
  return { prefix, account, messages: messages || 'messages', servers: servers || 'servers' };
}

function resolve(index, files, structure, path) {
  const [head, ...tail] = path.split('/');
  const actualHead = structure[head] || head;
  const actual = index.get(`${structure.prefix}${actualHead}/${tail.join('/')}`);
  return actual ? files[actual] : null;
}

function resolveChannel(index, files, structure, id) {
  for (const dirPrefix of ['c', '']) {
    const channel = resolve(index, files, structure, `messages/${dirPrefix}${id}/channel.json`);
    if (!channel) continue;
    for (const format of ['json', 'csv']) {
      const data = resolve(index, files, structure, `messages/${dirPrefix}${id}/messages.${format}`);
      if (data) return { channel, data, format };
    }
  }
  return null;
}

function decodeJson(bytes) {
  return parseSnowflakeJson(strFromU8(bytes));
}

export async function importDiscordPackage(file, { onProgress = () => {} } = {}) {
  if (!file || typeof file.arrayBuffer !== 'function') throw new PackageImportError('A ZIP file is required.');
  let files;
  try { files = unzipSync(new Uint8Array(await readBlob(file))); }
  catch (error) { throw new PackageImportError(`Unable to read ZIP archive: ${error.message}`); }
  const index = buildIndex(files);
  const structure = sniffStructure(index);
  if (!structure) throw new PackageImportError('Unrecognized Discord package: account/user.json is missing.');

  const userFile = resolve(index, files, structure, 'account/user.json');
  if (!userFile) throw new PackageImportError('Unrecognized Discord package: account/user.json is missing.');
  const rawUser = decodeJson(userFile);
  if (!rawUser.id) throw new PackageImportError('Invalid account/user.json.');
  const guilds = [];
  for (const path of index.keys()) {
    const match = path.match(new RegExp(`^${escapeRegex(structure.prefix + structure.servers)}/(\\d+)/guild\\.json$`));
    if (!match) continue;
    try {
      const guild = decodeJson(files[index.get(path)]);
      if (guild.id) guilds.push({ id: String(guild.id), name: guild.name || 'Unnamed server' });
    } catch { /* ignore malformed metadata */ }
  }

  const nameIndex = {};
  const names = resolve(index, files, structure, 'messages/index.json');
  if (names) { try { Object.assign(nameIndex, decodeJson(names)); } catch {} }
  const channelIds = new Set();
  for (const path of index.keys()) {
    const relative = structure.prefix && path.startsWith(structure.prefix) ? path.slice(structure.prefix.length) : path;
    const match = relative.match(new RegExp(`^${escapeRegex(structure.messages)}/c?(\\d+)/`));
    if (match && !SKIPPED_PREFIXES.some(prefix => relative.startsWith(prefix))) channelIds.add(match[1]);
  }

  const channels = [];
  const messages = new Map();
  let processed = 0;
  for (const id of channelIds) {
    const resolved = resolveChannel(index, files, structure, id);
    if (!resolved) continue;
    let channel;
    try { channel = decodeJson(resolved.channel); } catch { continue; }
    const list = resolved.format === 'json' ? parseMessagesJson(strFromU8(resolved.data)) : parseCsv(strFromU8(resolved.data));
    const channelId = String(channel.id || id);
    list.forEach(message => { message.channelId = channelId; });
    const type = Number(channel.type);
    channels.push({
      id: channelId,
      name: channel.name || nameIndex[channelId] || null,
      avatar: channel.icon ? `https://cdn.discordapp.com/channel-icons/${channelId}/${channel.icon}.png?size=64` : null,
      recipient: channel.recipients?.[0] ? {
        id: String(channel.recipients[0].id || ''),
        username: channel.recipients[0].username || channel.recipients[0].global_name || null,
        avatar: channel.recipients[0].avatar ? `https://cdn.discordapp.com/avatars/${channel.recipients[0].id}/${channel.recipients[0].avatar}.png?size=64` : null,
      } : null,
      type: type === 1 ? 'DM' : type === 3 ? 'GROUP' : 'SERVER_TEXT',
      guildName: channel.guild?.name,
      guildId: channel.guild?.id,
      isLeft: type === 0 && !channel.guild,
      messagesCount: list.length,
    });
    messages.set(channelId, list);
    processed += 1;
    onProgress({ current: processed, total: channelIds.size, channelId, stage: 'Extraction des messages' });
  }

  channels.sort((a, b) => b.messagesCount - a.messagesCount);
  return {
    user: { id: String(rawUser.id), username: rawUser.username || 'Unknown user', globalName: rawUser.global_name || null },
    guilds,
    channels,
    messages,
    totalMessages: channels.reduce((sum, channel) => sum + channel.messagesCount, 0),
    packageSizeBytes: file.size || 0,
  };
}

export function getSelectedPackageMessageKeys(selection) {
  return [...selection].map(value => {
    const [channelId, messageId] = String(value).split(':');
    return { channelId, messageId };
  }).filter(item => item.channelId && item.messageId);
}
