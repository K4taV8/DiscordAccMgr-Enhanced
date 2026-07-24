import { loadSavedTokens, saveToken } from './utils/tokenManager.js';
import { DMManager } from './components/DMManager.js';
import { ServerManager } from './components/ServerManager.js';
import { FriendsManager } from './components/FriendsManager.js';
import { GroupManager } from './components/GroupManager.js';
import { showInfoModal } from './utils/ui.js';
import { copyToClipboard } from './utils/clipboard.js';
import { getFriendsList } from './utils/discord.js';

window.dmManager = new DMManager(document.getElementById('dms-page'));
window.serverManager = new ServerManager(document.getElementById('servers-page'));
window.friendsManager = new FriendsManager(document.getElementById('friends-page'));
window.groupManager = new GroupManager(document.getElementById('groups-page'));

window._dlOpen = false;
window._dlPanel = null;

window.toggleDebugLog = () => {
  const n = document.getElementById('logNavItem');
  window._dlOpen = !window._dlOpen;
  n?.classList.toggle('active', window._dlOpen);

  if (!window._dlOpen) {
    window._dlPanel?.remove();
    window._dlPanel = null;
    return;
  }

  if (window._dlPanel) return;
  const p = document.createElement('div');
  p.style.cssText = [
    'position:fixed;bottom:60px;left:4px;width:232px;z-index:10001',
    'background:#18191c;border:1px solid #303338;border-radius:8px',
    'box-shadow:0 4px 24px rgba(0,0,0,.6);overflow:hidden',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
    'font-size:13px;color:#dcddde',
  ].join(';');
  p.innerHTML = [
    '<div id="dlHeader" style="display:flex;align-items:center;padding:10px 14px;background:#202225;border-bottom:1px solid #303338;gap:8px;cursor:grab;user-select:none">',
      '<span style="font-weight:600;font-size:14px;color:#fff;flex:1">Debug Log</span>',
      '<button id="dlClose" style="background:none;border:none;color:#96989d;cursor:pointer;font-size:20px;line-height:1;padding:2px 4px;border-radius:4px">&times;</button>',
    '</div>',
    '<div id="dlBody" style="overflow-y:auto;padding:4px 0;min-height:60px;max-height:200px;background:#0d0d0d;font-family:Consolas,\'Courier New\',monospace;font-size:8px;line-height:1.3;color:#a0a0a0"></div>',
    '<div id="dlResize" style="width:14px;height:14px;position:absolute;bottom:0;right:0;cursor:nwse-resize;background:#424549;clip-path:polygon(100% 0,100% 100%,0 100%)"></div>',
  ].join('');
  document.body.appendChild(p);

  // drag
  let dx, dy, dragging = false;
  const h = p.querySelector('#dlHeader');
  h.addEventListener('mousedown', e => {
    if (e.target.id === 'dlClose') return;
    dragging = true;
    dx = e.clientX - p.offsetLeft;
    dy = e.clientY - p.offsetTop;
    h.style.cursor = 'grabbing';
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    p.style.left = (e.clientX - dx) + 'px';
    p.style.top = (e.clientY - dy) + 'px';
    p.style.bottom = 'auto';
    p.style.right = 'auto';
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    h.style.cursor = 'grab';
  });

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
  document.addEventListener('mousemove', e => {
    if (!resizing) return;
    const w = Math.max(200, rw + (e.clientX - rx));
    const h = Math.max(100, rh + (e.clientY - ry));
    p.style.width = w + 'px';
    p.querySelector('#dlBody').style.maxHeight = (h - 44) + 'px';
  });
  document.addEventListener('mouseup', () => { resizing = false; });

  p.querySelector('#dlClose').onclick = () => { window._dlOpen = false; n?.classList.remove('active'); p.remove(); window._dlPanel = null; };
  window._dlPanel = p;
};

