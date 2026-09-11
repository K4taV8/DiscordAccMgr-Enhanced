import { getDMsList, copyToClipboard } from '../utils/discord.js';
import { deleteDMMessages } from '../utils/messageDeleter.js';
import { removeReactionsFromChannel, removeReactionsBulk } from '../utils/reactionRemover.js';
import { handleBulkDMActions } from '../utils/bulkDMHandler.js';
import { confirmAction } from '../utils/ui.js';
import { escHtml } from '../utils/emojiUtils.js';
import { preservePageScroll, cachedListRefresh, delegate } from '../utils/domManager.js';
import { bentoCard, listView, FloatingSelectionDock } from './bento.js';

export class DMManager {
  constructor(contentArea) {
    this.contentArea = contentArea;
    this.isDeleting = false;

    // R03b : handlers inline → délégation d'événements (CSP sans 'unsafe-inline').
    const item = (el) => el.closest('.bento-card');
    this.actions = {
      updateSelected: () => this.updateSelectedCount(),
      toggleView: (el) => listView.toggle(document.getElementById('dmsList'), 'dms', el),
      copy: (el) => copyToClipboard(item(el).dataset.id),
      deleteMessages: (el) => this.deleteDMMessages(item(el).dataset.id, decodeURIComponent(item(el).dataset.username)),
      removeReactions: (el) => this.removeReactions(el, item(el).dataset.id, decodeURIComponent(item(el).dataset.username)),
      close: (el) => this.closeDM(el, item(el).dataset.id),
    };
    delegate(contentArea, this.actions);

    this.selectionDock = new FloatingSelectionDock({
      onSelectAll: () => this.toggleSelectAllDMs(),
      actions: [
        { label: '🗑️ Supprimer les messages', className: 'btn-danger', onClick: () => this.deleteSelectedMessages() },
        { label: '💥 Supprimer les réactions', className: 'btn-danger', onClick: () => this.removeSelectedReactions() },
        { label: '⚡ Nettoyer & Quitter', className: 'dock-combo', onClick: () => this.cleanAndCloseSelected() },
        { label: '🚪 Fermer les DM', className: 'btn-danger', onClick: () => this.closeSelectedDMs() },
      ],
    });
  }

  async refreshDMsList(force = false) {
    try {
      const render = (dms) => {
        const listMode = listView.isOn('dms');
        preservePageScroll(this.contentArea, () => `
        <div class="list-toolbar">
          <h2 class="page-title">DMs List <span class="list-count">${dms.length}</span></h2>
          <div class="toolbar-actions">${listView.button('dms')}</div>
        </div>
        <div id="dmsList" class="bento-grid${listMode ? ' list-view' : ''}">
          ${(dms || []).map(dm => bentoCard({
            id: dm.id,
            attrs: ` data-username="${encodeURIComponent(dm.username)}"`,
            name: dm.displayName,
            meta: dm.username ? `@${dm.username}` : '',
            icon: dm.avatar,
            iconAlt: dm.displayName,
            checkboxClass: 'dm-checkbox',
            badge: { label: 'DM' },
            quick: [
              { action: 'deleteMessages', label: 'Delete Msgs', theme: 'danger', emoji: '🗑️' },
              { action: 'removeReactions', label: 'Rm Reactions', theme: 'amber', emoji: '💥' },
              { action: 'close', label: 'Close DM', theme: 'crimson', emoji: '🚪' },
            ],
          })).join('')}
        </div>
      `);
        this.selectionDock.sync(0, 0);
      };
      await cachedListRefresh(this, () => getDMsList(), render, force);
    } catch (error) {
      this.contentArea.innerHTML = '<p class="error">Failed to load DMs</p>';
    }
  }

  toggleSelectAllDMs() {
    const checkboxes = [...this.contentArea.querySelectorAll('.dm-checkbox')];
    const allChecked = checkboxes.length > 0 && checkboxes.every(cb => cb.checked);
    checkboxes.forEach(cb => cb.checked = !allChecked);
    this.updateSelectedCount();
  }

  updateSelectedCount() {
    const total = this.contentArea.querySelectorAll('.dm-checkbox').length;
    const selected = this.contentArea.querySelectorAll('.dm-checkbox:checked').length;
    this.selectionDock.sync(selected, total);
  }

  async deleteSelectedMessages() {
    if (this.isDeleting) return;
    const selectedCount = document.querySelectorAll('.dm-checkbox:checked').length;
    if (selectedCount === 0) return;
    if (!(await confirmAction('Delete Messages', `Delete your messages in ${selectedCount} selected DM(s)? This cannot be undone.`))) return;
    this.isDeleting = true;

    try {
      const selectedDMs = Array.from(document.querySelectorAll('.dm-checkbox:checked')).map(checkbox => {
        const item = checkbox.closest('.bento-card');
        return {
          id: item.dataset.id,
          username: decodeURIComponent(item.dataset.username)
        };
      });

      await handleBulkDMActions(selectedDMs, 'delete', window.electronAPI);
      this.refreshDMsList(true);
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
        const item = checkbox.closest('.bento-card');
        return {
          id: item.dataset.id,
          username: decodeURIComponent(item.dataset.username)
        };
      });

      await handleBulkDMActions(selectedDMs, 'close', window.electronAPI);
      this.refreshDMsList(true);
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
            this.refreshDMsList(true);
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
        this.refreshDMsList(true);
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
          this.refreshDMsList(true);
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
    const selectedDMs = Array.from(document.querySelectorAll('.dm-checkbox:checked')).map(checkbox => {
      const item = checkbox.closest('.bento-card');
      return { channelId: item.dataset.id, channelName: decodeURIComponent(item.dataset.username) };
    });
    if (selectedDMs.length === 0) return;
    if (!(await confirmAction('Remove Reactions', `Remove your reactions in ${selectedDMs.length} selected DM(s)?`))) return;
    this.isDeleting = true;

    try {
      // R03b/bugfix : UNE modal agrégée (plus d'empilement de modals qui
      // faisait « se lancer et se terminer direct »).
      await removeReactionsBulk({ targets: selectedDMs, electronAPI: window.electronAPI });
      this.refreshDMsList(true);
    } finally {
      this.isDeleting = false;
    }
  }

  // Combo 3-en-1 : Delete messages → Remove reactions → Close, dans l'ordre.
  // Chaque étape tolère l'échec ; la sortie (Close) est toujours tentée.
  async cleanAndCloseSelected() {
    if (this.isDeleting) return;
    const selected = Array.from(document.querySelectorAll('.dm-checkbox:checked')).map(checkbox => {
      const item = checkbox.closest('.bento-card');
      return { channelId: item.dataset.id, username: decodeURIComponent(item.dataset.username) };
    });
    if (selected.length === 0) return;
    if (!(await confirmAction('Nettoyer & Quitter', `Delete messages, remove reactions and close ${selected.length} selected DM(s)?`))) return;
    this.isDeleting = true;
    try {
      for (const dm of selected) {
        try {
          await deleteDMMessages({ channelId: dm.channelId, username: dm.username, electronAPI: window.electronAPI, onComplete: () => {}, skipRefresh: true, quiet: true });
        } catch (e) { console.error('Combo delete failed:', e); }
        try {
          await removeReactionsFromChannel({ channelId: dm.channelId, channelName: dm.username, electronAPI: window.electronAPI, onComplete: () => {} });
        } catch (e) { console.error('Combo reactions failed:', e); }
        try { await window.electronAPI.closeDM(dm.channelId); } catch (e) { console.error('Combo close failed:', e); }
      }
      this.refreshDMsList(true);
    } finally {
      this.isDeleting = false;
    }
  }
}
