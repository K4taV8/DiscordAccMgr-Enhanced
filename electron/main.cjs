const { app, BrowserWindow, ipcMain, shell, dialog, safeStorage, protocol, session } = require('electron');

// Switches Chromium pour accélérer le cold boot et limiter la VRAM.
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('force_high_performance_gpu');
app.commandLine.appendSwitch('v8-cache-options', 'code');
const path = require('path');
const axios = require('axios');
const fs = require('fs');
const fsp = require('fs/promises');
const { Readable } = require('stream');

// SEC-03 : timeout global — aucun appel HTTP ne doit pendre indéfiniment
axios.defaults.timeout = 15000;

const { readJson, writeJson } = require('./persist.cjs');
const { routeKeyFor, isSnowflake, isOp, isMessageBearingChannel } = require('./helpers.cjs');
const { createTokenStore } = require('./tokenStore.cjs');
const { importArchiveDepuisChemin } = require('./packageImporter.service.cjs');
const { mediaRequestPath, mediaUrlFor, mediaRelPath, mediaMirrorKey, readManifest, downloadMirror, MIRROR_DIR_NAME, isMediaPathInside, parseByteRange } = require('./mediaMirror.service.cjs');
const { extraireToken, estUrlAuth, MOTIF_TOKEN } = require('./discordLogin.service.cjs');

// Le miroir media est servi par un protocole maison : la CSP interdit `file://`,
// une copie locale serait donc refusee au chargement sous `img-src`/`media-src`.
// Le schema doit etre declare PRIVILEGIE au niveau module, AVANT `app.whenReady()`
// (l'appel se trouve au bas de ce fichier) : declare trop tard, il ne serait pas
// standard/secure et `media:` retomberait sous `default-src`.
protocol.registerSchemesAsPrivileged([{
  scheme: 'media',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}]);

// 100% portable : TOUTES les données (userData, session, cache, crashDumps,
// logs) vivent dans un dossier data/ à côté de l'app — jamais dans %APPDATA%.
let appRoot;
try { appRoot = app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '..'); } catch { appRoot = path.join(__dirname, '..'); }

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
  console.error('Failed to initialize local data directory:', err.message);
  dialog.showErrorBox('Portable Mode Error',
    'Cannot write to application data directory.\nPlease ensure the application folder is writable.');
  process.exit(1);
}

// Migration ponctuelle : rapatrie une fois les données de l'ancien userData
// %APPDATA% (jetons chiffrés, checkpoints, watermarks, ledger, cache serveurs)
// vers le dossier local — pour ne rien perdre au passage en mode portable.
function migrateLegacyUserData(localUserData) {
  try {
    const legacy = path.join(app.getPath('appData'), 'discord-account-manager');
    if (legacy === localUserData) return;
    const legacyTokens = path.join(legacy, 'saved_tokens.json');
    if (!fs.existsSync(legacyTokens)) return;
    if (fs.existsSync(path.join(localUserData, 'saved_tokens.json'))) return; // déjà migré
    fs.mkdirSync(localUserData, { recursive: true });
    ['saved_tokens.json', 'cleaned_reactions.json', 'servers_cache.json'].forEach(f => {
      const src = path.join(legacy, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(localUserData, f));
    });
    const legacyCp = path.join(legacy, 'checkpoints');
    if (fs.existsSync(legacyCp)) fs.cpSync(legacyCp, path.join(localUserData, 'checkpoints'), { recursive: true });
    for (const f of fs.readdirSync(legacy)) {
      if (f.startsWith('watermark-') && f.endsWith('.json')) {
        fs.copyFileSync(path.join(legacy, f), path.join(localUserData, f));
      }
    }
  } catch (err) {
    console.error('Legacy userData migration skipped:', err.message);
  }
}
migrateLegacyUserData(portablePaths.userData);

let mainWindow;
let discordClient = null;
let connecting = false;

// BUG-001 : identifiant du compte connecte, utilise pour scoper TOUT stockage
// local par compte (watermark, ledger, checkpoints, cache canaux). Sans compte
// connecte, `unknown` : les fichiers historiques NON scopes sont ignores.
const currentUid = () => {
  const id = discordClient?.user?.id;
  return id ? String(id) : 'unknown';
};

const tokensPath = path.join(app.getPath('userData'), 'saved_tokens.json');

if (!fs.existsSync(tokensPath)) {
  fs.writeFileSync(tokensPath, '[]', 'utf8');
}

// R05#2 : logique token extraite dans tokenStore.cjs (safeStorage + chemins injectés → testable).
const tokenStore = createTokenStore({ safeStorage, tokensPath });

// R05#3 : verrou mono-instance — deux copies simultanées partageraient le même
// userData et la 2e échouerait à créer son cache disque (« Unable to move the
// cache: Access denied » / « Gpu Cache Creation failed »). La 2e instance se
// contente de ramener la 1re au premier plan.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 925,
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
      paintingWhenInitiallyHidden: true,
    },
    backgroundColor: '#0f1117',
    icon: path.join(__dirname, '..', 'assets', 'logo.png')
  });

  mainWindow.loadFile('./index.html');
  mainWindow.webContents.setBackgroundThrottling(false);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // C1a : l'app est une page locale : aucune navigation externe (anti-exfiltration).
  // On n'autorise QUE la page de l'app (protocole `file:` ET hote vide) : un
  // `file://hote/share` (UNC) ferait fuiter le hash SMB/NTLM. Une redirection 302
  // ne passe pas par `will-navigate`, donc meme garde sur `will-redirect`.
  const estNavigationApp = (u) => { try { const x = new URL(u); return x.protocol === 'file:' && !x.host; } catch { return false; } };
  mainWindow.webContents.on('will-navigate', (e, url) => { if (!estNavigationApp(url)) e.preventDefault(); });
  mainWindow.webContents.on('will-redirect',  (e, url) => { if (!estNavigationApp(url)) e.preventDefault(); });
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
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
    if (resp.status === 429) {
      return { success: false, status: 429, error: 'Rate limited', retryAfter: parseInt(resp.headers?.['retry-after']) || 5 };
    }
    return { success: resp.status >= 200 && resp.status < 300, status: resp.status, data: resp.data, headers: resp.headers };
  } catch (error) {
    return { success: false, status: 0, error: error.message };
  } finally {
    release();
  }
}

// BUG-07 : mutations simples avec retry borné sur 429 (cohérent avec les
// suppressions de messages). 3 tentatives + Retry-After, puis échec explicite.
// discordFetch ne met jamais d 'error' sur un echec HTTP : seul le corps de la
// reponse porte la raison (« Invalid Form Body », « Missing Access », ...).
// La reconstruire ici evite les onze sites qui renvoyaient « HTTP 400 » et
// perdaient la seule information exploitable.
function apiFailure(r) {
  const status = Number(r?.status) || 0;
  const detail = String(r?.data?.message || r?.error || '').trim();
  return {
    success: false,
    status,
    error: detail || (status ? `HTTP ${status}` : 'Requête échouée'),
    code: r?.data?.code ?? null,
  };
}

