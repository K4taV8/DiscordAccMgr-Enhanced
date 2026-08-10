import { showProgressModal, confirmAction } from '../utils/ui.js';
import { copyToClipboard } from '../utils/clipboard.js';
import { escHtml } from '../utils/emojiUtils.js';
import { preservePageScroll, cachedListRefresh } from '../utils/domManager.js';

export class FriendsManager {
  constructor(contentArea) {
    this.contentArea = contentArea;
  }

  async refreshFriendsList(force = false) {
    try {
      const render = (result) => {
        if (!result.success) {
          this.contentArea.innerHTML = `<p class="error">${escHtml(result.error)}</p>`;
          return;
        }
        preservePageScroll(this.contentArea, () => `
        <h2 class="page-title">Friends List <span class="list-count">${result.friends.length}</span></h2>
        <div class="actions-bar">
          <button id="selectAllFriendsBtn" class="btn btn-secondary" onclick="window.friendsManager.toggleSelectAll()">Select All</button>
          <button id="removeSelectedFriendsBtn" class="btn btn-danger" onclick="window.friendsManager.removeSelected()" disabled>Remove Selected</button>
        </div>
        <div id="friendsList">
          ${result.friends.map(friend => `
            <div class="list-item" data-id="${friend.id}">
              <div class="list-item-left">
                <input type="checkbox" class="friend-checkbox" onchange="window.friendsManager.updateSelectedCount()">
                <img src="${escHtml(friend.avatar)}" alt="${escHtml(friend.username)}" loading="lazy">
                <div class="user-info">
                  <span class="display-name">${escHtml(friend.displayName)}</span>
                  <span class="username">(${escHtml(friend.username)})</span>
                </div>
              </div>
              <div class="button-group">
                <button onclick="window.friendsManager.copyId('${friend.id}')" class="btn btn-secondary">Copy ID</button>
                <button onclick="window.friendsManager.removeFriend(this, '${friend.id}')" class="btn btn-danger">Remove</button>
              </div>
            </div>
          `).join('')}
        </div>
      `);
      };
      await cachedListRefresh(this, () => window.electronAPI.getFriends(), render, force);
    } catch (error) {
      this.contentArea.innerHTML = `<p class="error">${escHtml(error.message)}</p>`;
    }
  }

  toggleSelectAll() {
    const checkboxes = this.contentArea.querySelectorAll('.friend-checkbox');
    const selectAllBtn = document.getElementById('selectAllFriendsBtn');
    const isSelectAll = selectAllBtn.textContent === 'Select All';
    
    checkboxes.forEach(checkbox => checkbox.checked = isSelectAll);
    selectAllBtn.textContent = isSelectAll ? 'Deselect All' : 'Select All';
    this.updateSelectedCount();
  }

  updateSelectedCount() {
    const selectedCount = this.contentArea.querySelectorAll('.friend-checkbox:checked').length;
    const removeSelectedBtn = document.getElementById('removeSelectedFriendsBtn');
    removeSelectedBtn.disabled = selectedCount === 0;
    removeSelectedBtn.textContent = `Remove Selected (${selectedCount})`;
  }

  async copyId(id) {
    await copyToClipboard(id);
  }

  async removeFriend(btn, friendId) {
    if (!(await confirmAction('Remove Friend', 'Remove this friend?'))) return;
    btn.disabled = true;
    try {
      await window.electronAPI.deleteFriend(friendId);
      this.refreshFriendsList(true);
    } catch (error) {
      console.error('Failed to remove friend:', error);
      btn.disabled = false;
    }
  }

  async removeSelected() {
    const selectedFriends = document.querySelectorAll('.friend-checkbox:checked');
    const total = selectedFriends.length;
    if (total === 0) return;
    if (!(await confirmAction('Remove Friends', `Remove ${total} selected friend(s)? This cannot be undone.`))) return;
    
    const { updateProgress, closeModal } = showProgressModal('Removing Friends', total);
    let completed = 0;

    for (const checkbox of selectedFriends) {
      const friendId = checkbox.closest('.list-item').dataset.id;
      try {
        await window.electronAPI.deleteFriend(friendId);
        completed++;
        updateProgress(completed);
      } catch (error) {
        console.error('Failed to remove friend:', error);
      }
    }

    setTimeout(() => {
      closeModal();
      this.refreshFriendsList(true);
    }, 1000);
  }
}
