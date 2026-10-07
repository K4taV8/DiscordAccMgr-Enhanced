import { importDiscordPackage, getSelectedPackageMessageKeys, isPlaceholderName } from '../services/packageImporter.service.js';
import { exportDiscordPackage } from '../services/packageExporter.service.js';
import { classifyDeleteResult, describeDeleteFailure, shouldRetryDelete, summarizeDelete } from '../services/packageDelete.service.js';
import { confirmAction, showNotification, showProgressModal } from '../utils/ui.js';
import { escHtml } from '../utils/emojiUtils.js';
import { buildMessageSearchIndex, isSystemNotification, attachmentKind, attachmentExtension } from '../services/packageData.service.js';
import { closeProgressPanel, finishProgressPanel, showProgressPanel, updateProgressPanel } from '../utils/progressPanel.js';
import { createPackageArchiveId, deletePackageArchive, isCurrentPackageArchive, listPackageArchives, savePackageArchive, PACKAGE_SCHEMA_VERSION } from '../services/packageStorage.service.js';
import { groupChannels } from '../services/packageSections.service.js';
import { channelWindow, CHANNEL_ROW_HEIGHT, CHANNEL_OVERSCAN } from '../services/packageWindow.service.js';
import { GALLERY_COLUMNS, GALLERY_GAP, buildMediaIndex, filterMedia, tileSizeFor, galleryWindow } from '../services/galleryIndex.service.js';

const MAX_FILE_BYTES = 8 * 1024 * 1024 * 1024;

// Conteneurs video que Chromium ne sait pas demultiplexer : QuickTime (.mov),
// Matroska (.mkv), AVI (.avi), l OGV (Theora) et le M4V non H.264. Le lecteur
// les nomme et propose l enregistrement au lieu d une boite noire muette. Les
// quatre extensions vraiment lues par Chromium sont .mp4 et .webm (225 videos
// de l archive : 215 .mp4, 4 .webm, 5 .mov, 1 .mkv).
const UNREADABLE_VIDEO_EXT = new Set(['mov', 'mkv', 'avi', 'm4v', 'ogv']);

// Hauteur d'un en-tete de section : plus bas qu'une ligne de salon, d'ou la
// necessite de cumuler les hauteurs reelles plutot que de supposer 56 px.
const CHANNEL_HEADER_HEIGHT = 34;

// Part de la barre d import reservee a la lecture du ZIP, le reste etant
// l extraction. Les deux etapes ne comptent pas la meme chose — octets puis
// salons — et sans cette ponderation la barre repart de zero a chaque fois.
const IMPORT_READ_SHARE = 0.3;

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

// Reconstruit le paquet renvoye par le main process.
//
// `messages` y est un OBJET indexe par identifiant de salon, pas une `Map`, et
// cette transformation est EXPLICITE des deux cotes : `aplatitPackagePourIpc`
// (electron/packageImporter.service.cjs) aplatit, ici on rehydrate. Ce n'est pas
// une contrainte du transport — l'IPC Electron sérialise par clonage structure,
// qui preserve les `Map` et les `Set` — c'est une forme qu'on peut inspecter dans
// un journal et comparer dans un test. La transformation reste donc, et elle est
// verifiee dans les deux sens (les deux formes sont acceptees ici : voir plus
// bas). Une troisieme forme existe pour la BASE, un TABLEAU DE PAIRES, dans
// packageStorage.service.js : les trois sont nommees la ou chacune est ecrite.
//
// La copie par spread ne deplace pas les cles : l'ordre du paquet reste celui du
// chemin par index, qui est l'ordre du repertoire central.
export function hydrateImportedPackage(paquet) {
  if (!paquet || typeof paquet !== 'object') throw new Error('Paquet d import vide.');
  const reconstruit = { ...paquet };
  // `Object.entries` sur une Map rend un tableau VIDE : un paquet qui arriverait
  // avec une vraie Map doit donc etre accepte tel quel, pas converti en un objet
  // sans aucun message. C'est aussi ce qui rend cette fonction tolérante a un
  // transport qui, lui, PRESERVERAIT la Map.
  reconstruit.messages = paquet.messages instanceof Map
    ? new Map(paquet.messages)
    : new Map(Object.entries(paquet.messages || {}));
  return reconstruit;
}

export class PackageManager {
  // LE PAQUET EST LE SEUL ETAT DONT L INDEX DES MEDIAS DERIVE : changer de
  // paquet remet l index a vide, sinon les tuiles d une archive precedente
  // resteraient affichees (l index n est reconstruit qu au premier affichage
  // de la galerie). L accesseur existe pour que l invalidation soit inseparable
  // de l assignation, quel que soit l endroit qui ecrit this.package.
  get package() { return this._package; }
  set package(value) {
    if (value === this._package) return;
    this._package = value;
    this.galleryIndex = [];
    this.galleryScrollTop = 0;
    this.galleryPainted = -1;
    this.gallerySafeTop = 0;
    this.gallerySafeBottom = 0;
    this.galleryHtml = '';
    this.galleryRefs = null;
  }