async function discordMutate(method, path, { data, params } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await discordFetch(method, path, { data, params });
    if (r.success) return { success: true };
    if (r.status === 429) {
      const wait = r.retryAfter || 5;
      await new Promise(res => setTimeout(res, (wait * 1000) + 500));
      continue;
    }
    return apiFailure(r);
  }
  return { success: false, error: 'Rate limited' };
}

// Ouvre / ferme les DevTools (F12 et Ctrl+Shift+L cote renderer).
// Indispensable pour lire la console quand un import reste bloque.
ipcMain.handle('app:toggleDevTools', () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return false;
  win.webContents.toggleDevTools();
  return true;
});
ipcMain.handle('discord:getGroups', async () => {
  const r = await discordFetch('GET', '/users/@me/channels');
  if (!r.success) return apiFailure(r);
  const groups = r.data
    .filter(ch => ch.type === 3)
    .map(group => ({
      id: group.id,
      name: group.name || 'Unnamed Group',
      icon: group.icon ? `https://cdn.discordapp.com/channel-icons/${group.id}/${group.icon}.png` : null,
      recipients: group.recipients?.length || 0,
      // 2 premiers destinataires (avatar) → stack natif Discord si pas d'icône.
      members: (group.recipients || []).slice(0, 2).map(r => ({
        id: r.id,
        avatar: r.avatar ? `https://cdn.discordapp.com/avatars/${r.id}/${r.avatar}.png?size=64` : null,
      })),
    }));
  return { success: true, groups };
});

// Rouvre un message direct a partir d un id d utilisateur (celui contenu
// dans le package). POST /users/@me/channels le recree cote compte : il
// reapparait alors dans la liste des DM du client Discord. Ne fonctionne que
// si le compte a encore acces a ce contact.
ipcMain.handle('discord:openDM', async (_, userId) => {
  const id = String(userId || '').trim();
  if (!/^\d{15,25}$/.test(id)) return { success: false, error: 'Identifiant invalide' };
  return discordMutate('POST', '/users/@me/channels', { data: { recipient_id: id } });
});
ipcMain.handle('discord:leaveGroup', async (_, groupId) => {
  if (!isSnowflake(groupId)) return { success: false, error: 'identifiant invalide' };
  return discordMutate('DELETE', `/channels/${groupId}`);
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
  const uid = discordClient?.user?.id;
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
      // me_burst (super-réactions) exclu : elles utilisent un autre endpoint et
      // un DELETE normal renverrait 404 → compté "supprimé" à tort.
      me: Boolean(ra.me)
    }))
  }));
  return { success: true, currentUserId: uid, messages: msgs };
}

ipcMain.handle('discord:getChannelMessages', async (_, channelId, beforeId = null, afterId = null) => {
  if (!isSnowflake(channelId)) return { success: false, error: 'identifiant invalide' };
  return fetchChannelMessagesRest(channelId, beforeId, afterId);
});

ipcMain.handle('discord:getDMMessages', async (_, channelId, beforeId = null) => {
  if (!isSnowflake(channelId)) return { success: false, error: 'identifiant invalide' };
  return fetchChannelMessagesRest(channelId, beforeId);
});

ipcMain.handle('discord:getMessage', async (_, channelId, messageId) => {
  if (!isSnowflake(channelId) || !isSnowflake(messageId)) return { success: false, error: 'identifiant invalide' };
  const r = await discordFetch('GET', `/channels/${channelId}/messages/${messageId}`);
  if (!r.success) return apiFailure(r);
  const msg = r.data;
  return {
    success: true,
    currentUserId: discordClient?.user?.id,
    reactions: (msg.reactions || []).map(ra => ({
      emoji: { id: ra.emoji.id, name: ra.emoji.name },
      count: ra.count,
      // me_burst (super-réactions) exclu : elles utilisent un autre endpoint et
      // un DELETE normal renverrait 404 → compté "supprimé" à tort.
      me: Boolean(ra.me)
    }))
  };
});

ipcMain.handle('discord:deleteGroupMessage', async (_, channelId, messageId) => {
  if (!isSnowflake(channelId) || !isSnowflake(messageId)) return { success: false, error: 'identifiant invalide' };
  const r = await discordFetch('DELETE', `/channels/${channelId}/messages/${messageId}`);
  if (!r.success) {
    if (r.status === 429) return { success: false, status: 429, error: 'Rate limited', retryAfter: r.retryAfter };
    // Le message de Discord est conserve : il distingue « Unknown Message »
    // (le message a disparu) de « Unknown Channel » (c est l identifiant du
    // salon qui est mauvais). Ecraser par « not found » rendait les deux
    // identiques, et l appelant ne pouvait plus rien diagnostiquer.
    if (r.status === 404) return { ...apiFailure(r), error: r.data?.message || 'not found' };
    return apiFailure(r);
  }
  return { success: true };
});

// Un salon d'un serveur quitte repond 403 « Missing Access » a la suppression :
// sans cette lecture prealable, l outil epuisait une requete par message pour
// apprendre a chaque fois la meme mauvaise nouvelle, a 4 r/s.
ipcMain.handle('discord:getChannel', async (_, channelId) => {
  if (!isSnowflake(channelId)) return { success: false, status: 400, error: 'identifiant invalide' };
  const r = await discordFetch('GET', `/channels/${channelId}`);
  if (!r.success) return apiFailure(r);
  // `thread_metadata.archived` est transmis tel quel (champ optionnel) : le
  // renderer doit savoir si un fil etait deja archive AVANT de le desarchiver
  // pour le nettoyer, afin de ne pas rearchiver un fil actif. Ajout additif :
  // les appelants qui ignoraient ce champ continuent de fonctionner.
  return { success: true, channel: { id: String(r.data?.id || channelId), name: r.data?.name || null, type: r.data?.type ?? null, thread_metadata: r.data?.thread_metadata ?? null } };
});

// Un fil archive refuse toute suppression (erreur 50083). Le reactiver puis le
// reassigner une fois le nettoyage fini est la seule voie par l API, et cela
// laisse le fil dans l etat ou l utilisateur l avait laisse.
ipcMain.handle('discord:setThreadArchived', async (_, threadId, archived) => {
  const id = String(threadId || '').trim();
  if (!isSnowflake(id)) return apiFailure({ status: 400, error: 'identifiant invalide' });
  const r = await discordFetch('PATCH', `/channels/${id}`, { data: { archived: Boolean(archived) } });
  if (!r.success) return apiFailure(r);
  return { success: true };
});

ipcMain.handle('discord:muteServer', async (_, serverId) => {
  if (!isSnowflake(serverId)) return { success: false, error: 'identifiant invalide' };
  return discordMutate('PATCH', `/users/@me/guilds/${serverId}/settings`, { data: { muted: true } });
});

ipcMain.handle('discord:unmuteServer', async (_, serverId) => {
  if (!isSnowflake(serverId)) return { success: false, error: 'identifiant invalide' };
  return discordMutate('PATCH', `/users/@me/guilds/${serverId}/settings`, { data: { muted: false } });
});

