import { getServersList, copyToClipboard } from '../utils/discord.js';
import { showNotification } from '../utils/ui.js';
import { deleteServerMessages } from '../utils/serverMessageDeleter.js';
import { removeServerReactions } from '../utils/serverReactionRemover.js';

export class ServerManager {
  constructor(contentArea) {
    this.contentArea = contentArea;
  }

  async muteServer(btn, serverId) {
    btn.disabled = true;
    try {
      await window.electronAPI.muteServer(serverId);
      this.refreshServersList();
    } catch (error) {
      console.error('Failed to mute server:', error);
      btn.disabled = false;
    }
  }
  
  async unmuteServer(serverId) {
    try {
      await window.electronAPI.unmuteServer(serverId);
      this.refreshServersList();
    } catch (error) {
      console.error('Failed to unmute server:', error);
    }
  }
  
  async muteSelectedServers() {
    const selectedServers = document.querySelectorAll('.server-checkbox:checked');
    for (const checkbox of selectedServers) {
      const serverItem = checkbox.closest('.list-item');
      try {
        await window.electronAPI.muteServer(serverItem.dataset.id);
      } catch (error) {
        console.error('Failed to mute server:', error);
      }
    }
    this.refreshServersList();
  }
  
  async refreshServersList() {
    try {
      const servers = await getServersList();
      
      this.contentArea.innerHTML = `
        <h2>Servers List</h2>
        <div class="actions-bar">
          <button id="selectAllServersBtn" onclick="window.serverManager.toggleSelectAllServers()">Select All</button>
          <button id="leaveSelectedServersBtn" onclick="window.serverManager.leaveSelectedServers()" disabled>Leave Selected</button>
          <button id="muteSelectedServersBtn" onclick="window.serverManager.muteSelectedServers()" disabled>Mute Selected</button>
          <button id="deleteSelectedServersMsgBtn" onclick="window.serverManager.deleteSelectedServersMessages()" disabled>Delete Selected</button>
          <button id="removeSelectedServersReactionsBtn" onclick="window.serverManager.removeSelectedServersReactions()" disabled>Remove Reactions</button>
          <button id="readAllBtn" onclick="window.serverManager.readAll()">Read All</button>
        </div>
        <div id="serversList">
          ${servers.map(server => `
            <div class="list-item" data-id="${server.id}">
              <div class="list-item-left">
                <input type="checkbox" class="server-checkbox" onchange="window.serverManager.updateSelectedServersCount()">
                <img src="${server.icon}" alt="${server.name}" loading="lazy">
                <span>${server.name}</span>
              </div>
              <div class="button-group">
                <button onclick="window.serverManager.copyToClipboard('${server.id}')" class="secondary-btn">Copy ID</button>
                <button onclick="window.serverManager.muteServer(this, '${server.id}')" class="secondary-btn">Mute</button>
                <button onclick="window.serverManager.deleteServerMessages('${server.id}')" class="danger-btn">Delete Msgs</button>
                <button onclick="window.serverManager.removeServerReactions('${server.id}')" class="danger-btn">Rm Reactions</button>
                <button onclick="window.serverManager.leaveServer(this, '${server.id}')" class="danger-btn">Leave</button>
              </div>
            </div>
          `).join('')}
        </div>
      `;
    } catch (error) {
      this.contentArea.innerHTML = `<p class="error">${error.message}</p>`;
    }
  }
  
  async readAll() {
    try {
      const result = await window.electronAPI.readAll();
      if (result.success) {
        showNotification('Marked all as read!');
      } else {
        showNotification('Failed to mark all as read');
      }
    } catch (error) {
      console.error('Read all error:', error);
      showNotification('Failed to mark all as read');
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
    for (const checkbox of selectedServers) {
      const serverItem = checkbox.closest('.list-item');
      try {
        await window.electronAPI.leaveServer(serverItem.dataset.id);
        serverItem.remove();
      } catch (error) {
        console.error('Failed to leave server:', error);
      }
    }
    this.refreshServersList();
  }

  async deleteServerMessages(serverId) {
    const item = document.querySelector(`.list-item[data-id="${serverId}"]`);
    const serverName = item?.querySelector('span')?.textContent || 'this server';
    await deleteServerMessages({
      serverId,
      serverName,
      electronAPI: window.electronAPI,
      onComplete: () => {}
    });
  }

  async deleteSelectedServersMessages() {
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
    this.refreshServersList();
  }

  async removeServerReactions(serverId) {
    const item = document.querySelector(`.list-item[data-id="${serverId}"]`);
    const serverName = item?.querySelector('span')?.textContent || 'this server';
    await removeServerReactions({
      serverId,
      serverName,
      electronAPI: window.electronAPI,
      onComplete: () => {}
    });
  }

  async removeSelectedServersReactions() {
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
    this.refreshServersList();
  }

  copyToClipboard = copyToClipboard;

  async leaveServer(btn, serverId) {
    btn.disabled = true;
    try {
      await window.electronAPI.leaveServer(serverId);
      this.refreshServersList();
    } catch (error) {
      console.error('Failed to leave server:', error);
      btn.disabled = false;
    }
  }
}