window.log = (msg) => {
  const cls = /\berror\b/i.test(msg) ? 'err' : /\b(?:done|success|removed|deleted?)\b/i.test(msg) ? 'ok' : /cancelled|warn/i.test(msg) ? 'warn' : '';
  const body = document.getElementById('dlBody');
  if (body) {
    const e = document.createElement('div');
    e.style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 6px;color:' + (cls === 'err' ? '#e04e4e' : cls === 'ok' ? '#3ba55d' : cls === 'warn' ? '#d4a72c' : '#a0a0a0');
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

function showUserProfile(username) {
  const userInitial = document.getElementById('userInitial');
  const userName = document.getElementById('userName');
  
  userInitial.textContent = username.charAt(0).toUpperCase();
  userName.textContent = username;
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
    if (page.id === `${pageId}-page`) {
      setTimeout(() => page.classList.add('active'), 50);
    }
  });

  navItems.forEach(item => {
    item.classList.remove('active');
    if (item.dataset.page === pageId) {
      item.classList.add('active');
    }
  });
  if (window._dlOpen) document.getElementById('logNavItem')?.classList.add('active');

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
  }
}

// Initialize visibility
toggleNavItems(false);
switchPage('login');

navItems.forEach(item => {
  if (item.id === 'logNavItem') return;
  item.addEventListener('click', () => switchPage(item.dataset.page));
});

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await loadSavedTokens();
  } catch (error) {
    console.error('Error during initialization:', error);
  }
});

// Window controls
document.getElementById('minimizeBtn').addEventListener('click', () => window.electronAPI.minimize());
document.getElementById('maximizeBtn').addEventListener('click', () => window.electronAPI.maximize());
document.getElementById('closeBtn').addEventListener('click', () => window.electronAPI.close());
document.getElementById('infoBtn').addEventListener('click', showInfoModal);
document.getElementById('saveTokenBtn').addEventListener('click', () => saveToken(tokenInput.value, status));

// Disconnect handler
document.getElementById('disconnectBtn').addEventListener('click', () => {
  window._dlOpen = false;
  window._dlPanel?.remove();
  window._dlPanel = null;
  document.getElementById('logNavItem')?.classList.remove('active');
  hideUserProfile();
  toggleNavItems(false);
  switchPage('login');
  tokenInput.value = '';
  tokenInput.type = 'password';
  document.getElementById('toggleTokenBtn').textContent = 'Show';
  status.textContent = '';
  status.className = '';
});

// Connect button handler
const connectBtn = document.getElementById('connectBtn');
const tokenInput = document.getElementById('tokenInput');
const status = document.getElementById('status');

connectBtn.addEventListener('click', async () => {
  const token = tokenInput.value;
  if (!token) {
    status.textContent = 'Please enter a token';
    status.className = 'error';
    return;
  }

  const btnText = connectBtn.querySelector('.btn-text');
  const loader = connectBtn.querySelector('.loader');
  btnText.style.display = 'none';
  loader.style.display = 'inline-block';
  connectBtn.disabled = true;

  try {
    const result = await window.electronAPI.connectDiscord(token);
    if (result.success) {
      status.textContent = `Connected as ${result.username}`;
      status.className = 'success';
      showUserProfile(result.username);
      toggleNavItems(true);
      switchPage('friends');
    } else {
      status.textContent = result.error;
      status.className = 'error';
    }
  } catch (error) {
    status.textContent = 'Connection failed';
    status.className = 'error';
  } finally {
    btnText.style.display = 'inline-block';
    loader.style.display = 'none';
    connectBtn.disabled = false;
  }
});

// Toggle token visibility
document.getElementById('toggleTokenBtn').addEventListener('click', () => {
  if (tokenInput.type === 'password') {
    tokenInput.type = 'text';
    document.getElementById('toggleTokenBtn').textContent = 'Hide';
  } else {
    tokenInput.type = 'password';
    document.getElementById('toggleTokenBtn').textContent = 'Show';
  }
});
