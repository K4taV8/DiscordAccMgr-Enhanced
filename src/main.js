import { loadSavedTokens, saveToken } from './utils/tokenManager.js';
import { DMManager } from './components/DMManager.js';
import { ServerManager } from './components/ServerManager.js';
import { FriendsManager } from './components/FriendsManager.js';
import { GroupManager } from './components/GroupManager.js';
import { showInfoModal } from './utils/ui.js';
import { copyToClipboard } from './utils/clipboard.js';
import { getFriendsList } from './utils/discord.js';
import { escHtml } from './utils/emojiUtils.js';
import { installAvatarFallbacks } from './utils/domManager.js';
import { showUserProfileModal } from './components/UserProfileModal.js';
import { showHelpModal } from './components/HelpModal.js';
import { toggleThemeSelector } from './components/ThemeSelector.js';
import { applyTheme, readStoredTheme, THEME_BUTTON_ICON } from './utils/theme.js';
import { initLanguage } from './i18n/index.js';
import { bindLanguageButtons } from './components/LanguageSelector.js';
import { PackageManager } from './components/PackageManager.js';
import { configurePreloads, preloadPage, preloadPages, isPageCachedFresh, clearPageCaches } from './utils/pagePreloader.js';

// log capture
window.__logs = [];
['log', 'warn', 'error'].forEach(m => {
  const orig = console[m];
  console[m] = (...args) => {
    let line;
    try {
      line = args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 1) : String(a)).join(' ');
    } catch {
      // Objet circulaire : JSON.stringify lève. Repli sûr, sans perdre la trace.
      line = args.map(a => String(a)).join(' ');
    }
    window.__logs.push(`[${new Date().toLocaleTimeString()}] ${line}`);
    window.__logs.splice(0, window.__logs.length - 5000);
    orig.apply(console, args);
  };
});

// Thème — appliqué au démarrage (défaut dark), puis au clic via le sélecteur
// Bento flottant. Le registre et la persistance vivent dans utils/theme.js ;
// le bouton ne fait plus de rotation cyclique, il ouvre le menu.
// Son icône est fixe (pinceau) : c'est une action « personnaliser », pas la
// représentation du thème courant. Le libellé est dans index.html.
const themeToggleBtn = document.getElementById('themeToggleBtn');

initLanguage();
bindLanguageButtons();
applyTheme(readStoredTheme());
if (themeToggleBtn) themeToggleBtn.innerHTML = THEME_BUTTON_ICON;
themeToggleBtn?.addEventListener('click', () => toggleThemeSelector(themeToggleBtn));

// Clic sur l'avatar → modale de profil utilisateur (état de session).
document.getElementById('userAvatarBtn').addEventListener('click', () => showUserProfileModal(window.currentUser));

// Clic sur « ? » → modale d'aide.
document.getElementById('helpBtn').addEventListener('click', () => showHelpModal());

window.dmManager = new DMManager(document.getElementById('dms-page'));
window.serverManager = new ServerManager(document.getElementById('servers-page'));
window.friendsManager = new FriendsManager(document.getElementById('friends-page'));
window.groupManager = new GroupManager(document.getElementById('groups-page'));
window.packageManager = new PackageManager(document.getElementById('package-page'));

// PagePreloader : cartographie page -> manager (utils/pagePreloader.js), servie au
// warm-up du login et au préchargement au survol d'un nav-item.
configurePreloads({
  friends: { manager: window.friendsManager, refresh: () => window.friendsManager.refreshFriendsList() },
  servers: { manager: window.serverManager, refresh: () => window.serverManager.refreshServersList() },
  dms:     { manager: window.dmManager,     refresh: () => window.dmManager.refreshDMsList() },
  groups:  { manager: window.groupManager,  refresh: () => window.groupManager.refreshGroupsList() },
  package: { manager: window.packageManager, refresh: () => window.packageManager.render() },
});

// R03b : fallback des avatars cassés (événement error en capture, CSP-safe).
installAvatarFallbacks();

window._dlOpen = false;
window._dlPanel = null;
window._dlListeners = null;

