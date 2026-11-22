import { getServersList, copyToClipboard } from '../utils/discord.js';
import { showNotification, confirmAction } from '../utils/ui.js';
import { deleteServerMessages } from '../utils/serverMessageDeleter.js';
import { removeServerReactions } from '../utils/serverReactionRemover.js';
import { escHtml } from '../utils/emojiUtils.js';
import { cachedListRefresh, delegate } from '../utils/domManager.js';
import { bentoCard, listView, FloatingSelectionDock, listSearchHtml, applySearchTo, bindListSearch, checkVisibleBoxes } from './bento.js';
import { openCleaningModeSelector } from './CleaningModeSelector.js';
import { finishProgressPanel, showProgressPanel, updateProgressPanel } from '../utils/progressPanel.js';
import { acquireOperation, releaseOperation } from '../utils/operationLock.js';

export class ServerManager {
  constructor(contentArea) {
    this.contentArea = contentArea;
    this.isDeleting = false;

    // R03b : handlers inline → délégation d'événements (CSP sans 'unsafe-inline').
    const itemId = (el) => el.closest('.bento-card')?.dataset.id;
    this.actions = {
      readAll: () => this.readAll(),
      updateSelected: () => this.updateSelectedServersCount(),
      toggleView: (el) => listView.toggle(document.getElementById('serversList'), 'servers', el),
      copy: (el) => copyToClipboard(itemId(el)),
      mute: (el) => this.muteServer(el, itemId(el)),
      deleteMessages: (el) => this.deleteServerMessages(itemId(el)),
      removeReactions: (el) => this.removeServerReactions(itemId(el)),
      leave: (el) => this.leaveServer(el, itemId(el)),
    };
    delegate(contentArea, this.actions);

    this.searchQuery = '';
    this.listTotal = 0;
    bindListSearch(contentArea, this, () => this.applySearch());

    this.selectionDock = new FloatingSelectionDock({
      onSelectAll: () => this.selectAllServers(),
      onDeselectAll: () => this.deselectAllServers(),
      actions: [
        { label: '👁️ Marquer comme lu', tip: 'Marque tous les serveurs sélectionnés comme lus (aucune suppression).', className: 'btn-primary', onClick: () => this.readSelectedServers() },
        { label: '🔕 Mettre en sourdine', tip: 'Coupe les notifications des serveurs sélectionnés.', onClick: () => this.muteSelectedServers() },
        // Les 3 doublons (messages / réactions / quitter) sont couverts par les
        // 4 modes de « Nettoyer » : on ne les garde pas deux fois dans la barre.
        { label: '🧹 Nettoyer', tip: 'Ouvrir les 4 modes : messages, réactions, les deux, ou tout + quitter le serveur.', className: 'dock-combo', menu: true, onClick: (btn) => this.openCleaningMode(btn) },
      ],
    });
  }

  async muteServer(btn, serverId) {
    btn.disabled = true;
    try {
      await window.electronAPI.muteServer(serverId);
      this.refreshServersList(true);
    } catch (error) {
      console.error('Échec de la mise en sourdine :', error);
      btn.disabled = false;
    }
  }

  async unmuteServer(serverId) {
    try {
      await window.electronAPI.unmuteServer(serverId);
      this.refreshServersList(true);
    } catch (error) {
      console.error('Échec de la réactivation des notifications :', error);
    }
  }

  async muteSelectedServers() {
    const selectedServers = this.contentArea.querySelectorAll('.server-checkbox:checked');
    let failed = 0;
    for (const checkbox of selectedServers) {
      const serverItem = checkbox.closest('.bento-card');
      try {
        const result = await window.electronAPI.muteServer(serverItem.dataset.id);
        if (!result?.success) failed++;
      } catch (error) {
        console.error('Échec de la mise en sourdine :', error);
        failed++;
      }
    }
    if (failed > 0) {
      showNotification(`${failed} serveur(s) n’ont pas pu être mis en sourdine`);
    }
    this.refreshServersList(true);
  }

