import { importDiscordPackage, getSelectedPackageMessageKeys } from '../services/packageImporter.service.js';
import { confirmAction, showNotification } from '../utils/ui.js';
import { escHtml } from '../utils/emojiUtils.js';
import { buildMessageSearchIndex, hydratePackageIdentity } from '../services/packageData.service.js';
import { createPackageArchiveId, deletePackageArchive, listPackageArchives, savePackageArchive } from '../services/packageStorage.service.js';

const MAX_FILE_BYTES = 8 * 1024 * 1024 * 1024;

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = -1;
  do { value /= 1024; unit += 1; } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'calcul en cours';
  if (seconds < 60) return `~${Math.ceil(seconds)} s restantes`;
  return `~${Math.floor(seconds / 60)} min ${Math.ceil(seconds % 60)} s restantes`;
}

function avatarFor(channel) {
  return channel.avatar || channel.recipient?.avatar || 'https://cdn.discordapp.com/embed/avatars/0.png';
}

function displayChannelName(channel) {
  const raw = channel.name || channel.recipient?.username || channel.guildName || '';
  const cleaned = String(raw).replace(/^direct message with\s*/i, '').replace(/^dm with\s*/i, '').replace(/^unknown channel(?: in .*)?$/i, '').trim();
  return cleaned ? (channel.type === 'DM' ? `@${cleaned.replace(/^@/, '')}` : channel.type === 'SERVER_TEXT' ? `#${cleaned.replace(/^#/, '')}` : cleaned) : (channel.type === 'DM' ? '@Utilisateur inconnu' : `Salon ${channel.id}`);
}

function isZip(file) {
  return file?.name?.toLowerCase().endsWith('.zip');
}

export class PackageManager {
  constructor(contentArea) {
    this.contentArea = contentArea;
    this.package = null;
    this.queue = [];
    this.selectedChannelId = null;
    this.selectedMessages = new Set();
    this.isDeleting = false;
    this.deleteProgress = null;
    this.isDragging = false;
    this.savedArchives = [];
    this.storageReady = false;
    this.messagePageSize = 100;
    this.messagePageOffset = 0;
    this.channelQuery = '';
    this.filterTimer = null;
    this.messageQuery = '';
    this.focusMode = false;
    this.messageSearchIndex = new Map();
    this.lastMessageKey = null;
    this.pausedImports = false;
    this.restoreArchives();
    contentArea.addEventListener('click', event => this.handleClick(event));
    contentArea.addEventListener('change', event => this.handleChange(event));
    contentArea.addEventListener('input', event => { this.handleMessageSearch(event); this.handleFilter(event); });
    contentArea.addEventListener('dragenter', event => this.handleDragEnter(event));
    contentArea.addEventListener('dragover', event => this.handleDragOver(event));
    contentArea.addEventListener('dragleave', event => this.handleDragLeave(event));
    contentArea.addEventListener('drop', event => this.handleDrop(event));
    this.render();
  }

  async restoreArchives() {
    try {
      this.savedArchives = await listPackageArchives();
      this.storageReady = true;
      if (!this.package) this.render();
    } catch (error) {
      this.storageReady = false;
      console.warn('Package archive persistence unavailable:', error);
    }
  }