// Ferme le panneau Debug Log et retire TOUJOURS les listeners globaux
// mousemove/mouseup — quel que soit le chemin de fermeture (toggle, croix,
// déconnexion). Sans cela, ils fuient et restent actifs après disparition.
const closeDebugLog = () => {
  if (window._dlListeners) {
    document.removeEventListener('mousemove', window._dlListeners.onMouseMove);
    document.removeEventListener('mouseup', window._dlListeners.onMouseUp);
    window._dlListeners = null;
  }
  window._dlPanel?.remove();
  window._dlPanel = null;
  window._dlOpen = false;
  document.getElementById('logNavItem')?.classList.remove('active');
};

window.toggleDebugLog = () => {
  const n = document.getElementById('logNavItem');
  window._dlOpen = !window._dlOpen;
  n?.classList.toggle('active', window._dlOpen);

  if (!window._dlOpen) {
    closeDebugLog();
    return;
  }

  if (window._dlPanel) return;
  const p = document.createElement('div');
  p.className = 'dl-panel';
  p.style.cssText = 'position:fixed;bottom:60px;left:84px;width:232px;z-index:10001';
  p.innerHTML = [
    '<div id="dlHeader" class="dl-header">',
      '<span class="dl-title">Journal de débogage</span>',
      '<button id="dlCopy" class="dl-btn">Copier</button>',
      '<button id="dlClose" class="dl-btn dl-close">&times;</button>',
    '</div>',
    '<div id="dlBody" class="dl-body"></div>',
    '<div id="dlResize" class="dl-resize"></div>',
  ].join('');
  document.body.appendChild(p);

  // drag
  let dx, dy, dragging = false;
  const h = p.querySelector('#dlHeader');
  const onMouseMove = (e) => {
    if (dragging) {
      p.style.left = (e.clientX - dx) + 'px';
      p.style.top = (e.clientY - dy) + 'px';
      p.style.bottom = 'auto';
      p.style.right = 'auto';
    }
    if (resizing) {
      const w = Math.max(200, rw + (e.clientX - rx));
      const h = Math.max(100, rh + (e.clientY - ry));
      p.style.width = w + 'px';
      p.querySelector('#dlBody').style.maxHeight = (h - 44) + 'px';
    }
  };
  const onMouseUp = () => {
    if (dragging) { dragging = false; h.style.cursor = 'grab'; }
    resizing = false;
  };
  h.addEventListener('mousedown', e => {
    if (e.target.id === 'dlClose') return;
    dragging = true;
    dx = e.clientX - p.offsetLeft;
    dy = e.clientY - p.offsetTop;
    h.style.cursor = 'grabbing';
  });
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
  window._dlListeners = { onMouseMove, onMouseUp };

  // resize
  let rx, ry, rw, rh, resizing = false;
  const rz = p.querySelector('#dlResize');
  rz.addEventListener('mousedown', e => {
    e.stopPropagation();
    resizing = true;
    rx = e.clientX;
    ry = e.clientY;
    rw = p.offsetWidth;
    rh = p.offsetHeight;
  });

  p.querySelector('#dlCopy').onclick = () => {
    copyToClipboard(window.__logs.join('\n'));
  };
  p.querySelector('#dlClose').onclick = () => {
    closeDebugLog();
  };
  window._dlPanel = p;
};

const MAX_LOG_LINES = 500;

window.log = (msg) => {
  const cls = /\berror\b/i.test(msg) ? 'err' : /\b(?:done|success|removed|deleted?)\b/i.test(msg) ? 'ok' : /cancelled|warn/i.test(msg) ? 'warn' : '';
  const body = document.getElementById('dlBody');
  if (body) {
    while (body.children.length >= MAX_LOG_LINES) {
      body.removeChild(body.firstChild);
    }
    const e = document.createElement('div');
    e.className = 'dl-line' + (cls ? ' ' + cls : '');
    e.textContent = msg;
    body.appendChild(e);
    body.scrollTop = body.scrollHeight;
  }
};

window.copyToClipboard = copyToClipboard;
window.getFriendsList = getFriendsList;

const navItems = document.querySelectorAll('.nav-item');
const pages = document.querySelectorAll('.page-container');
const userProfile = document.getElementById('userProfile');
const loginNavItem = document.getElementById('loginNavItem');

