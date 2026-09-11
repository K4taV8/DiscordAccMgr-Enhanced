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

    // R03b : handlers inline → délégation d'événements (CSP sans 'unsafe-inline').
    const item = (el) => el.closest('.bento-card');
    this.actions = {
      updateSelected: () => this.updateSelectedCount(),
      toggleView: (el) => listView.toggle(document.getElementById('groupsList'), 'groups', el),
      copy: (el) => this.copyId(item(el).dataset.id),
      deleteMessages: (el) => this.deleteMessages(item(el).dataset.id, decodeURIComponent(item(el).dataset.name)),
      removeReactions: (el) => this.removeReactions(el, item(el).dataset.id, decodeURIComponent(item(el).dataset.name)),
      leave: (el) => this.leaveGroup(el, item(el).dataset.id),
    };
    delegate(contentArea, this.actions);

    this.selectionDock = new FloatingSelectionDock({
      onSelectAll: () => this.toggleSelectAll(),
      actions: [
        { label: '🗑️ Supprimer les messages', className: 'btn-danger', onClick: () => this.deleteSelectedMessages() },
        { label: '💥 Supprimer les réactions', className: 'btn-danger', onClick: () => this.removeSelectedReactions() },
        { label: '⚡ Nettoyer & Quitter', className: 'dock-combo', onClick: () => this.cleanAndLeaveSelected() },
        { label: '🚪 Quitter', className: 'btn-danger', onClick: () => this.leaveSelectedGroups() },
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
        const GROUP_DEFAULT_AVATAR = 'https://cdn.discordapp.com/embed/avatars/0.png';
        // recipients exclut l'utilisateur connecté → +1 pour le total.
        const memberLabel = (count) => {
          const total = (count || 0) + 1;
          return total === 1 ? '1 membre (Seul)' : `${total} membres`;
        };
        // Avatar natif Discord : icône CDN si présente, sinon stack des 2 premiers membres.
        const avatarFor = (g) => {
          if (g.icon) return null; // image CDN standard (rendue par bentoCard)
          const members = g.members || [];
          const av1 = members[0]?.avatar || GROUP_DEFAULT_AVATAR;
          if (members.length < 2) {
            return `<img src="${escHtml(av1)}" alt="${escHtml(g.name)}" loading="lazy">`;
          }
          const av2 = members[1]?.avatar || GROUP_DEFAULT_AVATAR;
          return `<span class="group-avatar-stack">
            <img class="group-avatar-stack-back" src="${escHtml(av1)}" alt="" loading="lazy">
            <img class="group-avatar-stack-front" src="${escHtml(av2)}" alt="" loading="lazy">
          </span>`;
        };
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
            meta: memberLabel(group.recipients),
            icon: group.icon ? `${group.icon}?size=128` : null,
            fallbackIcon: group.icon ? GROUP_DEFAULT_AVATAR : null,
            iconAlt: group.name,
            avatarHtml: avatarFor(group),
            checkboxClass: 'group-checkbox',
            badge: { label: 'Group' },
            quick: [
              { action: 'deleteMessages', label: 'Delete Msgs', theme: 'danger', emoji: '🗑️' },
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

  // Combo 3-en-1 : Delete messages → Remove reactions → Leave, dans l'ordre.
  // Chaque étape tolère l'échec ; la sortie (Leave) est toujours tentée.
  async cleanAndLeaveSelected() {
    if (this.isDeleting) return;
    const selected = Array.from(document.querySelectorAll('.group-checkbox:checked')).map(checkbox => {
      const item = checkbox.closest('.bento-card');
      return { groupId: item.dataset.id, name: decodeURIComponent(item.dataset.name) };
    });
    if (selected.length === 0) return;
    if (!(await confirmAction('Nettoyer & Quitter', `Delete messages, remove reactions and leave ${selected.length} selected group(s)?`))) return;
    this.isDeleting = true;
    try {
      for (const g of selected) {
        try {
          await deleteDMMessages({
            channelId: g.groupId,
            username: g.name,
            electronAPI: window.electronAPI,
            isGroup: true,
            skipRefresh: true,
            quiet: true,
            onComplete: () => {},
          });
        } catch (e) { console.error('Combo delete failed:', e); }
        try {
          await removeReactionsFromChannel({ channelId: g.groupId, channelName: g.name, electronAPI: window.electronAPI, isGroup: true, onComplete: () => {} });
        } catch (e) { console.error('Combo reactions failed:', e); }
        try { await window.electronAPI.leaveGroup(g.groupId); } catch (e) { console.error('Combo leave failed:', e); }
      }
      this.refreshGroupsList(true);
    } finally {
      this.isDeleting = false;
    }
  }
}
