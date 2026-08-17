import { showProgressModal, confirmAction } from '../utils/ui.js';
import { copyToClipboard } from '../utils/clipboard.js';
import { deleteDMMessages } from '../utils/messageDeleter.js';
import { removeReactionsFromChannel, removeReactionsBulk } from '../utils/reactionRemover.js';
import { escHtml } from '../utils/emojiUtils.js';
import { preservePageScroll, cachedListRefresh, delegate } from '../utils/domManager.js';
import { bentoCard, listView, FloatingSelectionDock } from './bento.js';

export class GroupManager {
  constructor(contentArea) {
    this.contentArea = contentArea;
    this.isDeleting = false;
    this.defaultGroupIcon = `data:image/svg+xml,${encodeURIComponent(`
      <svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="32" height="32" rx="16" fill="#5865F2"/>
        <path d="M22 12C22 14.2091 20.2091 16 18 16C15.7909 16 14 14.2091 14 12C14 9.79086 15.7909 8 18 8C20.2091 8 22 9.79086 22 12Z" fill="white"/>
        <path d="M10 20C10 17.7909 11.7909 16 14 16H22C24.2091 16 26 17.7909 26 20V22C26 23.1046 25.1046 24 24 24H12C10.8954 24 10 23.1046 10 22V20Z" fill="white"/>
        <path d="M12 14C12 15.1046 11.1046 16 10 16C8.89543 16 8 15.1046 8 14C8 12.8954 8.89543 12 10 12C11.1044 12 12 12.8954 12 14Z" fill="white"/>
        <path d="M6 19.5C6 18.1193 7.11929 17 8.5 17H11.5C12.8807 17 14 18.1193 14 19.5V22C14 23.1046 13.1046 24 12 24H8C6.89543 24 6 23.1046 6 22V19.5Z" fill="white"/>
      </svg>
    `)}`;

    // R03b : handlers inline → délégation d'événements (CSP sans 'unsafe-inline').
    const item = (el) => el.closest('.bento-card');
    this.actions = {
      updateSelected: () => this.updateSelectedCount(),
      toggleView: (el) => listView.toggle(document.getElementById('groupsList'), 'groups', el),
      copy: (el) => this.copyId(item(el).dataset.id),
      deleteMessages: (el) => this.deleteMessages(item(el).dataset.id, decodeURIComponent(item(el).dataset.name), el.dataset.oldest === 'true'),
      removeReactions: (el) => this.removeReactions(el, item(el).dataset.id, decodeURIComponent(item(el).dataset.name)),
      leave: (el) => this.leaveGroup(el, item(el).dataset.id),
    };
    delegate(contentArea, this.actions);

    this.selectionDock = new FloatingSelectionDock({
      onSelectAll: () => this.toggleSelectAll(),
      actions: [
        { label: 'Delete Msgs', className: 'btn-danger', onClick: () => this.deleteSelectedMessages() },
        { label: 'Rm Reactions', className: 'btn-danger', onClick: () => this.removeSelectedReactions() },
        { label: 'Leave', className: 'btn-danger', onClick: () => this.leaveSelectedGroups() },
      ],
    });
  }

  async refreshGroupsList(force = false) {
    try {
      const render = (result) => {
        if (!result.success) {
          this.contentArea.innerHTML = '<p class="error">Failed to load groups</p>';
          return;
        }
        const listMode = listView.isOn('groups');
        preservePageScroll(this.contentArea, () => `
        <div class="list-toolbar">
          <h2 class="page-title">Groups List <span class="list-count">${result.groups.length}</span></h2>
          <div class="toolbar-actions">${listView.button('groups')}</div>
        </div>
        <div id="groupsList" class="bento-grid${listMode ? ' list-view' : ''}">
          ${result.groups.map(group => bentoCard({
            id: group.id,
            attrs: ` data-name="${encodeURIComponent(group.name)}"`,
            name: group.name,
            meta: `${group.recipients} members`,
            icon: group.icon === '/discord.png' ? this.defaultGroupIcon : group.icon,
            fallbackIcon: this.defaultGroupIcon,
            iconAlt: group.name,
            checkboxClass: 'group-checkbox',
            badge: { label: 'Group' },
            quick: [
              { action: 'deleteMessages', label: 'Delete Msgs', theme: 'danger', emoji: '🗑️', attrs: ' data-oldest="false"' },
              { action: 'deleteMessages', label: 'Oldest First', theme: 'danger', emoji: '🗑️', attrs: ' data-oldest="true"' },
              { action: 'removeReactions', label: 'Rm Reactions', theme: 'amber', emoji: '💥' },
              { action: 'leave', label: 'Leave', theme: 'crimson', emoji: '🚪' },
            ],
          })).join('')}
        </div>
      `);
        this.selectionDock.sync(0, 0);
      };
      await cachedListRefresh(this, () => window.electronAPI.getGroups(), render, force);
    } catch (error) {
      this.contentArea.innerHTML = `<p class="error">${escHtml(error.message)}</p>`;
    }
  }

