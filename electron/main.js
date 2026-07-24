const { app, BrowserWindow, ipcMain, shell, dialog, safeStorage } = require('electron');
const path = require('path');
const axios = require('axios');
const fs = require('fs');
const fsp = require('fs/promises');

// Portable data directory setup
const isPortable = process.env.PORTABLE_BUILD === 'true' || (app.isPackaged && fs.existsSync(path.join(path.dirname(process.execPath), '.portable')));
const appRoot = app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '..');

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
const tokensPath = path.join(app.getPath('userData'), 'saved_tokens.json');

if (!fs.existsSync(tokensPath)) {
  fs.writeFileSync(tokensPath, '[]', 'utf8');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 750,
    minWidth: 770,
    minHeight: 600,
    frame: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
    backgroundColor: '#1a1b1e'
  });

  mainWindow.loadFile('./index.html');
  mainWindow.webContents.setBackgroundThrottling(false);
  mainWindow.once('ready-to-show', () => mainWindow.show());
}

ipcMain.on('window:minimize', () => mainWindow.minimize());
ipcMain.on('window:maximize', () => {
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
});
ipcMain.on('window:close', () => mainWindow.close());

ipcMain.handle('discord:getGroups', async () => {
  try {
    if (!discordClient || !discordClient.user) {
      return { 
        success: false, 
        error: 'Not connected to Discord' 
      };
    }

    const groups = Array.from(discordClient.channels.cache.values())
      .filter(channel => channel.type === 'GROUP_DM')
      .map(group => ({
        id: group.id,
        name: group.name || 'Unnamed Group',
        icon: group.iconURL() || '/discord.png',
        recipients: group.recipients.size
      }));

    return { 
      success: true, 
      groups 
    };
  } catch (error) {
    console.error('Get groups error:', error);
    return { 
      success: false, 
      error: error.message 
    };
  }
});

ipcMain.handle('discord:leaveGroup', async (_, groupId) => {
  try {
    if (!discordClient || !discordClient.user) {
      return { 
        success: false, 
        error: 'Not connected to Discord' 
      };
    }

    const group = await discordClient.channels.fetch(groupId);
    if (!group || group.type !== 'GROUP_DM') {
      return {
        success: false,
        error: 'Invalid group'
      };
    }

    await group.delete();
    return { success: true };
  } catch (error) {
    console.error('Leave group error:', error);
    return { 
      success: false, 
      error: error.message 
    };
  }
});

