const { contextBridge, ipcRenderer, webUtils } = require('electron');

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

// Import d'un export Discord. Le `File` du renderer n'est pas sérialisable, et
// l'export réel fait 394 Mo : on ne transmet donc que le CHEMIN du fichier, et
// le main process lit les tranches qu'il demande (cf. discord:importPackage).
// `webUtils.getPathForFile` remplace `File.path`, retiré en Electron 32 — c'est
// le seul endroit du preload qui a le droit de toucher au disque.
//
// On transmet AUSSI `taille`, et ce n'est pas décoratif : c'est la seule chose
// qui permet au main process de vérifier qu'il ouvre bien le fichier que
// l'utilisateur a choisi (il le compare à la taille réellement trouvée sur le
// disque, et un écart déclenche le repli). Sans elle, un fichier remplacé entre
// la sélection et l'ouverture serait importé sans que rien ne le signale.
//
// PAS DE `wrap` ICI, et c'est deliberé : `wrap` journalise la valeur de retour, or
// cette reponse contient le PAQUET ENTIER — 667 salons et leurs messages sur un
// export reel. Le journal ne porte donc que l'enveloppe.
//
// Rappel pour qui lira l'enveloppe : `messages` y est un OBJET indexé par
// identifiant de salon, non une `Map`. L'IPC Electron sérialise par clonage
// structuré, qui PRÉSERVE les `Map` — l'aplatissement est un choix de forme
// (inspectable, comparable), pas une contrainte du transport.
async function importPackage(file) {
  let chemin = '';
  try {
    chemin = webUtils.getPathForFile(file) || '';
  } catch (error) {
    console.warn('[IPC !!] importPackage', `fichier sans chemin (${error.message})`);
  }
  if (!chemin) return { success: false, fallbackToRenderer: true, error: 'Fichier sans chemin sur le disque.' };

  console.log('[IPC >>] importPackage', { chemin, nom: file.name, taille: file.size });
  try {
    const resultat = await ipcRenderer.invoke('discord:importPackage', { chemin, nom: file.name, taille: Number(file.size) || 0 });
    console.log('[IPC <<] importPackage', {
      success: resultat?.success,
      mode: resultat?.mode,
      reason: resultat?.reason,
      error: resultat?.error,
      cancelled: resultat?.cancelled,
      salons: resultat?.package?.channels?.length,
      messages: resultat?.package?.totalMessages,
    });
    return resultat;
  } catch (e) {
    console.error('[IPC !!] importPackage', e.message);
    throw e;
  }
}

function onImportPackageProgress(callback) {
  const listener = (_event, data) => callback(data);
  ipcRenderer.on('discord:importPackage:progress', listener);
  return () => ipcRenderer.removeListener('discord:importPackage:progress', listener);
}

// Miroir local des medias : meme motif que onImportPackageProgress. La
// progression arrive par events, car `invoke` ne repond qu'a la fin.
function onMediaMirrorProgress(callback) {
  const listener = (_event, data) => callback(data);
  ipcRenderer.on('media:mirror:progress', listener);
  return () => ipcRenderer.removeListener('media:mirror:progress', listener);
}

    // DevTools a la demande (F12 / Ctrl+Shift+L).
contextBridge.exposeInMainWorld('electronAPI', {
  toggleDevTools: () => ipcRenderer.invoke('app:toggleDevTools'),
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

  importPackage,
  onImportPackageProgress,

  mediaMirror: {
    start: wrap('mediaMirrorStart', (items) => ipcRenderer.invoke('media:mirrorStart', { items })),
    cancel: wrap('mediaMirrorCancel', () => ipcRenderer.invoke('media:mirrorCancel')),
    status: wrap('mediaMirrorStatus', (items) => ipcRenderer.invoke('media:mirrorStatus', { items })),
    purge: wrap('mediaMirrorPurge', (key) => ipcRenderer.invoke('media:mirrorPurge', { key })),
    onProgress: onMediaMirrorProgress,
  },

  saveAttachment: wrap('saveAttachment', attachment => ipcRenderer.invoke('discord:saveAttachment', attachment)),

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
  openDM: (userId) => ipcRenderer.invoke('discord:openDM', userId),
  leaveGroup: wrap('leaveGroup', (groupId) => ipcRenderer.invoke('discord:leaveGroup', groupId)),
  getChannelMessages: wrap('getChannelMessages', (channelId, beforeId, afterId) => ipcRenderer.invoke('discord:getChannelMessages', channelId, beforeId, afterId)),
  getMessage: wrap('getMessage', (channelId, messageId) => ipcRenderer.invoke('discord:getMessage', channelId, messageId)),
  deleteGroupMessage: wrap('deleteGroupMessage', (channelId, messageId) => ipcRenderer.invoke('discord:deleteGroupMessage', channelId, messageId)),
  deletePackageMessage: wrap('deletePackageMessage', (channelId, messageId) => ipcRenderer.invoke('discord:deleteGroupMessage', channelId, messageId)),
  getChannel: wrap('getChannel', (channelId) => ipcRenderer.invoke('discord:getChannel', channelId)),
  setThreadArchived: wrap('setThreadArchived', (threadId, archived) => ipcRenderer.invoke('discord:setThreadArchived', threadId, archived)),

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