function showUserProfile(username, avatar) {
  const userInitial = document.getElementById('userInitial');
  const userAvatarBtn = document.getElementById('userAvatarBtn');

  userInitial.innerHTML = avatar
    ? `<img src="${escHtml(avatar)}" alt="${escHtml(username)}" data-hide-on-error>`
    : escHtml(username.charAt(0).toUpperCase());
  userAvatarBtn.dataset.tooltip = username;
  userProfile.classList.add('visible');
}

function hideUserProfile() {
  userProfile.classList.remove('visible');
}

function toggleNavItems(show) {
  document.querySelectorAll('.nav-item:not(#loginNavItem)').forEach(item => {
    item.classList.toggle('hidden', !show);
  });
  loginNavItem.classList.toggle('hidden', show);
}

function switchPage(pageId) {
  pages.forEach(page => {
    page.classList.remove('active');
  });
  document.getElementById(`${pageId}-page`)?.classList.add('active');
  document.body.classList.toggle('login-active', pageId === 'login');
  const loginPage = document.getElementById('login-page');
  if (loginPage) loginPage.classList.toggle('login-centered', pageId === 'login');

  navItems.forEach(item => {
    item.classList.remove('active');
    if (item.dataset.page === pageId) {
      item.classList.add('active');
    }
  });

  // Le dock de sélection d'une autre page ne doit pas survivre au switch.
  document.querySelectorAll('.selection-dock').forEach(d => d.classList.remove('show'));

  // Load content based on page
  switch (pageId) {
    case 'friends':
      window.friendsManager.refreshFriendsList();
      break;
    case 'servers':
      window.serverManager.refreshServersList();
      break;
    case 'dms':
      window.dmManager.refreshDMsList();
      break;
    case 'groups':
      window.groupManager.refreshGroupsList();
      break;
    case 'package':
      window.packageManager.render();
      break;
  }
}

// Initialize visibility
toggleNavItems(false);
switchPage('login');

navItems.forEach(item => {
  if (!item.dataset.page) return;
  item.addEventListener('click', () => switchPage(item.dataset.page));
  // Préchargement au survol : re-warm la page si son cache est absent ou froid.
  item.addEventListener('mouseenter', () => {
    if (!window.currentUser) return;
    if (!isPageCachedFresh(item.dataset.page)) preloadPage(item.dataset.page);
  });
});

// F12 et Ctrl+Shift+L ouvrent les DevTools.
document.addEventListener('keydown', event => {
  const isF12 = event.key === 'F12';
  const letter = typeof event.code === 'string' ? event.code : event.key;
  const isCombo = (event.ctrlKey || event.metaKey) && event.shiftKey && ['l', 'keyl'].includes(String(letter).toLowerCase());
  if (!isF12 && !isCombo) return;
  event.preventDefault();
  window.electronAPI?.toggleDevTools?.();
});

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await loadSavedTokens();
    warmUpPages();
  } catch (error) {
    console.error('Erreur d’initialisation :', error);
  }
});

// Warm up GPU/layout so first page switches are as fluid as the rest.
// Les pages actives AVANT le warm-up sont restaurées après le double rAF :
// au premier démarrage (IPC lent), la page courante ne peut plus être
// effacée par le warm-up → pas de fenêtre vide initiale.
function warmUpPages() {
  const els = ['login', 'friends', 'servers', 'dms', 'groups', 'package'].map(id => document.getElementById(`${id}-page`)).filter(Boolean);
  const wasActive = new Set(els.filter(el => el.classList.contains('active')));
  document.body.classList.add('warming');
  els.forEach(el => el.classList.add('active'));
  requestAnimationFrame(() => requestAnimationFrame(() => {
    els.forEach(el => {
      el.classList.remove('active');
      if (wasActive.has(el)) el.classList.add('active');
    });
    document.body.classList.remove('warming');
  }));
}

// Window controls
document.getElementById('minimizeBtn').addEventListener('click', () => window.electronAPI.minimize());
document.getElementById('maximizeBtn').addEventListener('click', () => window.electronAPI.maximize());
document.getElementById('closeBtn').addEventListener('click', () => window.electronAPI.close());
document.getElementById('infoBtn').addEventListener('click', showInfoModal);
document.getElementById('saveTokenBtn').addEventListener('click', () => saveToken(tokenInput.value, status));

