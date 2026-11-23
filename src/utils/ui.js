export { copyToClipboard, showNotification } from './clipboard.js';
import { escHtml } from './emojiUtils.js';
import { techStackHtml } from './techStack.js';

export const confirmAction = (title, message, confirmLabel = 'Confirmer') => new Promise(resolve => {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';

  const content = document.createElement('div');
  content.className = 'modal-content';

  const titleEl = document.createElement('h2');
  titleEl.textContent = title;

  const messageEl = document.createElement('p');
  messageEl.textContent = message;

  const buttonGroup = document.createElement('div');
  buttonGroup.className = 'button-group';

  const okBtn = document.createElement('button');
  okBtn.className = 'btn btn-danger';
  okBtn.textContent = confirmLabel;
  okBtn.addEventListener('click', () => { resolve(true); modal.remove(); });

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-secondary';
  cancelBtn.textContent = 'Annuler';
  cancelBtn.addEventListener('click', () => { resolve(false); modal.remove(); });

  buttonGroup.appendChild(okBtn);
  buttonGroup.appendChild(cancelBtn);

  content.appendChild(titleEl);
  content.appendChild(messageEl);
  content.appendChild(buttonGroup);
  modal.appendChild(content);

  document.body.appendChild(modal);
  cancelBtn.focus();
});

// Modale de progression. `options.onCancel` est OPTIONNEL : fourni, il rend un
// bouton « Annuler » qui appelle le rappel puis se desactive (pour qu'un second
// clic ne le rappelle pas). Sans lui, la modale reste celle d'avant — les
// appelants existants passent deux arguments.
export const showProgressModal = (title, total, options = {}) => {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';

  const content = document.createElement('div');
  content.className = 'modal-content';

  const titleEl = document.createElement('h2');
  titleEl.textContent = title;

  const progressContainer = document.createElement('div');
  progressContainer.className = 'progress-container';

  const progressBar = document.createElement('div');
  progressBar.className = 'progress-track';

  const progress = document.createElement('div');
  progress.className = 'progress-fill';
  progress.style.width = '0%';

  const progressText = document.createElement('div');
  progressText.className = 'progress-text';
  progressText.textContent = `0/${total}`;

  progressBar.appendChild(progress);
  progressContainer.appendChild(progressBar);
  progressContainer.appendChild(progressText);

  content.appendChild(titleEl);
  content.appendChild(progressContainer);

  if (typeof options.onCancel === 'function') {
    const buttonGroup = document.createElement('div');
    buttonGroup.className = 'button-group';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-secondary';
    cancelBtn.textContent = 'Annuler';
    cancelBtn.addEventListener('click', () => {
      if (cancelBtn.disabled) return;
      cancelBtn.disabled = true;
      options.onCancel();
    });

    buttonGroup.appendChild(cancelBtn);
    content.appendChild(buttonGroup);
  }

  modal.appendChild(content);

  document.body.appendChild(modal);

  return {
    updateProgress: (completed) => {
      const percent = (completed / total) * 100;
      progress.style.width = `${percent}%`;
      progressText.textContent = `${completed}/${total}`;
    },
    closeModal: () => modal.remove()
  };
};