  async refreshServersList(force = false) {
    try {
      const render = (servers) => {
        const scroller = this.contentArea.closest('.page-container') || this.contentArea;
        const top = scroller.scrollTop;
        const listMode = listView.isOn('servers');
        this.listTotal = servers.length;
        this.contentArea.innerHTML = `
        <div class="list-toolbar list-toolbar-stacked">
          <div class="list-toolbar-head">
            <h2 class="page-title">Liste des serveurs <span class="list-count">${servers.length}</span></h2>
            <div class="toolbar-actions">
              ${listView.button('servers')}
            </div>
          </div>
          <div class="list-toolbar-search">
            ${listSearchHtml('servers', this.searchQuery)}
            <button id="readAllBtn" class="btn btn-primary" data-action="readAll">Tout marquer comme lu</button>
          </div>
        </div>
        <div id="serversList" class="bento-grid${listMode ? ' list-view' : ''}"></div>
        <p class="list-empty" data-list-empty hidden></p>
        `;
        scroller.scrollTop = top;
        const list = document.getElementById('serversList');
        // Phase C : rendu chunké (50 cartes/frame) — pas de frame bloquée à 200 lignes
        const CHUNK = 50;
        const row = (server) => bentoCard({
          id: server.id,
          name: server.name,
          icon: server.icon,
          fallbackIcon: 'https://cdn.discordapp.com/embed/avatars/0.png',
          iconAlt: server.name,
          checkboxClass: 'server-checkbox',
          badge: server.owner ? { label: '👑 Propriétaire', className: 'is-owner' } : null,
          quick: [
            { action: 'mute', label: 'Mettre en sourdine', emoji: '🔕' },
            { action: 'deleteMessages', label: 'Supprimer les messages', theme: 'danger', emoji: '🗑️' },
            { action: 'removeReactions', label: 'Retirer les réactions', theme: 'amber', emoji: '💥' },
            { action: 'leave', label: 'Quitter le serveur', theme: 'crimson', emoji: '🚪' },
          ],
        });
        let i = 0;
        const flush = () => {
          // La page a pu changer pendant le rendu : le conteneur est détaché,
          // on arrête d'écrire dedans (travail inutile).
          if (!list.isConnected) return;
          const end = Math.min(i + CHUNK, servers.length);
          list.insertAdjacentHTML('beforeend', servers.slice(i, end).map(row).join(''));
          i = end;
          // Rendu chunké : on re-applique le filtre a chaque tranche, pour que la
          // recherche tienne des les premieres cartes (pas seulement a la fin).
          this.applySearch();
          if (i < servers.length) requestAnimationFrame(flush);
        };
        requestAnimationFrame(flush);
        this.selectionDock.sync(0, 0);
      };
      await cachedListRefresh(this, () => getServersList(force), render, force);
    } catch (error) {
      this.contentArea.innerHTML = `<p class="error">${escHtml(error.message)}</p>`;
    }
  }

  async readAll() {
    const btn = document.getElementById('readAllBtn');
    const originalText = btn?.textContent;
    const unsubscribe = window.electronAPI?.onReadAllProgress?.(({ done, total }) => {
      if (btn) btn.textContent = `Tout marquer comme lu (${done}/${total})`;
    });
    try {
      if (btn) btn.disabled = true;
      const result = await window.electronAPI.readAll();
      if (result.success) {
        // RED-3 : distinguer complétion totale / arrêt anticipé (échecs > 1/3).
        if (result.partial) {
          showNotification(`${result.done}/${result.total} serveur(s) marqué(s) comme lu(s) — ${result.failed} échec(s), arrêt anticipé`);
        } else if (result.failed > 0) {
          showNotification(`Tous les serveurs ont été marqués comme lus (${result.failed} échec(s))`);
        } else {
          showNotification('Tous les serveurs ont été marqués comme lus !');
        }
      } else {
        showNotification('Échec du marquage comme lu');
      }
    } catch (error) {
      console.error('Erreur du marquage comme lu :', error);
      showNotification('Échec du marquage comme lu');
    } finally {
      unsubscribe?.();
      if (btn) { btn.disabled = false; btn.textContent = originalText; }
    }
  }