  constructor(contentArea) {
    this.contentArea = contentArea;
    this.view = 'messages';
    this.galleryIndex = [];
    // `url -> localUrl` des copies locales declarees finies par le main. La
    // source d'une tuile passe par mediaSourceFor, jamais par item.url en clair.
    this.mediaManifest = new Map();
    this.mediaMirrorKey = '';
    // Abonnement vivant a `media:mirror:progress`. Un second clic sur
    // « Telecharger les medias » doit d'abord desabonner le precedent, sinon
    // deux abonnements empiles updateraient la meme modale.
    this.mediaProgressUnsubscribe = null;
    this.galleryFilter = { kind: 'all', channelId: '', tri: this.readGallerySort() };
    this.galleryScrollTop = 0;
    this.galleryViewport = 800;
    this.galleryPainted = -1;
    this.gallerySafeTop = 0;
    this.gallerySafeBottom = 0;
    this.galleryTileSize = 0;
    this.galleryFrame = null;
    this.galleryHtml = '';
    this.galleryRefs = null;
    this.package = null;
    this.queue = [];
    this.selectedChannelId = null;
    this.selectedMessages = new Set();
    this.isDeleting = false;
    this.deleteProgress = null;
    this.isDragging = false;
    this.savedArchives = [];
    this.droppedArchives = 0;
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
    this.lightboxOverlay = null;
    this.lightboxState = null;
    this.lightboxKeyHandler = null;
    this.messageQuery = '';
    this.messageSearchIndex = new Map();
    this.lastMessageKey = null;
    this.pausedImports = false;
    this.restoreArchives();
    contentArea.addEventListener('click', event => this.handleClick(event));
    contentArea.addEventListener('change', event => this.handleChange(event));
    contentArea.addEventListener('input', event => { this.handleMessageSearch(event); this.handleFilter(event); });
    contentArea.addEventListener('keydown', event => this.handleKeydown(event));
    // « error » ne remonte pas : il faut une capture, sinon une image cassee
    // ne declenche rien et laisse un trou dans la conversation.
    contentArea.addEventListener('error', event => {
      const img = event.target.closest?.('[data-attachment-img]');
      if (!img) return;
      img.closest('[data-attachment-fallback]')?.classList.add('is-broken');
    }, true);
    contentArea.addEventListener('dragenter', event => this.handleDragEnter(event));
    contentArea.addEventListener('dragover', event => this.handleDragOver(event));
    contentArea.addEventListener('dragleave', event => this.handleDragLeave(event));
    contentArea.addEventListener('drop', event => this.handleDrop(event));
    // Sans recalcul de la tuile, un redimensionnement laisserait la grille
    // calee sur l ancienne largeur. Le handler ne fait que mesurer et invalider :
    // le repaint passe par le rAF unique de scheduleGalleryWindow().
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('resize', () => this.handleGalleryResize());
    }
    this.render();
  }

  // localStorage peut etre indisponible (navigation privee, environnement de
  // test) : lecture et ecriture sont toutes deux encadrees, sur le motif de
  // listView (src/components/bento.js:10-20), mais sans y jeter d exception.
  readGallerySort() {
    try {
      return globalThis.localStorage?.getItem('gallery:tri') === 'ancien' ? 'ancien' : 'recent';
    } catch {
      return 'recent';
    }
  }

  persistGallerySort() {
    try {
      globalThis.localStorage?.setItem('gallery:tri', this.galleryFilter.tri);
    } catch {
      // Stockage indisponible : le tri reste en memoire pour la session.
    }
  }

  async restoreArchives() {
    try {
      const all = await listPackageArchives();
      // Une archive analysee par une version anterieure de l import peut
      // contenir des identifiants arrondis : la servir ferait echouer la
      // suppression en silence. Elle est ecartee, pas servie.
      this.savedArchives = all.filter(isCurrentPackageArchive);
      this.droppedArchives = all.length - this.savedArchives.length;
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
          <div class="package-filter-bulk">
            <button type="button" class="btn btn-secondary btn-xs" data-select-all>Tout cocher</button>
            <button type="button" class="btn btn-secondary btn-xs" data-select-none>Tout décocher</button>
          </div>
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
          ${this.droppedArchives ? `<p class="package-archive-note">${this.droppedArchives} archive${this.droppedArchives > 1 ? 's' : ''} locale${this.droppedArchives > 1 ? 's' : ''} écartée${this.droppedArchives > 1 ? 's' : ''} : elle${this.droppedArchives > 1 ? 's' : ''} ont été analysée${this.droppedArchives > 1 ? 's' : ''} par une version antérieure de l'import. Réimporte${this.droppedArchives > 1 ? 'z' : ''} le ZIP pour les utiliser.</p>` : ''}
        </section>`;
      return;
    }

    const channels = this.package.channels;
    if (this.selectedChannelId && !this.messageSearchIndex.has(this.selectedChannelId)) this.messageSearchIndex.set(this.selectedChannelId, buildMessageSearchIndex(this.package.messages.get(this.selectedChannelId) || []));
    this.contentArea.innerHTML = `
      <div class="list-toolbar package-toolbar">
        <div><h2 class="page-title"><span class="package-title-icon">📦</span> Data Package <span class="list-count">${channels.length}</span></h2><p class="text-muted">${escHtml(this.package.user.username)} · ${this.package.totalMessages} messages</p></div>
        <div class="toolbar-actions"><button class="btn btn-danger" data-package-action="delete" ${this.selectedMessages.size && !this.isDeleting ? '' : 'disabled'}>🗑️ ${this.isDeleting ? `Suppression ${this.deleteProgress?.done || 0}/${this.deleteProgress?.total || 0}` : `Supprimer (${this.selectedMessages.size})`}</button><button class="btn btn-secondary" data-package-action="gallery">${this.view === 'gallery' ? 'Retour aux messages' : 'Galerie'}</button><button class="btn btn-secondary" data-package-action="download-all">Télécharger les médias</button><button class="btn btn-secondary" data-package-action="purge-media">Purger les médias</button><button class="btn btn-secondary" data-package-action="export" data-export-format="zip">Exporter ZIP</button><button class="btn btn-secondary" data-package-action="export" data-export-format="json">Exporter JSON</button><button class="btn btn-secondary" data-package-action="close">Fermer</button></div>
      </div>
      <div class="package-layout">${this.view === 'gallery' ? this.renderGallery() : this.layoutMessages()}</div>`;
    this.attachChannelScroll();
    if (this.view === 'gallery') this.attachGalleryScroll();
  }

  // Extrait de render() SANS AUCUN changement de contenu : c est un garde-fou,
  // pas une refonte. Le HTML des messages doit rester bit pour bit identique
  // (prouve par les tests de rendu existants, inchanges, et par la capture
  // avant/apres du bloc .package-layout). Seule la DECISION d appeler cette
  // methode depend de la vue.
  layoutMessages() {
    const visibleChannels = this.filteredChannels();
    const selectedChannel = this.package.channels.find(channel => channel.id === this.selectedChannelId);
    const channelListHtml = this.renderChannelListHtml(visibleChannels);
    const channelContext = this.currentSectionContext();
    return `
        <aside class="package-channels card">
          <input class="package-filter" data-package-filter value="${escHtml(this.channelQuery)}" placeholder="Filtrer salons, serveurs ou DMs..." aria-label="Filtrer les salons">
          ${this.renderChannelFilterBar()}
          <div class="package-channel-context" data-channel-context>${escHtml(channelContext)}</div>
          <div class="package-channel-list" data-channel-scroll>${channelListHtml}</div>
        </aside>
        <section class="package-messages card">${selectedChannel ? this.renderMessages(selectedChannel) : '<div class="package-placeholder text-muted">Sélectionnez un salon pour consulter ses messages.</div>'}</section>
      `;
  }

  // ---- Galerie des medias -------------------------------------------------

  // POINT DE COUTURE : toute source de tuile passe par cette methode. Ecrire
  // item.url en clair dans le HTML d une tuile couperait le chantier suivant,
  // qui branchera ici ses copies locales telechargees (et ne touchera que cette
  // ligne). item.url vient de buildMediaIndex : il est toujours present.
  mediaSourceFor(item) {
    return this.mediaManifest.get(item.url) || item.url;
  }

  // Filtre + tri courants. filterMedia rend un tableau neuf, donc inverser ne
  // peut pas reordonner l index, lui trie par horodatage decroissant (« recent »
  // est donc deja son ordre naturel).
  galleryVisibleItems() {
    const items = filterMedia(this.galleryIndex, { kind: this.galleryFilter.kind, channelId: this.galleryFilter.channelId });
    return this.galleryFilter.tri === 'ancien' ? items.reverse() : items;
  }

  // Filtre, tri ou salon changes : la fenetre peinte ne designe plus rien. Un
  // changement de largeur, lui, deplace le scroll reel : on garde alors la
  // position, le repaint se rejoue avec la nouvelle hauteur de rang.
  resetGalleryPaint(keepScroll = false) {
    this.galleryPainted = -1;
    this.gallerySafeTop = 0;
    this.gallerySafeBottom = 0;
    this.galleryHtml = '';
    if (!keepScroll) this.galleryScrollTop = 0;
  }

  renderGalleryToolbar(items) {
    const chip = (kind, label) => `<button type="button" class="package-filter-chip${this.galleryFilter.kind === kind ? ' is-active' : ''}" data-gallery-kind="${kind}" aria-pressed="${this.galleryFilter.kind === kind}">${label}</button>`;
    // Seuls les salons qui portent au moins un media : le selecteur propose
    // 667 salons et presque tous sont vides.
    const salons = new Map();
    for (const item of this.galleryIndex) {
      if (item.channelId && !salons.has(item.channelId)) salons.set(item.channelId, item.channelName || `Salon ${item.channelId}`);
    }
    const options = [...salons].map(([id, nom]) => `<option value="${escHtml(id)}"${this.galleryFilter.channelId === id ? ' selected' : ''}>${escHtml(nom)}</option>`).join('');
    const prochain = this.galleryFilter.tri === 'recent' ? 'ancien' : 'recent';
    const libelle = prochain === 'ancien' ? 'Les plus anciens' : 'Les plus récents';
    return `<div class="package-gallery-toolbar" data-gallery-filter>
          <div class="package-filter-group" role="group" aria-label="Type de media">${chip('all', 'Tout')}${chip('image', 'Photos')}${chip('video', 'Videos')}${chip('audio', 'Audio')}${chip('file', 'Fichiers')}</div>
          <select class="package-gallery-channel" data-gallery-channel aria-label="Filtrer par salon"><option value="">Tous les salons</option>${options}</select>
          <span class="package-gallery-count">${items.length} média${items.length === 1 ? '' : 's'}</span>
          <button type="button" class="btn btn-secondary btn-xs" data-gallery-sort="${prochain}">${libelle}</button>
        </div>`;
  }

  // Index de la piece jointe DANS SON MESSAGE : c est ce que la visionneuse
  // attend dans data-attachment-index. data-gallery-tile, lui, est la position
  // dans la liste filtree.
  galleryAttachmentIndex(item) {
    const message = (this.package.messages.get(item.channelId) || []).find(entry => String(entry.id) === String(item.messageId));
    const pieces = Array.isArray(message?.attachments) ? message.attachments : [];
    const position = pieces.findIndex(piece => String(piece.url) === String(item.url) && String(piece.fileName) === String(item.fileName));
    return position >= 0 ? position : 0;
  }

  galleryFileIcon(ext) {
    const suffixe = String(ext || '').toLowerCase();
    if (suffixe === 'pdf') return '📕';
    if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2'].includes(suffixe)) return '🗄️';
    if (['txt', 'md', 'log', 'csv'].includes(suffixe)) return '📝';
    return '📎';
  }

  galleryTileHtml(item, index) {
    const nom = escHtml(item.fileName || 'fichier');
    const source = escHtml(this.mediaSourceFor(item));
    // aspect-ratio est en style inline et non en CSS : aucune dimension d image
    // n est disponible, le ratio reserve la place AVANT le chargement, sinon
    // chaque image qui arrive ferait sauter la mise en page.
    const attrs = `data-gallery-tile="${index}" data-gallery-open data-attachment-index="${this.galleryAttachmentIndex(item)}" title="${nom}" style="aspect-ratio: 1"`;
    if (item.kind === 'image') {
      // data-attachment-img + data-attachment-fallback : les memes attributs que
      // le rendu dans les messages, pour reutiliser la captation d erreur et le
      // repli is-broken qui existent deja.
      return `<button type="button" class="package-gallery-tile" ${attrs} data-attachment-fallback><img src="${source}" alt="${nom}" loading="lazy" decoding="async" data-attachment-img><span class="package-gallery-name">${nom}</span></button>`;
    }
    const icone = item.kind === 'video' ? '🎬' : item.kind === 'audio' ? '🎵' : this.galleryFileIcon(item.ext);
    return `<button type="button" class="package-gallery-tile" ${attrs}><span class="package-gallery-icon" aria-hidden="true">${icone}</span><span class="package-gallery-name">${nom}</span></button>`;
  }

  // LA HAUTEUR D UN RANG N EST PAS LA TUILE : un rang de grille CSS vaut
  // tuile + gouttiere. galleryWindow n a plus de parametre tileSize, et c est
  // rowHeight qui porte la donnée — this.galleryTileSize + GALLERY_GAP, a chaque
  // appel. Tant que la largeur n est pas mesuree (tuile a 0) il n y a pas de rang
  // a fenetrer : on rend la grille COMPLETE, jamais une grille vide.
  galleryWindowSlice(items) {
    const rowHeight = this.galleryTileSize + GALLERY_GAP;
    if (this.galleryTileSize <= 0) {
      return { startRow: 0, endRow: Math.ceil(items.length / GALLERY_COLUMNS), padTop: 0, padBottom: 0, rowHeight, full: true };
    }
    const slice = galleryWindow({
      total: items.length,
      columns: GALLERY_COLUMNS,
      scrollTop: this.galleryScrollTop,
      viewport: this.galleryViewport,
      rowHeight,
    });
    return { ...slice, rowHeight, full: false };
  }

  galleryTilesHtml(items, slice) {
    const start = slice.startRow * GALLERY_COLUMNS;
    const end = Math.min(items.length, slice.endRow * GALLERY_COLUMNS);
    let html = '';
    for (let index = start; index < end; index += 1) html += this.galleryTileHtml(items[index], index);
    return html;
  }

  // Les deux tampons reconstituent la hauteur totale exactement :
  // padTop + (endRow - startRow) * rowHeight + padBottom vaut rows * rowHeight,
  // sans quoi la barre de scroll raccourcirait et le scroll deviendrait faux.
  // Gouttiere et colonnes viennent des constantes du service, jamais d un
  // literal : le CSS ne peut pas deriver du calcul de tuile.
  galleryWindowHtml(items, slice) {
    return `<div data-gallery-pad="top" style="height:${slice.padTop}px"></div>
          <div data-gallery-rows class="package-gallery-grid" style="grid-template-columns: repeat(${GALLERY_COLUMNS}, 1fr); gap: ${GALLERY_GAP}px">${this.galleryTilesHtml(items, slice)}</div>
          <div data-gallery-pad="bottom" style="height:${slice.padBottom}px"></div>`;
  }

  renderGallery() {
    if (!this.package) return '';
    if (!this.galleryIndex.length) this.galleryIndex = buildMediaIndex(this.package);
    // Rafraichissement NON bloquant : le rendu initial part avec le manifeste
    // courant, le main repond ensuite et un second rendu adopte la source locale.
    if (!this.mediaSyncPending && globalThis.window?.electronAPI?.mediaMirror?.status) {
      this.mediaSyncPending = true;
      this.syncMediaManifest(this.mediaItems()).finally(() => { this.mediaSyncPending = false; });
    }
    const items = this.galleryVisibleItems();
    const toolbar = this.renderGalleryToolbar(items);
    if (!items.length) {
      this.resetGalleryPaint();
      const message = this.galleryFilter.channelId ? 'Aucun media dans ce salon' : 'Aucun média ne correspond à ce filtre';
      return `${toolbar}<div class="package-gallery-empty" data-gallery-empty>${message}</div>`;
    }
    const slice = this.galleryWindowSlice(items);
    // Cache de peinture : si la fenetre peinte couvre deja la position de scroll,
    // on retourne le HTML existant au lieu de le reconstruire. Ce cache n a de
    // sens qu une fois la largeur mesuree : sans tuile, il n y a pas de fenetre
    // a proteger, et le HTML est toujours reconstruit (c est aussi ce qui laisse
    // mediaSourceFor voir ses nouvelles sources a chaque rendu).
    const couverte = this.galleryTileSize > 0
      && this.galleryPainted >= 0
      && this.gallerySafeTop <= this.galleryScrollTop
      && this.gallerySafeBottom >= this.galleryScrollTop + this.galleryViewport + slice.rowHeight;
    if (couverte && this.galleryHtml) return this.galleryHtml;
    const html = `${toolbar}
        <div class="package-gallery-scroll" data-gallery-scroll>
          ${this.galleryWindowHtml(items, slice)}
        </div>`;
    this.galleryPainted = slice.startRow;
    this.gallerySafeTop = slice.padTop;
    this.gallerySafeBottom = slice.full ? Number.POSITIVE_INFINITY : slice.padTop + (slice.endRow - slice.startRow) * slice.rowHeight;
    this.galleryHtml = html;
    return html;
  }

  // ---- Miroir local des medias (tache 5) ---------------------------------

  // Les champs dont le service du main a besoin, et rien d'autre. L'index est
  // celui de TOUTE la galerie (pas seulement le filtre courant) : la cle du lot
  // doit rester la meme quels que soient les filtres.
  mediaItems() {
    if (!this.galleryIndex.length && this.package) this.galleryIndex = buildMediaIndex(this.package);
    return this.galleryIndex.map(item => ({ url: item.url, fileName: item.fileName, kind: item.kind, channelId: item.channelId }));
  }

  // Rafraichit `mediaManifest` depuis le main (ruling R5 : le renderer ne
  // construit jamais l'URL media://). On ne relance un rendu que si la carte a
  // change, sans quoi renderGallery bouclerait sur cet appel.
  async syncMediaManifest(items) {
    const api = globalThis.window?.electronAPI;
    if (!api?.mediaMirror?.status) return;
    try {
      const status = await api.mediaMirror.status(items);
      if (status?.key) this.mediaMirrorKey = status.key;
      const prochain = new Map();
      for (const entree of Array.isArray(status?.entries) ? status.entries : []) {
        if (entree.state === 'done' && entree.localUrl) prochain.set(entree.url, entree.localUrl);
      }
      let change = prochain.size !== this.mediaManifest.size;
      if (!change) {
        for (const [url, localUrl] of prochain) {
          if (this.mediaManifest.get(url) !== localUrl) { change = true; break; }
        }
      }
      if (change) { this.mediaManifest = prochain; this.render(); }
    } catch (error) {
      console.warn('Media mirror status unavailable:', error);
    }
  }

  // « Telecharger les medias » : le main process telecharge, le renderer ouvre
  // la progression, s'abonne, propose l'annulation et rapporte le resultat.
  async downloadAllMedia() {
    const api = globalThis.window?.electronAPI;
    if (!api?.mediaMirror?.start) { showNotification('Téléchargement impossible : IPC indisponible'); return; }
    const items = this.mediaItems();
    if (!items.length) { showNotification('Aucun média à télécharger'); return; }
    // Un second clic ne doit pas empiler un second abonnement : le precedent est
    // desabonne AVANT d'en poser un nouveau.
    if (typeof this.mediaProgressUnsubscribe === 'function') {
      this.mediaProgressUnsubscribe();
      this.mediaProgressUnsubscribe = null;
    }
    const modal = showProgressModal('Téléchargement des médias', items.length, {
      onCancel: () => { api.mediaMirror.cancel?.(); },
    });
    const desabonner = api.mediaMirror.onProgress?.(info => modal.updateProgress(Math.min(Number(info?.done) || 0, items.length))) || null;
    this.mediaProgressUnsubscribe = desabonner;
    try {
      const resultat = await api.mediaMirror.start(items);
      if (resultat?.ok === false) showNotification(`Téléchargement impossible : ${resultat.error || 'erreur inconnue'}`);
      await this.syncMediaManifest(items);
    } catch (error) {
      showNotification(`Téléchargement impossible : ${error.message}`);
    } finally {
      if (typeof desabonner === 'function') desabonner();
      // Seulement s'il est encore le notre : un second clic a pu le remplacer.
      if (this.mediaProgressUnsubscribe === desabonner) this.mediaProgressUnsubscribe = null;
      modal.closeModal();
      this.render();
    }
  }

  // « Purger les medias » : confirmation, purge cote main (cle validee), puis on
  // vide le manifeste local pour que les tuiles reviennent au CDN.
  async purgeMedia() {
    const api = globalThis.window?.electronAPI;
    if (!api?.mediaMirror?.purge) { showNotification('Purge impossible : IPC indisponible'); return; }
    const items = this.mediaItems();
    let key = this.mediaMirrorKey;
    if (!key && api.mediaMirror.status) {
      try { key = (await api.mediaMirror.status(items))?.key || ''; } catch (error) { console.warn('Media mirror status unavailable:', error); }
    }
    if (!key) { showNotification('Purge impossible : aucune copie locale'); return; }
    if (!(await confirmAction('Purger les médias', 'Supprimer les copies locales téléchargées ? Les tuiles reviendront au CDN.'))) return;
    try {
      const resultat = await api.mediaMirror.purge(key);
      if (resultat?.ok === false) { showNotification(`Purge impossible : ${resultat.error || 'erreur inconnue'}`); return; }
      this.mediaManifest = new Map();
      this.mediaMirrorKey = '';
      this.render();
    } catch (error) {
      showNotification(`Purge impossible : ${error.message}`);
    }
  }

  // La largeur se lit sur la GRILLE elle meme : c est elle qui reclame la tuile,
  // barre de defilement deduite. Largeur 0 (conteneur non mesurable) : la tuile
  // reste a 0 et la grille complete rendue par renderGallery tient debout.
  measureGalleryTile() {
    const refs = this.galleryRefs;
    if (!refs) return false;
    const width = refs.rows.clientWidth || 0;
    const taille = width > 0 ? tileSizeFor(width) : 0;
    if (taille === this.galleryTileSize) return false;
    this.galleryTileSize = taille;
    // La hauteur de rang change : la fenetre peinte ne correspond plus au DOM.
    this.resetGalleryPaint(true);
    return true;
  }

  attachGalleryScroll() {
    const scroller = this.contentArea.querySelector('[data-gallery-scroll]');
    const rows = scroller?.querySelector('[data-gallery-rows]');
    const top = scroller?.querySelector('[data-gallery-pad="top"]');
    const bottom = scroller?.querySelector('[data-gallery-pad="bottom"]');
    if (!scroller || !rows || !top || !bottom) { this.galleryRefs = null; return; }
    this.galleryRefs = { scroller, rows, top, bottom };
    if (this.measureGalleryTile()) this.scheduleGalleryWindow();
    const measured = scroller.clientHeight;
    if (measured > 0) this.galleryViewport = measured;
    scroller.scrollTop = this.galleryScrollTop;
    scroller.addEventListener('scroll', () => {
      this.galleryScrollTop = scroller.scrollTop;
      if (scroller.clientHeight > 0) this.galleryViewport = scroller.clientHeight;
      this.scheduleGalleryWindow();
    }, { passive: true });
    this.scheduleGalleryWindow();
  }

  renderGalleryWindow() {
    const refs = this.galleryRefs;
    if (!refs || this.view !== 'gallery') return;
    // Une seule requete par frame, comme pour la liste des salons.
    this.galleryScrollTop = refs.scroller.scrollTop;
    if (refs.scroller.clientHeight > 0) this.galleryViewport = refs.scroller.clientHeight;
    const items = this.galleryVisibleItems();
    if (!items.length) return;
    const slice = this.galleryWindowSlice(items);
    const couverte = this.galleryPainted >= 0
      && this.gallerySafeTop <= this.galleryScrollTop
      && this.gallerySafeBottom >= this.galleryScrollTop + this.galleryViewport + slice.rowHeight;
    // Ne touche a rien tant que la fenetre peinte couvre le viewport : c est ce
    // qui evite de recharger les images a chaque pixel de defilement.
    if (couverte) return;
    refs.top.style.height = `${slice.padTop}px`;
    refs.rows.innerHTML = this.galleryTilesHtml(items, slice);
    refs.bottom.style.height = `${slice.padBottom}px`;
    this.galleryPainted = slice.startRow;
    this.gallerySafeTop = slice.padTop;
    this.gallerySafeBottom = slice.full ? Number.POSITIVE_INFINITY : slice.padTop + (slice.endRow - slice.startRow) * slice.rowHeight;
    // Le HTML complet en cache decrit l ancienne fenetre : il est invalide.
    this.galleryHtml = '';
  }

  scheduleGalleryWindow() {
    if (this.galleryFrame !== null || typeof requestAnimationFrame !== 'function') return;
    this.galleryFrame = requestAnimationFrame(() => {
      this.galleryFrame = null;
      this.renderGalleryWindow();
    });
  }

  // Redimensionner : on reprend la mesure puis on invalide la fenetre peinte.
  // Sans cela, la grille resterait calée sur l ancienne largeur.
  handleGalleryResize() {
    if (this.view !== 'gallery' || !this.galleryRefs) return;
    if (this.measureGalleryTile()) this.scheduleGalleryWindow();
  }

  openGalleryTile(tile) {
    const items = this.galleryVisibleItems();
    const item = items[Number(tile.dataset.galleryTile)];
    if (!item) return;
    // Toute tuile lisible — image, video, audio — s ouvre dans la visionneuse.
    // Une video non lisible y affiche son nom et le bouton d enregistrement. Le
    // lien target="_blank" d avant etait refuse par setWindowOpenHandler.
    if (item.kind !== 'file') {
      const message = (this.package.messages.get(item.channelId) || []).find(entry => String(entry.id) === String(item.messageId));
      if (message) { this.openLightbox(message.attachments, Number(tile.dataset.attachmentIndex) || 0); return; }
    }
    // Un fichier ordinaire n a pas de lecteur : la seule sortie reelle est de
    // l enregistrer. Le lien target="_blank" d avant etait refuse par
    // setWindowOpenHandler (main.cjs) : il n a jamais rien ouvert.
    //
    // L URL DISTANTE (item.url), pas mediaSourceFor : enregistrer est un
    // telechargement reseau, et discord:saveAttachment refuse tout ce qui n est
    // pas http(s). La copie locale `media://` ne sert qu a l AFFICHAGE.
    this.saveAttachment({ url: item.url, fileName: item.fileName });
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
    const kind = channel.type === 'DM' ? 'Message direct' : channel.type === 'GROUP' ? 'Groupe' : channel.type === 'THREAD' ? 'Fil de discussion' : channel.guildName || 'Serveur';
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
    // La case est un vrai controle : sans elle, on ne pouvait selectionner un
    // salon entier, donc ni supprimer ses messages en un geste.
    const selectBox = `<input type="checkbox" class="package-selection-state ${state}" data-select-channel="${escHtml(channel.id)}"${state === 'all' ? ' checked' : ''} title="${label}" aria-label="${label}">`;
    return `<div class="package-channel${active}" role="button" tabindex="0" data-channel-id="${escHtml(channel.id)}">${selectBox}<img class="package-channel-avatar" src="${escHtml(avatarFor(channel))}" alt="" data-hide-on-error><span class="package-channel-copy"><strong>${escHtml(name)}</strong><small>${escHtml(this.channelSubtitle(channel))}</small></span>${openButton}<b>${channel.messagesCount}</b></div>`;
  }

  // Selection en lot : on coche ou decoche tous les messages des salons
  // actuellement visibles, filtres compris. Cocher 667 salons d un coup reste
  // possible, mais resteAnnule par le filtre actif.
  toggleAllFiltered(checked) {
    for (const channel of this.filteredChannels()) {
      const messages = this.package.messages.get(String(channel.id)) || [];
      for (const message of messages) {
        const key = `${channel.id}:${message.id}`;
        if (checked) this.selectedMessages.add(key);
        else this.selectedMessages.delete(key);
      }
    }
    this.render();
  }

  toggleChannelSelection(channelId, checked) {
    const messages = this.package.messages.get(String(channelId)) || [];
    for (const message of messages) {
      const key = `${channelId}:${message.id}`;
      if (checked) this.selectedMessages.add(key);
      else this.selectedMessages.delete(key);
    }
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

  // Le bandeau ne sert que lorsque l en-tete de section a quitte la fenetre :
  // sinon le meme nom s affichait deux fois de suite.
  currentSectionHeaderVisible() {
    const model = this.channelModel;
    if (!model || !model.total) return false;
    const { start, end } = this.channelWindowSlice();
    for (let index = start; index < end; index += 1) {
      if (model.rows[index].type === 'header') return true;
    }
    return false;
  }

  currentSectionContext() {
    return this.currentSectionHeaderVisible() ? '' : this.currentSectionLabel();
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
      const label = this.currentSectionContext();
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

  // Une page peut contenir plus de cent images : tout est charge en paresseux et
// les videos ne telechargent rien avant lecture. Si l URL signee a expire,
// l image bascule sur son lien plutot que de laisser un trou.
  attachmentHtml(attachment, index = 0, messageKey = '') {
    const url = escHtml(attachment.url);
    const name = escHtml(attachment.fileName || 'fichier');
    const kind = attachmentKind(attachment.url, attachment.fileName);

    if (kind === 'image') {
      const locate = messageKey ? ` data-attachment-message="${escHtml(messageKey)}" data-attachment-index="${index}"` : '';
      return `<a class="package-attachment package-attachment-image" data-attachment-fallback data-attachment-open${locate} data-attachment-url="${url}" data-attachment-file-name="${name}" href="${url}" rel="noreferrer" title="${name}"><img data-attachment-img src="${url}" alt="${name}" loading="lazy" decoding="async"><span class="package-attachment-broken">Voir le fichier</span></a>`;
    }
    if (kind === 'video') {
      return `<span class="package-attachment package-attachment-media"><video src="${url}" controls preload="metadata" playsinline></video><a class="package-attachment-link" href="${url}" rel="noreferrer">${name}</a></span>`;
    }
    if (kind === 'audio') {
      return `<span class="package-attachment package-attachment-media"><audio src="${url}" controls preload="metadata"></audio><a class="package-attachment-link" href="${url}" rel="noreferrer">${name}</a></span>`;
    }
    return `<a class="package-attachment-link" href="${url}" rel="noreferrer">📎 ${name}</a>`;
  }

  clampLightboxIndex(index, length) {
    if (!length) return 0;
    const value = Number(index);
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(Math.floor(value), length - 1));
  }

  lightboxKind(attachment) {
    if (attachment?.kind) return attachment.kind;
    // Le nom de fichier Discord n est pas toujours fiable : un nom sans
    // extension ne doit pas faire disparaitre une image dont l URL, elle, en a
    // une. On classe donc par le nom, puis par l URL en repli.
    const parNom = attachmentKind('', attachment?.fileName);
    return parNom !== 'file' ? parNom : attachmentKind(attachment?.url, '');
  }

  // Les conteneurs QuickTime/Matroska/AVI/OGV/M4V ne sont pas demultiplexables
  // par Chromium : on les nomme et on propose l enregistrement, mais on ne les
  // monte pas dans un <video>, qui resterait noir et muet.
  isUnreadableVideo(attachment) {
    return UNREADABLE_VIDEO_EXT.has(attachmentExtension(attachment?.url, attachment?.fileName));
  }

  lightboxUnreadableHtml(url, name) {
    return `<div class="package-lightbox-unreadable"><strong>${name}</strong><p>Format non lisible par le lecteur</p><button type="button" class="package-lightbox-save" data-save-attachment data-save-url="${url}" data-save-name="${name}">Enregistrer le fichier</button></div>`;
  }

  // `source` est la source d AFFICHAGE : la copie locale `media://` si le miroir
  // la declare finie, le CDN sinon. La visionneuse suit donc les tuiles (F4).
  // Pour un format non lisible, le bouton enregistrer vise l URL DISTANTE
  // (`attachment.url`) : enregistrer est un telechargement reseau, jamais la
  // lecture d une copie locale.
  lightboxMediaHtml(attachment, source, name) {
    const kind = this.lightboxKind(attachment);
    if (kind === 'image') return `<img src="${source}" alt="${name}" data-lightbox-img>`;
    if (kind === 'audio') return `<audio src="${source}" controls preload="metadata" data-lightbox-audio></audio>`;
    if (kind === 'video' && !this.isUnreadableVideo(attachment)) {
      return `<video src="${source}" controls playsinline preload="metadata" data-lightbox-video></video>`;
    }
    return this.lightboxUnreadableHtml(escHtml(attachment.url), name);
  }

  lightboxHtml(attachments, index) {
    const list = Array.isArray(attachments) ? attachments : [];
    const readable = list.filter(item => this.lightboxKind(item) !== 'file');
    const cible = list.length ? list[this.clampLightboxIndex(index, list.length)] : null;
    const position = cible ? Math.max(0, readable.indexOf(cible)) : 0;
    const current = readable[position] || readable[0];
    if (!current) {
      return `<button type="button" class="package-lightbox-backdrop" data-lightbox-close aria-label="Fermer"></button>
      <figure class="package-lightbox-figure"></figure>
      <button type="button" class="package-lightbox-close" data-lightbox-close aria-label="Fermer">✕</button>`;
    }
    const source = escHtml(this.mediaSourceFor(current));
    const name = escHtml(current.fileName || 'média');
    const several = readable.length > 1;
    const prev = several ? `<button type="button" class="package-lightbox-nav prev" data-lightbox-prev aria-label="Média précédent">‹</button>` : '';
    const next = several ? `<button type="button" class="package-lightbox-nav next" data-lightbox-next aria-label="Média suivant">›</button>` : '';
    const counter = several ? `<span class="package-lightbox-counter">${position + 1} / ${readable.length}</span>` : '';
    return `<button type="button" class="package-lightbox-backdrop" data-lightbox-close aria-label="Fermer"></button>
      <figure class="package-lightbox-figure">
        ${prev}
        ${this.lightboxMediaHtml(current, source, name)}
        ${next}
        <figcaption class="package-lightbox-caption"><span>${name}</span>${counter}</figcaption>
      </figure>
      <button type="button" class="package-lightbox-close" data-lightbox-close aria-label="Fermer">✕</button>`;
  }

  openLightbox(attachments, index) {
    const list = Array.isArray(attachments) ? attachments : [];
    // La visionneuse parcourt les medias lisibles (image, video, audio) : un
    // message peut melanger une capture et un PDF, et un PDF dans un <img> ne
    // donnerait rien. Les fichiers ordinaires ne sont pas navigables.
    const readable = list.filter(item => this.lightboxKind(item) !== 'file');
    if (!readable.length) return;
    const target = list[this.clampLightboxIndex(index, list.length)];
    const start = readable.indexOf(target);
    this.lightboxState = { attachments: readable, index: start >= 0 ? start : 0 };

    const overlay = this.lightboxOverlay || document.createElement('div');
    overlay.className = 'package-lightbox';
    overlay.innerHTML = this.lightboxHtml(this.lightboxState.attachments, this.lightboxState.index);
    if (!this.lightboxOverlay) {
      overlay.addEventListener('click', event => {
        const save = event.target.closest('[data-save-attachment]');
        if (save) { this.saveAttachment({ url: save.dataset.saveUrl, fileName: save.dataset.saveName }); return; }
        if (event.target.closest('[data-lightbox-close]')) { this.closeLightbox(); return; }
        if (event.target.closest('[data-lightbox-prev]')) { this.stepLightbox(-1); return; }
        if (event.target.closest('[data-lightbox-next]')) { this.stepLightbox(1); }
      });
      document.body.appendChild(overlay);
      this.lightboxOverlay = overlay;
      this.lightboxKeyHandler = event => this.handleLightboxKey(event);
      document.addEventListener('keydown', this.lightboxKeyHandler);
    }
  }

  stepLightbox(delta) {
    if (!this.lightboxState) return;
    this.lightboxState.index = this.clampLightboxIndex(this.lightboxState.index + delta, this.lightboxState.attachments.length);
    this.lightboxOverlay.innerHTML = this.lightboxHtml(this.lightboxState.attachments, this.lightboxState.index);
  }

  closeLightbox() {
    if (this.lightboxKeyHandler) {
      document.removeEventListener('keydown', this.lightboxKeyHandler);
      this.lightboxKeyHandler = null;
    }
    this.lightboxOverlay?.remove();
    this.lightboxOverlay = null;
    this.lightboxState = null;
  }

  // Le telechargement se fait dans le main process : connect-src 'self'
  // interdit au renderer de fetch le CDN. Ici on ne fait que demander et rendre
  // compte — un echec se dit, une annulation se tait.
  async saveAttachment(attachment) {
    const api = globalThis.window?.electronAPI;
    if (!api?.saveAttachment) {
      showNotification('Enregistrement impossible : IPC indisponible');
      return;
    }
    try {
      const resultat = await api.saveAttachment({ url: attachment?.url || '', fileName: attachment?.fileName || '' });
      if (resultat?.ok) {
        showNotification(`Fichier enregistré : ${resultat.chemin}`);
      } else if (!resultat?.cancelled) {
        showNotification(`Enregistrement impossible : ${resultat?.error || 'erreur inconnue'}`);
      }
    } catch (error) {
      showNotification(`Enregistrement impossible : ${error.message}`);
    }
  }

  handleLightboxKey(event) {
    if (!this.lightboxOverlay) return;
    if (event.key === 'Escape') { this.closeLightbox(); return; }
    if (event.key === 'ArrowLeft') { this.stepLightbox(-1); return; }
    if (event.key === 'ArrowRight') { this.stepLightbox(1); }
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
    return `<div class="package-message-header"><div><div class="package-conversation-title"><img class="package-message-avatar" src="${escHtml(avatarFor(channel))}" alt="" data-hide-on-error><h3>${escHtml(displayChannelName(channel))}</h3></div><span class="text-muted">${start + 1}-${end} / ${allMessages.length} messages${channel.isLeft ? ' · serveur quitté' : ''}</span></div><div class="package-message-actions"><input class="package-message-search" data-message-search value="${escHtml(this.messageQuery)}" placeholder="Rechercher dans le salon..." aria-label="Rechercher dans les messages"><label><input type="checkbox" data-select-page ${selectedCount === messages.length && messages.length ? 'checked' : ''}> Tout sélectionner</label></div></div><div class="package-message-list">${messages.map(message => { const key = `${channel.id}:${message.id}`; return `<article class="package-message${this.selectedMessages.has(key) ? ' selected' : ''}"><label class="package-message-select"><input type="checkbox" data-message-key="${escHtml(key)}" data-message-index="${start + messages.indexOf(message)}" ${this.selectedMessages.has(key) ? 'checked' : ''}><span></span></label><div><div class="package-message-meta"><img class="package-message-avatar small" src="${escHtml(this.package.user.avatar || 'https://cdn.discordapp.com/embed/avatars/0.png')}" alt="" data-hide-on-error><strong>${escHtml(this.package.user.username)}</strong><time>${escHtml(message.timestamp)}</time></div><p>${isSystemNotification(message) ? '<span class="package-system-badge">Notification système</span> <span class="text-muted">(texte absent de l’export Discord)</span>' : escHtml(message.content) || '<span class="text-muted">(message sans contenu)</span>'}</p>${message.attachments.length ? `<div class="package-attachments">${message.attachments.map((attachment, index) => this.attachmentHtml(attachment, index, key)).join('')}</div>` : ''}</div></article>`; }).join('')}</div><div class="package-pagination">${start > 0 ? '<button class="btn btn-secondary btn-xs" data-package-page="prev">← Précédent</button>' : ''}${end < sourceMessages.length ? '<button class="btn btn-secondary btn-xs" data-package-page="next">Suivant →</button>' : ''}</div>`;
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

  // 90 ms : onze rendus par seconde suffisent a fluidifier sans reconstruire la
// page plus souvent que nécessaire pendant la lecture d'un gros fichier.
renderThrottled(delay = 90) {
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

// L importeur parle deux langues : des octets pendant la lecture du ZIP, puis
// des salons pendant l extraction. Prendre current/total brut faisait passer la
// barre de 0 a 100 %, puis revenir a 0 : le remplissage paraissait saccade.
// La lecture pese donc 30 % de la barre, l extraction les 70 % restants.
//
// DEUX PHASES SONT DONC DEUX PASSAGES, et le second se reconnait a son ordre : seul le
// chemin flux annonce des OCTETS, et il le fait avant toute extraction. Un evenement en
// octets apres un evenement d ENTREE ne peut donc pas venir du meme passage — l index a
// echoue et le flux prend la main. La jauge repart alors a zero : le second passage
// relit TOUT le fichier, et une jauge restee au passage mort afficherait un temps
// restant faux. Le mode, affiche a cote, explique ce retour en arriere.
//
// Le mode se deduit de la meme phase plutot que d attendre la reponse du main process,
// qui ne rend qu a la fin : sur un import lent — le seul cas ou l utilisateur le
// regarde — la reponse n est pas encore la.
applyImportProgress(item, info) {
    if (!info || !Number.isFinite(Number(info.total)) || Number(info.total) <= 0) return;
    const current = Number(info.current || 0);
    const total = Math.max(1, Number(info.total));
    const ratio = Math.max(0, Math.min(1, current / total));
    const isRead = Boolean(info?.bytes);
    const phasePrecedente = item.importPhase;

    if (isRead && phasePrecedente === 'entrees') {
      item.percent = 0;
      item.startedAt = Date.now(); // l ETA ne doit pas compter le passage mort
    }
    item.importMode = isRead || phasePrecedente === 'octets' ? 'flux' : 'index';
    item.importPhase = isRead ? 'octets' : 'entrees';

    const base = isRead ? 0 : IMPORT_READ_SHARE;
    const span = isRead ? IMPORT_READ_SHARE : 1 - IMPORT_READ_SHARE;
    const percent = (base + ratio * span) * 100;
    item.percent = Math.min(100, percent);

    // L ETA ne peut pas se baser sur current/elapsed : l unite change de bytes
    // en salons. On l estime donc depuis l avancement global et le temps ecoule.
    const elapsed = (Date.now() - item.startedAt) / 1000;
    const remaining = percent > 1 ? ` · ~${formatEta((elapsed * (100 - percent)) / percent)}` : '';
    item.statusText = `${escHtml(info?.stage || 'Analyse des salons')} · ${Math.round(percent)} %${remaining} · mode ${item.importMode}`;
    this.renderThrottled();
  }

  // LECTURE DU PAQUET. Deux chemins, un seul point de sortie.
  //
  // Le chemin par index vit dans le main process — `node:zlib` y est autorise,
  // pas ici — et recoit le CHEMIN du fichier : les octets d une archive de
  // 394 Mo ne traversent pas l'IPC. Il echoue la ou le chemin local reussit
  // (un repertoire central illisible, une entree a 4 Go), et le repli se fait
  // la, dans le main process. Si le main process ne peut pas importer du tout —
  // pas de `electronAPI`, pas de chemin sur le disque — l'import se fait ici,
  // comme avant.
  //
  // Le chemin retenu est journalise UNE fois par import : deux fois par fichier
  // versé dans la file rendrait le journal illisible, et jamais ne rendrait
  // l'information plus exacte. Il est aussi AFFICHE, dans le `statusText` de la file :
  // c'est le seul endroit où l'utilisateur peut le voir, et le gain de ce chantier peut
  // disparaître en silence (cf. le commentaire d'`applyImportProgress`).
  //
  // `shouldStop` N'EST PAS CABLE ICI, et ce n'est pas un oubli. L'API l'expose et le
  // service `electron/` lui obeit — une annulation ne doit jamais relancer le chemin flux —
  // mais RIEN dans cette interface n'annule un import : il n'y a pas de bouton. Le câbler
  // donnerait l'illusion d'une annulation disponible ; la règle reste écrite dans le
  // service, où elle protège l'API, et attend son bouton.
  async readPackage(item) {
    const api = globalThis.window?.electronAPI;
    const onProgress = info => this.applyImportProgress(item, info);

    if (!api?.importPackage) {
      const parsed = await importDiscordPackage(item.file, { onProgress });
      item.importMode = 'flux';
      console.info(`Import ${item.file.name} : mode local`);
      return parsed;
    }

    // La progression vient du main process par events : `importPackage` ne repond
    // qu a la fin, et sans ce relais la jauge resterait figee pendant tout
    // l'import. On se desabonne dans tous les cas, une seule fois.
    const stopProgress = api.onImportPackageProgress?.(info => { if (info.fichier === item.file.name) onProgress(info); });
    try {
      const reponse = await api.importPackage(item.file);
      if (!reponse?.success) {
        if (reponse?.fallbackToRenderer) {
          const parsed = await importDiscordPackage(item.file, { onProgress });
          item.importMode = 'flux';
          console.info(`Import ${item.file.name} : mode local (${reponse.error || 'main process indisponible'})`);
          return parsed;
        }
        // Une annulation n est PAS un succes : ni paquet rendu, ni archive
        // enregistree. Son texte la distingue d un echec d archive, qui a lui
        // son propre motif.
        throw new Error(reponse?.cancelled ? 'Import annulé' : (reponse?.error || 'Erreur de lecture'));
      }
      // La REPONSE fait autorite sur le mode : c est elle qui sait, et non la phase des
      // evenements. Sans elle, un import qui n aurait emis aucun evenement — une archive
      // minuscule — afficherait le mode deduit, donc un mode possible mais jamais verifie.
      if (reponse.mode) item.importMode = reponse.mode === 'stream' ? 'flux' : 'index';
      console.info(`Import ${item.file.name} : mode ${reponse.mode}${reponse.reason ? ` (${reponse.reason})` : ''}`);
      return hydrateImportedPackage(reponse.package);
    } finally {
      stopProgress?.();
    }
  }

  async importQueueItem(item) {
    // `importPhase` et `importMode` repartent de zero avec l essai : sans cela, une
    // annulation puis un reessai verrait le second passage comme un repli, et
    // afficherait le mode du precedent.
    item.status = 'processing'; item.statusText = 'Lecture locale de l’archive'; item.startedAt = Date.now(); item.percent = 0; item.importPhase = null; item.importMode = null; this.render();
    try {
      const parsed = await this.readPackage(item);
      item.status = 'success'; item.percent = 100; item.statusText = item.importMode ? `OK · mode ${item.importMode}` : 'OK';
      // La version du schema est une cle du COTE IHM : `isCurrentPackageArchive`
      // la lit a la relecture pour ecarter une archive d une version perimee. Le
      // main process ne la connait pas et ne la pose donc pas — la poser ici,
      // apres l import et avant la sauvegarde, la conserve pour les DEUX chemins.
      parsed.schemaVersion = PACKAGE_SCHEMA_VERSION;
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
      // Un import qui n a rien produit ne montre pas une jauge pleine a cote du mot « error » :
      // a l oeil, une barre a 100 % EST un succes. Le motif, lui, reste affiche — c est
      // lui que l utilisateur lit et qu il recopie dans un rapport de bug.
      item.status = 'error'; item.statusText = error.message || 'Erreur de lecture'; item.percent = 0; this.renderNow();
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
    const saveButton = event.target.closest('[data-save-attachment]');
    if (saveButton) {
      event.preventDefault();
      await this.saveAttachment({ url: saveButton.dataset.saveUrl, fileName: saveButton.dataset.saveName });
      return;
    }
    // Une tuile de galerie ouvre la visionneuse quand c est un media lisible, et
    // la source dans un onglet sinon.
    const galleryTile = event.target.closest('[data-gallery-open]');
    if (galleryTile) { this.openGalleryTile(galleryTile); return; }
    // Le clic sur une vignette ouvre la visionneuse. Une image cassee, elle,
    // laisse place a son repli : elle propose l enregistrement au lieu de
    // rafraichir la meme image morte.
    const open = event.target.closest('[data-attachment-open]');
    if (open && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
      event.preventDefault();
      if (open.classList.contains('is-broken')) {
        await this.saveAttachment({ url: open.dataset.attachmentUrl, fileName: open.dataset.attachmentFileName });
        return;
      }
      const key = open.dataset.attachmentMessage;
      const [channelId, messageId] = String(key || '').split(':');
      const message = channelId && messageId ? (this.package.messages.get(channelId) || []).find(item => String(item.id) === messageId) : null;
      if (message) this.openLightbox(message.attachments, Number(open.dataset.attachmentIndex) || 0);
      return;
    }
    const selectBox = event.target.closest('[data-select-channel]');
    if (selectBox) return;
    const kindFilter = event.target.closest('[data-channel-filter]');
    if (kindFilter) { this.channelKindFilter = kindFilter.dataset.channelFilter; this.render(); return; }
    const galleryKind = event.target.closest('[data-gallery-kind]');
    if (galleryKind) { this.galleryFilter.kind = galleryKind.dataset.galleryKind || 'all'; this.resetGalleryPaint(); this.render(); return; }
    const gallerySort = event.target.closest('[data-gallery-sort]');
    if (gallerySort) { this.galleryFilter.tri = this.galleryFilter.tri === 'recent' ? 'ancien' : 'recent'; this.persistGallerySort(); this.resetGalleryPaint(); this.render(); return; }
    if (event.target.closest('[data-select-all]')) { this.toggleAllFiltered(true); return; }
    if (event.target.closest('[data-select-none]')) { this.toggleAllFiltered(false); return; }
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
    if (action === 'gallery') { this.view = this.view === 'gallery' ? 'messages' : 'gallery'; this.render(); return; }
    if (action === 'download-all') { this.downloadAllMedia(); return; }
    if (action === 'purge-media') { this.purgeMedia(); return; }
    if (action === 'export') { this.exportPackage(actionButton.dataset.exportFormat || 'json'); return; }
    if (action === 'close') { this.closeLightbox(); this.package = null; this.selectedChannelId = null; this.selectedMessages.clear(); this.render(); }
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
    if (event.target.matches('[data-gallery-channel]')) { this.galleryFilter.channelId = event.target.value || ''; this.resetGalleryPaint(); this.render(); return; }
    if (event.target.matches('[data-hide-empty]')) { this.hideEmptyDms = event.target.checked; this.render(); return; }
    if (event.target.matches('[data-hide-system]')) { this.hideSystemNotes = event.target.checked; this.render(); return; }
    const channelBox = event.target.closest('[data-select-channel]');
    if (channelBox) {
      this.toggleChannelSelection(channelBox.dataset.selectChannel, channelBox.checked);
      this.render();
      return;
    }
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
// Un 404 ne prouve pas que le message a disparu : il peut venir d un mauvais
// identifiant de salon, d'un message systeme non supprimable, ou d'une race.
// On demande une fois au serveur si le message existe encore, plutot que de
// classer en « deja absent » sur la seule foi du statut.
async confirmMessageStillExists(channelId, messageId) {
    const api = globalThis.window?.electronAPI;
    if (!api?.getMessage) return null;
    try {
      const result = await api.getMessage(channelId, messageId);
      return Boolean(result?.success);
    } catch (error) {
      console.warn('Package message existence check failed:', error);
      return null;
    }
  }

  async deleteOnePackageMessage(target, counts) {
    let result = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      result = await window.electronAPI.deletePackageMessage(target.channelId, target.messageId);
      if (!shouldRetryDelete(result)) break;
      await new Promise(resolve => setTimeout(resolve, ((Number(result.retryAfter) || 5) * 1000) + 500));
    }
    let outcome = classifyDeleteResult(result);
    // Ni 404 ni 400 ne prouvent que le message a disparu : un 400 peut venir
    // d un message systeme non supprimable, d un corps de requete refuse. On
    // demande au serveur, une fois, si le message existe encore.
    const status = Number(result?.status);
    if (outcome === 'missing' || status === 400) {
      const exists = await this.confirmMessageStillExists(target.channelId, target.messageId);
      if (exists === true && outcome === 'missing') {
        outcome = 'failed';
        counts.reasons = counts.reasons || {};
        const reason = 'suppression refusée, message toujours présent';
        counts.reasons[reason] = (counts.reasons[reason] || 0) + 1;
        console.warn('Package message deletion refused but message exists:', `${target.channelId}:${target.messageId}`, result);
        return outcome;
      }
      if (exists === true && outcome === 'failed') {
        counts.reasons = counts.reasons || {};
        const reason = `message présent, suppression refusée (${describeDeleteFailure(result)})`;
        counts.reasons[reason] = (counts.reasons[reason] || 0) + 1;
        console.warn('Package message present but undeletable:', `${target.channelId}:${target.messageId}`, result);
        return outcome;
      }
    }
    counts[outcome] = (counts[outcome] || 0) + 1;
    if (outcome === 'failed') {
      // Sans la raison, « echec » ne dit rien. Elle est comptee par motif pour
      // apparaitre dans le resume, et tracee pour la console.
      const reason = describeDeleteFailure(result);
      counts.reasons = counts.reasons || {};
      counts.reasons[reason] = (counts.reasons[reason] || 0) + 1;
      console.warn('Package message deletion failed:', reason);
    }
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

  // Un fil archive refuse toute suppression (Discord, erreur 50083). On le
// reactive, on supprime, puis on le reassigne : le fil est laisse dans l etat
// ou l utilisateur l avait. Impossible de le reactiver, c est soit le compte,
// soit les permissions qui bloquent, et l outil ne pretend pas le contraire.
async unarchiveThread(threadId) {
    const api = globalThis.window?.electronAPI;
    if (!api?.setThreadArchived) return false;
    try {
      const result = await api.setThreadArchived(threadId, false);
      return Boolean(result?.success);
    } catch (error) {
      console.warn('Package thread unarchive failed:', error);
      return false;
    }
  }

  async rearchiveThread(threadId) {
    const api = globalThis.window?.electronAPI;
    if (!api?.setThreadArchived) return;
    try {
      await api.setThreadArchived(threadId, true);
    } catch (error) {
      console.warn('Package thread re-archive failed:', error);
    }
  }

  // Le cycle de vie d un fil est tightlye autour de son propre groupe : si une
// exception survient, le fil est quand meme reassigne. Un reassignage groupe a
// la fin laissait les fils ouverts si la boucle etait interrompue, ce qui
// modifiait l etat du serveur sans que l utilisateur l ait demande.
async deleteChannelGroup(channel, group, counts, onProgress) {
    const channelId = String(channel.id);
    const reactivated = channel.type === 'THREAD' ? await this.unarchiveThread(channelId) : false;
    try {
      for (const target of group) {
        try {
          await this.deleteOnePackageMessage(target, counts);
        } catch (error) {
          counts.failed += 1;
          console.warn('Package message deletion failed:', error);
        }
        if (onProgress) await onProgress();
      }
    } finally {
      if (reactivated) await this.rearchiveThread(channelId);
    }
    return { reactivated };
  }

  async deleteSelectedMessages() {
    if (this.isDeleting || !this.selectedMessages.size) return;
    const targets = getSelectedPackageMessageKeys(this.selectedMessages);
    if (!targets.length || !(await confirmAction('Supprimer les messages', `Supprimer ${targets.length} message(s) sélectionné(s) ? Cette action est irréversible.`))) return;
    this.isDeleting = true; this.deleteProgress = { done: 0, total: targets.length };
    const counts = { deleted: 0, missing: 0, forbidden: 0, failed: 0 };
    const skippedChannels = [];
    showProgressPanel({ title: 'Suppression des messages', total: targets.length, detail: 'préparation' });
    // Regroupement par salon : l acces se verifie une fois, pas par message.
    const byChannel = new Map();
    for (const target of targets) {
      if (!byChannel.has(target.channelId)) byChannel.set(target.channelId, []);
      byChannel.get(target.channelId).push(target);
    }
    try {
      let sincePause = 0;
      let reactived = 0;
      for (const [channelId, group] of byChannel) {
        if (!(await this.channelIsAccessible(channelId))) {
          counts.forbidden += group.length;
          skippedChannels.push({ channelId, count: group.length });
          this.deleteProgress.done += group.length;
          this.render();
          continue;
        }
        const channel = this.package.channels.find(candidate => String(candidate.id) === String(channelId));
        if (!channel) {
          counts.failed += group.length;
          this.deleteProgress.done += group.length;
          continue;
        }
        const onProgress = async () => {
          this.deleteProgress.done += 1;
          sincePause += 1;
          // Le panneau donne le sentiment d avance et nomme le salon traite :
          // sans lui, une longue suppression parait bloquee.
          updateProgressPanel({
            done: this.deleteProgress.done,
            total: this.deleteProgress.total,
            detail: `${displayChannelName(channel)} — suppression ${this.deleteProgress.done}/${this.deleteProgress.total}`,
          });
          if (sincePause >= 10) { sincePause = 0; this.render(); await new Promise(resolve => setTimeout(resolve, 150)); }
        };
        const outcome = await this.deleteChannelGroup(channel, group, counts, onProgress);
        if (outcome.reactivated) reactived += 1;
        else if (channel.type === 'THREAD') {
          counts.reasons = counts.reasons || {};
          const reason = 'fil de discussion non réactivable';
          counts.reasons[reason] = (counts.reasons[reason] || 0) + 1;
        }
      }
      const skipped = skippedChannels.length
        ? ` · ${skippedChannels.length} salon${skippedChannels.length > 1 ? 's' : ''} inaccessible${skippedChannels.length > 1 ? 's' : ''} ignoré${skippedChannels.length > 1 ? 's' : ''}`
        : '';
      const resume = summarizeDelete(counts, counts.reasons).text + skipped + (reactived ? ` · ${reactived} fil${reactived > 1 ? 's' : ''} réarchivé${reactived > 1 ? 's' : ''}` : '');
      showNotification(resume);
      finishProgressPanel({ detail: resume });
    } finally { this.isDeleting = false; this.deleteProgress = null; this.render(); }
  }
}
