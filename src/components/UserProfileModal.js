import { escHtml } from '../utils/emojiUtils.js';
import { copyToClipboard } from '../utils/clipboard.js';
import { getLanguage } from '../i18n/index.js';

function createdAtFromId(id) {
  try {
    const ts = Number((BigInt(id) >> 22n) + 1420070400000n);
    return new Date(ts);
  } catch {
    return null;
  }
}

// Date lisible dans la langue active. Exportée : le formatage est ainsi
// vérifié sans monter la modale ni dépendre du DOM.
export function formatMemberSince(id, language = 'fr') {
  const created = id ? createdAtFromId(id) : null;
  if (!created) return '—';
  return created.toLocaleDateString(language === 'en' ? 'en-US' : 'fr-FR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
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
  const memberSince = formatMemberSince(id, getLanguage());

  overlay.innerHTML = `
    <div class="modal-content profile-modal" role="dialog" aria-modal="true" aria-label="Profil utilisateur">
      <button type="button" class="profile-close" id="profileClose" title="Fermer" aria-label="Fermer">
        <svg class="profile-close-icon" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
          <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
        </svg>
      </button>
      <div class="profile-hero">
        <div class="profile-avatar">${avatarImg}</div>
        <div class="profile-identity">
          <h2 class="profile-display">${escHtml(user?.displayName || 'Non connecté')}</h2>
          <div class="profile-subtitle">
            <span class="profile-username">${user ? '@' + escHtml(user.username) : ''}</span>
            ${id ? `<span class="profile-sep">•</span><button type="button" class="id-badge" id="profileCopyId" title="Copier l'ID" aria-label="Copier l'ID">ID</button>` : ''}
          </div>
        </div>
      </div>
      <div class="profile-meta">
        <span class="profile-meta-label">Membre depuis</span>
        <span class="profile-meta-value">${escHtml(memberSince)}</span>
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