export const showInfoModal = async () => {
  // Liens des depots. Original : Bherl1. Fork : KataV8.
  const ORIGINAL_REPO_URL = 'https://github.com/Bherl1/DiscordAccMgr';
  const FORK_REPO_URL = 'https://github.com/K4taV8/DiscordAccMgr-Enhanced';

  const modal = document.createElement('div');
  modal.className = 'modal-overlay';

  const content = document.createElement('div');
  content.className = 'modal-content info-modal';

  let versionText = '';
  try {
    versionText = await window.electronAPI.getAppVersion();
  } catch { /* fallback below */ }

  // Carte auteur : avatar rond (repli initiales si l image manque) + nom + role.
  const authorCard = (name, role, initial, img, url) => {
    const inner = `<span class="info-avatar"><span class="info-avatar-fallback" aria-hidden="true">${initial}</span><img src="${img}" alt="" loading="lazy" data-hide-on-error></span>
        <span class="info-author-copy"><strong>${name}</strong><small>${role}</small></span>`;
    return url
      ? `<a class="info-author-card" href="#" data-url="${url}">${inner}</a>`
      : `<div class="info-author-card info-author-card-static">${inner}</div>`;
  };

  const repoLink = (url, label) => `<a href="#" data-url="${url}"><svg class="info-link-icon" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M4 2h6v6M10 2L2 10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg><span>${label}</span></a>`;
  const forkLink = FORK_REPO_URL ? repoLink(FORK_REPO_URL, 'Dépôt (fork)') : '';

  content.innerHTML = `
    <div class="info-head">
      <div class="modal-icon"><img class="modal-logo" src="assets/logo.png" alt="" loading="lazy"></div>
      <div class="info-head-copy">
        <h2>Discord Account Manager - Enhanced</h2>
        <span class="version-badge">Version ${escHtml(versionText || '1.5.6')}</span>
      </div>
    </div>
    <p class="info-description">Application de bureau pour gérer son propre compte Discord : nettoyage, serveurs, MP, groupes, archives et médias. Basé sur Discord Account Manager, créé par Bherl1.</p>
    <div class="info-left">
      <div class="info-authors">
        ${authorCard('KataV8', 'Développement & enrichissement (fork)', 'K', 'assets/kataV8.jpg', FORK_REPO_URL)}
        ${authorCard('Bherl1', 'Auteur original', 'B', 'assets/bherl1.jpg', ORIGINAL_REPO_URL)}
      </div>
      <div class="info-footer">
        <div class="info-links">
          ${forkLink}
          ${repoLink(ORIGINAL_REPO_URL, 'Dépôt original')}
        </div>
        <p class="info-license">Licence MIT · © 2024 Bherl1</p>
        <div class="info-divider"></div>
        <button type="button" class="btn btn-secondary info-close-btn" id="infoCloseBtn"><svg class="info-close-icon" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg><span>Fermer</span></button>
      </div>
    </div>
    <div class="info-section">
      <h3>Technologies</h3>
      ${techStackHtml()}
    </div>
  `;

  const close = () => {
    document.removeEventListener('keydown', escHandler);
    modal.remove();
  };
  const escHandler = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', escHandler);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  content.addEventListener('click', (e) => {
    const link = e.target.closest('a[data-url]');
    if (link) { e.preventDefault(); window.electronAPI.openExternal(link.dataset.url); }
  });
  content.querySelector('#infoCloseBtn').addEventListener('click', close);

  modal.appendChild(content);
  document.body.appendChild(modal);
  content.querySelector('#infoCloseBtn').focus();
};

export const showInputModal = (title, message) => {
  return new Promise((resolve) => {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';

    const content = document.createElement('div');
    content.className = 'modal-content';

    const icon = document.createElement('div');
    icon.className = 'modal-icon';
    icon.innerHTML = '<svg width="26" height="26" fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M8 21c2.76 0 5-2.24 5-5 0-1.02-.31-1.96-.83-2.75l3.33-3.33 1.79 1.79 1.41-1.41-1.79-1.79L18 7.42l2.29 2.29L21.7 8.3l-2.29-2.29 1.29-1.29-1.41-1.41-8.54 8.54c-.79-.52-1.74-.83-2.75-.83-2.76 0-5 2.24-5 5s2.24 5 5 5Zm0-8c1.65 0 3 1.35 3 3s-1.35 3-3 3-3-1.35-3-3 1.35-3 3-3"></path></svg>';

    const titleEl = document.createElement('h2');
    titleEl.textContent = title;

    const messageEl = document.createElement('p');
    messageEl.textContent = message;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'modal-input';
    input.placeholder = 'ex. Compte principal, Alt-1...';

    const buttonGroup = document.createElement('div');
    buttonGroup.className = 'button-group';

    const close = (result) => {
      document.removeEventListener('keydown', escHandler);
      resolve(result);
      modal.remove();
    };
    const escHandler = (e) => {
      if (e.key === 'Escape') close(null);
    };
    document.addEventListener('keydown', escHandler);

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-primary';
    saveBtn.textContent = 'Enregistrer';
    saveBtn.addEventListener('click', () => {
      const value = input.value.trim();
      if (value) close(value);
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-secondary';
    cancelBtn.textContent = 'Annuler';
    cancelBtn.addEventListener('click', () => close(null));

    buttonGroup.appendChild(saveBtn);
    buttonGroup.appendChild(cancelBtn);

    content.appendChild(icon);
    content.appendChild(titleEl);
    content.appendChild(messageEl);
    content.appendChild(input);
    content.appendChild(buttonGroup);
    modal.appendChild(content);

    document.body.appendChild(modal);
    input.focus();
  });
};
