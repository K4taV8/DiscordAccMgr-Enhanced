import { escHtml } from '../utils/emojiUtils.js';
import { copyToClipboard } from '../utils/clipboard.js';

function createdAtFromId(id) {
  try {
    const ts = Number((BigInt(id) >> 22n) + 1420070400000n);
    return new Date(ts);
  } catch {
    return null;
  }
}

// Modale de profil minimaliste — conteneur épuré, sans bannière ni bio.
// L'ID n'est jamais affiché en clair ; le badge [ID] le copie au clic.
// Clôture : croix, Échap, clic extérieur.
export function showUserProfileModal(user) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay profile-overlay';

  const avatarSrc = user?.avatar ? `${user.avatar}?size=4096` : null;
  const avatarImg = avatarSrc
    ? `<img src="${escHtml(avatarSrc)}" alt="${escHtml(user.displayName)}">`
    : `<span class="profile-avatar-fallback">${escHtml((user?.displayName || '?').charAt(0).toUpperCase())}</span>`;

  const id = user?.id || '';
  const created = id ? createdAtFromId(id) : null;

  overlay.innerHTML = `
    <div class="modal-content profile-modal" role="dialog" aria-modal="true" aria-label="User profile">
      <button type="button" class="profile-close" id="profileClose" aria-label="Close">×</button>
      <div class="profile-avatar">${avatarImg}</div>
      <div class="profile-body">
        <h2 class="profile-display">${escHtml(user?.displayName || 'Not connected')}</h2>
        <div class="profile-subtitle">
          <span class="profile-username">${user ? '@' + escHtml(user.username) : ''}</span>
          ${id ? `<span class="profile-sep">•</span><button type="button" class="id-badge" id="profileCopyId">ID</button>` : ''}
        </div>
        ${created ? `<div class="profile-info-row"><span>Membre depuis</span><span class="profile-member-since">${created.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}</span></div>` : ''}
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const close = () => {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('#profileClose').addEventListener('click', close);

  const copyBtn = overlay.querySelector('#profileCopyId');
  if (copyBtn) copyBtn.addEventListener('click', () => {
    copyToClipboard(id);
    copyBtn.textContent = 'Copié';
    setTimeout(() => { copyBtn.textContent = 'ID'; }, 1500);
  });

  return overlay;
}