// ponytail: ordonnanceurs côté main = autorité débit. Lecture nominale 25 r/s,
// suppression 4 r/s (seuils sûrs calibrés) ; les en-têtes X-RateLimit-* gouvernent
// ensuite les bursts réels — zéro 429 par construction.
const { makeRouteScheduler } = require('./rateLimiter.cjs');
const readScheduler = makeRouteScheduler({ nominalRatePerSec: 25, burst: 16, maxConcurrent: 12 });
const deleteScheduler = makeRouteScheduler({ nominalRatePerSec: 4, burst: 2, maxConcurrent: 4 });

ipcMain.handle('discord:readAll', async () => {
  try {
    if (!discordClient?.token) {
      return { success: false, error: 'Not connected' };
    }

    // ARCH-03 : tout HTTP repasse par discordFetch (G1). Le bucket de route est
    // normalisé par routeKeyFor — un seul budget partagé pour tous les /guilds/:id/ack
    // (l'ancien acquire(`/guilds/<id>/ack`) créait un bucket distinct par guild).
    let allGuilds = [];
    let lastId = null;
    let firstPageOk = false;
    while (true) {
      const params = { limit: 100 };
      if (lastId) params.after = lastId;
      // RED-1 : retry borné sur la pagination de la liste (cohérent avec la boucle ack).
      let r;
      for (let attempt = 0; attempt < 3; attempt++) {
        r = await discordFetch('GET', '/users/@me/guilds', { params });
        if (r.success) break;
        if (r.status === 429) {
          const wait = r.retryAfter || 1;
          await new Promise(res => setTimeout(res, (wait * 1000) + 500));
          continue;
        }
        break; // 401/403 : pas de retry utile
      }
      if (!r?.success) break;
      firstPageOk = true;
      allGuilds = allGuilds.concat(r.data);
      if (r.data.length < 100) break;
      lastId = r.data[r.data.length - 1].id;
    }
    if (allGuilds.length === 0 && !firstPageOk) {
      return { success: false, error: 'Failed to fetch servers' };
    }

    let failed = 0;
    let done = 0;
    const total = allGuilds.length;

    const ackGuild = async (guild) => {
      let ok = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        const ack = await discordFetch('PUT', `/guilds/${guild.id}/ack`, { data: { token: null } });
        if (ack.success) { ok = true; break; }
        if (ack.status === 429) {
          const wait = ack.retryAfter || 1;
          await new Promise(r => setTimeout(r, (wait * 1000) + 500));
          continue;
        }
        break; // 403/401 : non-réussite comptabilisée en échec
      }
      if (!ok) failed++;
      done++;
      mainWindow?.webContents.send('readall:progress', { done, total, failed });
    };

    // P-01 : traitement parallèle borné à 12 workers (== readScheduler.maxConcurrent) —
    // le débit réel reste gouverné par les en-têtes X-RateLimit-* côté main.
    // L'ancienne boucle séquentielle faisait 200 PUT à la chaîne ; on ne dépasse
    // jamais le budget du scheduler, on cesse simplement d'empiler les nouveaux
    // ack dès que les échecs dépassent 1/3.
    const CONCURRENCY = 12;
    let cursor = 0;
    async function worker() {
      while (cursor < total && failed <= total / 3) {
        const i = cursor++;
        await ackGuild(allGuilds[i]);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, () => worker()));

    // RED-3 : retour explicite — partial=true quand des guilds n'ont pas été tentées.
    return { success: true, failed, done, total, partial: done < total };
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

// Import d'un export Discord (ZIP) — chemin par index, repli sur le chemin flux.
// Le renderer n'envoie que le CHEMIN du fichier (electron/preload.cjs) : les
// 394 Mo d'un export réel ne traversent pas l'IPC, et le main process n'ouvre un
// descripteur de lecture que pour les plages que l'import demande.
//
// TOUT le reste — l'ouverture, la comparaison de la taille annoncée à la taille
// réellement ouverte, la progression, la règle d'annulation, la forme de l'enveloppe
// — vit dans le service, et y est teste. Ce handler ne fait que router : c'est
// `importArchiveDepuisChemin` qui décide si l'import a réussi, jamais cette
// fonction, qui n'aurait aucun test comportemental (le fichier prend le verrou
// d'instance unique dès son chargement, donc il n'est pas exécutable ici).
ipcMain.handle('discord:importPackage', (event, demande) => {
  const nom = typeof demande?.nom === 'string' ? demande.nom : 'package.zip';
  // La progression traverse par events : `invoke` ne répond qu'à la fin, et la
  // barre resterait figée pendant tout l'import. `isDestroyed` parce qu'une
  // fenêtre fermée en cours d'import ne doit pas faire échouer l'import.
  const publier = info => { if (!event.sender.isDestroyed()) event.sender.send('discord:importPackage:progress', info); };
  return importArchiveDepuisChemin({ chemin: demande?.chemin, nom, taille: demande?.taille }, { onProgress: publier });
});

// Sortie de secours d'une piece jointe que Chromium ne sait pas decoder
// (.mov, .mkv) ou dont l URL signee a expire. Le renderer ne peut PAS fetch le
// CDN (CSP connect-src 'self') : tout le telechargement vit ici, avec le meme
// axios (timeout 15 s) que le reste du fichier.
//
// Le nom propose au dialogue est assaini avant showSaveDialog, qui refuse les
// caracteres interdits Windows. Une annulation n'est ni un succes ni un echec :
// elle se dit `cancelled`, jamais `error`.
function sanitizeSaveName(name) {
  const cleaned = String(name || 'piece-jointe')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/[\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim();
  return cleaned || 'piece-jointe';
}

ipcMain.handle('discord:saveAttachment', async (event, attachment) => {
  const url = typeof attachment?.url === 'string' ? attachment.url : '';
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'URL invalide' };
  // S2 : exige https + CDN Discord (anti-SSRF) et borne le corps a 2 Gio.
  if (!estUrlDiscordCdn(url)) return { ok: false, error: 'URL non autorisée' };
  const nom = sanitizeSaveName(attachment?.fileName);
  const parent = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  try {
    const cible = await dialog.showSaveDialog(parent, { defaultPath: nom });
    if (cible.canceled || !cible.filePath) return { ok: false, cancelled: true };
    const reponse = await axios.get(url, { responseType: 'arraybuffer', maxContentLength: MAX_MEDIA_CONTENT_LENGTH });
    await fsp.writeFile(cible.filePath, Buffer.from(reponse.data));
    return { ok: true, chemin: cible.filePath };
  } catch (error) {
    return { ok: false, error: error.message || 'Échec du téléchargement' };
  }
});

// ---------------------------------------------------------------------------
// Miroir local des medias (tache 5) : IPC autour du service mediaMirror.
//
// Aucune logique du service n'est reimplementee ici : ces handlers calculent la
// cle, branchent le transport axios de production, publient la progression et
// routent l'annulation et la purge. Tout le reseau et tout le disque vivent
// dans le main process ; le renderer, lui, ne fetch jamais le CDN (CSP).
// ---------------------------------------------------------------------------

// Drapeau d'annulation, reinitialise a chaque demarrage de miroir. La boucle le
// consulte AVANT chaque fichier : une annulation ne laisse donc aucun partiel.
let mirrorStop = false;

// BUG-011 : verrou mono-lot. Deux `mirrorStart` simultanes partageaient le meme
// drapeau `mirrorStop` global : l'annulation de l'un arretait l'autre, et deux
// ecritures pouvaient melanger leurs manifestes. Un seul lot a la fois.
let mirrorRunning = false;

// S2 : seules les URL servies par le CDN Discord sont acceptees en telechargement.
// Bloque le SSRF : une URL arbitraire vendeur du renderer ne doit jamais faire
// sortir le main process vers le reseau interne.
function estUrlDiscordCdn(u) {
  try {
    const url = new URL(u);
    if (url.protocol !== 'https:') return false;
    const hote = url.hostname.toLowerCase();
    return hote === 'cdn.discordapp.com'
      || hote === 'media.discordapp.net'
      || hote.endsWith('.discordapp.com');
  } catch {
    return false;
  }
}

// S3 : un segment d'emoji peut etre un emoji Unicode (deja encode par le
// renderer) ou `name:id` (custom). On NE re-encode jamais une sequence deja
// percent-encodee (sinon double encodage : `%` -> `%25`), mais on neutralise
// toute injection de chemin (`/`, `..`) en normalisant a un encodage unique.
function encodeEmojiSegment(raw) {
  const s = String(raw || '');
  const custom = /^([^:/\\]+):(\d+)$/.exec(s);
  // `encodeURIComponent` laisse le point LITTERAL : un segment `..` replierait
  // le chemin (`.../reactions/../@me`). On remplace donc les points isoles par
  // `%2E` pour que le segment ne puisse jamais valoir `.` ou `..`.
  const encoder = (v) => encodeURIComponent(v).replace(/\./g, '%2E');
  if (custom) return `${encoder(custom[1])}:${custom[2]}`;
  try {
    return encoder(decodeURIComponent(s));
  } catch {
    return encoder(s);
  }
}

// Transport de production (ruling R3) : `head` lit l'octet annonce, `get`
// rapporte les octets. Timeout 15000, comme le reste du fichier.
// S2 : toute URL hors CDN Discord est refusee, et le corps est borne a 2 Gio.
const MAX_MEDIA_CONTENT_LENGTH = 2 * 1024 * 1024 * 1024;
const mirrorTransport = {
  head: url => {
    if (!estUrlDiscordCdn(url)) return Promise.reject(new Error('URL média non autorisée'));
    return axios.head(url, { timeout: 15000, maxContentLength: MAX_MEDIA_CONTENT_LENGTH }).then(r => Number(r.headers['content-length']) || 0);
  },
  get: url => {
    if (!estUrlDiscordCdn(url)) return Promise.reject(new Error('URL média non autorisée'));
    // BUG-012 : axios (Node) rend deja un Buffer pour `arraybuffer` ; on evite la
    // copie inutile de `Buffer.from`. Le streaming complet du corps est reporte
    // (voir rapport) : la borne `maxContentLength` garde la memoire plafonnee.
    return axios.get(url, { responseType: 'arraybuffer', timeout: 15000, maxContentLength: MAX_MEDIA_CONTENT_LENGTH })
      .then(r => (Buffer.isBuffer(r.data) ? r.data : Buffer.from(r.data)));
  },
};

const mirrorRootDir = () => path.join(dataDir, MIRROR_DIR_NAME);

ipcMain.handle('media:mirrorStart', async (event, demande) => {
  // BUG-011 : un seul lot a la fois — sinon deux boucles partagent `mirrorStop`.
  if (mirrorRunning) return { ok: false, error: 'Telechargement deja en cours' };
  mirrorRunning = true;
  // Tout est enveloppe : un echec d'ecriture du manifeste (mineur T2) ne doit
  // pas rejeter l'IPC, il se dit `{ ok: false, error }`.
  try {
    const items = Array.isArray(demande?.items) ? demande.items : [];
    const key = mediaMirrorKey(items.map(item => item?.url));
    mirrorStop = false;
    const publier = info => { if (!event.sender.isDestroyed()) event.sender.send('media:mirror:progress', info); };
    const resultat = await downloadMirror({
      rootDir: mirrorRootDir(),
      key,
      items,
      transport: mirrorTransport,
      shouldStop: () => mirrorStop,
      onProgress: publier,
    });
    return { ok: true, key, ...resultat };
  } catch (error) {
    return { ok: false, error: error.message || 'Échec du téléchargement des médias' };
  } finally {
    mirrorRunning = false;
  }
});

ipcMain.handle('media:mirrorCancel', () => {
  mirrorStop = true;
  return { ok: true };
});

// Etat d'un lot. `localUrl` est construit ICI (ruling R5) : le renderer ne
// construit jamais l'URL `media://` lui-meme.
ipcMain.handle('media:mirrorStatus', (event, demande) => {
  const items = Array.isArray(demande?.items) ? demande.items : [];
  const key = mediaMirrorKey(items.map(item => item?.url));
  const manifest = key ? readManifest(path.join(mirrorRootDir(), key)) : {};
  const entries = [];
  const failures = [];
  let bytesDownloaded = 0;
  for (const item of items) {
    if (!item || typeof item.url !== 'string') continue;
    const entree = manifest[item.url];
    const state = entree?.state || 'absent';
    if (state === 'error') failures.push(item.url);
    const octets = Number(entree?.bytes) || 0;
    if (state === 'done') bytesDownloaded += octets;
    entries.push({
      url: item.url,
      state,
      localUrl: state === 'done' ? mediaUrlFor(mediaRelPath(key, item.channelId, item.url, item.fileName)) : null,
    });
  }
  return { key, bytesDownloaded, bytesTotal: bytesDownloaded, failures, entries };
});

// Purge d'un lot : la cle vient du renderer, donc on la VALIDE avant tout `rm`
// (defense en profondeur) : douze caracteres hexadecimaux, rien d'autre.
ipcMain.handle('media:mirrorPurge', async (event, demande) => {
  const key = typeof demande?.key === 'string' ? demande.key : '';
  if (!/^[0-9a-f]{12}$/.test(key)) return { ok: false, error: 'Clé invalide' };
  try {
    await fsp.rm(path.join(mirrorRootDir(), key), { recursive: true, force: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message || 'Échec de la purge' };
  }
});

// Token management — encrypted at rest via safeStorage.
// R05#2 : la logique (chiffrement, schéma, mutex) vit dans tokenStore.cjs —
// testable avec un safeStorage mocké. main.cjs n'expose que les IPC handlers.
ipcMain.handle('tokens:save', (_, name, token) => tokenStore.save(name, token));

ipcMain.handle('tokens:get', () => tokenStore.list());

ipcMain.handle('tokens:delete', (_, name) => tokenStore.remove(name));

ipcMain.handle('tokens:deleteAll', () => tokenStore.removeAll());

// SEC-03 : connexion par nom — le secret est lu/déchiffré dans le main et ne
// transite jamais vers le renderer. Le mutex n'est tenu que pendant la lecture.
ipcMain.handle('tokens:connectByName', async (_, name) => {
  const resolved = await tokenStore.resolveByName(name);
  if (resolved.error) return { success: false, error: resolved.error };
  // Perf : si le compte cible est DEJA connecte (meme userId en session), on
  // reutilise la session au lieu de re-loggner - "Use" apres Ctrl+R/re-Use
  // passe d'un handshake Discord (5-25 s) a ~0 ms de login.
  const live = discordClient;
  if (resolved.userId && live?.isReady?.() && String(live.user?.id) === String(resolved.userId)) {
    return { success: true, reused: true, ...connectPayload(live.user) };
  }
  const result = await connectDiscord(resolved.token);
  if (result.success && result.user?.id) tokenStore.setUserId(name, result.user.id).catch(() => {});
  return result;
});

// Updates disabled
ipcMain.handle('app:checkUpdates', async () => ({ success: true, hasUpdate: false }));
ipcMain.handle('app:downloadUpdate', async () => ({ success: true }));

// Version — single source of truth: package.json (via Electron)
ipcMain.handle('app:getVersion', async () => app.getVersion());

// Discord handlers
function connectPayload(u) {
  const cdn = (base, hash) => hash ? `https://cdn.discordapp.com/${base}/${u.id}/${hash}.${hash.startsWith('a_') ? 'gif' : 'png'}` : null;
  return {
    username: u.tag,
    avatar: cdn('avatars', u.avatar) ? `${cdn('avatars', u.avatar)}?size=64` : 'https://cdn.discordapp.com/embed/avatars/0.png',
    user: {
      id: u.id,
      username: u.username,
      displayName: u.globalName || u.username,
      avatar: cdn('avatars', u.avatar),
    },
  };
}

// SEC-03 : borne d'attente du login — sans elle, un `login()` qui pend laissait
// `connecting` vrai pour toujours, et toute tentative suivante repondait
// « Already connecting ».
const LOGIN_TIMEOUT_MS = 30000;

async function connectDiscord(token) {
  if (connecting) return { success: false, error: 'Already connecting' };
  connecting = true;
  let suivant = null;
  let minuteur = null;
  try {
    const { Client } = require('discord.js-selfbot-v13');
    suivant = new Client({ checkUpdate: false, fetchAllMembers: false });
    // BUG-008 : on N'ECRASE l'ancien client qu'APRES un login reussi. En cas
    // d'echec (ou de timeout), l'utilisateur reste connecte au compte precedent
    // (UI, navigation, caches intacts) au lieu de basculer sur « Not connected ».
    await Promise.race([
      suivant.login(token),
      new Promise((_, rejeter) => {
        minuteur = setTimeout(() => rejeter(new Error('Delai de connexion depasse (30 s)')), LOGIN_TIMEOUT_MS);
      }),
    ]);
    const ancien = discordClient;
    discordClient = suivant;
    if (ancien) { try { const p = ancien.destroy(); if (p?.catch) p.catch(() => {}); } catch {} }
    // R05#4 : l'objet user (id, global_name, avatar) part avec le résultat de
    // connexion → la modale profil l'a sans API call.
    const u = suivant.user;
    return { success: true, ...connectPayload(u) };
  } catch (error) {
    // Echec : le client candidat est detruit, l'ancien (s'il existe) reste en place.
    if (suivant) { try { const p = suivant.destroy(); if (p?.catch) p.catch(() => {}); } catch {} }
    console.error('Connect error:', error.message);
    return { success: false, error: error.message || 'Connection failed' };
  } finally {
    if (minuteur) clearTimeout(minuteur);
    connecting = false;
  }
}

ipcMain.handle('discord:connect', async (_, token) => connectDiscord(token));

ipcMain.handle('discord:disconnect', async () => {
  try {
    if (discordClient) {
      const p = discordClient.destroy();
      if (p?.catch) p.catch(() => {});
    }
  } catch {}
  discordClient = null;
  return { success: true };
});

// Connexion Discord native : ouvre discord.com/login dans une BrowserWindow
// jetable et capte le user token, d'abord en lisant le corps des reponses
// /api/v9/auth/* via le debugger CDP, puis en repli en fouillant le stockage
// de la page. Une seule fenetre a la fois : un deuxieme appel rejoue la meme
// promesse. Nettoyage/detachement garantis avant resolution, resolution unique.
let loginWindowEnCours = null;

// Partition PERSISTANTE : le cache HTTP de Discord doit survivre entre les
// ouvertures (sinon rechargement froid ~40-70 s). L AUTH, elle, est purgee a
// chaque ouverture/fermeture (voir ouvrirLoginDiscord).
const LOGIN_PARTITION = 'persist:dam-discord-login';
let prechauffageLogin = null;

function ouvrirLoginDiscord() {
  if (loginWindowEnCours) return loginWindowEnCours;

  loginWindowEnCours = new Promise((resolve) => {
    let fini = false;
    let intervalle = null;
    let minuteur = null;

    // CACHE PERSISTANT, AUTH PURGEE. Une session neuve a CHAQUE tentative rendait
    // le chargement tres lent : Discord re-telechargeait ~5,8 Mo d assets a
    // chaque ouverture (mesure : ~50 s a froid). Un nom avec prefixe `persist:`
    // garde le cache HTTP sur disque -> ~2 s des la 2e ouverture, meme apres un
    // redemarrage. En revanche l AUTH ne doit JAMAIS subsister : on purge
    // cookies/stockage a l ouverture ET a la fermeture. `clearStorageData` ne
    // vide PAS le cache HTTP (verifie) : il ne reste sur disque que des assets
    // statiques PUBLICS de Discord, jamais un cookie de session.
    const partition = LOGIN_PARTITION;
    // Repart d une auth vierge meme si un lancement precedent a plante avant la
    // purge de fermeture : sinon la fenetre s ouvrirait deja connectee.
    try { session.fromPartition(partition).clearStorageData(); } catch {}

    const win = new BrowserWindow({
      parent: mainWindow,
      modal: false,
      width: 1000,
      height: 820,
      alwaysOnTop: true,
      title: 'Connexion Discord',
      webPreferences: {
        partition,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });

    // BUG-020(a) : `webPreferences.userAgent` n'existe pas (Electron l'ignore) ;
    // l'UA se fixe sur le webContents AVANT la navigation.
    // L'UA par defaut d'Electron porte la VRAIE version de Chrome du moteur
    // (Electron 43.4.0 -> Chrome 150). On retire seulement le jeton `Electron/x`.
    // Un UA FIGE plus ancien (ex. Chrome/130) fait servir par Discord une page
    // qui ne demarre jamais : app-mount vide, fenetre blanche, aucun log.
    win.webContents.setUserAgent(win.webContents.getUserAgent().replace(/\sElectron\/[^\s]+/, ''));

    // C1a : la fenetre de connexion ne doit naviguer que vers discord.com, en
    // HTTPS. Ni popup, ni redirection externe (phishing / exfiltration de la
    // saisie) ; exiger le protocole ferme aussi `file://` et les schemas custom.
    // BUG-020(b) : une redirection 302 ne passe PAS par `will-navigate` : la
    // meme garde est posee sur `will-redirect`.
    const estNavigationDiscord = (url) => {
      try {
        const u = new URL(url);
        const hote = u.hostname.toLowerCase();
        return u.protocol === 'https:' && (hote === 'discord.com' || hote.endsWith('.discord.com'));
      } catch { return false; }
    };
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event, url) => { if (!estNavigationDiscord(url)) event.preventDefault(); });
    win.webContents.on('will-redirect', (event, url) => { if (!estNavigationDiscord(url)) event.preventDefault(); });

    // Detache le debugger, coupe les timers, detruit la fenetre et libere le
    // singleton. Appele dans TOUS les chemins de sortie, une seule fois grace a
    // `fini` ; les operations sont idempotentes (try/catch, isDestroyed).
    const nettoyer = () => {
      if (intervalle) { clearInterval(intervalle); intervalle = null; }
      if (minuteur) { clearTimeout(minuteur); minuteur = null; }
      try { win.webContents.debugger.detach(); } catch {}
      try { if (!win.isDestroyed()) win.destroy(); } catch {}
      // Purge l AUTH (cookies, stockage) mais PAS le cache HTTP : les assets
      // Discord restent en cache pour accelerer la prochaine ouverture.
      try { session.fromPartition(partition).clearStorageData(); } catch {}
      loginWindowEnCours = null;
    };

    // Resolution unique : le premier evenement gagne, les suivants sont ignores.
    const finir = (resultat) => {
      if (fini) return;
      fini = true;
      nettoyer();
      resolve(resultat);
    };

    minuteur = setTimeout(() => finir({ ok: false, error: 'delai' }), 240000);

    win.on('closed', () => finir({ ok: false, cancelled: true }));

    // Repli periodique : le token peut etre ecrit dans localStorage/
    // sessionStorage sans passer par une reponse d'auth observable.
    const scannerStockage = async () => {
      if (fini) return;
      try {
        const token = await win.webContents.executeJavaScript(`(() => {
          const motif = new RegExp(${JSON.stringify(MOTIF_TOKEN.source)});
          const chercher = (store) => {
            try {
              for (let i = 0; i < store.length; i++) {
                const valeur = store.getItem(store.key(i)) || '';
                const m = valeur.match(motif);
                if (m) return m[0];
              }
            } catch {}
            return null;
          };
          try { return chercher(localStorage); } catch {}
          try { return chercher(sessionStorage); } catch {}
          return null;
        })()`);
        if (typeof token === 'string' && token) finir({ ok: true, token });
      } catch {}
    };
    intervalle = setInterval(scannerStockage, 2000);

    // Voie nominale : CDP lit le corps des reponses d'auth (le token y est en
    // clair). Les requestId d'auth sont memorises a responseReceived, puis
    // relus a loadingFinished, quand le corps est disponible.
    const requetesAuth = new Set();
    win.webContents.once('did-finish-load', () => {
      if (fini) return;
      try {
        win.webContents.debugger.attach('1.3');
        win.webContents.debugger.sendCommand('Network.enable').catch(() => {});
        win.webContents.debugger.on('message', async (_event, methode, params) => {
          if (fini) return;
          if (methode === 'Network.responseReceived') {
            const url = params?.response?.url || '';
            if (estUrlAuth(url)) requetesAuth.add(params.requestId);
          } else if (methode === 'Network.loadingFinished' && requetesAuth.has(params?.requestId)) {
            requetesAuth.delete(params.requestId);
            try {
              const corps = await win.webContents.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId });
              const texte = corps.base64Encoded ? Buffer.from(corps.body, 'base64').toString('utf8') : corps.body;
              const token = extraireToken(texte);
              if (token) finir({ ok: true, token });
            } catch {}
          } else if (methode === 'Network.webSocketFrameSent') {
            // Voie QR (remote-auth) : le token n'arrive PAS dans une reponse
            // /api/v9/auth/*. L'app web le renvoie en clair dans l'IDENTIFY du
            // gateway (op 2). Sans ce cas, scanner le QR connecte Discord dans la
            // fenetre mais ne fournit jamais de token a l'app.
            const donnees = params?.response?.payloadData;
            if (typeof donnees === 'string') {
              const token = extraireToken(donnees);
              if (token) finir({ ok: true, token });
            }
          }
        });
      } catch {}
    });

    win.loadURL('https://discord.com/login').catch(() => {});
  });

  return loginWindowEnCours;
}

