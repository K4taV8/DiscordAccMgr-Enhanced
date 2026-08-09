import { getDMsList, copyToClipboard } from '../utils/discord.js';
import { deleteDMMessages } from '../utils/messageDeleter.js';
import { removeReactionsFromChannel } from '../utils/reactionRemover.js';
import { handleBulkDMActions } from '../utils/bulkDMHandler.js';
import { confirmAction } from '../utils/ui.js';
import { escHtml, escJs } from '../utils/emojiUtils.js';
import { preservePageScroll } from '../utils/domManager.js';

export class DMManager {
  constructor(contentArea) {
    this.contentArea = contentArea;
    this.isDeleting = false;
  }

  async refreshDMsList() {
    try {
      const dms = await getDMsList();
      
      preservePageScroll(this.contentArea, () => `
        <h2>DMs List</h2>
        <div class="actions-bar">
          <button id="selectAllDMsBtn" class="btn btn-secondary" onclick="window.dmManager.toggleSelectAllDMs()">Select All</button>
          <button id="deleteSelectedMessagesBtn" class="btn btn-secondary" onclick="window.dmManager.deleteSelectedMessages()" disabled>Delete Selected Messages</button>
          <button id="removeSelectedReactionsBtn" class="btn btn-secondary" onclick="window.dmManager.removeSelectedReactions()" disabled>Remove Selected Reactions</button>
          <button id="closeSelectedDMsBtn" class="btn btn-secondary" onclick="window.dmManager.closeSelectedDMs()" disabled>Close Selected DMs</button>
        </div>
        <div id="dmsList">
          ${dms.map(dm => `
            <div class="list-item" data-id="${dm.id}" data-username="${encodeURIComponent(dm.username)}">
              <div class="list-item-left">
                <input type="checkbox" class="dm-checkbox" onchange="window.dmManager.updateSelectedCount()">
                <img src="${escHtml(dm.avatar)}" alt="${escHtml(dm.username)}" loading="lazy">
                <div class="user-info">
                  <span class="display-name">${escHtml(dm.displayName)}</span>
                  <span class="username">(${escHtml(dm.username)})</span>
                </div>
              </div>
              <div class="button-group">
                <button onclick="window.dmManager.copyToClipboard('${dm.id}')" class="btn btn-secondary">Copy ID</button>
                <button onclick="window.dmManager.deleteDMMessages('${dm.id}', '${escJs(dm.username)}', false)" class="btn btn-secondary">Delete Messages</button>
                <button onclick="window.dmManager.deleteDMMessages('${dm.id}', '${escJs(dm.username)}', true)" class="btn btn-secondary">Delete Oldest First</button>
                <button onclick="window.dmManager.removeReactions(this, '${dm.id}', '${escJs(dm.username)}')" class="btn btn-secondary">Remove Reactions</button>
                <button onclick="window.dmManager.closeDM(this, '${dm.id}')" class="btn btn-danger">Close DM</button>
              </div>
            </div>
          `).join('')}
        </div>
      `);
    } catch (error) {
      this.contentArea.innerHTML = '<p class="error">Failed to load DMs</p>';
    }
  }

  toggleSelectAllDMs() {
    const checkboxes = document.querySelectorAll('.dm-checkbox');
    const selectAllBtn = document.getElementById('selectAllDMsBtn');
    const isSelectAll = selectAllBtn.textContent === 'Select All';
    
    checkboxes.forEach(checkbox => checkbox.checked = isSelectAll);
    selectAllBtn.textContent = isSelectAll ? 'Deselect All' : 'Select All';
    this.updateSelectedCount();
  }

  updateSelectedCount() {
    const selectedCount = document.querySelectorAll('.dm-checkbox:checked').length;
    const deleteSelectedBtn = document.getElementById('deleteSelectedMessagesBtn');
    const closeSelectedBtn = document.getElementById('closeSelectedDMsBtn');
    const removeSelectedBtn = document.getElementById('removeSelectedReactionsBtn');
    
    deleteSelectedBtn.disabled = selectedCount === 0;
    closeSelectedBtn.disabled = selectedCount === 0;
    removeSelectedBtn.disabled = selectedCount === 0;
    
    deleteSelectedBtn.textContent = `Delete Selected Messages (${selectedCount})`;
    closeSelectedBtn.textContent = `Close Selected DMs (${selectedCount})`;
    removeSelectedBtn.textContent = `Remove Selected Reactions (${selectedCount})`;
  }