// Disconnect handler
document.getElementById('disconnectBtn').addEventListener('click', () => {
  window.electronAPI.disconnect();
  closeDebugLog();
  // La visionneuse (lightbox) vit hors des pages : sans fermeture explicite, son
  // overlay et son listener `keydown` survivraient à la déconnexion.
  window.packageManager?.closeLightbox?.();
  window.currentUser = null;
  clearPageCaches();
  hideUserProfile();
  toggleNavItems(false);
  switchPage('login');
  tokenInput.value = '';
  tokenInput.type = 'password';
  const eyeOpen = document.getElementById('eyeOpenIcon');
  const eyeClosed = document.getElementById('eyeClosedIcon');
  if (eyeOpen) eyeOpen.style.display = 'inline-block';
  if (eyeClosed) eyeClosed.style.display = 'none';
  document.getElementById('toggleTokenBtn').title = 'Afficher';
  status.textContent = '';
  status.className = '';
});

// Connect button handler
const connectBtn = document.getElementById('connectBtn');
const tokenInput = document.getElementById('tokenInput');
const status = document.getElementById('status');

async function performConnect(connectPromise) {
  const btnText = connectBtn.querySelector('.btn-text');
  const loader = connectBtn.querySelector('.loader');
  btnText.style.display = 'none';
  loader.style.display = 'inline-block';
  connectBtn.disabled = true;

  try {
    const result = await connectPromise;
    if (result.success) {
      status.textContent = `Connecté en tant que ${result.username}`;
      status.className = 'success';
      window.currentUser = result.user;
      showUserProfile(result.username, result.avatar);
      toggleNavItems(true);

      // Warm-up : l'interface n'apparaît qu'une fois les 4 listes rendues (le
      // spinner couvre cette période). On réarme d'abord les caches pour ne
      // jamais montrer celles d'un compte précédent.
      clearPageCaches();
      await preloadPages(['friends', 'servers', 'dms', 'groups']);
      // Le package part en fond, en dernier, sans bloquer le login.
      preloadPage('package');
      switchPage('friends');
    } else {
      status.textContent = result.error;
      status.className = 'error';
    }
    return result;
  } catch (error) {
    status.textContent = 'Échec de la connexion';
    status.className = 'error';
    return null;
  } finally {
    btnText.style.display = 'inline-block';
    loader.style.display = 'none';
    connectBtn.disabled = false;
  }
}

connectBtn.addEventListener('click', async () => {
  const token = tokenInput.value;
  if (!token) {
    status.textContent = 'Veuillez saisir un token';
    status.className = 'error';
    return;
  }
  await performConnect(window.electronAPI.connectDiscord(token));
});

// Connexion Discord native : la fenetre de login ouvre Discord, capture le
// token via CDP (tache 2), puis on rejoue le flux de connexion existant.
document.getElementById('discordLoginBtn').addEventListener('click', async () => {
  const r = await window.electronAPI.loginNative();
  if (r && r.ok && r.token) {
    tokenInput.value = r.token;
    const res = await performConnect(window.electronAPI.connectDiscord(r.token));
    if (res && res.success) await saveToken(r.token, status);
  } else if (r && !r.cancelled) {
    status.textContent = 'Connexion Discord impossible : ' + (r.error || 'erreur inconnue');
    status.className = 'error';
  }
});

// SEC-03 : connexion depuis un token sauvegardé — seul le nom circule,
// le secret reste chiffré dans le main process.
window.connectBySavedToken = (name) => performConnect(window.electronAPI.connectByName(name));

// Toggle token visibility
const eyeOpenIcon = document.getElementById('eyeOpenIcon');
const eyeClosedIcon = document.getElementById('eyeClosedIcon');
document.getElementById('toggleTokenBtn').addEventListener('click', () => {
  if (tokenInput.type === 'password') {
    tokenInput.type = 'text';
    if (eyeOpenIcon) eyeOpenIcon.style.display = 'none';
    if (eyeClosedIcon) eyeClosedIcon.style.display = 'inline-block';
    document.getElementById('toggleTokenBtn').title = 'Masquer';
  } else {
    tokenInput.type = 'password';
    if (eyeOpenIcon) eyeOpenIcon.style.display = 'inline-block';
    if (eyeClosedIcon) eyeClosedIcon.style.display = 'none';
    document.getElementById('toggleTokenBtn').title = 'Afficher';
  }
});