ipcMain.handle('discord:loginNative', () => ouvrirLoginDiscord());

// Pre-chauffe le CACHE HTTP de la page de login, en tache de fond au demarrage.
// Le chargement FROID de discord.com/login dans Electron est lent (beaucoup de
// chunks ; mesure 40-70 s) alors que le reseau est rapide (~4,5 Mo/s, verifie
// hors Electron). En chauffant le cache des le lancement, la fenetre de login
// s ouvre en ~2 s quand l utilisateur la demande. Fenetre invisible, enfant de
// la principale (donc detruite avec elle), auto-detruite des que la page est
// prete (ou ~3 min max).
function prechaufferLogin() {
  try {
    if (prechauffageLogin && !prechauffageLogin.isDestroyed()) return;
    const w = new BrowserWindow({
      parent: mainWindow,
      show: false,
      webPreferences: { partition: LOGIN_PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
    });
    w.webContents.setUserAgent(w.webContents.getUserAgent().replace(/\sElectron\/[^\s]+/, ''));
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    prechauffageLogin = w;
    const arreter = () => {
      if (prechauffageLogin === w) prechauffageLogin = null;
      try { if (!w.isDestroyed()) w.destroy(); } catch {}
    };
    let essais = 0;
    const iv = setInterval(async () => {
      if (w.isDestroyed()) { clearInterval(iv); return; }
      essais += 1;
      try {
        const pret = await w.webContents.executeJavaScript(`!!document.querySelector('canvas, [class*=qr i]')`);
        if (pret) { clearInterval(iv); arreter(); return; }
      } catch {}
      if (essais >= 60) { clearInterval(iv); arreter(); }
    }, 3000);
    w.on('closed', () => clearInterval(iv));
    w.loadURL('https://discord.com/login').catch(arreter);
  } catch {}
}

ipcMain.handle('discord:getFriends', async () => {
  const r = await discordFetch('GET', '/users/@me/relationships');
  if (!r.success) return apiFailure(r);

  const friends = r.data
    .filter(relationship => relationship.type === 1)
    .map(friend => ({
      id: friend.user.id,
      username: friend.user.username,
      displayName: friend.user.global_name || friend.user.username,
      avatar: friend.user.avatar ? `https://cdn.discordapp.com/avatars/${friend.user.id}/${friend.user.avatar}.png?size=64` : 'https://cdn.discordapp.com/embed/avatars/0.png'
    }));

  return { success: true, friends };
});

ipcMain.handle('discord:getDMs', async () => {
  const r = await discordFetch('GET', '/users/@me/channels');
  if (!r.success) return apiFailure(r);
  const dms = r.data
    .filter(ch => ch.type === 1)
    .map(dm => ({
      id: dm.id,
      username: dm.recipients?.[0]?.username || 'Unknown User',
      displayName: dm.recipients?.[0]?.global_name || dm.recipients?.[0]?.username || 'Unknown User',
      avatar: dm.recipients?.[0]?.avatar
        ? `https://cdn.discordapp.com/avatars/${dm.recipients[0].id}/${dm.recipients[0].avatar}.png?size=64`
        : 'https://cdn.discordapp.com/embed/avatars/0.png'
    }));
  return { success: true, dms };
});

ipcMain.handle('discord:deleteDMMessage', async (_, channelId, messageId) => {
  if (!isSnowflake(channelId) || !isSnowflake(messageId)) return { success: false, error: 'identifiant invalide' };
  const r = await discordFetch('DELETE', `/channels/${channelId}/messages/${messageId}`);
  if (!r.success) {
    if (r.status === 429) return { success: false, error: 'Rate limited', retryAfter: r.retryAfter };
    if (r.status === 404) return { success: false, error: 'not found' };
    return apiFailure(r);
  }
  return { success: true };
});

ipcMain.handle('discord:closeDM', async (_, channelId) => {
  if (!isSnowflake(channelId)) return { success: false, error: 'identifiant invalide' };
  return discordMutate('DELETE', `/channels/${channelId}`);
});

ipcMain.handle('discord:removeOwnReaction', async (_, channelId, messageId, rawEmojiKey) => {
  if (!isSnowflake(channelId) || !isSnowflake(messageId)) return { success: false, error: 'identifiant invalide' };
  if (!rawEmojiKey) return { success: false, error: 'empty emoji key' };

  // La clé vient déjà de formatEmojiForApi (référence discrub) : "name:id" brut
  // ou unicode URL-encodé AVEC variation selector. On ne la re-strippe PAS
  // (U+FE0F) mais on l'encode pour le chemin (S3 : jamais de segment brut).
  const r = await discordFetch('DELETE', `/channels/${channelId}/messages/${messageId}/reactions/${encodeEmojiSegment(rawEmojiKey)}/@me`);

  if (!r.success) {
    // anti-fantômes : 404 = réaction confirmée absente (ok) ; 400 = requête invalide (échec visible, pas silencieux)
    if (r.status === 404) return { success: false, error: 'noReaction' };
    if (r.status === 400) return { success: false, error: 'invalidEmoji' };
    if (r.status === 429) return { success: false, error: 'Rate limited', retryAfter: r.retryAfter };
    return apiFailure(r);
  }
  return { success: true };
});

ipcMain.handle('discord:getReactions', async (_, channelId, messageId, emoji, afterId) => {
  if (!isSnowflake(channelId) || !isSnowflake(messageId)) return { success: false, error: 'identifiant invalide' };
  const r = await discordFetch('GET', `/channels/${channelId}/messages/${messageId}/reactions/${encodeEmojiSegment(emoji)}`, afterId ? { params: { after: afterId } } : {});
  if (!r.success) {
    if (r.status === 429) return { success: false, error: 'Rate limited', retryAfter: r.retryAfter };
    return { success: false, error: r.status ? `HTTP ${r.status}` : 'Failed to get reactions' };
  }
  return { success: true, data: r.data };
});

ipcMain.handle('discord:deleteFriend', async (_, friendId) => {
  if (!isSnowflake(friendId)) return { success: false, error: 'identifiant invalide' };
  return discordMutate('DELETE', `/users/@me/relationships/${friendId}`);
});

// Phase C : cache persistant de la liste des serveurs (lancement instantané).
// La correction (force=true) contourne le cache — aucune donnée périmée après mutation.
const SERVERS_CACHE_TTL = 30000;
// Cache indexe par compte : un compte B ne voit pas les serveurs du compte A (fuite 30 s).
const serversCachePath = (userId) => path.join(app.getPath('userData'), `servers_cache.${String(userId || 'unknown')}.json`);

// ARCH-04 : cache serveurs en écriture atomique (tmp+rename, async) via persist.cjs —
// plus de fs synchrone dans le main process, cohérent avec P1.
async function readServersCache(userId) {
  try {
    const { at, servers } = (await readJson(serversCachePath(userId))) || {};
    if (Date.now() - at < SERVERS_CACHE_TTL && Array.isArray(servers)) return servers;
  } catch {}
  return null;
}

function writeServersCache(userId, servers) {
  return writeJson(serversCachePath(userId), { at: Date.now(), servers }).catch(() => {});
}

ipcMain.handle('discord:getServers', async (_, force = false) => {
  const userId = discordClient?.user?.id;
  if (!force) {
    const cached = await readServersCache(userId);
    if (cached) return { success: true, servers: cached };
  }
  const r = await discordFetch('GET', '/users/@me/guilds');
  if (!r.success) return apiFailure(r);

  const servers = r.data.map(server => ({
    id: server.id,
    name: server.name,
    owner: !!server.owner,
    icon: server.icon
      ? `https://cdn.discordapp.com/icons/${server.id}/${server.icon}.png?size=64`
      : 'https://cdn.discordapp.com/embed/avatars/0.png'
  }));
  await writeServersCache(userId, servers);
  return { success: true, servers };
});

// Phase D : cache canaux par serveur (mémoire, TTL 60 s) — évite de re-fetch
// quand delete-msgs + rm-reactions s'enchaînent sur le même serveur.
const channelsCache = new Map(); // `${uid}:${serverId}` -> { at, channels }
const CHANNELS_TTL = 60000;

ipcMain.handle('discord:getServerChannels', async (_, serverId) => {
  if (!isSnowflake(serverId)) return { success: false, error: 'identifiant invalide' };
  const cle = `${currentUid()}:${serverId}`;
  const hit = channelsCache.get(cle);
  if (hit && Date.now() - hit.at < CHANNELS_TTL) {
    return { success: true, channels: hit.channels, currentUserId: discordClient?.user?.id };
  }
  const r = await discordFetch('GET', `/guilds/${serverId}/channels`);
  if (!r.success) return apiFailure(r);

  // Le chat intégré des salons vocaux (2) et des scènes (13) est inclus : leurs
  // messages se suppriment via /channels/{voiceId}/messages comme un salon texte.
  // Voir MESSAGE_BEARING_CHANNEL_TYPES dans helpers.cjs.
  const channels = r.data
    .filter(ch => isMessageBearingChannel(ch.type))
    .map(ch => ({ id: ch.id, name: ch.name, type: ch.type }));
  channelsCache.set(cle, { at: Date.now(), channels });
  return { success: true, channels, currentUserId: discordClient?.user?.id };
});

ipcMain.handle('discord:leaveServer', async (_, serverId) => {
  if (!isSnowflake(serverId)) return { success: false, error: 'identifiant invalide' };
  return discordMutate('DELETE', `/users/@me/guilds/${serverId}`);
});

// Marquage "lu" d'un seul serveur (le dock de sélection) — même ack que readAll.
ipcMain.handle('discord:readServer', async (_, serverId) => {
  if (!isSnowflake(serverId)) return { success: false, error: 'identifiant invalide' };
  return discordFetch('PUT', `/guilds/${serverId}/ack`, { data: { token: null } });
});

// ============================================================
// Persistance locale (checkpoints, watermarks, ledger anti-fantômes)
// ============================================================
const cpDir = () => path.join(app.getPath('userData'), 'checkpoints');
// BUG-001 : watermark, ledger et checkpoints sont prefixes par l'identifiant du
// compte connecte (`currentUid()`). Deux comptes ne partagent plus le meme
// fichier : l'un ne saute plus des canaux « deja nettoyes » par l'autre. Les
// anciens fichiers NON scopes sont simplement ignores.
const wmFile = (serverId) => path.join(app.getPath('userData'), `watermark-${currentUid()}-${serverId}.json`);
const LEDGER_FILE = () => path.join(app.getPath('userData'), `cleaned_reactions.${currentUid()}.json`);
const checkpointFile = (op, serverId) => path.join(cpDir(), `${op}-${currentUid()}-${serverId}.json`);
const LEDGER_TTL = 24 * 3600 * 1000;

// BUG-022 : la lecture-modification-ecriture du ledger est serialisee (une seule
// operation a la fois) pour ne pas perdre de cles quand plusieurs `ledgerAdd`
// arrivent en parallele. Motif identique au mutex de tokenStore.cjs.
let ledgerOp = Promise.resolve();
const withLedgerLock = (fn) => {
  const p = ledgerOp.then(fn);
  ledgerOp = p.then(() => {}, () => {});
  return p;
};

ipcMain.handle('persist:checkpointLoad', async (_, op, serverId) => {
  if (!isOp(op) || !isSnowflake(serverId)) return null;
  return readJson(checkpointFile(op, serverId));
});
ipcMain.handle('persist:checkpointSave', async (_, op, serverId, cp) => {
  if (!isOp(op) || !isSnowflake(serverId) || !cp || typeof cp !== 'object') return;
  await writeJson(checkpointFile(op, serverId), cp);
});
ipcMain.handle('persist:checkpointClear', async (_, op, serverId) => {
  if (!isOp(op) || !isSnowflake(serverId)) return;
  try { await fsp.unlink(checkpointFile(op, serverId)); } catch {}
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
// BUG-022 : purge des entrees perimees A L'ECRITURE (le fichier ne grossit plus
// sans fin) ET serialisation : sans le verrou, deux `ledgerAdd` concurrents
// perdaient l'ajout de l'un des deux.
ipcMain.handle('persist:ledgerAdd', (_, keys) => withLedgerLock(async () => {
  if (!Array.isArray(keys) || !keys.length) return;
  const lus = (await readJson(LEDGER_FILE())) || {};
  const now = Date.now();
  const vivants = {};
  for (const [k, ts] of Object.entries(lus)) {
    if (typeof ts === 'number' && now - ts < LEDGER_TTL) vivants[k] = ts;
  }
  for (const k of keys) if (typeof k === 'string' && k.length <= 200) vivants[k] = now;
  await writeJson(LEDGER_FILE(), vivants);
}));
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

// Le type MIME deduit de l'extension du fichier. Les types inconnus retombent
// sur `application/octet-stream` : le navigateur telechargera alors la piece
// jointe plutot que d'echouer a la decodier.
const MEDIA_MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  // Un SVG peut porter du script : on le sert en text/plain pour neutraliser
  // toute execution (nosniff en tete, cf. servirMedia).
  '.svg': 'text/plain',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/opus',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
};
function mediaContentType(chemin) {
  return MEDIA_MIME_TYPES[path.extname(chemin).toLowerCase()] || 'application/octet-stream';
}

// Sert un fichier du miroir sous `data/media`. Le refus de traversee est
// DELEGUE a `mediaRequestPath`, qui retire le `/` de tete puis decode UNE fois
// et appelle `resolveMediaPath` (tache 1) : une URL `media://mirror/../secret`
// se resout hors racine, le garde rend `null`, et le handler repond 404 — la
// garde n'est PAS reimplementee ici. Le handler ne decode PAS le pathname
// lui-meme : le decodage, unique, appartient a `mediaRequestPath`.
//
// F3 : `resolveMediaPath` est purement LEXICALE et ne voit donc pas un LIEN
// SYMBOLIQUE. Ce handler, lui, touche deja au disque : apres la resolution, il
// suit le lien avec `fs.promises.realpath` puis confirme, via `isMediaPathInside`,
// que la cible REELLE est bien sous `data/media`. Un fichier absent fait jeter
// `realpath`, capte plus bas -> 404. Toute lecture impossible repond 404 aussi.
// BUG-013 : les medias sont servis en FLUX (`createReadStream`), avec support
// de l'en-tete `Range` et reponse 206 — indispensable aux seeks des videos
// locales. `fsp.readFile` chargeait tout le fichier en memoire et ne repondait
// jamais 206 / `Accept-Ranges`. Une plage hors fichier repond 416.
async function servirMedia(request) {
  try {
    const racine = path.join(dataDir, MIRROR_DIR_NAME);
    const cible = mediaRequestPath(racine, new URL(request.url).pathname);
    if (!cible) return new Response('Introuvable', { status: 404 });
    const reelle = await fsp.realpath(cible);
    if (!isMediaPathInside(racine, reelle)) return new Response('Introuvable', { status: 404 });
    const taille = (await fsp.stat(reelle)).size;
    const entetes = {
      'Content-Type': mediaContentType(reelle),
      'X-Content-Type-Options': 'nosniff',
      'Accept-Ranges': 'bytes',
    };
    const plage = parseByteRange(request.headers.get('range'), taille);
    if (plage === 'invalid') {
      return new Response('Plage invalide', {
        status: 416,
        headers: { ...entetes, 'Content-Range': `bytes */${taille}` },
      });
    }
    if (plage) {
      const flux = fs.createReadStream(reelle, { start: plage.start, end: plage.end });
      return new Response(Readable.toWeb(flux), {
        status: 206,
        headers: {
          ...entetes,
          'Content-Range': `bytes ${plage.start}-${plage.end}/${taille}`,
          'Content-Length': String(plage.end - plage.start + 1),
        },
      });
    }
    const flux = fs.createReadStream(reelle);
    return new Response(Readable.toWeb(flux), {
      headers: { ...entetes, 'Content-Length': String(taille) },
    });
  } catch {
    return new Response('Introuvable', { status: 404 });
  }
}

app.whenReady().then(() => {
  protocol.handle('media', servirMedia);
  createWindow();
  cleanupCheckpoints();
  // Pre-chauffe le cache de la page de login pour qu elle s ouvre instantanement
  // (leger differe : laisse la fenetre principale s afficher d abord).
  setTimeout(() => { try { prechaufferLogin(); } catch {} }, 1500);
  // Les anciennes connexions natives laissaient des cookies Discord dans la
  // session par defaut (persistante). La fenetre de login utilise desormais une
  // session ephemere : ces cookies n ont plus d usage, on les retire une fois.
  try {
    session.defaultSession.cookies.get({ domain: 'discord.com' })
      .then((liste) => Promise.all(liste.map((c) => session.defaultSession.cookies.remove('https://discord.com', c.name).catch(() => {}))))
      .catch(() => {});
  } catch {}
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