  render() {
    if (!this.package) {
      this.contentArea.innerHTML = `
        <section class="package-import-shell" data-dropzone>
          <div class="package-empty package-dropzone${this.isDragging ? ' is-dragover' : ''}">
            <div class="package-drop-icon">📦</div>
            <h2 data-drop-copy>${this.isDragging ? 'Relâchez le fichier ZIP' : 'Importer un Discord Data Package'}</h2>
            <p class="text-muted" data-drop-description>${this.isDragging ? 'Importation automatique de l’export Discord' : 'Glissez-déposez votre export Discord ou sélectionnez-le ci-dessous.'}</p>
            <label class="btn btn-primary package-picker-label">Choisir un fichier ZIP<input id="packageFileInput" type="file" accept=".zip,application/zip" multiple hidden></label>
            <div class="package-drop-hint">.ZIP uniquement · traitement local 100 % · aucune donnée envoyée</div>
          </div>
          <div class="package-queue" data-queue>${this.renderQueue()}</div>
          ${this.renderSavedArchives()}
        </section>`;
      return;
    }

    const channels = this.package.channels;
    if (this.selectedChannelId && !this.messageSearchIndex.has(this.selectedChannelId)) this.messageSearchIndex.set(this.selectedChannelId, buildMessageSearchIndex(this.package.messages.get(this.selectedChannelId) || []));
    const selectionState = channel => { const list = this.package.messages.get(channel.id) || []; let selected = 0; for (const message of list) if (this.selectedMessages.has(`${channel.id}:${message.id}`)) selected += 1; return selected === 0 ? 'none' : selected === list.length ? 'all' : 'partial'; };
    const query = this.channelQuery.trim().toLowerCase();
    const visibleChannels = query ? channels.filter(channel => `${channel.name || ''} ${channel.guildName || ''} ${channel.type} ${channel.id}`.toLowerCase().includes(query)) : channels;
    const selectedChannel = channels.find(channel => channel.id === this.selectedChannelId);
    this.contentArea.innerHTML = `
      <div class="list-toolbar package-toolbar">
        <div><h2 class="page-title"><span class="package-title-icon">📦</span> Data Package <span class="list-count">${channels.length}</span></h2><p class="text-muted">${escHtml(this.package.user.username)} · ${this.package.totalMessages} messages</p></div>
        <div class="toolbar-actions"><button class="btn btn-danger" data-package-action="delete" ${this.selectedMessages.size && !this.isDeleting ? '' : 'disabled'}>🗑️ ${this.isDeleting ? `Suppression ${this.deleteProgress?.done || 0}/${this.deleteProgress?.total || 0}` : `Supprimer (${this.selectedMessages.size})`}</button><button class="btn btn-secondary" data-package-action="focus">${this.focusMode ? 'Quitter focus' : 'Mode focus'}</button><button class="btn btn-secondary" data-package-action="export" data-export-format="json">Exporter JSON</button><button class="btn btn-secondary" data-package-action="close">Fermer</button></div>
      </div>
      <div class="package-layout"><aside class="package-channels card"><input class="package-filter" data-package-filter value="${escHtml(this.channelQuery)}" placeholder="Filtrer salons, serveurs ou DMs..." aria-label="Filtrer les salons"><div class="package-channel-list">${visibleChannels.length ? visibleChannels.map(channel => { const state = selectionState(channel); return `<button class="package-channel${channel.id === this.selectedChannelId ? ' active' : ''}" data-channel-id="${escHtml(channel.id)}"><span class="package-selection-state ${state}" title="${state === 'all' ? 'Sélection complète' : state === 'partial' ? 'Sélection partielle' : 'Aucune sélection'}" aria-label="${state === 'all' ? 'Sélection complète' : state === 'partial' ? 'Sélection partielle' : 'Aucune sélection'}"></span><img class="package-channel-avatar" src="${escHtml(avatarFor(channel))}" alt="" data-hide-on-error><span class="package-channel-copy"><strong>${escHtml(displayChannelName(channel))}</strong><small>${channel.type === 'DM' ? 'Message direct' : channel.type === 'GROUP' ? 'Groupe' : escHtml(channel.guildName || 'Serveur')}${channel.isLeft ? ' · quitté' : ''}</small></span><b>${channel.messagesCount}</b></button>`; }).join('') : '<div class="package-placeholder text-muted">Aucun salon trouvé.</div>'}</div></aside><section class="package-messages card">${selectedChannel ? this.renderMessages(selectedChannel) : '<div class="package-placeholder text-muted">Sélectionnez un salon pour consulter ses messages.</div>'}</section></div>`;
  }

  renderSavedArchives() {
    if (!this.savedArchives.length) return '';
    return `<section class="package-saved card"><div class="package-saved-header"><h3>Archives locales</h3><span class="text-muted">${this.savedArchives.length}</span></div><div class="package-saved-list">${this.savedArchives.map(archive => `<div class="package-saved-item"><button class="package-saved-open" data-archive-id="${escHtml(archive.id)}"><strong>${escHtml(archive.metadata.name || 'Package importé')}</strong><small>${formatBytes(archive.metadata.size || archive.packageData.packageSizeBytes || 0)} · ${new Date(archive.savedAt).toLocaleString()}</small></button><button class="btn btn-secondary btn-xs" data-delete-archive="${escHtml(archive.id)}" aria-label="Supprimer l’archive locale">Supprimer</button></div>`).join('')}</div></section>`;
  }

