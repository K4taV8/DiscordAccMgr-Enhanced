const { app, BrowserWindow, ipcMain, shell, dialog, safeStorage } = require('electron');
const path = require('path');
const axios = require('axios');
const fs = require('fs');
const fsp = require('fs/promises');

// SEC-03 : timeout global — aucun appel HTTP ne doit pendre indéfiniment
axios.defaults.timeout = 15000;

const { readJson, writeJson } = require('./persist.cjs');

// Portable data directory setup
const isPortable = process.env.PORTABLE_BUILD === 'true' || (app.isPackaged && fs.existsSync(path.join(path.dirname(process.execPath), '.portable')));
let appRoot;
try { appRoot = app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '..'); } catch { appRoot = path.join(__dirname, '..'); }

if (isPortable) {
  const dataDir = path.join(appRoot, 'data');
  const portablePaths = {
    userData: path.join(dataDir, 'userData'),
    sessionData: path.join(dataDir, 'sessionData'),
    cache: path.join(dataDir, 'cache'),
    crashDumps: path.join(dataDir, 'crashDumps'),
    logs: path.join(dataDir, 'logs'),
  };
  try {
    Object.values(portablePaths).forEach(p => fs.mkdirSync(p, { recursive: true }));
    Object.entries(portablePaths).forEach(([name, p]) => app.setPath(name, p));
  } catch (err) {
    console.error('Failed to initialize portable data directory:', err.message);
    dialog.showErrorBox('Portable Mode Error',
      'Cannot write to application data directory.\nPlease ensure the application folder is writable.');
    process.exit(1);
  }
}

let mainWindow;
let discordClient = null;
let connecting = false;
const tokensPath = path.join(app.getPath('userData'), 'saved_tokens.json');

if (!fs.existsSync(tokensPath)) {
  fs.writeFileSync(tokensPath, '[]', 'utf8');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    center: true,
    minWidth: 770,
    minHeight: 600,
    frame: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
    backgroundColor: '#1a1b1e'
  });

  mainWindow.loadFile('./index.html');
  mainWindow.webContents.setBackgroundThrottling(false);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (!app.isPackaged || process.env.ELECTRON_DEV === '1') {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  });
}

ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('window:close', () => mainWindow?.close());

// ponytail: proxy REST unique — tout handler HTTP passe ici.
// Casse les doublons axios (Authorization / validateStatus / 429) de ce fichier.
// Succès = statut 2xx ; sinon {success:false, error, status} — le handler
// interprète 403/404 comme il veut ('No access' / 'not found' / 'noReaction').
async function discordFetch(method, path, { data, params } = {}) {
  if (!discordClient?.token) return { success: false, error: 'Not connected' };
  const key = routeKeyFor(path);
  const scheduler = method === 'DELETE' ? deleteScheduler : readScheduler;
  const release = await scheduler.acquire(key);
  try {
    const resp = await axios.request({
      method,
      url: `https://discord.com/api/v9${path}`,
      params,
      data,
      headers: { Authorization: discordClient.token },
      validateStatus: () => true,
    });
    scheduler.applyHeaders(key, resp.headers);
    httpStats.requests++;
    httpStats.byRoute.set(key, (httpStats.byRoute.get(key) || 0) + 1);
    if (resp.status === 429) {
      httpStats.rateLimited++;
      return { success: false, status: 429, error: 'Rate limited', retryAfter: parseInt(resp.headers?.['retry-after']) || 5 };
    }
    return { success: resp.status >= 200 && resp.status < 300, status: resp.status, data: resp.data, headers: resp.headers };
  } catch (error) {
    httpStats.requests++;
    return { success: false, status: 0, error: error.message };
  } finally {
    release();
  }
}

