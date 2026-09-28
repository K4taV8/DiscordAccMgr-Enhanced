const { contextBridge, ipcRenderer } = require('electron');

const SENSITIVE_CALLS = new Set(['connectDiscord', 'saveToken', 'getTokens']);

function redact(name, args) {
  return SENSITIVE_CALLS.has(name) ? args.map(() => '[redacted]') : args;
}

function wrap(name, fn) {
  return async (...args) => {
    console.log(`[IPC >>] ${name}`, redact(name, args));
    try {
      const result = await fn(...args);
      const preview = result && typeof result === 'object' ? { ...result, messages: result.messages?.length } : result;
      console.log(`[IPC <<] ${name}`, redact(name, [preview]));
      return result;
    } catch (e) {
      console.error(`[IPC !!] ${name}`, e.message);
      throw e;
    }
  };
}

contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),

  getTokens: wrap('getTokens', () => ipcRenderer.invoke('tokens:get')),
  saveToken: wrap('saveToken', (name, token) => ipcRenderer.invoke('tokens:save', name, token)),
  deleteToken: wrap('deleteToken', (name) => ipcRenderer.invoke('tokens:delete', name)),
  deleteAllTokens: wrap('deleteAllTokens', () => ipcRenderer.invoke('tokens:deleteAll')),
  connectByName: wrap('connectByName', (name) => ipcRenderer.invoke('tokens:connectByName', name)),

  openExternal: wrap('openExternal', (url) => ipcRenderer.invoke('app:openExternal', url)),
  getAppVersion: wrap('getAppVersion', () => ipcRenderer.invoke('app:getVersion')),
  disconnect: wrap('disconnect', () => ipcRenderer.invoke('discord:disconnect')),

  muteServer: wrap('muteServer', (serverId) => ipcRenderer.invoke('discord:muteServer', serverId)),
  unmuteServer: wrap('unmuteServer', (serverId) => ipcRenderer.invoke('discord:unmuteServer', serverId)),
  readAll: wrap('readAll', () => ipcRenderer.invoke('discord:readAll')),
  readServer: wrap('readServer', (serverId) => ipcRenderer.invoke('discord:readServer', serverId)),
  onReadAllProgress: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('readall:progress', listener);
    return () => ipcRenderer.removeListener('readall:progress', listener);
  },

  connectDiscord: wrap('connectDiscord', (token) => ipcRenderer.invoke('discord:connect', token)),
  getFriends: wrap('getFriends', () => ipcRenderer.invoke('discord:getFriends')),
  deleteFriend: wrap('deleteFriend', (friendId) => ipcRenderer.invoke('discord:deleteFriend', friendId)),
  getServers: wrap('getServers', (force) => ipcRenderer.invoke('discord:getServers', force)),
  getServerChannels: wrap('getServerChannels', (serverId) => ipcRenderer.invoke('discord:getServerChannels', serverId)),
  leaveServer: wrap('leaveServer', (serverId) => ipcRenderer.invoke('discord:leaveServer', serverId)),
  getDMs: wrap('getDMs', () => ipcRenderer.invoke('discord:getDMs')),
  getDMMessages: wrap('getDMMessages', (channelId, beforeId) => ipcRenderer.invoke('discord:getDMMessages', channelId, beforeId)),
  deleteDMMessage: wrap('deleteDMMessage', (channelId, messageId) => ipcRenderer.invoke('discord:deleteDMMessage', channelId, messageId)),
  closeDM: wrap('closeDM', (channelId) => ipcRenderer.invoke('discord:closeDM', channelId)),

  getGroups: wrap('getGroups', () => ipcRenderer.invoke('discord:getGroups')),
  leaveGroup: wrap('leaveGroup', (groupId) => ipcRenderer.invoke('discord:leaveGroup', groupId)),
  getChannelMessages: wrap('getChannelMessages', (channelId, beforeId, afterId) => ipcRenderer.invoke('discord:getChannelMessages', channelId, beforeId, afterId)),
  getMessage: wrap('getMessage', (channelId, messageId) => ipcRenderer.invoke('discord:getMessage', channelId, messageId)),
  deleteGroupMessage: wrap('deleteGroupMessage', (channelId, messageId) => ipcRenderer.invoke('discord:deleteGroupMessage', channelId, messageId)),
  deletePackageMessage: wrap('deletePackageMessage', (channelId, messageId) => ipcRenderer.invoke('discord:deleteGroupMessage', channelId, messageId)),

  removeOwnReaction: wrap('removeOwnReaction', (channelId, messageId, emoji) => ipcRenderer.invoke('discord:removeOwnReaction', channelId, messageId, emoji)),
});

// Persistance locale (checkpoints / watermarks / ledger anti-fantômes)
contextBridge.exposeInMainWorld('persistAPI', {
  checkpointLoad: (op, serverId) => ipcRenderer.invoke('persist:checkpointLoad', op, serverId),
  checkpointSave: (op, serverId, cp) => ipcRenderer.invoke('persist:checkpointSave', op, serverId, cp),
  checkpointClear: (op, serverId) => ipcRenderer.invoke('persist:checkpointClear', op, serverId),
  watermarkGet: (serverId) => ipcRenderer.invoke('persist:watermarkGet', serverId),
  watermarkSet: (serverId, map) => ipcRenderer.invoke('persist:watermarkSet', serverId, map),
  ledgerGet: () => ipcRenderer.invoke('persist:ledgerGet'),
  ledgerAdd: (keys) => ipcRenderer.invoke('persist:ledgerAdd', keys),
});