  renderQueue() {
    if (!this.queue.length) return '';
    return this.queue.map((item, index) => `<div class="package-queue-item ${item.status}" data-queue-index="${index}"><div class="package-queue-main"><span class="package-queue-number">${index + 1}.</span><span class="package-file-icon">📄</span><strong title="${escHtml(item.file.name)}">${escHtml(item.file.name)}</strong><span class="package-file-size">${formatBytes(item.file.size)}</span></div><div class="package-queue-progress"><div class="package-progress-track"><span style="width:${item.percent || 0}%"></span></div><strong>${Math.round(item.percent || 0)} %</strong><span class="package-queue-status">${escHtml(item.statusText || 'En attente')}</span>${item.status === 'error' ? `<button class="btn btn-secondary btn-xs" data-retry-index="${index}">🔄 Réessayer</button>` : ''}</div></div>`).join('');
  }

  renderMessages(channel) {
    const allMessages = this.package.messages.get(channel.id) || [];
    const selectedCount = allMessages.reduce((count, message) => count + (this.selectedMessages.has(`${channel.id}:${message.id}`) ? 1 : 0), 0);
    const start = this.messagePageOffset;
    const query = this.messageQuery.trim().toLowerCase();
    const sourceMessages = query ? allMessages.filter(message => `${message.content || ''} ${message.id}`.toLowerCase().includes(query)) : allMessages;
    const messages = sourceMessages.slice(start, start + this.messagePageSize);
    const end = Math.min(sourceMessages.length, start + this.messagePageSize);
    return `<div class="package-message-header"><div><div class="package-conversation-title"><img class="package-message-avatar" src="${escHtml(avatarFor(channel))}" alt="" data-hide-on-error><h3>${escHtml(displayChannelName(channel))}</h3></div><span class="text-muted">${start + 1}-${end} / ${allMessages.length} messages${channel.isLeft ? ' · serveur quitté' : ''}</span></div><div class="package-message-actions"><input class="package-message-search" data-message-search value="${escHtml(this.messageQuery)}" placeholder="Rechercher dans le salon..." aria-label="Rechercher dans les messages"><label><input type="checkbox" data-select-page ${selectedCount === messages.length && messages.length ? 'checked' : ''}> Tout sélectionner</label></div></div><div class="package-message-list">${messages.map(message => { const key = `${channel.id}:${message.id}`; return `<article class="package-message${this.selectedMessages.has(key) ? ' selected' : ''}"><label class="package-message-select"><input type="checkbox" data-message-key="${escHtml(key)}" data-message-index="${start + messages.indexOf(message)}" ${this.selectedMessages.has(key) ? 'checked' : ''}><span></span></label><div><div class="package-message-meta"><img class="package-message-avatar small" src="${escHtml(this.package.user.avatar || 'https://cdn.discordapp.com/embed/avatars/0.png')}" alt="" data-hide-on-error><strong>${escHtml(this.package.user.username)}</strong><time>${escHtml(message.timestamp)}</time></div><p>${escHtml(message.content) || '<span class="text-muted">(message sans contenu)</span>'}</p>${message.attachments.length ? `<div class="package-attachments">${message.attachments.map(attachment => `<a href="${escHtml(attachment.url)}" target="_blank" rel="noreferrer">📎 ${escHtml(attachment.fileName)}</a>`).join('')}</div>` : ''}</div></article>`; }).join('')}</div><div class="package-pagination">${start > 0 ? '<button class="btn btn-secondary btn-xs" data-package-page="prev">← Précédent</button>' : ''}${end < sourceMessages.length ? '<button class="btn btn-secondary btn-xs" data-package-page="next">Suivant →</button>' : ''}</div>`;
  }

  addFiles(files) {
    const candidates = [...files];
    candidates.forEach(file => {
      const item = { file, status: isZip(file) && file.size <= MAX_FILE_BYTES ? 'queued' : 'error', statusText: isZip(file) ? file.size <= MAX_FILE_BYTES ? 'En attente' : 'Fichier trop volumineux' : 'ZIP requis', percent: 0, startedAt: 0 };
      if (!this.queue.some(existing => existing.file.name === file.name && existing.file.size === file.size)) this.queue.push(item);
    });
    this.render();
    this.queue.filter(item => item.status === 'queued').forEach(item => this.importQueueItem(item));
  }

