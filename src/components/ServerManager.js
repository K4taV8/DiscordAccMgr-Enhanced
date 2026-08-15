import { getServersList, copyToClipboard } from '../utils/discord.js';
import { showNotification, confirmAction } from '../utils/ui.js';
import { deleteServerMessages } from '../utils/serverMessageDeleter.js';
import { removeServerReactions } from '../utils/serverReactionRemover.js';
import { escHtml } from '../utils/emojiUtils.js';
import { cachedListRefresh, delegate } from '../utils/domManager.js';
import { bentoCard, listView, FloatingSelectionDock } from './bento.js';

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
      onSelectAll: () => this.toggleSelectAllServers(),
      actions: [
        { label: 'Read', className: 'btn-primary', onClick: () => this.readSelectedServers() },
        { label: 'Mute', onClick: () => this.muteSelectedServers() },
        { label: 'Delete Msgs', className: 'btn-danger', onClick: () => this.deleteSelectedServersMessages() },
        { label: 'Rm Reactions', className: 'btn-danger', onClick: () => this.removeSelectedServersReactions() },
        { label: 'Leave', className: 'btn-danger', onClick: () => this.leaveSelectedServers() },
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
    const selectedServers = document.querySelectorAll('.server-checkbox:checked');
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
          fallbackIcon: '/discord.png',
          iconAlt: server.name,
          checkboxClass: 'server-checkbox',
          badge: server.owner ? { label: '👑 Owner', className: 'is-owner' } : null,
          quick: [
            { action: 'mute', label: 'Mute' },
            { action: 'deleteMessages', label: 'Delete Msgs', danger: true },
            { action: 'removeReactions', label: 'Rm Reactions', danger: true },
            { action: 'leave', label: 'Leave', danger: true },
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
    const ids = [...document.querySelectorAll('.server-checkbox:checked')]
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

  toggleSelectAllServers() {
    const checkboxes = [...document.querySelectorAll('.server-checkbox')];
    const allChecked = checkboxes.length > 0 && checkboxes.every(cb => cb.checked);
    checkboxes.forEach(cb => cb.checked = !allChecked);
    this.updateSelectedServersCount();
  }

  updateSelectedServersCount() {
    const total = document.querySelectorAll('.server-checkbox').length;
    const selected = document.querySelectorAll('.server-checkbox:checked').length;
    this.selectionDock.sync(selected, total);
  }

  async leaveSelectedServers() {
    const selectedServers = document.querySelectorAll('.server-checkbox:checked');
    if (selectedServers.length === 0) return;
    if (!(await confirmAction('Leave Servers', `Leave ${selectedServers.length} selected server(s)? This cannot be undone.`))) return;
    for (const checkbox of selectedServers) {
      const serverItem = checkbox.closest('.bento-card');
      try {
        await window.electronAPI.leaveServer(serverItem.dataset.id);
        serverItem.remove();
      } catch (error) {
        console.error('Failed to leave server:', error);
      }
    }
    this.refreshServersList(true);
  }

  async deleteServerMessages(serverId) {
    if (this.isDeleting) return;
    if (!(await confirmAction('Delete Messages', 'Delete ALL your messages in this server? This cannot be undone.'))) return;
    this.isDeleting = true;
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

  async deleteSelectedServersMessages() {
    if (this.isDeleting) return;
    const selectedCount = document.querySelectorAll('.server-checkbox:checked').length;
    if (selectedCount === 0) return;
    if (!(await confirmAction('Delete Messages', `Delete your messages in ${selectedCount} selected server(s)? This cannot be undone.`))) return;
    this.isDeleting = true;
    try {
      const selectedServers = document.querySelectorAll('.server-checkbox:checked');
      for (const checkbox of selectedServers) {
        const serverItem = checkbox.closest('.bento-card');
        await deleteServerMessages({
          serverId: serverItem.dataset.id,
          serverName: serverItem.querySelector('.bento-name')?.textContent || 'server',
          electronAPI: window.electronAPI,
          onComplete: () => {}
        });
      }
      this.refreshServersList(true);
    } finally {
      this.isDeleting = false;
    }
  }

  async removeServerReactions(serverId) {
    if (this.isDeleting) return;
    if (!(await confirmAction('Remove Reactions', 'Remove all your reactions in this server?'))) return;
    this.isDeleting = true;
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

  async removeSelectedServersReactions() {
    if (this.isDeleting) return;
    const selectedCount = document.querySelectorAll('.server-checkbox:checked').length;
    if (selectedCount === 0) return;
    if (!(await confirmAction('Remove Reactions', `Remove your reactions in ${selectedCount} selected server(s)?`))) return;
    this.isDeleting = true;
    try {
      const selectedServers = document.querySelectorAll('.server-checkbox:checked');
      for (const checkbox of selectedServers) {
        const serverItem = checkbox.closest('.bento-card');
        await removeServerReactions({
          serverId: serverItem.dataset.id,
          serverName: serverItem.querySelector('.bento-name')?.textContent || 'server',
          electronAPI: window.electronAPI,
          onComplete: () => {}
        });
      }
      this.refreshServersList(true);
    } finally {
      this.isDeleting = false;
    }
  }

  copyToClipboard = copyToClipboard;

  async leaveServer(btn, serverId) {
    if (!(await confirmAction('Leave Server', 'Leave this server? This cannot be undone.'))) return;
    btn.disabled = true;
    try {
      await window.electronAPI.leaveServer(serverId);
      this.refreshServersList(true);
    } catch (error) {
      console.error('Failed to leave server:', error);
      btn.disabled = false;
    }
  }
}
