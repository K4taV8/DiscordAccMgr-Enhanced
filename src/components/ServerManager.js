import { getServersList, copyToClipboard } from '../utils/discord.js';
import { showNotification, confirmAction } from '../utils/ui.js';
import { deleteServerMessages } from '../utils/serverMessageDeleter.js';
import { removeServerReactions } from '../utils/serverReactionRemover.js';
import { escHtml } from '../utils/emojiUtils.js';
import { cachedListRefresh, delegate } from '../utils/domManager.js';
import { bentoCard, listView, FloatingSelectionDock } from './bento.js';
import { openCleaningModeSelector } from './CleaningModeSelector.js';
import { finishProgressPanel, showProgressPanel, updateProgressPanel } from '../utils/progressPanel.js';

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
      console.error('Failed to mute server:', error);
      btn.disabled = false;
    }
  }

  async unmuteServer(serverId) {
    try {
      await window.electronAPI.unmuteServer(serverId);
      this.refreshServersList(true);
    } catch (error) {
      console.error('Failed to unmute server:', error);
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
        console.error('Failed to mute server:', error);
        failed++;
      }
    }
    if (failed > 0) {
      showNotification(`Failed to mute ${failed} server(s)`);
    }
    this.refreshServersList(true);
  }

  async refreshServersList(force = false) {
    try {
      const render = (servers) => {
        const scroller = this.contentArea.closest('.page-container') || this.contentArea;
        const top = scroller.scrollTop;
        const listMode = listView.isOn('servers');
        this.contentArea.innerHTML = `
        <div class="list-toolbar">
          <h2 class="page-title">Servers List <span class="list-count">${servers.length}</span></h2>
          <div class="toolbar-actions">
            ${listView.button('servers')}
            <button id="readAllBtn" class="btn btn-primary" data-action="readAll">Read All</button>
          </div>
        </div>
        <div id="serversList" class="bento-grid${listMode ? ' list-view' : ''}"></div>
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
          const end = Math.min(i + CHUNK, servers.length);
          list.insertAdjacentHTML('beforeend', servers.slice(i, end).map(row).join(''));
          i = end;
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
      if (btn) btn.textContent = `Read All (${done}/${total})`;
    });
    try {
      if (btn) btn.disabled = true;
      const result = await window.electronAPI.readAll();
      if (result.success) {
        // RED-3 : distinguer complétion totale / arrêt anticipé (échecs > 1/3).
        if (result.partial) {
          showNotification(`Marked ${result.done}/${result.total} as read — ${result.failed} failed, stopped early`);
        } else if (result.failed > 0) {
          showNotification(`Marked all as read (${result.failed} failed)`);
        } else {
          showNotification('Marked all as read!');
        }
      } else {
        showNotification('Failed to mark all as read');
      }
    } catch (error) {
      console.error('Read all error:', error);
      showNotification('Failed to mark all as read');
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
        console.error('Failed to read server:', error);
        failed++;
      }
    }
    showNotification(failed ? `Marked ${ids.length - failed}/${ids.length} as read` : 'Marked selected as read');
  }

  selectAllServers() {
    this.contentArea.querySelectorAll('.server-checkbox').forEach(cb => { cb.checked = true; });
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
    if (!(await confirmAction('Delete Messages', 'Delete ALL your messages in this server? This cannot be undone.'))) { this.isDeleting = false; return; }
    try {
      const item = document.querySelector(`.bento-card[data-id="${serverId}"]`);
      const serverName = item?.querySelector('.bento-name')?.textContent || 'this server';
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
    if (!(await confirmAction('Remove Reactions', 'Remove all your reactions in this server?'))) { this.isDeleting = false; return; }
    try {
      const item = document.querySelector(`.bento-card[data-id="${serverId}"]`);
      const serverName = item?.querySelector('.bento-name')?.textContent || 'this server';
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
    if (!(await confirmAction('Leave Server', 'Leave this server? This cannot be undone.'))) { this.isDeleting = false; return; }
    btn.disabled = true;
    try {
      await window.electronAPI.leaveServer(serverId);
      this.refreshServersList(true);
    } catch (error) {
      console.error('Failed to leave server:', error);
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

    // Le meme panneau que pour les DM et les groupes : la suppression d un
    // serveur parcourt tous ses salons et peut durer tres longtemps.
    const steps = (mode === 'messages' ? 1 : 0) + (mode === 'reactions' ? 1 : 0) + (mode === 'full' ? 3 : 0);
    let done = 0;
    showProgressPanel({ title: 'Nettoyage des serveurs', total: items.length * Math.max(1, steps), detail: 'démarrage' });
    try {
      for (const item of items) {
        const serverId = item.dataset.id;
        const serverName = item.querySelector('.bento-name')?.textContent || 'server';
        if (mode === 'messages' || mode === 'both' || mode === 'full') {
          try {
            await deleteServerMessages({ serverId, serverName, electronAPI: window.electronAPI, onComplete: () => {} });
          } catch (e) { console.error('Cleaning delete failed:', e); }
          done += 1;
        }
        if (mode === 'reactions' || mode === 'both' || mode === 'full') {
          try {
            await removeServerReactions({ serverId, serverName, electronAPI: window.electronAPI, onComplete: () => {} });
          } catch (e) { console.error('Cleaning reactions failed:', e); }
          done += 1;
        }
        if (mode === 'full') {
          try { await window.electronAPI.leaveServer(serverId); } catch (e) { console.error('Cleaning leave failed:', e); }
          done += 1;
        }
        updateProgressPanel({ done, detail: serverName });
      }
      this.refreshServersList(true);
      finishProgressPanel({ detail: `${items.length} serveur(s) traité(s)` });
    } finally {
      this.isDeleting = false;
    }
  }
}