  async importQueueItem(item) {
    item.status = 'processing'; item.statusText = 'Lecture locale de l’archive'; item.startedAt = Date.now(); item.percent = 0; this.render();
    try {
      const parsed = await importDiscordPackage(item.file, info => {
        const current = Number(info.current || 0); const total = Math.max(1, Number(info.total || 1));
        item.percent = Math.min(100, current / total * 100);
        const elapsed = (Date.now() - item.startedAt) / 1000;
        const rate = current / Math.max(elapsed, 0.001);
        item.statusText = `${escHtml(info.stage || 'Analyse des salons')} · ${formatEta((total - current) / Math.max(rate, 0.001))}`;
        this.render();
      });
      item.status = 'success'; item.percent = 100; item.statusText = 'OK';
      const archiveId = createPackageArchiveId(item.file);
      try {
        await savePackageArchive(archiveId, parsed, { name: item.file.name, size: item.file.size, type: item.file.type, lastModified: item.file.lastModified });
        this.savedArchives = (await listPackageArchives());
      } catch (storageError) {
        console.warn('Unable to persist package archive:', storageError);
      }
      if (!this.package) { this.package = parsed; this.selectedChannelId = parsed.channels[0]?.id || null; }
      this.render();
    } catch (error) {
      item.status = 'error'; item.statusText = error.message || 'Erreur de lecture'; item.percent = Math.max(0, item.percent); this.render();
    }
  }