  async readSelectedServers() {
    const ids = [...this.contentArea.querySelectorAll('.server-checkbox:checked')]
      .map(cb => cb.closest('.bento-card')?.dataset.id)
      .filter(Boolean);
    if (ids.length === 0) return;
    let failed = 0;
    for (const id of ids) {
      try {
        const r = await window.electronAPI.readServer(id);
        if (!r?.success) failed++;
      } catch (error) {
        console.error('Échec du marquage du serveur comme lu :', error);
        failed++;
      }
    }
    showNotification(failed ? `${ids.length - failed}/${ids.length} serveur(s) marqué(s) comme lu(s)` : 'Les serveurs sélectionnés ont été marqués comme lus');
  }

  applySearch() {
    applySearchTo(this.contentArea, this.searchQuery, this.listTotal);
  }

  selectAllServers() {
    checkVisibleBoxes(this.contentArea, '.server-checkbox');
    this.updateSelectedServersCount();
  }

  // Vide la sélection quoi qu'il reste de coché.
  deselectAllServers() {
    this.contentArea.querySelectorAll('.server-checkbox').forEach(cb => { cb.checked = false; });
    this.updateSelectedServersCount();
  }

  updateSelectedServersCount() {
    const total = this.contentArea.querySelectorAll('.server-checkbox').length;
    const selected = this.contentArea.querySelectorAll('.server-checkbox:checked').length;
    this.selectionDock.sync(selected, total);
  }

  async deleteServerMessages(serverId) {
    if (this.isDeleting) return;
    this.isDeleting = true;
    if (!(await confirmAction('Supprimer les messages', 'Supprimer TOUS vos messages dans ce serveur ? Cette action est irréversible.'))) { this.isDeleting = false; return; }
    try {
      const item = document.querySelector(`.bento-card[data-id="${serverId}"]`);
      const serverName = item?.querySelector('.bento-name')?.textContent || 'ce serveur';
      await deleteServerMessages({
        serverId,
        serverName,
        electronAPI: window.electronAPI,
        onComplete: () => {}
      });
    } finally {
      this.isDeleting = false;
    }
  }

  async removeServerReactions(serverId) {
    if (this.isDeleting) return;
    this.isDeleting = true;
    if (!(await confirmAction('Retirer les réactions', 'Retirer toutes vos réactions dans ce serveur ?'))) { this.isDeleting = false; return; }
    try {
      const item = document.querySelector(`.bento-card[data-id="${serverId}"]`);
      const serverName = item?.querySelector('.bento-name')?.textContent || 'ce serveur';
      await removeServerReactions({
        serverId,
        serverName,
        electronAPI: window.electronAPI,
        onComplete: () => {}
      });
    } finally {
      this.isDeleting = false;
    }
  }

  copyToClipboard = copyToClipboard;

  async leaveServer(btn, serverId) {
    if (this.isDeleting) return;
    this.isDeleting = true;
    if (!(await confirmAction('Quitter le serveur', 'Quitter ce serveur ? Cette action est irréversible.'))) { this.isDeleting = false; return; }
    btn.disabled = true;
    try {
      const result = await window.electronAPI.leaveServer(serverId);
      // BUG-009 : {success:false} ignoré — ne pas rafraîchir comme si le serveur
      // avait été quitté.
      if (result?.success) {
        this.refreshServersList(true);
      } else {
        showNotification(result?.error || 'Échec : serveur non quitté');
        btn.disabled = false;
      }
    } catch (error) {
      console.error('Échec de la sortie du serveur :', error);
      showNotification('Échec : serveur non quitté');
      btn.disabled = false;
    } finally {
      this.isDeleting = false;
    }
  }