  toggleSelectAll() {
    const checkboxes = [...this.contentArea.querySelectorAll('.group-checkbox')];
    const allChecked = checkboxes.length > 0 && checkboxes.every(cb => cb.checked);
    checkboxes.forEach(cb => cb.checked = !allChecked);
    this.updateSelectedCount();
  }

  updateSelectedCount() {
    const total = this.contentArea.querySelectorAll('.group-checkbox').length;
    const selected = this.contentArea.querySelectorAll('.group-checkbox:checked').length;
    this.selectionDock.sync(selected, total);
  }

  async copyId(id) {
    await copyToClipboard(id);
  }

  async deleteMessages(groupId, groupName, oldestFirst = false, skipRefresh = false) {
    if (this.isDeleting) return;
    if (!skipRefresh && !(await confirmAction('Delete Messages', `Delete ALL your messages in ${groupName}? This cannot be undone.`))) return;
    this.isDeleting = true;

    try {
      await deleteDMMessages({
        channelId: groupId,
        username: groupName,
        electronAPI: window.electronAPI,
        onComplete: () => {
          this.isDeleting = false;
          if (!skipRefresh) {
            this.refreshGroupsList(true);
          }
        },
        skipRefresh,
        isGroup: true,
        oldestFirst
      });
    } catch (error) {
      console.error('Failed to delete messages:', error);
      this.isDeleting = false;
    }
  }

  async leaveGroup(btn, groupId) {
    if (!(await confirmAction('Leave Group', 'Leave this group? This cannot be undone.'))) return;
    btn.disabled = true;
    try {
      const result = await window.electronAPI.leaveGroup(groupId);
      if (result.success) {
        this.refreshGroupsList(true);
      }
    } catch (error) {
      console.error('Failed to leave group:', error);
      btn.disabled = false;
    }
  }

  async removeReactions(btn, groupId, groupName) {
    if (this.isDeleting) return;
    this.isDeleting = true;
    btn.disabled = true;

    try {
      await removeReactionsFromChannel({
        channelId: groupId,
        channelName: groupName,
        electronAPI: window.electronAPI,
        isGroup: true,
        onComplete: () => {
          this.isDeleting = false;
          this.refreshGroupsList(true);
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
    this.isDeleting = true;

    try {
      const selectedGroups = Array.from(document.querySelectorAll('.group-checkbox:checked')).map(checkbox => {
        const item = checkbox.closest('.bento-card');
        return { channelId: item.dataset.id, channelName: decodeURIComponent(item.dataset.name) };
      });

      await removeReactionsBulk({ targets: selectedGroups, electronAPI: window.electronAPI, isGroup: true });
      this.refreshGroupsList(true);
    } finally {
      this.isDeleting = false;
    }
  }

  async leaveSelectedGroups() {
    const selectedGroups = document.querySelectorAll('.group-checkbox:checked');
    const total = selectedGroups.length;
    if (total === 0) return;
    if (!(await confirmAction('Leave Groups', `Leave ${total} selected group(s)? This cannot be undone.`))) return;
    let completed = 0;

    const { updateProgress, closeModal } = showProgressModal('Leaving Groups', total);

    for (const checkbox of selectedGroups) {
      const groupItem = checkbox.closest('.bento-card');
      const groupId = groupItem.dataset.id;

      try {
        await window.electronAPI.leaveGroup(groupId);
        completed++;
        updateProgress(completed);
      } catch (error) {
        console.error('Failed to leave group:', error);
      }
    }

    setTimeout(() => {
      closeModal();
      this.refreshGroupsList(true);
    }, 1000);
  }

  async deleteSelectedMessages() {
    if (this.isDeleting) return;
    const selectedCount = document.querySelectorAll('.group-checkbox:checked').length;
    if (selectedCount === 0) return;
    if (!(await confirmAction('Delete Messages', `Delete your messages in ${selectedCount} selected group(s)? This cannot be undone.`))) return;
    this.isDeleting = true;

    const selectedGroups = document.querySelectorAll('.group-checkbox:checked');
    const total = selectedGroups.length;
    let completed = 0;

    const { updateProgress, closeModal } = showProgressModal('Deleting Messages', total);

    for (const checkbox of selectedGroups) {
      const groupItem = checkbox.closest('.bento-card');
      const groupId = groupItem.dataset.id;
      const groupName = decodeURIComponent(groupItem.dataset.name);

      // BUG-08 : appeler deleteDMMessages directement — deleteMessages() se
      // protège via isDeleting et aurait sauté toute la boucle (no-op silencieux).
      await deleteDMMessages({
        channelId: groupId,
        username: groupName,
        electronAPI: window.electronAPI,
        isGroup: true,
        skipRefresh: true,
        quiet: true,
        onComplete: () => {},
      });
      completed++;
      updateProgress(completed);
    }

    setTimeout(() => {
      closeModal();
      this.isDeleting = false;
      this.refreshGroupsList(true);
    }, 1000);
  }
}