ipcMain.handle('discord:getGroups', async () => {
  const r = await discordFetch('GET', '/users/@me/channels');
  if (!r.success) return { success: false, error: r.error || `HTTP ${r.status}` };
  const groups = r.data
    .filter(ch => ch.type === 3)
    .map(group => ({
      id: group.id,
      name: group.name || 'Unnamed Group',
      icon: group.icon ? `https://cdn.discordapp.com/channel-icons/${group.id}/${group.icon}.png` : '/discord.png',
      recipients: group.recipients?.length || 0
    }));
  return { success: true, groups };
});

ipcMain.handle('discord:leaveGroup', async (_, groupId) => {
  const r = await discordFetch('DELETE', `/channels/${groupId}`);
  if (!r.success) {
    if (r.status === 429) return { success: false, error: 'Rate limited', retryAfter: r.retryAfter };
    return { success: false, error: r.error || `HTTP ${r.status}` };
  }
  return { success: true };
});

async function fetchChannelMessagesRest(channelId, beforeId = null, afterId = null) {
  const params = { limit: afterId ? 1 : 100 };
  if (beforeId) params.before = beforeId;
  if (afterId) params.after = afterId;
  const r = await discordFetch('GET', `/channels/${channelId}/messages`, { params });
  if (!r.success) {
    if (r.status === 429) return { success: false, error: 'Rate limited', retryAfter: r.retryAfter };
    if (r.status === 403 || r.status === 404) return { success: false, error: 'No access' };
    if (r.status) return { success: false, error: `HTTP ${r.status}` };
    return { success: false, error: r.error };
  }
  const uid = discordClient.user?.id;
  const msgs = r.data.map(msg => ({
    id: msg.id,
    content: typeof msg.content === 'string' ? msg.content.substring(0, 80) : '',
    author: { id: msg.author?.id },
    type: msg.type,
    attachments: msg.attachments?.length || 0,
    embeds: msg.embeds?.length || 0,
    sticker_items: msg.sticker_items?.length || 0,
    message_snapshots: msg.message_snapshots?.length || 0,
    message_reference: msg.message_reference || null,
    isDeletable: msg.author?.id === uid,
    reactions: (msg.reactions || []).map(ra => ({
      emoji: { id: ra.emoji.id, name: ra.emoji.name },
      count: ra.count,
      me: Boolean(ra.me || ra.me_burst)
    }))
  }));
  return { success: true, currentUserId: uid, messages: msgs };
}

ipcMain.handle('discord:getChannelMessages', async (_, channelId, beforeId = null, afterId = null) => {
  return fetchChannelMessagesRest(channelId, beforeId, afterId);
});

ipcMain.handle('discord:getDMMessages', async (_, channelId, beforeId = null) => {
  return fetchChannelMessagesRest(channelId, beforeId);
});

ipcMain.handle('discord:getMessage', async (_, channelId, messageId) => {
  const r = await discordFetch('GET', `/channels/${channelId}/messages/${messageId}`);
  if (!r.success) return { success: false, error: r.error || `HTTP ${r.status}` };
  const msg = r.data;
  return {
    success: true,
    currentUserId: discordClient.user.id,
    reactions: (msg.reactions || []).map(ra => ({
      emoji: { id: ra.emoji.id, name: ra.emoji.name },
      count: ra.count,
      me: Boolean(ra.me || ra.me_burst)
    }))
  };
});

ipcMain.handle('discord:deleteGroupMessage', async (_, channelId, messageId) => {
  const r = await discordFetch('DELETE', `/channels/${channelId}/messages/${messageId}`);
  if (!r.success) {
    if (r.status === 429) return { success: false, error: 'Rate limited', retryAfter: r.retryAfter };
    if (r.status === 404) return { success: false, error: 'not found' };
    return { success: false, error: r.error || `HTTP ${r.status}` };
  }
  return { success: true };
});

ipcMain.handle('discord:muteServer', async (_, serverId) => {
  const r = await discordFetch('PATCH', `/users/@me/guilds/${serverId}/settings`, { data: { muted: true } });
  if (!r.success) {
    if (r.status === 429) return { success: false, error: 'Rate limited', retryAfter: r.retryAfter };
    return { success: false, error: r.error || `HTTP ${r.status}` };
  }
  return { success: true };
});

