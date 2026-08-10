export { copyToClipboard, showNotification } from './clipboard.js';

export const confirmAction = (title, message, confirmLabel = 'Confirm') => new Promise(resolve => {
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
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => { resolve(false); modal.remove(); });

  buttonGroup.appendChild(okBtn);
  buttonGroup.appendChild(cancelBtn);

  content.appendChild(titleEl);
  content.appendChild(messageEl);
  content.appendChild(buttonGroup);
  modal.appendChild(content);

  document.body.appendChild(modal);
  okBtn.focus();
});

export const showProgressModal = (title, total) => {
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
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';

  const content = document.createElement('div');
  content.className = 'modal-content info-modal';

  const icon = document.createElement('div');
  icon.className = 'modal-icon';
  icon.innerHTML = '<svg width="26" height="26" fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>';

  const title = document.createElement('h2');
  title.textContent = 'Discord Account Manager';

  let versionText = '';
  try {
    versionText = await window.electronAPI.getAppVersion();
  } catch { /* fallback below */ }

  const badge = document.createElement('span');
  badge.className = 'version-badge';
  badge.textContent = `Version ${versionText || '1.5.6'}`;

  const author = document.createElement('p');
  author.className = 'info-author';
  author.textContent = 'Created by Bherl1';

  const links = document.createElement('div');
  links.className = 'info-links';

  const githubLink = document.createElement('a');
  githubLink.href = 'https://github.com/Bherl1/DiscordAccMgr';
  githubLink.textContent = 'GitHub Repository';
  githubLink.addEventListener('click', (e) => {
    e.preventDefault();
    window.electronAPI.openExternal(githubLink.href);
  });
  links.appendChild(githubLink);

  const divider = document.createElement('div');
  divider.className = 'info-divider';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn btn-secondary';
  closeBtn.textContent = 'Close';

  const close = () => {
    document.removeEventListener('keydown', escHandler);
    modal.remove();
  };
  const escHandler = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', escHandler);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  closeBtn.addEventListener('click', close);

  content.appendChild(icon);
  content.appendChild(title);
  content.appendChild(badge);
  content.appendChild(author);
  content.appendChild(links);
  content.appendChild(divider);
  content.appendChild(closeBtn);
  modal.appendChild(content);

  document.body.appendChild(modal);
  closeBtn.focus();
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
    input.placeholder = 'e.g. Main Account, Alt-1...';

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
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', () => {
      const value = input.value.trim();
      if (value) close(value);
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-secondary';
    cancelBtn.textContent = 'Cancel';
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
