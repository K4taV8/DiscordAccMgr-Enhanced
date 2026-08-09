const { app, BrowserWindow, ipcMain, shell, dialog, safeStorage } = require('electron');
const path = require('path');
const axios = require('axios');
const fs = require('fs');
const fsp = require('fs/promises');

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

ipcMain.handle('discord:getGroups', async () => {
  try {
    if (!discordClient?.token) return { success: false, error: 'Not connected' };
    const resp = await axios.get('https://discord.com/api/v9/users/@me/channels', {
      headers: { 'Authorization': discordClient.token },
      validateStatus: () => true
    });
    if (resp.status !== 200) return { success: false, error: `HTTP ${resp.status}` };
    const groups = resp.data
      .filter(ch => ch.type === 3)
      .map(group => ({
        id: group.id,
        name: group.name || 'Unnamed Group',
        icon: group.icon ? `https://cdn.discordapp.com/channel-icons/${group.id}/${group.icon}.png` : '/discord.png',
        recipients: group.recipients?.length || 0
      }));
    return { success: true, groups };
  } catch (error) {
    console.error('Get groups error:', error.message);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('discord:leaveGroup', async (_, groupId) => {
  try {
    if (!discordClient?.token) return { success: false, error: 'Not connected' };
    const resp = await axios.delete(`https://discord.com/api/v9/channels/${groupId}`, {
      headers: { 'Authorization': discordClient.token },
      validateStatus: () => true
    });
    if (resp.status === 429) return { success: false, error: 'Rate limited', retryAfter: parseInt(resp.headers?.['retry-after']) || 5 };
    if (resp.status === 204 || resp.status === 200) return { success: true };
    return { success: false, error: `HTTP ${resp.status}` };
  } catch (error) {
    console.error('Leave group error:', error.message);
    return { success: false, error: error.message };
  }
});

async function fetchChannelMessagesRest(channelId, beforeId = null, afterId = null) {
  try {
    if (!discordClient?.token) return { success: false, error: 'Not connected' };
    const params = new URLSearchParams({ limit: afterId ? '1' : '100' });
    if (beforeId) params.set('before', beforeId);
    if (afterId) params.set('after', afterId);
    const resp = await axios.get(
      `https://discord.com/api/v9/channels/${channelId}/messages?${params}`,
      { headers: { 'Authorization': discordClient.token }, validateStatus: () => true }
    );
    if (resp.status === 429) {
      return { success: false, error: 'Rate limited', retryAfter: parseInt(resp.headers?.['retry-after']) || 5 };
    }
    if (resp.status === 403 || resp.status === 404) {
      return { success: false, error: 'No access' };
    }
    if (resp.status !== 200) {
      return { success: false, error: `HTTP ${resp.status}` };
    }
    const uid = discordClient.user?.id;
    const msgs = resp.data.map(msg => ({
      id: msg.id,
      content: typeof msg.content === 'string' ? msg.content.substring(0, 80) : '',
      author: { id: msg.author?.id },
      type: msg.type,
      attachments: (msg.attachments || []).map(a => ({ id: a.id, url: a.url })),
      embeds: (msg.embeds || []).map(e => ({ type: e.type })),
      sticker_items: msg.sticker_items || [],
      message_snapshots: msg.message_snapshots || [],
      message_reference: msg.message_reference || null,
      isDeletable: msg.author?.id === uid,
      reactions: (msg.reactions || []).map(r => ({
        emoji: { id: r.emoji.id, name: r.emoji.name },
        count: r.count,
        me: Boolean(r.me || r.me_burst)
      }))
    }));
    return { success: true, currentUserId: uid, messages: msgs };
  } catch (error) {
    console.error('fetchChannelMessagesRest error:', error.message);
    return { success: false, error: error.message };
  }
}

ipcMain.handle('discord:getChannelMessages', async (_, channelId, beforeId = null, afterId = null) => {
  return fetchChannelMessagesRest(channelId, beforeId, afterId);
});

ipcMain.handle('discord:getDMMessages', async (_, channelId, beforeId = null) => {
  return fetchChannelMessagesRest(channelId, beforeId);
});

ipcMain.handle('discord:getMessage', async (_, channelId, messageId) => {
  try {
    if (!discordClient?.token) return { success: false, error: 'Not connected' };
    const resp = await axios.get(
      `https://discord.com/api/v9/channels/${channelId}/messages/${messageId}`,
      { headers: { 'Authorization': discordClient.token }, validateStatus: () => true }
    );
    if (resp.status === 429) return { success: false, error: 'Rate limited', retryAfter: parseInt(resp.headers?.['retry-after']) || 5 };
    if (resp.status !== 200) return { success: false, error: `HTTP ${resp.status}` };
    const msg = resp.data;
    return {
      success: true,
      currentUserId: discordClient.user.id,
      reactions: (msg.reactions || []).map(r => ({
        emoji: { id: r.emoji.id, name: r.emoji.name },
        count: r.count,
        me: Boolean(r.me || r.me_burst)
      }))
    };
  } catch (error) {
    console.error('getMessage error:', error.message);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('discord:deleteGroupMessage', async (_, channelId, messageId) => {
  try {
    if (!discordClient || !discordClient.token) {
      return { success: false, error: 'Not connected' };
    }

    const resp = await axios.delete(`https://discord.com/api/v9/channels/${channelId}/messages/${messageId}`, {
      headers: { 'Authorization': discordClient.token },
      validateStatus: () => true
    });

    if (resp.status === 204 || resp.status === 200) return { success: true };
    if (resp.status === 429) {
      return { success: false, error: 'Rate limited', retryAfter: parseInt(resp.headers?.['retry-after']) || 5 };
    }
    if (resp.status === 404) return { success: false, error: 'not found' };
    return { success: false, error: `HTTP ${resp.status}` };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('discord:muteServer', async (_, serverId) => {
  try {
    if (!discordClient || !discordClient.token) {
      return { success: false, error: 'Not connected' };
    }

    const resp = await axios.patch(`https://discord.com/api/v9/users/@me/guilds/${serverId}/settings`, {
      muted: true
    }, {
      headers: {
        'Authorization': discordClient.token,
        'Content-Type': 'application/json'
      },
      validateStatus: () => true
    });

    if (resp.status === 429) return { success: false, error: 'Rate limited', retryAfter: parseInt(resp.headers?.['retry-after']) || 5 };
    if (resp.status !== 200) return { success: false, error: `HTTP ${resp.status}` };
    return { success: true };
  } catch (error) {
    console.error('Mute server error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('discord:unmuteServer', async (_, serverId) => {
  try {
    if (!discordClient || !discordClient.token) {
      return { success: false, error: 'Not connected' };
    }

    const resp = await axios.patch(`https://discord.com/api/v9/users/@me/guilds/${serverId}/settings`, {
      muted: false
    }, {
      headers: {
        'Authorization': discordClient.token,
        'Content-Type': 'application/json'
      },
      validateStatus: () => true
    });

    if (resp.status === 429) return { success: false, error: 'Rate limited', retryAfter: parseInt(resp.headers?.['retry-after']) || 5 };
    if (resp.status !== 200) return { success: false, error: `HTTP ${resp.status}` };
    return { success: true };
  } catch (error) {
    console.error('Unmute server error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('discord:readAll', async () => {
  try {
    if (!discordClient?.token) {
      return { success: false, error: 'Not connected' };
    }

    let allGuilds = [];
    let lastId = null;
    while (true) {
      const params = new URLSearchParams({ limit: '100' });
      if (lastId) params.set('after', lastId);
      const resp = await axios.get(`https://discord.com/api/v9/users/@me/guilds?${params}`, {
        headers: { 'Authorization': discordClient.token },
        validateStatus: () => true
      });
      if (resp.status !== 200) break;
      allGuilds = allGuilds.concat(resp.data);
      if (resp.data.length < 100) break;
      lastId = resp.data[resp.data.length - 1].id;
    }

    let failed = 0;
    for (const guild of allGuilds) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const ack = await axios.put(`https://discord.com/api/v9/guilds/${guild.id}/ack`, { token: null }, {
            headers: { 'Authorization': discordClient.token },
            validateStatus: () => true
          });
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
      await new Promise(resolve => setTimeout(resolve, 300));
      if (failed > allGuilds.length / 3) break; // ponytail: se retire si les erreurs s'accumulent — on n'ignore pas un serveur en panne indéfiniment
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
  await fsp.writeFile(tokensPath, JSON.stringify({ schemaVersion: TOKEN_SCHEMA_VERSION, tokens: store }, null, 2));
}

function encryptToken(token) {
  return 'enc:' + safeStorage.encryptString(token).toString('base64');
}

function decryptToken(stored) {
  if (typeof stored === 'string' && stored.startsWith('enc:')) {
    return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
  }
  return null;
}

ipcMain.handle('tokens:save', async (_, name, token) => {
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
});

ipcMain.handle('tokens:get', async () => {
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
});

ipcMain.handle('tokens:delete', async (_, name) => {
  try {
    const store = await readTokensFile();
    const tokens = store.tokens || [];
    const newTokens = tokens.filter(t => t.name !== name);
    await writeTokensFile(newTokens);
    return { success: true };
  } catch (error) {
    return { success: false, error: 'Failed to delete token' };
  }
});

ipcMain.handle('tokens:deleteAll', async () => {
  try {
    await writeTokensFile([]);
    return { success: true };
  } catch (error) {
    return { success: false, error: 'Failed to delete tokens' };
  }
});

// Updates disabled
ipcMain.handle('app:checkUpdates', async () => ({ success: true, hasUpdate: false }));
ipcMain.handle('app:downloadUpdate', async () => ({ success: true }));

// Version — single source of truth: package.json (via Electron)
ipcMain.handle('app:getVersion', async () => app.getVersion());

// Discord handlers
ipcMain.handle('discord:connect', async (_, token) => {
  if (connecting) return { success: false, error: 'Already connecting' };
  connecting = true;
  try {
    if (discordClient) { try { const p = discordClient.destroy(); if (p?.catch) p.catch(() => {}); } catch {} }
    const { Client } = require('discord.js-selfbot-v13');
    discordClient = new Client({ checkUpdate: false, fetchAllMembers: false });
    await discordClient.login(token);
    return {
      success: true,
      username: discordClient.user.tag,
      avatar: discordClient.user.avatar
        ? `https://cdn.discordapp.com/avatars/${discordClient.user.id}/${discordClient.user.avatar}.png?size=64`
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
  try {
    if (!discordClient || !discordClient.token) {
      return { 
        success: false, 
        error: 'Not connected to Discord' 
      };
    }

    const resp = await axios.get('https://discord.com/api/v9/users/@me/relationships', {
      headers: { 'Authorization': discordClient.token },
      validateStatus: () => true
    });
    if (resp.status !== 200) return { success: false, error: `HTTP ${resp.status}` };

    const friends = resp.data
      .filter(relationship => relationship.type === 1)
      .map(friend => ({
        id: friend.user.id,
        username: friend.user.username,
        displayName: friend.user.global_name || friend.user.username,
        avatar: friend.user.avatar ? `https://cdn.discordapp.com/avatars/${friend.user.id}/${friend.user.avatar}.png` : '/discord.png'
      }));

    return { 
      success: true, 
      friends 
    };
  } catch (error) {
    console.error('Get friends error:', error);
    return { 
      success: false, 
      error: error.message 
    };
  }
});

ipcMain.handle('discord:getDMs', async () => {
  try {
    if (!discordClient?.token) return { success: false, error: 'Not connected' };
    const resp = await axios.get('https://discord.com/api/v9/users/@me/channels', {
      headers: { 'Authorization': discordClient.token },
      validateStatus: () => true
    });
    if (resp.status !== 200) return { success: false, error: `HTTP ${resp.status}` };
    const dms = resp.data
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
  } catch (error) {
    console.error('Get DMs error:', error.message);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('discord:deleteDMMessage', async (_, channelId, messageId) => {
  try {
    if (!discordClient?.token) return { success: false, error: 'Not connected' };
    const resp = await axios.delete(
      `https://discord.com/api/v9/channels/${channelId}/messages/${messageId}`,
      { headers: { 'Authorization': discordClient.token }, validateStatus: () => true }
    );
    if (resp.status === 204 || resp.status === 200) return { success: true };
    if (resp.status === 429) return { success: false, error: 'Rate limited', retryAfter: parseInt(resp.headers?.['retry-after']) || 5 };
    if (resp.status === 404) return { success: false, error: 'not found' };
    return { success: false, error: `HTTP ${resp.status}` };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('discord:closeDM', async (_, channelId) => {
  try {
    if (!discordClient?.token) return { success: false, error: 'Not connected' };
    const resp = await axios.delete(`https://discord.com/api/v9/channels/${channelId}`, {
      headers: { 'Authorization': discordClient.token },
      validateStatus: () => true
    });
    if (resp.status === 429) return { success: false, error: 'Rate limited', retryAfter: parseInt(resp.headers?.['retry-after']) || 5 };
    if (resp.status === 204 || resp.status === 200) return { success: true };
    return { success: false, error: `HTTP ${resp.status}` };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('discord:removeOwnReaction', async (_, channelId, messageId, rawEmojiKey) => {
  try {
    if (!discordClient?.token) return { success: false, error: 'Not connected' };
    if (!rawEmojiKey) return { success: false, error: 'empty emoji key' };

    const key = rawEmojiKey.includes(':') ? rawEmojiKey : rawEmojiKey.replace(/%EF%B8%8F/g, '');
    const url = `https://discord.com/api/v9/channels/${channelId}/messages/${messageId}/reactions/${key}/@me`;
    const resp = await axios.delete(url, {
      headers: { 'Authorization': discordClient.token },
      validateStatus: () => true
    });

    if (resp.status === 204) return { success: true };
    if (resp.status === 404 || resp.status === 400) return { success: false, error: 'noReaction' };
    if (resp.status === 429) {
      return { success: false, error: 'Rate limited', retryAfter: parseInt(resp.headers?.['retry-after']) || 5 };
    }
    return { success: false, error: `HTTP ${resp.status}` };
  } catch (error) {
    console.error('[RR] error:', error.message);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('discord:getReactions', async (_, channelId, messageId, emoji, afterId) => {
  try {
    if (!discordClient || !discordClient.token) {
      return { success: false, error: 'Not connected' };
    }
    const params = afterId ? `?after=${afterId}` : '';
    const url = `https://discord.com/api/v9/channels/${channelId}/messages/${messageId}/reactions/${emoji}${params}`;
    const resp = await axios.get(url, {
      headers: { 'Authorization': discordClient.token },
      validateStatus: () => true
    });
    if (resp.status === 200) return { success: true, data: resp.data };
    if (resp.status === 429) return { success: false, error: 'Rate limited', retryAfter: parseInt(resp.headers?.['retry-after']) || 5 };
    return { success: false, error: `HTTP ${resp.status}` };
  } catch (error) {
    console.log('[RR] getReactions error:', error.message);
    return { success: false, error: 'Failed to get reactions' };
  }
});

ipcMain.handle('discord:deleteFriend', async (_, friendId) => {
  try {
    if (!discordClient?.token) return { success: false, error: 'Not connected' };
    const resp = await axios.delete(`https://discord.com/api/v9/users/@me/relationships/${friendId}`, {
      headers: { 'Authorization': discordClient.token },
      validateStatus: () => true
    });
    if (resp.status === 204 || resp.status === 200) return { success: true };
    if (resp.status === 429) return { success: false, error: 'Rate limited', retryAfter: parseInt(resp.headers?.['retry-after']) || 5 };
    return { success: false, error: `HTTP ${resp.status}` };
  } catch (error) {
    console.error('Delete friend error:', error.message);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('discord:getServers', async () => {
  try {
    if (!discordClient?.token) {
      return { success: false, error: 'Not connected' };
    }

    const resp = await axios.get('https://discord.com/api/v9/users/@me/guilds', {
      headers: { 'Authorization': discordClient.token },
      validateStatus: () => true
    });
    if (resp.status !== 200) return { success: false, error: `HTTP ${resp.status}` };

    const servers = resp.data.map(server => ({
      id: server.id,
      name: server.name,
      icon: server.icon
        ? `https://cdn.discordapp.com/icons/${server.id}/${server.icon}.png`
        : '/discord.png'
    }));

    return { success: true, servers };
  } catch (error) {
    console.error('Get servers error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('discord:getServerChannels', async (_, serverId) => {
  try {
    if (!discordClient || !discordClient.token) {
      return { success: false, error: 'Not connected' };
    }

    const response = await axios.get(
      `https://discord.com/api/v9/guilds/${serverId}/channels`,
      { headers: { 'Authorization': discordClient.token }, validateStatus: () => true }
    );
    if (response.status !== 200) return { success: false, error: `HTTP ${response.status}` };

    // types: 0=text, 2=voice, 5=announcement, 10=announcement-thread, 11=public-thread, 12=private-thread, 15=forum, 16=media
    const channels = response.data
      .filter(ch => [0, 5, 10, 11, 12, 15, 16].includes(ch.type))
      .map(ch => ({ id: ch.id, name: ch.name, type: ch.type }));

    return { success: true, channels, currentUserId: discordClient.user?.id };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('discord:leaveServer', async (_, serverId) => {
  try {
    if (!discordClient?.token) {
      return { success: false, error: 'Not connected' };
    }

    const resp = await axios.delete(`https://discord.com/api/v9/users/@me/guilds/${serverId}`, {
      headers: { 'Authorization': discordClient.token },
      validateStatus: () => true
    });

    if (resp.status === 429) return { success: false, error: 'Rate limited', retryAfter: parseInt(resp.headers?.['retry-after']) || 5 };
    if (resp.status === 204 || resp.status === 200) return { success: true };
    return { success: false, error: `HTTP ${resp.status}` };
  } catch (error) {
    console.error('Leave server error:', error);
    return { success: false, error: error.message };
  }
});

app.whenReady().then(createWindow);

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