ipcMain.handle('discord:unmuteServer', async (_, serverId) => {
  const r = await discordFetch('PATCH', `/users/@me/guilds/${serverId}/settings`, { data: { muted: false } });
  if (!r.success) {
    if (r.status === 429) return { success: false, error: 'Rate limited', retryAfter: r.retryAfter };
    return { success: false, error: r.error || `HTTP ${r.status}` };
  }
  return { success: true };
});

// ponytail: ordonnanceurs côté main = autorité débit. Lecture nominale 25 r/s,
// suppression 4 r/s (seuils sûrs calibrés) ; les en-têtes X-RateLimit-* gouvernent
// ensuite les bursts réels — zéro 429 par construction.
const { makeRouteScheduler } = require('./rateLimiter.cjs');
const readScheduler = makeRouteScheduler({ nominalRatePerSec: 25, burst: 16, maxConcurrent: 12 });
const deleteScheduler = makeRouteScheduler({ nominalRatePerSec: 4, burst: 2, maxConcurrent: 4 });

// Statistiques HTTP (phase E) — exposées via app:getHttpStats
const httpStats = { requests: 0, rateLimited: 0, byRoute: new Map() };

// Clé de route normalisée : snowflakes masqués (~bucket Discord, major params)
function routeKeyFor(path) {
  return path.replace(/\/\d+(?=\/|$)/g, '/:id');
}

ipcMain.handle('discord:readAll', async () => {
  try {
    if (!discordClient?.token) {
      return { success: false, error: 'Not connected' };
    }

    let allGuilds = [];
    let lastId = null;
    let firstPageOk = false;
    while (true) {
      await readScheduler.acquire('/users/@me/guilds');
      const params = new URLSearchParams({ limit: '100' });
      if (lastId) params.set('after', lastId);
      const resp = await axios.get(`https://discord.com/api/v9/users/@me/guilds?${params}`, {
        headers: { 'Authorization': discordClient.token },
        validateStatus: () => true
      });
      readScheduler.applyHeaders('/users/@me/guilds', resp.headers);
      if (resp.status !== 200) break;
      firstPageOk = true;
      allGuilds = allGuilds.concat(resp.data);
      if (resp.data.length < 100) break;
      lastId = resp.data[resp.data.length - 1].id;
    }
    if (allGuilds.length === 0 && !firstPageOk) {
      return { success: false, error: 'Failed to fetch servers' };
    }

    let failed = 0;
    const total = allGuilds.length;
    for (let i = 0; i < total; i++) {
      const guild = allGuilds[i];
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await readScheduler.acquire(`/guilds/${guild.id}/ack`);
          const ack = await axios.put(`https://discord.com/api/v9/guilds/${guild.id}/ack`, { token: null }, {
            headers: { 'Authorization': discordClient.token },
            validateStatus: () => true
          });
          readScheduler.applyHeaders(`/guilds/${guild.id}/ack`, ack.headers);
          if (ack.status === 429) {
            const wait = parseInt(ack.headers?.['retry-after']) || 1;
            await new Promise(r => setTimeout(r, (wait * 1000) + 500));
            continue;
          }
          break;
        } catch (e) {
          if (attempt === 2) { failed++; console.error(`Failed to mark guild ${guild.id} as read:`, e.message); }
          else await new Promise(r => setTimeout(r, 1000));
        }
      }
      mainWindow?.webContents.send('readall:progress', { done: i + 1, total, failed });
      if (failed > total / 3) break; // ponytail: se retire si les erreurs s'accumulent — on n'ignore pas un serveur en panne indéfiniment
    }

    return { success: true, failed };
  } catch (error) {
    console.error('Read all error:', error);
    return { success: false, error: error.message };
  }
});

