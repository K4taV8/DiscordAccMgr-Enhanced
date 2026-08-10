import { getServersList, copyToClipboard } from '../utils/discord.js';
import { showNotification, confirmAction } from '../utils/ui.js';
import { deleteServerMessages } from '../utils/serverMessageDeleter.js';
import { removeServerReactions } from '../utils/serverReactionRemover.js';
import { escHtml } from '../utils/emojiUtils.js';
import { cachedListRefresh } from '../utils/domManager.js';

export class ServerManager {
  constructor(contentArea) {
    this.contentArea = contentArea;
    this.isDeleting = false;
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
      const serverItem = checkbox.closest('.list-item');
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
        this.contentArea.innerHTML = `
        <h2 class="page-title">Servers List <span class="list-count">${servers.length}</span></h2>
        <div class="actions-bar">
          <button id="selectAllServersBtn" class="btn btn-secondary" onclick="window.serverManager.toggleSelectAllServers()">Select All</button>
          <button id="leaveSelectedServersBtn" class="btn btn-secondary" onclick="window.serverManager.leaveSelectedServers()" disabled>Leave Selected</button>
          <button id="muteSelectedServersBtn" class="btn btn-secondary" onclick="window.serverManager.muteSelectedServers()" disabled>Mute Selected</button>
          <button id="deleteSelectedServersMsgBtn" class="btn btn-secondary" onclick="window.serverManager.deleteSelectedServersMessages()" disabled>Delete Selected</button>
          <button id="removeSelectedServersReactionsBtn" class="btn btn-secondary" onclick="window.serverManager.removeSelectedServersReactions()" disabled>Remove Reactions</button>
          <button id="readAllBtn" class="btn btn-primary" onclick="window.serverManager.readAll()">Read All</button>
        </div>
        <div id="serversList"></div>
        `;
        scroller.scrollTop = top;
        const list = document.getElementById('serversList');
        // Phase C : rendu chunké (50 lignes/frame) — pas de frame bloquée à 200 lignes
        const CHUNK = 50;
        const row = (server) => `
          <div class="list-item" data-id="${server.id}">
            <div class="list-item-left">
              <input type="checkbox" class="server-checkbox" onchange="window.serverManager.updateSelectedServersCount()">
              <img src="${escHtml(server.icon)}" alt="${escHtml(server.name)}" loading="lazy">
              <span>${escHtml(server.name)}</span>
            </div>
            <div class="button-group">
              <button onclick="window.serverManager.copyToClipboard('${server.id}')" class="btn btn-secondary">Copy ID</button>
              <button onclick="window.serverManager.muteServer(this, '${server.id}')" class="btn btn-secondary">Mute</button>
              <button onclick="window.serverManager.deleteServerMessages('${server.id}')" class="btn btn-danger">Delete Msgs</button>
              <button onclick="window.serverManager.removeServerReactions('${server.id}')" class="btn btn-danger">Rm Reactions</button>
              <button onclick="window.serverManager.leaveServer(this, '${server.id}')" class="btn btn-danger">Leave</button>
            </div>
          </div>
        `;
        let i = 0;
        const flush = () => {
          const end = Math.min(i + CHUNK, servers.length);
          list.insertAdjacentHTML('beforeend', servers.slice(i, end).map(row).join(''));
          i = end;
          if (i < servers.length) requestAnimationFrame(flush);
        };
        requestAnimationFrame(flush);
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
        showNotification(result.failed > 0 ? `Marked all as read (${result.failed} failed)` : 'Marked all as read!');
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


  toggleSelectAllServers() {
    const checkboxes = document.querySelectorAll('.server-checkbox');
    const selectAllBtn = document.getElementById('selectAllServersBtn');
    const isSelectAll = selectAllBtn.textContent === 'Select All';
    
    checkboxes.forEach(checkbox => {
      checkbox.checked = isSelectAll;
    });
    
    selectAllBtn.textContent = isSelectAll ? 'Deselect All' : 'Select All';
    this.updateSelectedServersCount();
  }

  updateSelectedServersCount() {
    const selectedCount = document.querySelectorAll('.server-checkbox:checked').length;
    const leaveSelectedBtn = document.getElementById('leaveSelectedServersBtn');
    const muteSelectedBtn = document.getElementById('muteSelectedServersBtn');
    const deleteSelectedBtn = document.getElementById('deleteSelectedServersMsgBtn');
    const removeReactionsBtn = document.getElementById('removeSelectedServersReactionsBtn');
    
    leaveSelectedBtn.disabled = selectedCount === 0;
    muteSelectedBtn.disabled = selectedCount === 0;
    if (deleteSelectedBtn) {
      deleteSelectedBtn.disabled = selectedCount === 0;
      deleteSelectedBtn.textContent = `Delete Selected (${selectedCount})`;
    }
    if (removeReactionsBtn) {
      removeReactionsBtn.disabled = selectedCount === 0;
      removeReactionsBtn.textContent = `Remove Reactions (${selectedCount})`;
    }
    
    leaveSelectedBtn.textContent = `Leave Selected (${selectedCount})`;
    muteSelectedBtn.textContent = `Mute Selected (${selectedCount})`;
  }

  async leaveSelectedServers() {
    const selectedServers = document.querySelectorAll('.server-checkbox:checked');
    if (selectedServers.length === 0) return;
    if (!(await confirmAction('Leave Servers', `Leave ${selectedServers.length} selected server(s)? This cannot be undone.`))) return;
    for (const checkbox of selectedServers) {
      const serverItem = checkbox.closest('.list-item');
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
      const item = document.querySelector(`.list-item[data-id="${serverId}"]`);
      const serverName = item?.querySelector('span')?.textContent || 'this server';
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
        const serverItem = checkbox.closest('.list-item');
        await deleteServerMessages({
          serverId: serverItem.dataset.id,
          serverName: serverItem.querySelector('span')?.textContent || 'server',
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
      const item = document.querySelector(`.list-item[data-id="${serverId}"]`);
      const serverName = item?.querySelector('span')?.textContent || 'this server';
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
        const serverItem = checkbox.closest('.list-item');
        await removeServerReactions({
          serverId: serverItem.dataset.id,
          serverName: serverItem.querySelector('span')?.textContent || 'server',
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