  openCleaningMode(anchor) {
    openCleaningModeSelector(anchor, {
      onSelect: (mode) => this.executeCleaningMode(mode),
    });
  }

  // Un seul point d'entrée pour les 4 modes de nettoyage. Ordre fixe
  // (messages → réactions → sortie) ; chaque étape tolère l'échec.
  async executeCleaningMode(mode) {
    if (this.isDeleting) return;
    this.isDeleting = true;
    const items = [...this.contentArea.querySelectorAll('.server-checkbox:checked')]
      .map(cb => cb.closest('.bento-card'))
      .filter(Boolean);
    if (items.length === 0) { this.isDeleting = false; return; }

    const modeLabels = {
      messages: 'supprimer vos messages',
      reactions: 'supprimer vos réactions',
      both: 'supprimer vos messages ET vos réactions',
      full: 'supprimer vos messages, vos réactions et quitter',
    };
    if (!(await confirmAction('Nettoyer', `${modeLabels[mode]} dans ${items.length} serveur(s) sélectionné(s) ?`))) { this.isDeleting = false; return; }

    // BUG-001 : une seule operation longue pilote le panneau a la fois.
    const lock = acquireOperation('Nettoyage des serveurs');
    if (!lock) {
      this.isDeleting = false;
      showNotification('Une autre opération est déjà en cours. Attendez sa fin.');
      return;
    }

    // Le meme panneau que pour les DM et les groupes : la suppression d un
    // serveur parcourt tous ses salons et peut durer tres longtemps.
    // BUG-023c : `both` exécute 2 étapes — l'ancienne formule les ignorait.
    const steps = (mode === 'messages' ? 1 : 0) + (mode === 'reactions' ? 1 : 0)
      + (mode === 'both' ? 2 : 0) + (mode === 'full' ? 3 : 0);
    let done = 0;
    let failures = 0;
    showProgressPanel({ title: 'Nettoyage des serveurs', total: items.length * Math.max(1, steps), detail: 'démarrage' });
    try {
      for (const item of items) {
        const serverId = item.dataset.id;
        const serverName = item.querySelector('.bento-name')?.textContent || 'ce serveur';
        if (mode === 'messages' || mode === 'both' || mode === 'full') {
          try {
            await deleteServerMessages({ serverId, serverName, electronAPI: window.electronAPI, onComplete: () => {} });
          } catch (e) { console.error('Échec de la suppression pendant le nettoyage :', e); failures++; }
          done += 1;
        }
        if (mode === 'reactions' || mode === 'both' || mode === 'full') {
          try {
            await removeServerReactions({ serverId, serverName, electronAPI: window.electronAPI, onComplete: () => {} });
          } catch (e) { console.error('Échec du retrait des réactions pendant le nettoyage :', e); failures++; }
          done += 1;
        }
        if (mode === 'full') {
          // BUG-009 : vérifier le retour de leaveServer.
          let ok = false;
          try { const r = await window.electronAPI.leaveServer(serverId); ok = !!r?.success; }
          catch (e) { console.error('Échec de la sortie pendant le nettoyage :', e); }
          if (!ok) failures++;
          done += 1;
        }
        updateProgressPanel({ done, detail: serverName });
      }
      this.refreshServersList(true);
      if (failures > 0) {
        finishProgressPanel({ detail: `${items.length} serveur(s) traité(s) — ${failures} étape(s) en échec`, status: 'failed' });
        showNotification(`${failures} opération(s) en échec lors du nettoyage`);
      } else {
        finishProgressPanel({ detail: `${items.length} serveur(s) traité(s)` });
      }
    } finally {
      releaseOperation(lock);
      this.isDeleting = false;
    }
  }
}
