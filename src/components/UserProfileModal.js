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

// Modale de profil : fiche lisible, avatar mis en avant, ID copiable.
// L'ID n'est jamais affiché en clair ; le badge [ID] le copie au clic.
// Clôture : croix, bouton Fermer, Échap, clic extérieur.
export function showUserProfileModal(user) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay profile-overlay';

  const avatarSrc = user?.avatar ? `${user.avatar}?size=4096` : null;
  const avatarImg = avatarSrc
    ? `<img src="${escHtml(avatarSrc)}" alt="${escHtml(user.displayName)}">`
    : `<span class="profile-avatar-fallback">${escHtml((user?.displayName || '?').charAt(0).toUpperCase())}</span>`;

  const id = user?.id || '';
  const created = id ? createdAtFromId(id) : null;
  const memberSince = created
    ? created.toLocaleDateString('fr-FR', { year: 'numeric', month: 'long', day: 'numeric' })
    : '—';

  overlay.innerHTML = `
    <div class="modal-content profile-modal" role="dialog" aria-modal="true" aria-label="Profil utilisateur">
      <div class="profile-banner" aria-hidden="true"></div>
      <button type="button" class="profile-close" id="profileClose" aria-label="Fermer">×</button>
      <div class="profile-avatar">${avatarImg}</div>
      <div class="profile-body">
        <div class="profile-heading">
          <span class="profile-status"><span class="profile-status-dot"></span>${user ? 'Connecté' : 'Non connecté'}</span>
          <h2 class="profile-display">${escHtml(user?.displayName || 'Non connecté')}</h2>
          <div class="profile-subtitle">
            <span class="profile-username">${user ? '@' + escHtml(user.username) : ''}</span>
            ${id ? `<span class="profile-sep">•</span><button type="button" class="id-badge" id="profileCopyId" title="Copier l’ID">ID</button>` : ''}
          </div>
          ${id ? '<p class="profile-hint">Clique sur ID pour copier l’identifiant.</p>' : ''}
        </div>
        <div class="profile-details">
          <div class="profile-detail">
            <span class="profile-detail-label">Membre depuis</span>
            <span class="profile-detail-value">${escHtml(memberSince)}</span>
          </div>
          <div class="profile-detail">
            <span class="profile-detail-label">Type de compte</span>
            <span class="profile-detail-value">Compte Discord</span>
          </div>
        </div>
        <button type="button" class="btn btn-secondary profile-close-btn" id="profileCloseBtn">Fermer</button>
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
  overlay.querySelector('#profileCloseBtn').addEventListener('click', close);

  const copyBtn = overlay.querySelector('#profileCopyId');
  if (copyBtn) copyBtn.addEventListener('click', () => {
    copyToClipboard(id);
    copyBtn.textContent = 'Copié';
    setTimeout(() => { copyBtn.textContent = 'ID'; }, 1500);
  });

  return overlay;
}