  async deleteSelectedMessages() {
    if (this.isDeleting) return;
    const selectedCount = document.querySelectorAll('.dm-checkbox:checked').length;
    if (selectedCount === 0) return;
    if (!(await confirmAction('Delete Messages', `Delete your messages in ${selectedCount} selected DM(s)? This cannot be undone.`))) return;
    this.isDeleting = true;

    try {
      const selectedDMs = Array.from(document.querySelectorAll('.dm-checkbox:checked')).map(checkbox => {
        const item = checkbox.closest('.list-item');
        return {
          id: item.dataset.id,
          username: decodeURIComponent(item.dataset.username)
        };
      });

      await handleBulkDMActions(selectedDMs, 'delete', window.electronAPI);
      this.refreshDMsList();
    } finally {
      this.isDeleting = false;
    }
  }

  async closeSelectedDMs() {
    if (this.isDeleting) return;
    const selectedCount = document.querySelectorAll('.dm-checkbox:checked').length;
    if (selectedCount === 0) return;
    if (!(await confirmAction('Close DMs', `Close ${selectedCount} selected DM(s)? Ongoing conversations will be deleted.`))) return;
    this.isDeleting = true;

    try {
      const selectedDMs = Array.from(document.querySelectorAll('.dm-checkbox:checked')).map(checkbox => {
        const item = checkbox.closest('.list-item');
        return {
          id: item.dataset.id,
          username: decodeURIComponent(item.dataset.username)
        };
      });

      await handleBulkDMActions(selectedDMs, 'close', window.electronAPI);
      this.refreshDMsList();
    } finally {
      this.isDeleting = false;
    }
  }

  copyToClipboard = copyToClipboard;

  async deleteDMMessages(channelId, username, oldestFirst = false, skipRefresh = false) {
    if (this.isDeleting) return;
    if (!(await confirmAction('Delete Messages', `Delete ALL your messages with ${username}? This cannot be undone.`))) return;
    this.isDeleting = true;

    try {
      await deleteDMMessages({
        channelId,
        username,
        electronAPI: window.electronAPI,
        onComplete: () => {
          this.isDeleting = false;
          if (!skipRefresh) {
            this.refreshDMsList();
          }
        },
        skipRefresh,
        oldestFirst
      });
    } catch (error) {
      console.error('Failed to delete messages:', error);
      this.isDeleting = false;
    }
  }

  async closeDM(btn, channelId) {
    if (this.isDeleting) return;
    if (!(await confirmAction('Close DM', 'Close this DM? The conversation will be deleted.'))) return;
    btn.disabled = true;

    try {
      const result = await window.electronAPI.closeDM(channelId);
      if (result.success) {
        this.refreshDMsList();
      }
    } catch (error) {
      console.error('Failed to close DM:', error);
      btn.disabled = false;
    }
  }

  async removeReactions(btn, channelId, username) {
    if (this.isDeleting) return;
    this.isDeleting = true;
    btn.disabled = true;

    try {
      await removeReactionsFromChannel({
        channelId,
        channelName: username,
        electronAPI: window.electronAPI,
        onComplete: () => {
          this.isDeleting = false;
          this.refreshDMsList();
        }
      });
    } catch (error) {
      console.error('Failed to remove reactions:', error);
      this.isDeleting = false;
      btn.disabled = false;
    }
  }

  async removeSelectedReactions() {
    if (this.isDeleting) return;
    const selectedCount = document.querySelectorAll('.dm-checkbox:checked').length;
    if (selectedCount === 0) return;
    if (!(await confirmAction('Remove Reactions', `Remove your reactions in ${selectedCount} selected DM(s)?`))) return;
    this.isDeleting = true;

    try {
      const selectedDMs = Array.from(document.querySelectorAll('.dm-checkbox:checked')).map(checkbox => {
        const item = checkbox.closest('.list-item');
        return { id: item.dataset.id, username: decodeURIComponent(item.dataset.username) };
      });

      const total = selectedDMs.length;
      let completed = 0;

      for (const dm of selectedDMs) {
        await removeReactionsFromChannel({
          channelId: dm.id,
          channelName: dm.username,
          electronAPI: window.electronAPI,
          skipRefresh: true
        });
        completed++;
      }

      this.refreshDMsList();
    } finally {
      this.isDeleting = false;
    }
  }
}