  handleDragEnter(event) { event.preventDefault(); this.isDragging = true; this.render(); }
  handleDragOver(event) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; if (!this.isDragging) { this.isDragging = true; this.render(); } }
  handleDragLeave(event) { if (event.target === this.contentArea || !this.contentArea.contains(event.relatedTarget)) { this.isDragging = false; this.render(); } }
  handleDrop(event) { event.preventDefault(); this.isDragging = false; this.addFiles(event.dataTransfer.files); }

  async handleClick(event) {
    const retry = event.target.closest('[data-retry-index]');
    if (retry) { const item = this.queue[Number(retry.dataset.retryIndex)]; if (item) { item.status = 'queued'; item.statusText = 'Nouvel essai'; this.render(); this.importQueueItem(item); } return; }
    const openArchive = event.target.closest('[data-archive-id]');
    if (openArchive) {
      const archive = this.savedArchives.find(item => item.id === openArchive.dataset.archiveId);
      if (archive) { this.package = archive.packageData; this.selectedChannelId = this.package.channels[0]?.id || null; this.selectedMessages.clear(); this.render(); }
      return;
    }
    const deleteArchive = event.target.closest('[data-delete-archive]');
    if (deleteArchive) {
      await deletePackageArchive(deleteArchive.dataset.deleteArchive);
      this.savedArchives = this.savedArchives.filter(item => item.id !== deleteArchive.dataset.deleteArchive);
      this.render();
      return;
    }
    const pageButton = event.target.closest('[data-package-page]');
    if (pageButton) {
      this.messagePageOffset = Math.max(0, this.messagePageOffset + (pageButton.dataset.packagePage === 'next' ? this.messagePageSize : -this.messagePageSize));
      this.render();
      return;
    }
    const channel = event.target.closest('[data-channel-id]');
    if (channel) {
      const sidebar = this.contentArea.querySelector('.package-channel-list');
      const scrollTop = sidebar?.scrollTop || 0;
      const messageScroller = this.contentArea.querySelector('.package-message-list');
      const messageScrollTop = messageScroller?.scrollTop || 0;
      this.selectedChannelId = channel.dataset.channelId;
      this.messagePageOffset = 0;
      this.render();
      const nextSidebar = this.contentArea.querySelector('.package-channel-list');
      if (nextSidebar) nextSidebar.scrollTop = scrollTop;
      const nextMessageScroller = this.contentArea.querySelector('.package-message-list');
      if (nextMessageScroller) nextMessageScroller.scrollTop = messageScrollTop;
      return;
    }
    const action = event.target.closest('[data-package-action]')?.dataset.packageAction;
    if (action === 'focus') { this.focusMode = !this.focusMode; this.contentArea.classList.toggle('package-focus-mode', this.focusMode); this.render(); return; }
    if (action === 'export') { this.exportPackage(event.target.dataset.exportFormat || 'json'); return; }
    if (action === 'close') { this.package = null; this.selectedChannelId = null; this.selectedMessages.clear(); this.render(); }
    if (action === 'delete') this.deleteSelectedMessages();
  }

  handleChange(event) {
    if (event.target.id === 'packageFileInput') this.addFiles(event.target.files);
    if (event.target.matches('[data-select-page]') && this.selectedChannelId) {
      const messages = this.package.messages.get(this.selectedChannelId) || [];
      const page = messages.slice(this.messagePageOffset, this.messagePageOffset + this.messagePageSize);
      page.forEach(message => {
        const key = `${this.selectedChannelId}:${message.id}`;
        if (event.target.checked) this.selectedMessages.add(key); else this.selectedMessages.delete(key);
      });
      this.render();
      return;
    }
    const checkbox = event.target.closest('[data-message-key]');
    if (checkbox) {
      const key = checkbox.dataset.messageKey;
      if (event.shiftKey && this.lastMessageKey && typeof CSS !== 'undefined' && CSS.escape) {
        const previous = this.contentArea.querySelector(`[data-message-key="${CSS.escape(this.lastMessageKey)}"]`);
        const currentIndex = Number(checkbox.dataset.messageIndex);
        const previousIndex = Number(previous?.dataset.messageIndex);
        const messages = this.package.messages.get(this.selectedChannelId) || [];
        if (Number.isFinite(previousIndex)) for (let index = Math.min(previousIndex, currentIndex); index <= Math.max(previousIndex, currentIndex); index += 1) this.selectedMessages.add(`${this.selectedChannelId}:${messages[index]?.id}`);
      } else if (checkbox.checked) this.selectedMessages.add(key); else this.selectedMessages.delete(key);
      this.lastMessageKey = key;
      this.render();
    }
  }

  handleMessageSearch(event) {
    if (!event.target.matches('[data-message-search]')) return;
    this.messageQuery = event.target.value;
    this.messagePageOffset = 0;
    clearTimeout(this.filterTimer);
    this.filterTimer = setTimeout(() => this.render(), 80);
  }

  handleFilter(event) {
    if (!event.target.matches('[data-package-filter]')) return;
    this.channelQuery = event.target.value;
    clearTimeout(this.filterTimer);
    this.filterTimer = setTimeout(() => {
      const input = this.contentArea.querySelector('[data-package-filter]');
      const position = input?.selectionStart;
      this.render();
      const nextInput = this.contentArea.querySelector('[data-package-filter]');
      if (nextInput) { nextInput.focus(); nextInput.setSelectionRange(position ?? nextInput.value.length, position ?? nextInput.value.length); }
    }, 80);
  }

  exportPackage(format) {
    if (!this.package) return;
    const rows = [...this.package.messages.entries()].flatMap(([channelId, messages]) => messages.map(message => ({ channelId, ...message })));
    const payload = format === 'json' ? JSON.stringify({ user: this.package.user, channels: this.package.channels, messages: rows }, null, 2) : rows.map(row => `${row.channelId}\t${row.id}\t${row.timestamp}\t${String(row.content || '').replace(/\n/g, ' ')}`).join('\n');
    const blob = new Blob([payload], { type: format === 'json' ? 'application/json' : 'text/plain' });
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `discord-package.${format === 'json' ? 'json' : 'txt'}`; link.click(); URL.revokeObjectURL(link.href);
  }

  async deleteSelectedMessages() {
    if (this.isDeleting || !this.selectedMessages.size) return;
    const targets = getSelectedPackageMessageKeys(this.selectedMessages);
    if (!targets.length || !(await confirmAction('Supprimer les messages', `Supprimer ${targets.length} message(s) sélectionné(s) ? Cette action est irréversible.`))) return;
    this.isDeleting = true; this.deleteProgress = { done: 0, total: targets.length }; let deleted = 0; let failed = 0;
    try {
      for (let offset = 0; offset < targets.length; offset += 10) {
        const batch = targets.slice(offset, offset + 10);
        for (const target of batch) {
          try {
            let result;
            for (let attempt = 0; attempt < 3; attempt += 1) {
              result = await window.electronAPI.deletePackageMessage(target.channelId, target.messageId);
              if (result?.success || result?.error === 'not found' || result?.error !== 'Rate limited') break;
              await new Promise(resolve => setTimeout(resolve, ((result.retryAfter || 5) * 1000) + 500));
            }
            if (result?.success || result?.error === 'not found') { deleted += 1; this.selectedMessages.delete(`${target.channelId}:${target.messageId}`); }
            else failed += 1;
            this.deleteProgress.done += 1;
          } catch (error) { failed += 1; console.warn('Package message deletion failed:', error); }
        }
        this.render();
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      showNotification(`${deleted} supprimé(s)${failed ? ` · ${failed} échec(s)` : ''}`);
    } finally { this.isDeleting = false; this.deleteProgress = null; this.render(); }
  }
}
