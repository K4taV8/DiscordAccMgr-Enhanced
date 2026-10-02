import { importDiscordPackage, getSelectedPackageMessageKeys, isPlaceholderName } from '../services/packageImporter.service.js';
import { exportDiscordPackage } from '../services/packageExporter.service.js';
import { classifyDeleteResult, shouldRetryDelete, summarizeDelete } from '../services/packageDelete.service.js';
import { confirmAction, showNotification } from '../utils/ui.js';
import { escHtml } from '../utils/emojiUtils.js';
import { buildMessageSearchIndex, hydratePackageIdentity, isSystemNotification } from '../services/packageData.service.js';
import { createPackageArchiveId, deletePackageArchive, listPackageArchives, savePackageArchive } from '../services/packageStorage.service.js';
import { groupChannels } from '../services/packageSections.service.js';
import { channelWindow, CHANNEL_ROW_HEIGHT, CHANNEL_OVERSCAN } from '../services/packageWindow.service.js';

const MAX_FILE_BYTES = 8 * 1024 * 1024 * 1024;

// Hauteur d'un en-tete de section : plus bas qu'une ligne de salon, d'ou la
// necessite de cumuler les hauteurs reelles plutot que de supposer 56 px.
const CHANNEL_HEADER_HEIGHT = 34;

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
    this.channelKindFilter = 'all';
    this.hideEmptyDms = false;
    this.hideSystemNotes = true;
    this.filterTimer = null;
    this.renderTimer = null;
    this.channelScrollTop = 0;
    this.channelViewport = 800;
    this.channelModel = null;
    this.channelFrame = null;
    this.channelPainted = -1;
    this.channelPaintedEnd = -1;
    this.channelSafeTop = 0;
    this.channelSafeBottom = 0;
    this.channelRefs = null;
    this.visibleChannels = [];
    this.channelRowHeight = CHANNEL_ROW_HEIGHT;
    this.channelHeaderHeight = CHANNEL_HEADER_HEIGHT;
    this.messageQuery = '';
    this.focusMode = false;
    this.messageSearchIndex = new Map();
    this.lastMessageKey = null;
    this.pausedImports = false;
    this.restoreArchives();
    contentArea.addEventListener('click', event => this.handleClick(event));
    contentArea.addEventListener('change', event => this.handleChange(event));
    contentArea.addEventListener('input', event => { this.handleMessageSearch(event); this.handleFilter(event); });
    contentArea.addEventListener('keydown', event => this.handleKeydown(event));
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

  // Un seul endroit applique le type de conversation, le masquage des MP sans
