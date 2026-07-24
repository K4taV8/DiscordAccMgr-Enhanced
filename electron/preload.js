const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),

  getTokens: () => ipcRenderer.invoke('tokens:get'),
  saveToken: (name, token) => ipcRenderer.invoke('tokens:save', name, token),
  deleteToken: (name) => ipcRenderer.invoke('tokens:delete', name),
  deleteAllTokens: () => ipcRenderer.invoke('tokens:deleteAll'),

  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),

  muteServer: (serverId) => ipcRenderer.invoke('discord:muteServer', serverId),
  unmuteServer: (serverId) => ipcRenderer.invoke('discord:unmuteServer', serverId),
  readAll: () => ipcRenderer.invoke('discord:readAll'),

  connectDiscord: (token) => ipcRenderer.invoke('discord:connect', token),
  getFriends: () => ipcRenderer.invoke('discord:getFriends'),
  deleteFriend: (friendId) => ipcRenderer.invoke('discord:deleteFriend', friendId),
  getServers: () => ipcRenderer.invoke('discord:getServers'),
  getServerChannels: (serverId) => ipcRenderer.invoke('discord:getServerChannels', serverId),
  leaveServer: (serverId) => ipcRenderer.invoke('discord:leaveServer', serverId),
  getDMs: () => ipcRenderer.invoke('discord:getDMs'),
  getDMMessages: (channelId, beforeId) => ipcRenderer.invoke('discord:getDMMessages', channelId, beforeId),
  deleteDMMessage: (channelId, messageId) => ipcRenderer.invoke('discord:deleteDMMessage', channelId, messageId),
  closeDM: (channelId) => ipcRenderer.invoke('discord:closeDM', channelId),
  
  // New Group Manager endpoints
  getGroups: () => ipcRenderer.invoke('discord:getGroups'),
  leaveGroup: (groupId) => ipcRenderer.invoke('discord:leaveGroup', groupId),
  getGroupMessages: (channelId, beforeId) => ipcRenderer.invoke('discord:getGroupMessages', channelId, beforeId),
  getMessage: (channelId, messageId) => ipcRenderer.invoke('discord:getMessage', channelId, messageId),
  deleteGroupMessage: (channelId, messageId) => ipcRenderer.invoke('discord:deleteGroupMessage', channelId, messageId),
  
  clearMessageReactions: (channelId, messageId) => ipcRenderer.invoke('discord:clearMessageReactions', channelId, messageId),
  removeOwnReaction: (channelId, messageId, emoji) => ipcRenderer.invoke('discord:removeOwnReaction', channelId, messageId, emoji)
});