// External links — whitelist: only GitHub repository (single known usage)
const EXTERNAL_URL_ALLOWLIST = /^https:\/\/github\.com\/Bherl1\/DiscordAccMgr(\/|$)/;
ipcMain.handle('app:openExternal', async (_, url) => {
  if (typeof url !== 'string' || !EXTERNAL_URL_ALLOWLIST.test(url)) {
    return { success: false, error: 'URL not allowed' };
  }
  try {
    await shell.openExternal(url);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Token management — encrypted at rest via safeStorage
// Storage schema: { schemaVersion: 1, tokens: [...] } — migrated from legacy flat array
const TOKEN_SCHEMA_VERSION = 1;

async function readTokensFile() {
  const raw = await fsp.readFile(tokensPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    // Legacy format: flat array -> migrate to versioned envelope
    const migrated = { schemaVersion: TOKEN_SCHEMA_VERSION, tokens: parsed };
    await fsp.writeFile(tokensPath, JSON.stringify(migrated, null, 2));
    return migrated;
  }
  return parsed;
}

async function writeTokensFile(store) {
  // BUG-03 : écriture atomique (tmp + rename) — pas de fichier tronqué en cas de crash
  const tmp = tokensPath + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify({ schemaVersion: TOKEN_SCHEMA_VERSION, tokens: store }, null, 2));
  await fsp.rename(tmp, tokensPath);
}

// BUG-03 : mutex — sérialise les read-modify-write (save/get/delete) pour éviter les pertes de mise à jour
let tokenOp = Promise.resolve();
const withTokenLock = (fn) => {
  const p = tokenOp.then(fn);
  tokenOp = p.then(() => {}, () => {});
  return p;
};

function encryptToken(token) {
  return 'enc:' + safeStorage.encryptString(token).toString('base64');
}

function decryptToken(stored) {
  if (typeof stored === 'string' && stored.startsWith('enc:')) {
    return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
  }
  return null;
}

ipcMain.handle('tokens:save', (_, name, token) => withTokenLock(async () => {
  if (!safeStorage.isEncryptionAvailable()) {
    return { success: false, error: 'Cannot save: secure storage unavailable. On Linux, install libsecret.' };
  }
  try {
    const store = await readTokensFile();
    const tokens = store.tokens || [];
    if (tokens.some(t => t.name === name)) {
      return { success: false, error: 'A token with this name already exists' };
    }
    tokens.push({ name, token: encryptToken(token) });
    await writeTokensFile(tokens);
    return { success: true };
  } catch (error) {
    return { success: false, error: 'Failed to save token' };
  }
}));

ipcMain.handle('tokens:get', () => withTokenLock(async () => {
  try {
    const store = await readTokensFile();
    const tokens = store.tokens || [];
    let hasLegacy = false;

    const result = tokens.map(t => {
      if (typeof t.token === 'string' && t.token.startsWith('enc:')) {
        try {
          return { ...t, token: decryptToken(t.token) };
        } catch {
          return { ...t, token: null, corrupt: true }; // BUG-07 : garder l'entrée pour que l'utilisateur la voie/supprime
        }
      }
      hasLegacy = true;
      return { ...t, token: t.token };
    }).filter(t => t !== null);

    if (hasLegacy && safeStorage.isEncryptionAvailable()) {
      const encrypted = result.map(t => ({ ...t, token: encryptToken(t.token) }));
      await writeTokensFile(encrypted);
    }

    return { success: true, tokens: result };
  } catch (error) {
    return { success: false, error: 'Failed to load tokens' };
  }
}));

ipcMain.handle('tokens:delete', (_, name) => withTokenLock(async () => {
  try {
    const store = await readTokensFile();
    const tokens = store.tokens || [];
    const newTokens = tokens.filter(t => t.name !== name);
    await writeTokensFile(newTokens);
    return { success: true };
  } catch (error) {
    return { success: false, error: 'Failed to delete token' };
  }
}));

ipcMain.handle('tokens:deleteAll', () => withTokenLock(async () => {
  try {
    await writeTokensFile([]);
    return { success: true };
  } catch (error) {
    return { success: false, error: 'Failed to delete tokens' };
  }
}));

// Updates disabled
ipcMain.handle('app:checkUpdates', async () => ({ success: true, hasUpdate: false }));
ipcMain.handle('app:downloadUpdate', async () => ({ success: true }));

// Version — single source of truth: package.json (via Electron)
ipcMain.handle('app:getVersion', async () => app.getVersion());

// Phase E : instrumentation HTTP (débit réel, 429, budget par route)
ipcMain.handle('app:getHttpStats', async () => ({
  requests: httpStats.requests,
  rateLimited: httpStats.rateLimited,
  routes: Object.fromEntries(httpStats.byRoute),
}));

// Discord handlers
ipcMain.handle('discord:connect', async (_, token) => {
  if (connecting) return { success: false, error: 'Already connecting' };
  connecting = true;
  try {
    // BUG-04 : ne détruit l'ancien client qu'après le succès du login —
    // un échec de connexion laisse l'utilisateur connecté au client précédent.
    const { Client } = require('discord.js-selfbot-v13');
    const next = new Client({ checkUpdate: false, fetchAllMembers: false });
    await next.login(token);
    if (discordClient) { try { const p = discordClient.destroy(); if (p?.catch) p.catch(() => {}); } catch {} }
    discordClient = next;
    return {
      success: true,
      username: next.user.tag,
      avatar: next.user.avatar
        ? `https://cdn.discordapp.com/avatars/${next.user.id}/${next.user.avatar}.png?size=64`
        : '/discord.png'
    };
  } catch (error) {
    console.error('Connect error:', error.message);
    return { success: false, error: error.message || 'Connection failed' };
  } finally {
    connecting = false;
  }
});

ipcMain.handle('discord:getFriends', async () => {
  const r = await discordFetch('GET', '/users/@me/relationships');
  if (!r.success) return { success: false, error: r.error || `HTTP ${r.status}` };

  const friends = r.data
    .filter(relationship => relationship.type === 1)
    .map(friend => ({
      id: friend.user.id,
      username: friend.user.username,
      displayName: friend.user.global_name || friend.user.username,
      avatar: friend.user.avatar ? `https://cdn.discordapp.com/avatars/${friend.user.id}/${friend.user.avatar}.png` : '/discord.png'
    }));

  return { success: true, friends };
});

ipcMain.handle('discord:getDMs', async () => {
  const r = await discordFetch('GET', '/users/@me/channels');
  if (!r.success) return { success: false, error: r.error || `HTTP ${r.status}` };
  const dms = r.data
    .filter(ch => ch.type === 1)
    .map(dm => ({
      id: dm.id,
      username: dm.recipients?.[0]?.username || 'Unknown User',
      displayName: dm.recipients?.[0]?.global_name || dm.recipients?.[0]?.username || 'Unknown User',
      avatar: dm.recipients?.[0]?.avatar
        ? `https://cdn.discordapp.com/avatars/${dm.recipients[0].id}/${dm.recipients[0].avatar}.png`
        : '/discord.png'
    }));
  return { success: true, dms };
});

ipcMain.handle('discord:deleteDMMessage', async (_, channelId, messageId) => {
  const r = await discordFetch('DELETE', `/channels/${channelId}/messages/${messageId}`);
  if (!r.success) {
    if (r.status === 429) return { success: false, error: 'Rate limited', retryAfter: r.retryAfter };
    if (r.status === 404) return { success: false, error: 'not found' };
    return { success: false, error: r.error || `HTTP ${r.status}` };
  }
  return { success: true };
});

ipcMain.handle('discord:closeDM', async (_, channelId) => {
  const r = await discordFetch('DELETE', `/channels/${channelId}`);
  if (!r.success) {
    if (r.status === 429) return { success: false, error: 'Rate limited', retryAfter: r.retryAfter };
    return { success: false, error: r.error || `HTTP ${r.status}` };
  }
  return { success: true };
});

ipcMain.handle('discord:removeOwnReaction', async (_, channelId, messageId, rawEmojiKey) => {
  if (!rawEmojiKey) return { success: false, error: 'empty emoji key' };

  const key = rawEmojiKey.includes(':') ? rawEmojiKey : rawEmojiKey.replace(/%EF%B8%8F/g, '');
  const r = await discordFetch('DELETE', `/channels/${channelId}/messages/${messageId}/reactions/${key}/@me`);

  if (!r.success) {
    // anti-fantômes : 404 = réaction confirmée absente (ok) ; 400 = requête invalide (échec visible, pas silencieux)
    if (r.status === 404) return { success: false, error: 'noReaction' };
    if (r.status === 400) return { success: false, error: 'invalidEmoji' };
    if (r.status === 429) return { success: false, error: 'Rate limited', retryAfter: r.retryAfter };
    return { success: false, error: r.error || `HTTP ${r.status}` };
  }
  return { success: true };
});

ipcMain.handle('discord:getReactions', async (_, channelId, messageId, emoji, afterId) => {
  const r = await discordFetch('GET', `/channels/${channelId}/messages/${messageId}/reactions/${emoji}`, afterId ? { params: { after: afterId } } : {});
  if (!r.success) {
    if (r.status === 429) return { success: false, error: 'Rate limited', retryAfter: r.retryAfter };
    return { success: false, error: r.status ? `HTTP ${r.status}` : 'Failed to get reactions' };
  }
  return { success: true, data: r.data };
});

ipcMain.handle('discord:deleteFriend', async (_, friendId) => {
  const r = await discordFetch('DELETE', `/users/@me/relationships/${friendId}`);
  if (!r.success) {
    if (r.status === 429) return { success: false, error: 'Rate limited', retryAfter: r.retryAfter };
    return { success: false, error: r.error || `HTTP ${r.status}` };
  }
  return { success: true };
});

// Phase C : cache persistant de la liste des serveurs (lancement instantané).
// La correction (force=true) contourne le cache — aucune donnée périmée après mutation.
const SERVERS_CACHE_TTL = 30000;
const serversCachePath = () => path.join(app.getPath('userData'), 'servers_cache.json');

function readServersCache() {
  try {
    const { at, servers } = JSON.parse(fs.readFileSync(serversCachePath(), 'utf8'));
    if (Date.now() - at < SERVERS_CACHE_TTL && Array.isArray(servers)) return servers;
  } catch {}
  return null;
}

function writeServersCache(servers) {
  try { fs.writeFileSync(serversCachePath(), JSON.stringify({ at: Date.now(), servers })); } catch {}
}

ipcMain.handle('discord:getServers', async (_, force = false) => {
  if (!force) {
    const cached = readServersCache();
    if (cached) return { success: true, servers: cached };
  }
  const r = await discordFetch('GET', '/users/@me/guilds');
  if (!r.success) return { success: false, error: r.error || `HTTP ${r.status}` };

  const servers = r.data.map(server => ({
    id: server.id,
    name: server.name,
    icon: server.icon
      ? `https://cdn.discordapp.com/icons/${server.id}/${server.icon}.png`
      : '/discord.png'
  }));
  writeServersCache(servers);
  return { success: true, servers };
});

// Phase D : cache canaux par serveur (mémoire, TTL 60 s) — évite de re-fetch
// quand delete-msgs + rm-reactions s'enchaînent sur le même serveur.
const channelsCache = new Map(); // serverId -> { at, channels }
const CHANNELS_TTL = 60000;

ipcMain.handle('discord:getServerChannels', async (_, serverId) => {
  const hit = channelsCache.get(serverId);
  if (hit && Date.now() - hit.at < CHANNELS_TTL) {
    return { success: true, channels: hit.channels, currentUserId: discordClient.user?.id };
  }
  const r = await discordFetch('GET', `/guilds/${serverId}/channels`);
  if (!r.success) return { success: false, error: r.error || `HTTP ${r.status}` };

  // types: 0=text, 2=voice, 5=announcement, 10=announcement-thread, 11=public-thread, 12=private-thread, 15=forum, 16=media
  const channels = r.data
    .filter(ch => [0, 5, 10, 11, 12, 15, 16].includes(ch.type))
    .map(ch => ({ id: ch.id, name: ch.name, type: ch.type }));
  channelsCache.set(serverId, { at: Date.now(), channels });
  return { success: true, channels, currentUserId: discordClient.user?.id };
});

ipcMain.handle('discord:leaveServer', async (_, serverId) => {
  const r = await discordFetch('DELETE', `/users/@me/guilds/${serverId}`);
  if (!r.success) {
    if (r.status === 429) return { success: false, error: 'Rate limited', retryAfter: r.retryAfter };
    return { success: false, error: r.error || `HTTP ${r.status}` };
  }
  return { success: true };
});

// ============================================================
// Persistance locale (checkpoints, watermarks, ledger anti-fantômes)
// ============================================================
const cpDir = () => path.join(app.getPath('userData'), 'checkpoints');
const wmFile = (serverId) => path.join(app.getPath('userData'), `watermark-${serverId}.json`);
const LEDGER_FILE = () => path.join(app.getPath('userData'), 'cleaned_reactions.json');
const LEDGER_TTL = 24 * 3600 * 1000;

const isSnowflake = (s) => typeof s === 'string' && /^\d+$/.test(s) && s.length <= 32;
const isOp = (op) => op === 'removeReactions' || op === 'deleteMessages';

ipcMain.handle('persist:checkpointLoad', async (_, op, serverId) => {
  if (!isOp(op) || !isSnowflake(serverId)) return null;
  return readJson(path.join(cpDir(), `${op}-${serverId}.json`));
});
ipcMain.handle('persist:checkpointSave', async (_, op, serverId, cp) => {
  if (!isOp(op) || !isSnowflake(serverId) || !cp || typeof cp !== 'object') return;
  await writeJson(path.join(cpDir(), `${op}-${serverId}.json`), cp);
});
ipcMain.handle('persist:checkpointClear', async (_, op, serverId) => {
  if (!isOp(op) || !isSnowflake(serverId)) return;
  try { await fsp.unlink(path.join(cpDir(), `${op}-${serverId}.json`)); } catch {}
});
ipcMain.handle('persist:watermarkGet', async (_, serverId) => {
  if (!isSnowflake(serverId)) return {};
  const s = await readJson(wmFile(serverId));
  return (s && typeof s === 'object' && !Array.isArray(s)) ? s : {};
});
ipcMain.handle('persist:watermarkSet', async (_, serverId, map) => {
  if (!isSnowflake(serverId) || !map || typeof map !== 'object') return;
  await writeJson(wmFile(serverId), map);
});
ipcMain.handle('persist:ledgerGet', async () => {
  const s = await readJson(LEDGER_FILE());
  return (s && typeof s === 'object' && !Array.isArray(s)) ? s : {};
});
ipcMain.handle('persist:ledgerAdd', async (_, keys) => {
  if (!Array.isArray(keys) || !keys.length) return;
  const s = (await readJson(LEDGER_FILE())) || {};
  const now = Date.now();
  for (const k of keys) if (typeof k === 'string' && k.length <= 200) s[k] = now;
  await writeJson(LEDGER_FILE(), s);
});
// Nettoyage des checkpoints obsolètes (au démarrage)
async function cleanupCheckpoints() {
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  try {
    const files = await fsp.readdir(cpDir());
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        if ((await fsp.stat(path.join(cpDir(), f))).mtimeMs < cutoff) {
          await fsp.unlink(path.join(cpDir(), f));
        }
      } catch {}
    }
  } catch {}
}
ipcMain.handle('persist:cleanup', cleanupCheckpoints);

app.whenReady().then(() => {
  createWindow();
  cleanupCheckpoints();
});

app.on('window-all-closed', () => {
  if (discordClient) { try { const p = discordClient.destroy(); if (p?.catch) p.catch(() => {}); } catch {} discordClient = null; }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