// aucun message et la recherche : l ordre compte. « Masquer les MP vides » ne
// concerne que les DM a zero message : un DM dont les seuls contenus sont des
// notifications systeme n est PAS vide et reste dans la liste.
filteredChannels() {
    const channels = this.package?.channels || [];
    const kind = this.channelKindFilter;
    const query = this.channelQuery.trim().toLowerCase();
    return channels.filter(channel => {
      if (kind !== 'all') {
        const family = channel.type === 'DM' ? 'dm' : channel.type === 'GROUP' ? 'group' : 'server';
        if (family !== kind) return false;
      }
      if (this.hideEmptyDms && channel.type === 'DM' && !channel.messagesCount) return false;
      if (query) {
        const haystack = `${channel.name || ''} ${channel.guildName || ''} ${channel.recipient?.username || ''} ${channel.type} ${channel.id}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
  }

  visibleMessages(channel) {
    const all = this.package.messages.get(channel.id) || [];
    if (!this.hideSystemNotes) return all;
    return all.filter(message => !isSystemNotification(message));
  }

  systemNotesHiddenCount(channel) {
    if (!this.hideSystemNotes) return 0;
    const all = this.package.messages.get(channel.id) || [];
    let count = 0;
    for (const message of all) if (isSystemNotification(message)) count += 1;
    return count;
  }

  renderChannelFilterBar() {
    const kindButton = kind => `<button type="button" class="package-filter-chip${this.channelKindFilter === kind ? ' is-active' : ''}" data-channel-filter="${kind}" aria-pressed="${this.channelKindFilter === kind}">${{ all: 'Tous', dm: 'MP', group: 'Groupes', server: 'Serveurs' }[kind]}</button>`;
    return `<div class="package-filter-bar">
          <div class="package-filter-group" role="group" aria-label="Type de conversation">${['all', 'dm', 'group', 'server'].map(kindButton).join('')}</div>
          <label class="package-filter-toggle"><input type="checkbox" data-hide-empty${this.hideEmptyDms ? ' checked' : ''}> MP vides</label>
          <label class="package-filter-toggle"><input type="checkbox" data-hide-system${this.hideSystemNotes ? ' checked' : ''}> Notifs système</label>
        </div>`;
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
    const visibleChannels = this.filteredChannels();
    const selectedChannel = channels.find(channel => channel.id === this.selectedChannelId);
    const channelListHtml = this.renderChannelListHtml(visibleChannels);
    const channelContext = this.currentSectionLabel();
    this.contentArea.innerHTML = `
      <div class="list-toolbar package-toolbar">
        <div><h2 class="page-title"><span class="package-title-icon">📦</span> Data Package <span class="list-count">${channels.length}</span></h2><p class="text-muted">${escHtml(this.package.user.username)} · ${this.package.totalMessages} messages</p></div>
        <div class="toolbar-actions"><button class="btn btn-danger" data-package-action="delete" ${this.selectedMessages.size && !this.isDeleting ? '' : 'disabled'}>🗑️ ${this.isDeleting ? `Suppression ${this.deleteProgress?.done || 0}/${this.deleteProgress?.total || 0}` : `Supprimer (${this.selectedMessages.size})`}</button><button class="btn btn-secondary" data-package-action="focus">${this.focusMode ? 'Quitter focus' : 'Mode focus'}</button><button class="btn btn-secondary" data-package-action="export" data-export-format="zip">Exporter ZIP</button><button class="btn btn-secondary" data-package-action="export" data-export-format="json">Exporter JSON</button><button class="btn btn-secondary" data-package-action="close">Fermer</button></div>
      </div>
      <div class="package-layout">
        <aside class="package-channels card">
          <input class="package-filter" data-package-filter value="${escHtml(this.channelQuery)}" placeholder="Filtrer salons, serveurs ou DMs..." aria-label="Filtrer les salons">
          ${this.renderChannelFilterBar()}
          <div class="package-channel-context" data-channel-context>${escHtml(channelContext)}</div>
          <div class="package-channel-list" data-channel-scroll>${channelListHtml}</div>
        </aside>
        <section class="package-messages card">${selectedChannel ? this.renderMessages(selectedChannel) : '<div class="package-placeholder text-muted">Sélectionnez un salon pour consulter ses messages.</div>'}</section>
      </div>`;
    this.attachChannelScroll();
  }

  // Les hauteurs mesurees doivent survivre a un changement de filtre ou de
  // selection : le modele est reconstruit a partir des memes canaux.
  currentVisibleChannels() {
    return this.visibleChannels || [];
  }

  channelSelectionState(channel) {
    const list = this.package.messages.get(channel.id) || [];
    let selected = 0;
    for (const message of list) if (this.selectedMessages.has(`${channel.id}:${message.id}`)) selected += 1;
    if (selected === 0) return 'none';
    return selected === list.length ? 'all' : 'partial';
  }

  channelSubtitle(channel) {
    const kind = channel.type === 'DM' ? 'Message direct' : channel.type === 'GROUP' ? 'Groupe' : channel.guildName || 'Serveur';
    return channel.isLeft ? `${kind} · quitté` : kind;
  }

  // Un <button> ne peut pas contenir un autre <button> : la ligne est un div
// role="button", d'ou le role du clavier assumé ici (entree ou espace).
channelRowHtml(channel) {
    const state = this.channelSelectionState(channel);
    const active = channel.id === this.selectedChannelId ? ' active' : '';
    const label = state === 'all' ? 'Sélection complète' : state === 'partial' ? 'Sélection partielle' : 'Aucune sélection';
    const name = displayChannelName(channel);
    const canOpen = channel.type === 'DM' && channel.recipient?.id;
    const openButton = canOpen
      ? `<button type="button" class="package-channel-open" data-open-dm="${escHtml(channel.recipient.id)}" data-open-dm-name="${escHtml(name)}" title="Ouvrir la conversation" aria-label="Ouvrir la conversation avec ${escHtml(name)}">↗</button>`
      : '';
    return `<div class="package-channel${active}" role="button" tabindex="0" data-channel-id="${escHtml(channel.id)}"><span class="package-selection-state ${state}" title="${label}" aria-label="${label}"></span><img class="package-channel-avatar" src="${escHtml(avatarFor(channel))}" alt="" data-hide-on-error><span class="package-channel-copy"><strong>${escHtml(name)}</strong><small>${escHtml(this.channelSubtitle(channel))}</small></span>${openButton}<b>${channel.messagesCount}</b></div>`;
  }

  // Aplatit les sections en une liste de lignes (en-tetes + salons) et cumule la
// hauteur reelle de chacune. channelWindow raisonne en lignes de hauteur
// uniforme : il fournit la tranche approximative (bornes + tampons), puis on
// corrige avec les offsets exacts, car un en-tete ne fait pas 56 px.
buildChannelModel(visibleChannels) {
    const rows = [];
    const offsets = [0];
    let height = 0;
    const rowHeight = this.channelRowHeight || CHANNEL_ROW_HEIGHT;
    const headerHeight = this.channelHeaderHeight || CHANNEL_HEADER_HEIGHT;
    for (const section of groupChannels(visibleChannels)) {
      rows.push({ type: 'header', section });
      height += headerHeight;
      offsets.push(height);
      for (const channel of section.channels) {
        rows.push({ type: 'channel', channel });
        height += rowHeight;
        offsets.push(height);
      }
    }
    return { rows, offsets, total: rows.length, height };
  }

  channelWindowSlice() {
    const model = this.channelModel;
    if (!model || !model.total) return { start: 0, end: 0, padTop: 0, padBottom: 0 };
    const scrollTop = Math.max(0, this.channelScrollTop);
    const viewport = Math.max(0, this.channelViewport);
    const rowHeight = this.channelRowHeight || CHANNEL_ROW_HEIGHT;
    const slice = channelWindow({ total: model.total, scrollTop, viewport, rowHeight, overscan: CHANNEL_OVERSCAN });
    // Un en-tete ne fait pas la hauteur d'une ligne : scrollTop / rowHeight
    // sous-estime donc l index de la premiere ligne visible. On recale sur les
    // hauteurs reelles.
    let start = slice.start;
    let end = slice.end;
    while (start < model.total - 1 && model.offsets[start] + rowHeight <= scrollTop) start += 1;
    while (start > 0 && model.offsets[start] > scrollTop) start -= 1;
    while (end < model.total && model.offsets[end] < scrollTop + viewport) end += 1;
    start = Math.max(0, Math.min(start, model.total));
    end = Math.max(start, Math.min(end, model.total));
    return { start, end, padTop: model.offsets[start], padBottom: Math.max(0, model.height - model.offsets[end]) };
  }

  channelSliceHtml() {
    const { start, end } = this.channelWindowSlice();
    return this.channelModel.rows.slice(start, end).map(row => row.type === 'header'
      ? `<div class="package-channel-section-header" data-section-id="${escHtml(row.section.id)}"><span>${escHtml(row.section.label)}</span><b>${row.section.count}</b></div>`
      : this.channelRowHtml(row.channel)).join('');
  }

  renderChannelListHtml(visibleChannels) {
    if (!groupChannels(visibleChannels).length) return '<div class="package-placeholder text-muted">Aucun salon trouvé.</div>';
    this.visibleChannels = visibleChannels;
    this.channelModel = this.buildChannelModel(visibleChannels);
    const slice = this.channelWindowSlice();
    return `<div data-channel-spacer-top style="height:${slice.padTop}px"></div><div data-channel-rows>${this.channelSliceHtml()}</div><div data-channel-spacer-bottom style="height:${slice.padBottom}px"></div>`;
  }

  // Ne rerend QUE la liste : panneau de messages, recherche et selection ne
  // doivent pas bouger quand on defile.
  // Avec la virtualisation, l en-tete d une section sort de la fenetre des que
// l on descend loin dans cette section : on affiche donc la section courante
// dans une barre epinglee, sinon on ne sait plus ou l on se trouve.
currentSectionLabel() {
    const model = this.channelModel;
    if (!model || !model.total) return '';
    const { start } = this.channelWindowSlice();
    for (let index = Math.min(start, model.total - 1); index >= 0; index -= 1) {
      if (model.rows[index].type === 'header') return model.rows[index].section.label;
    }
    return '';
  }

  // Les hauteurs ne sont pas celles des constantes CSS : on mesure une fois
  // pour toutes sur les noeuds reels. Sans cela, chaque repeint decale la
  // ligne sous le doigt de 2 px et le defilement parait glissant.
  measureChannelHeights() {
    const scroller = this.contentArea.querySelector('[data-channel-scroll]');
    if (!scroller) return false;
    const row = scroller.querySelector('[data-channel-rows] .package-channel');
    const header = scroller.querySelector('[data-channel-rows] .package-channel-section-header');
    const rowHeight = row ? row.offsetHeight : 0;
    const headerHeight = header ? header.offsetHeight : 0;
    if (rowHeight <= 0) return false;
    if (rowHeight !== this.channelRowHeight || headerHeight !== this.channelHeaderHeight) {
      this.channelRowHeight = rowHeight;
      this.channelHeaderHeight = headerHeight > 0 ? headerHeight : CHANNEL_HEADER_HEIGHT;
      return true;
    }
    return false;
  }

  renderChannelWindow() {
    const refs = this.channelRefs;
    if (!refs || !this.channelModel) return;
    const { scroller, top, rows, bottom, context } = refs;
    if (!scroller || !top || !rows || !bottom) return;

    // Une seule requete par frame au lieu de quatre.
    this.channelScrollTop = scroller.scrollTop;
    const viewport = scroller.clientHeight;
    if (viewport > 0) this.channelViewport = viewport;

    const slice = this.channelWindowSlice();
    // Repeindre a chaque frame recreerait les noeuds visibles, rechargerait
    // leurs images et briserait l'elan du pave tactile. La tranche peinte
    // deborde deja de `overscan` lignes de chaque cote : tant que le viewport
    // y tient entierement, on ne touche a rien. Le tampon d'une ligne evite
    // juste de basculer d'un frame a l'autre sur la borne.
    const buffer = this.channelRowHeight || CHANNEL_ROW_HEIGHT;
    const covered = this.channelPainted >= 0
      && this.channelSafeTop <= this.channelScrollTop
      && this.channelSafeBottom >= this.channelScrollTop + this.channelViewport + buffer;

    if (!covered) {
      top.style.height = `${slice.padTop}px`;
      rows.innerHTML = this.channelSliceHtml();
      bottom.style.height = `${slice.padBottom}px`;
      this.channelPainted = slice.start;
      this.channelPaintedEnd = slice.end;
      this.channelSafeTop = slice.padTop;
      this.channelSafeBottom = slice.padTop + (this.channelModel.offsets[slice.end] - this.channelModel.offsets[slice.start]);
    }
    if (context) {
      const label = this.currentSectionLabel();
      if (context.textContent !== label) context.textContent = label;
    }
  }

  scheduleChannelWindow() {
    if (this.channelFrame !== null || typeof requestAnimationFrame !== 'function') return;
    this.channelFrame = requestAnimationFrame(() => {
      this.channelFrame = null;
      this.renderChannelWindow();
    });
  }

  attachChannelScroll() {
    const scroller = this.contentArea.querySelector('[data-channel-scroll]');
    if (!scroller) return;
    this.channelPainted = -1;
    this.channelPaintedEnd = -1;
    const measured = scroller.clientHeight;
    if (measured > 0) this.channelViewport = measured;
    scroller.scrollTop = this.channelScrollTop;

    if (this.measureChannelHeights()) {
      // Hauteurs reelles connues : on reconstruit le modele et la fenetre.
      const channels = this.currentVisibleChannels();
      if (channels.length) {
        this.channelModel = this.buildChannelModel(channels);
        this.channelPainted = -1;
      }
    }

    this.channelRefs = {
      scroller,
      top: scroller.querySelector('[data-channel-spacer-top]'),
      rows: scroller.querySelector('[data-channel-rows]'),
      bottom: scroller.querySelector('[data-channel-spacer-bottom]'),
      context: this.contentArea.querySelector('[data-channel-context]'),
    };
    scroller.addEventListener('scroll', () => {
      this.channelScrollTop = scroller.scrollTop;
      if (scroller.clientHeight > 0) this.channelViewport = scroller.clientHeight;
      this.scheduleChannelWindow();
    }, { passive: true });
    this.scheduleChannelWindow();
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
    const hiddenNotes = this.systemNotesHiddenCount(channel);
    const shownMessages = this.visibleMessages(channel);
    if (!shownMessages.length && hiddenNotes) {
      return `<div class="package-message-header"><div><div class="package-conversation-title"><img class="package-message-avatar" src="${escHtml(avatarFor(channel))}" alt="" data-hide-on-error><h3>${escHtml(displayChannelName(channel))}</h3></div></div></div><div class="package-placeholder package-system-note"><p>${hiddenNotes} notification${hiddenNotes > 1 ? 's' : ''} système${hiddenNotes > 1 ? 's' : ''} ${hiddenNotes > 1 ? 'masquées' : 'masquée'}.</p><p class="text-muted">L'export de Discord ne contient pas leur texte : ni l'appelant, ni la durée. Seul l'horodatage est conservé.</p><button type="button" class="btn btn-secondary btn-xs" data-show-system-notes>Afficher quand même</button></div>`;
    }
    const selectedCount = allMessages.reduce((count, message) => count + (this.selectedMessages.has(`${channel.id}:${message.id}`) ? 1 : 0), 0);
    const start = this.messagePageOffset;
    const query = this.messageQuery.trim().toLowerCase();
    const sourceMessages = query ? shownMessages.filter(message => `${message.content || ''} ${message.id}`.toLowerCase().includes(query)) : shownMessages;
    const messages = sourceMessages.slice(start, start + this.messagePageSize);
    const end = Math.min(sourceMessages.length, start + this.messagePageSize);
    return `<div class="package-message-header"><div><div class="package-conversation-title"><img class="package-message-avatar" src="${escHtml(avatarFor(channel))}" alt="" data-hide-on-error><h3>${escHtml(displayChannelName(channel))}</h3></div><span class="text-muted">${start + 1}-${end} / ${allMessages.length} messages${channel.isLeft ? ' · serveur quitté' : ''}</span></div><div class="package-message-actions"><input class="package-message-search" data-message-search value="${escHtml(this.messageQuery)}" placeholder="Rechercher dans le salon..." aria-label="Rechercher dans les messages"><label><input type="checkbox" data-select-page ${selectedCount === messages.length && messages.length ? 'checked' : ''}> Tout sélectionner</label></div></div><div class="package-message-list">${messages.map(message => { const key = `${channel.id}:${message.id}`; return `<article class="package-message${this.selectedMessages.has(key) ? ' selected' : ''}"><label class="package-message-select"><input type="checkbox" data-message-key="${escHtml(key)}" data-message-index="${start + messages.indexOf(message)}" ${this.selectedMessages.has(key) ? 'checked' : ''}><span></span></label><div><div class="package-message-meta"><img class="package-message-avatar small" src="${escHtml(this.package.user.avatar || 'https://cdn.discordapp.com/embed/avatars/0.png')}" alt="" data-hide-on-error><strong>${escHtml(this.package.user.username)}</strong><time>${escHtml(message.timestamp)}</time></div><p>${isSystemNotification(message) ? '<span class="package-system-badge">Notification système</span> <span class="text-muted">(texte absent de l’export Discord)</span>' : escHtml(message.content) || '<span class="text-muted">(message sans contenu)</span>'}</p>${message.attachments.length ? `<div class="package-attachments">${message.attachments.map(attachment => `<a href="${escHtml(attachment.url)}" target="_blank" rel="noreferrer">📎 ${escHtml(attachment.fileName)}</a>`).join('')}</div>` : ''}</div></article>`; }).join('')}</div><div class="package-pagination">${start > 0 ? '<button class="btn btn-secondary btn-xs" data-package-page="prev">← Précédent</button>' : ''}${end < sourceMessages.length ? '<button class="btn btn-secondary btn-xs" data-package-page="next">Suivant →</button>' : ''}</div>`;
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

  renderThrottled(delay = 120) {
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.render();
    }, delay);
  }

  renderNow() {
    if (this.renderTimer) { clearTimeout(this.renderTimer); this.renderTimer = null; }
    this.render();
  }

  applyImportProgress(item, info) {
    const current = Number(info?.current || 0);
    const total = Math.max(1, Number(info?.total || 1));
    item.percent = Math.min(100, current / total * 100);
    const elapsed = (Date.now() - item.startedAt) / 1000;
    const rate = current / Math.max(elapsed, 0.001);
    item.statusText = `${escHtml(info?.stage || 'Analyse des salons')} · ${formatEta((total - current) / Math.max(rate, 0.001))}`;
    this.renderThrottled();
  }

  async importQueueItem(item) {
    item.status = 'processing'; item.statusText = 'Lecture locale de l’archive'; item.startedAt = Date.now(); item.percent = 0; this.render();
    try {
      const parsed = await importDiscordPackage(item.file, {
        onProgress: info => this.applyImportProgress(item, info),
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
      this.renderNow();
      this.hydrateDmPartners();
    } catch (error) {
      item.status = 'error'; item.statusText = error.message || 'Erreur de lecture'; item.percent = Math.max(0, item.percent); this.renderNow();
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
    // Avant la selection : le bouton Ouvrir est imbrique dans la ligne.
    const kindFilter = event.target.closest('[data-channel-filter]');
    if (kindFilter) { this.channelKindFilter = kindFilter.dataset.channelFilter; this.render(); return; }
    const showNotes = event.target.closest('[data-show-system-notes]');
    if (showNotes) { this.hideSystemNotes = false; this.render(); return; }
    const openDm = event.target.closest('[data-open-dm]');
    if (openDm) { this.openDmChannel(openDm.dataset.openDm, openDm.dataset.openDmName); return; }
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
    const actionButton = event.target.closest('[data-package-action]');
    const action = actionButton?.dataset.packageAction;
    if (action === 'focus') { this.focusMode = !this.focusMode; this.contentArea.classList.toggle('package-focus-mode', this.focusMode); this.render(); return; }
    if (action === 'export') { this.exportPackage(actionButton.dataset.exportFormat || 'json'); return; }
    if (action === 'close') { this.package = null; this.selectedChannelId = null; this.selectedMessages.clear(); this.render(); }
    if (action === 'delete') this.deleteSelectedMessages();
  }

  // La ligne n'est plus un <button> natif : on restaure l'activation clavier.
handleKeydown(event) {
    if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
    const openDm = event.target.closest?.('[data-open-dm]');
    if (openDm) { event.preventDefault(); this.openDmChannel(openDm.dataset.openDm, openDm.dataset.openDmName); return; }
    const channel = event.target.closest?.('[data-channel-id]');
    if (!channel) return;
    event.preventDefault();
    this.selectChannel(channel.dataset.channelId);
  }

  selectChannel(channelId) {
    const sidebar = this.contentArea.querySelector('.package-channel-list');
    const scrollTop = sidebar?.scrollTop || 0;
    const messageScroller = this.contentArea.querySelector('.package-message-list');
    const messageScrollTop = messageScroller?.scrollTop || 0;
    this.selectedChannelId = channelId;
    this.messagePageOffset = 0;
    this.render();
    const nextSidebar = this.contentArea.querySelector('.package-channel-list');
    if (nextSidebar) nextSidebar.scrollTop = scrollTop;
    const nextMessageScroller = this.contentArea.querySelector('.package-message-list');
    if (nextMessageScroller) nextMessageScroller.scrollTop = messageScrollTop;
  }

  async openDmChannel(userId, label) {
    const api = globalThis.window?.electronAPI;
    if (!api?.openDM || !userId) return;
    try {
      const result = await api.openDM(userId);
      if (!result?.success) {
        showNotification(`Ouverture impossible : ${result?.error || 'erreur inconnue'}`);
        return;
      }
      await globalThis.window?.dmManager?.refreshDMsList?.();
      document.querySelector('.nav-item[data-page="dms"]')?.click();
    } catch (error) {
      showNotification(`Ouverture impossible : ${error.message}`);
    }
  }

  // Le hash d avatar n'est pas derivable d un identifiant : seuls les DM encore
  // ouverts par le compte livrent un pseudo et une image via l API.
  async hydrateDmPartners() {
    const api = globalThis.window?.electronAPI;
    if (!api?.getDMs || !this.package) return 0;
    let result;
    try {
      result = await api.getDMs();
    } catch (error) {
      console.warn('Package DM hydration failed:', error);
      return 0;
    }
    const live = new Map((Array.isArray(result?.dms) ? result.dms : []).map(dm => [String(dm.id), dm]));
    let updated = 0;
    for (const channel of this.package.channels) {
      if (channel.type !== 'DM') continue;
      const dm = live.get(String(channel.id));
      if (!dm) continue;
      channel.recipient = { ...(channel.recipient || {}), username: dm.username || channel.recipient?.username };
      if (dm.avatar) channel.avatar = dm.avatar;
      if (!channel.name || isPlaceholderName(channel.name)) channel.name = dm.displayName || dm.username;
      updated += 1;
    }
    if (updated) this.renderThrottled();
    return updated;
  }

  handleChange(event) {
    if (event.target.id === 'packageFileInput') this.addFiles(event.target.files);
    if (event.target.matches('[data-hide-empty]')) { this.hideEmptyDms = event.target.checked; this.render(); return; }
    if (event.target.matches('[data-hide-system]')) { this.hideSystemNotes = event.target.checked; this.render(); return; }
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

  // L'export d'avant ne proposait qu'un JSON alors que l'import exige un ZIP :
// l'aller-retour etait impossible. buildExportBlob est separee du
// declenchement du telechargement pour rester testable hors DOM.
buildExportBlob(format) {
    if (!this.package) return null;
    if (format === 'zip') {
      return { blob: new Blob([exportDiscordPackage(this.package)], { type: 'application/zip' }), filename: 'discord-data-package.zip' };
    }
    const rows = [...this.package.messages.entries()].flatMap(([channelId, messages]) => messages.map(message => ({ channelId, ...message })));
    const payload = JSON.stringify({ user: this.package.user, channels: this.package.channels, messages: rows }, null, 2);
    return { blob: new Blob([payload], { type: 'application/json' }), filename: 'discord-data-package.json' };
  }

  // Revoquer l URL immediatement annule le telechargement dans Chromium : le
  // clic n'a pas encore ete traite.
  downloadBlob(blob, filename) {
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  exportPackage(format) {
    const target = this.buildExportBlob(format);
    if (!target) return;
    this.downloadBlob(target.blob, target.filename);
  }

  // Un salon quitte (403) ou un message deja efface (404) ne sont pas des
// succes : l'ancien code les comptait comme supprimes. Seul le 429 se reessaye.
async deleteOnePackageMessage(target, counts) {
    let result = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      result = await window.electronAPI.deletePackageMessage(target.channelId, target.messageId);
      if (!shouldRetryDelete(result)) break;
      await new Promise(resolve => setTimeout(resolve, ((Number(result.retryAfter) || 5) * 1000) + 500));
    }
    const outcome = classifyDeleteResult(result);
    counts[outcome] = (counts[outcome] || 0) + 1;
    if (outcome === 'deleted') this.selectedMessages.delete(`${target.channelId}:${target.messageId}`);
    return outcome;
  }

  // Une seule lecture decide de tout un salon. Sur un serveur quitte, chaque
// DELETE rendait 403 : sans ce controle, 219 messagesCosts autant de requetes
// pour la meme reponse, a 4 r/s. Sans l API disponible on tente quand meme,
// plutot que de bloquer une suppression qui reussirait.
async channelIsAccessible(channelId) {
    const api = globalThis.window?.electronAPI;
    if (!api?.getChannel) return true;
    try {
      const result = await api.getChannel(channelId);
      return Boolean(result?.success);
    } catch (error) {
      console.warn('Package channel access check failed:', error);
      return false;
    }
  }

  async deleteSelectedMessages() {
    if (this.isDeleting || !this.selectedMessages.size) return;
    const targets = getSelectedPackageMessageKeys(this.selectedMessages);
    if (!targets.length || !(await confirmAction('Supprimer les messages', `Supprimer ${targets.length} message(s) sélectionné(s) ? Cette action est irréversible.`))) return;
    this.isDeleting = true; this.deleteProgress = { done: 0, total: targets.length };
    const counts = { deleted: 0, missing: 0, forbidden: 0, failed: 0 };
    const skippedChannels = [];
    // Regroupement par salon : l acces se verifie une fois, pas par message.
    const byChannel = new Map();
    for (const target of targets) {
      if (!byChannel.has(target.channelId)) byChannel.set(target.channelId, []);
      byChannel.get(target.channelId).push(target);
    }
    try {
      let sincePause = 0;
      for (const [channelId, group] of byChannel) {
        if (!(await this.channelIsAccessible(channelId))) {
          counts.forbidden += group.length;
          skippedChannels.push({ channelId, count: group.length });
          this.deleteProgress.done += group.length;
          this.render();
          continue;
        }
        for (const target of group) {
          try {
            await this.deleteOnePackageMessage(target, counts);
          } catch (error) {
            counts.failed += 1;
            console.warn('Package message deletion failed:', error);
          }
          this.deleteProgress.done += 1;
          sincePause += 1;
          if (sincePause >= 10) { sincePause = 0; this.render(); await new Promise(resolve => setTimeout(resolve, 150)); }
        }
      }
      const skipped = skippedChannels.length
        ? ` · ${skippedChannels.length} salon${skippedChannels.length > 1 ? 's' : ''} inaccessible${skippedChannels.length > 1 ? 's' : ''} ignoré${skippedChannels.length > 1 ? 's' : ''}`
        : '';
      showNotification(summarizeDelete(counts).text + skipped);
    } finally { this.isDeleting = false; this.deleteProgress = null; this.render(); }
  }
}