ipcMain.handle('discord:getGroupMessages', async (_, channelId, beforeId = null) => {
  try {
    if (!discordClient || !discordClient.user) {
      return { success: false, error: 'Not connected to Discord' };
    }
    const channel = await discordClient.channels.fetch(channelId);
    if (!channel) return { success: false, error: 'No access' };
    const options = beforeId ? { before: beforeId, limit: 100 } : { limit: 100 };
    const messages = await channel.messages.fetch(options);
    const msgs = Array.from(messages.values()).map(msg => ({
        id: msg.id,
        content: msg.content,
        author: { id: msg.author.id },
        type: msg.type,
        attachments: Array.from(msg.attachments.values()).map(a => ({ id: a.id, url: a.url })),
        embeds: Array.from(msg.embeds.values()).map(e => ({ type: e.type })),
        reactions: Array.from(msg.reactions.cache.values()).map(r => ({
          emoji: { id: r.emoji.id, name: r.emoji.name },
          count: r.count,
          me: r.me
        }))
      }));
    return {
      success: true,
      currentUserId: discordClient.user.id,
      messages: msgs
    };
  } catch (error) {
    if (error.code === 50001) {
      return { success: false, error: 'No access' };
    }
    console.error('getGroupMessages error:', error.message);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('discord:getMessage', async (_, channelId, messageId) => {
  try {
    if (!discordClient || !discordClient.token) {
      return { success: false, error: 'Not connected' };
    }
    const res = await axios.get(
      `https://discord.com/api/v9/channels/${channelId}/messages/${messageId}`,
      { headers: { 'Authorization': discordClient.token } }
    );
    const msg = res.data;
    return {
      success: true,
      currentUserId: discordClient.user.id,
      reactions: (msg.reactions || []).map(r => ({
        emoji: { id: r.emoji.id, name: r.emoji.name },
        count: r.count,
        me: r.me
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

    await axios.delete(`https://discord.com/api/v9/channels/${channelId}/messages/${messageId}`, {
      headers: {
        'Authorization': discordClient.token,
        'Content-Type': 'application/json'
      }
    });

    return { success: true };
  } catch (error) {
    console.error('Delete group message error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('discord:muteServer', async (_, serverId) => {
  try {
    if (!discordClient || !discordClient.token) {
      return { success: false, error: 'Not connected' };
    }

    await axios.patch(`https://discord.com/api/v9/users/@me/guilds/${serverId}/settings`, {
      muted: true
    }, {
      headers: {
        'Authorization': discordClient.token,
        'Content-Type': 'application/json'
      }
    });

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

    await axios.patch(`https://discord.com/api/v9/users/@me/guilds/${serverId}/settings`, {
      muted: false
    }, {
      headers: {
        'Authorization': discordClient.token,
        'Content-Type': 'application/json'
      }
    });

    return { success: true };
  } catch (error) {
    console.error('Unmute server error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('discord:readAll', async () => {
  try {
    if (!discordClient || !discordClient.token) {
      return { success: false, error: 'Not connected' };
    }

    // Get all guilds
    const guilds = Array.from(discordClient.guilds.cache.values());
    
    // Mark each guild as read
    for (const guild of guilds) {
      try {
        await guild.markAsRead();
      } catch (error) {
        console.error(`Failed to mark guild ${guild.id} as read:`, error);
      }
    }

    return { success: true };
  } catch (error) {
    console.error('Read all error:', error);
    return { success: false, error: error.message };
  }
});

// External links
ipcMain.handle('app:openExternal', async (_, url) => {
  await shell.openExternal(url);
});

// Token management — encrypted at rest via safeStorage
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
    const raw = await fsp.readFile(tokensPath, 'utf8');
    const tokens = JSON.parse(raw);
    if (tokens.some(t => t.name === name)) {
      return { success: false, error: 'A token with this name already exists' };
    }
    tokens.push({ name, token: encryptToken(token) });
    await fsp.writeFile(tokensPath, JSON.stringify(tokens, null, 2));
    return { success: true };
  } catch (error) {
    return { success: false, error: 'Failed to save token' };
  }
});

ipcMain.handle('tokens:get', async () => {
  try {
    const raw = await fsp.readFile(tokensPath, 'utf8');
    const tokens = JSON.parse(raw);
    let hasLegacy = false;

    const result = tokens.map(t => {
      if (typeof t.token === 'string' && t.token.startsWith('enc:')) {
        try {
          return { ...t, token: decryptToken(t.token) };
        } catch {
          return null;
        }
      }
      hasLegacy = true;
      return { ...t, token: t.token };
    }).filter(Boolean);

    if (hasLegacy && safeStorage.isEncryptionAvailable()) {
      const encrypted = result.map(t => ({ ...t, token: encryptToken(t.token) }));
      await fsp.writeFile(tokensPath, JSON.stringify(encrypted, null, 2));
    }

    return { success: true, tokens: result };
  } catch (error) {
    return { success: false, error: 'Failed to load tokens' };
  }
});

ipcMain.handle('tokens:delete', async (_, name) => {
  try {
    const raw = await fsp.readFile(tokensPath, 'utf8');
    const tokens = JSON.parse(raw);
    const newTokens = tokens.filter(t => t.name !== name);
    await fsp.writeFile(tokensPath, JSON.stringify(newTokens, null, 2));
    return { success: true };
  } catch (error) {
    return { success: false, error: 'Failed to delete token' };
  }
});

ipcMain.handle('tokens:deleteAll', async () => {
  try {
    await fsp.writeFile(tokensPath, '[]', 'utf8');
    return { success: true };
  } catch (error) {
    return { success: false, error: 'Failed to delete tokens' };
  }
});

// Updates disabled — no network requests
ipcMain.handle('app:checkUpdates', async () => ({ hasUpdate: false }));
ipcMain.handle('app:downloadUpdate', async () => {});

// Discord handlers
ipcMain.handle('discord:connect', async (_, token) => {
  try {
    if (discordClient) {
      await discordClient.destroy();
    }
    
    const { Client } = require('discord.js-selfbot-v13');
    discordClient = new Client({
      checkUpdate: false,
      fetchAllMembers: false,
    });
    
    await discordClient.login(token);
    
    return { 
      success: true, 
      username: discordClient.user.tag 
    };
  } catch (error) {
    console.error('Connection failed');
    return { 
      success: false, 
      error: error.message || 'Connection failed' 
    };
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

    const response = await axios.get('https://discord.com/api/v9/users/@me/relationships', {
      headers: {
        'Authorization': discordClient.token
      }
    });

    const friends = response.data
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
    if (!discordClient || !discordClient.user) {
      return { 
        success: false, 
        error: 'Not connected to Discord' 
      };
    }

    const dms = Array.from(discordClient.channels.cache.values())
      .filter(channel => channel.type === 'DM')
      .map(dm => ({
        id: dm.id,
        username: dm.recipient?.username || 'Unknown User',
        displayName: dm.recipient?.globalName || dm.recipient?.username || 'Unknown User',
        avatar: dm.recipient?.avatarURL() || '/discord.png'
      }));

    return { 
      success: true, 
      dms 
    };
  } catch (error) {
    console.error('Get DMs error:', error);
    return { 
      success: false, 
      error: error.message 
    };
  }
});

ipcMain.handle('discord:getDMMessages', async (_, channelId, beforeId = null) => {
  try {
    if (!discordClient || !discordClient.user) {
      return { 
        success: false, 
        error: 'Not connected to Discord' 
      };
    }

    const channel = await discordClient.channels.fetch(channelId);
    if (!channel || channel.type !== 'DM') {
      return { 
        success: false, 
        error: 'Invalid DM channel' 
      };
    }

    const options = beforeId ? { before: beforeId, limit: 100 } : { limit: 100 };
    const messages = await channel.messages.fetch(options);
    
    return { 
      success: true, 
      currentUserId: discordClient.user.id,
      messages: Array.from(messages.values()).map(msg => ({
        id: msg.id,
        content: msg.content,
        isDeletable: msg.author.id === discordClient.user.id && !msg.system,
        reactions: Array.from(msg.reactions.cache.values()).map(r => ({
          emoji: { id: r.emoji.id, name: r.emoji.name },
          count: r.count,
          me: r.me
        }))
      }))
    };
  } catch (error) {
    console.error('Get DM messages error:', error);
    return { 
      success: false, 
      error: error.message 
    };
  }
});

ipcMain.handle('discord:deleteDMMessage', async (_, channelId, messageId) => {
  try {
    if (!discordClient || !discordClient.user) {
      return { 
        success: false, 
        error: 'Not connected to Discord' 
      };
    }

    const channel = await discordClient.channels.fetch(channelId);
    if (!channel || channel.type !== 'DM') {
      return { 
        success: false, 
        error: 'Invalid DM channel' 
      };
    }

    const message = await channel.messages.fetch(messageId);
    await message.delete();

    return { success: true };
  } catch (error) {
    console.error('Delete DM message error:', error);
    return { 
      success: false, 
      error: error.message 
    };
  }
});

ipcMain.handle('discord:closeDM', async (_, channelId) => {
  try {
    if (!discordClient || !discordClient.user) {
      return { 
        success: false, 
        error: 'Not connected to Discord' 
      };
    }

    const channel = await discordClient.channels.fetch(channelId);
    if (!channel || channel.type !== 'DM') {
      return { 
        success: false, 
        error: 'Invalid DM channel' 
      };
    }

    await channel.delete();
    return { success: true };
  } catch (error) {
    console.error('Close DM error:', error);
    return { 
      success: false, 
      error: error.message 
    };
  }
});

ipcMain.handle('discord:clearMessageReactions', async (_, channelId, messageId) => {
  try {
    if (!discordClient || !discordClient.token) {
      return { success: false, error: 'Not connected' };
    }

    await axios.delete(
      `https://discord.com/api/v9/channels/${channelId}/messages/${messageId}/reactions`,
      { headers: { 'Authorization': discordClient.token } }
    );

    return { success: true };
  } catch (error) {
    if (error.response?.status === 403) {
      return { success: false, error: 'No permission to clear reactions' };
    }
    if (error.response?.status === 429) {
      return { success: false, error: 'Rate limited', retryAfter: parseInt(error.response.headers?.['retry-after']) || 5 };
    }
    return { success: false, error: 'Failed to clear reactions' };
  }
});

ipcMain.handle('discord:removeOwnReaction', async (_, channelId, messageId, emoji) => {
  try {
    if (!discordClient || !discordClient.token) {
      return { success: false, error: 'Not connected' };
    }

    const encoded = encodeURIComponent(emoji);
    const url = `https://discord.com/api/v9/channels/${channelId}/messages/${messageId}/reactions/${encoded}/@me`;
    const response = await axios.delete(url, {
      headers: { 'Authorization': discordClient.token },
      validateStatus: () => true // accept any status
    });

    if (response.status === 204 || response.status === 200) {
      return { success: true };
    }
    if (response.status === 404) {
      return { success: false, error: 'noReaction' };
    }
    if (response.status === 429) {
      return { success: false, error: 'Rate limited', retryAfter: parseInt(response.headers?.['retry-after']) || 5 };
    }
    console.log(`[RR] removeOwnReaction unexpected status: ${response.status}`, emoji);
    return { success: false, error: `Unexpected status ${response.status}` };
  } catch (error) {
    console.log(`[RR] removeOwnReaction error:`, error.message);
    return { success: false, error: 'Failed to remove reaction' };
  }
});

ipcMain.handle('discord:deleteFriend', async (_, friendId) => {
  try {
    if (!discordClient || !discordClient.token) {
      return { success: false, error: 'Not connected to Discord' };
    }

    await axios.delete(`https://discord.com/api/v9/users/@me/relationships/${friendId}`, {
      headers: {
        'Authorization': discordClient.token,
        'Content-Type': 'application/json'
      }
    });

    return { success: true };
  } catch (error) {
    console.error('Delete friend error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('discord:getServers', async () => {
  try {
    if (!discordClient || !discordClient.guilds) {
      return { 
        success: false, 
        error: 'Not connected' 
      };
    }

    const servers = Array.from(discordClient.guilds.cache.values())
      .filter(server => server)
      .map(server => ({
        id: server.id,
        name: server.name,
        icon: server.iconURL() || '/discord.png'
      }));

    return { 
      success: true, 
      servers 
    };
  } catch (error) {
    console.error('Get servers error:', error);
    return { 
      success: false, 
      error: error.message 
    };
  }
});

ipcMain.handle('discord:getServerChannels', async (_, serverId) => {
  try {
    if (!discordClient || !discordClient.token) {
      return { success: false, error: 'Not connected' };
    }

    const response = await axios.get(
      `https://discord.com/api/v9/guilds/${serverId}/channels`,
      { headers: { 'Authorization': discordClient.token } }
    );

    const channels = response.data
      .filter(ch => [0, 5, 10, 11, 12].includes(ch.type))
      .map(ch => ({ id: ch.id, name: ch.name, type: ch.type }));

    return { success: true, channels };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('discord:leaveServer', async (_, serverId) => {
  try {
    if (!discordClient || !discordClient.guilds) {
      return { 
        success: false, 
        error: 'Not connected' 
      };
    }

    const guild = discordClient.guilds.cache.get(serverId);
    if (!guild) {
      return {
        success: false,
        error: 'Server not found'
      };
    }

    await guild.leave();
    return { success: true };
  } catch (error) {
    console.error('Leave server error:', error);
    return { 
      success: false, 
      error: error.message 
    };
  }
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});