import { getDMsList, copyToClipboard } from '../utils/discord.js';
import { deleteDMMessages } from '../utils/messageDeleter.js';
import { removeReactionsFromChannel } from '../utils/reactionRemover.js';
import { confirmAction } from '../utils/ui.js';
import { escHtml } from '../utils/emojiUtils.js';
import { preservePageScroll, cachedListRefresh, delegate } from '../utils/domManager.js';
import { bentoCard, listView, FloatingSelectionDock } from './bento.js';
import { openCleaningModeSelector } from './CleaningModeSelector.js';

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
      cleanBoth: (el) => this.cleanBoth(el, item(el).dataset.id, decodeURIComponent(item(el).dataset.username)),
      close: (el) => this.closeDM(el, item(el).dataset.id),
    };
    delegate(contentArea, this.actions);

    this.selectionDock = new FloatingSelectionDock({
      onSelectAll: () => this.toggleSelectAllDMs(),
      onDeselectAll: () => this.deselectAllDMs(),
      actions: [
        // Un seul bouton : les 4 modes de « Nettoyer » couvrent messages,
        // réactions, les deux, et fermeture du DM. Pas de doublon dans la barre.
        { label: '🧹 Nettoyer', tip: 'Ouvrir les 4 modes : messages, réactions, les deux, ou tout + fermeture du DM.', className: 'dock-combo', onClick: (btn) => this.openCleaningMode(btn) },
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
              // Nettoyage combiné sur CE DM : messages + réactions, sans le fermer.
              { action: 'cleanBoth', label: 'Msgs + Réac', theme: 'combo', emoji: '📦' },
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

  // Vide la sélection quoi qu'il reste de coché — le toggle « Tout sélectionner »
  // ne décoche que si TOUT était coché, sinon il rebranche tout.
  deselectAllDMs() {
    this.contentArea.querySelectorAll('.dm-checkbox').forEach(cb => { cb.checked = false; });
    this.updateSelectedCount();
  }

  updateSelectedCount() {
    const total = this.contentArea.querySelectorAll('.dm-checkbox').length;
    const selected = this.contentArea.querySelectorAll('.dm-checkbox:checked').length;
    this.selectionDock.sync(selected, total);
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

  // Nettoyage combiné sur un seul DM : messages PUIS réactions, et surtout
  // SANS closeDM — le DM reste dans la liste. Chaque étape est indépendante :
  // un échec sur les messages n'empêche pas les réactions (et inversement).
  async cleanBoth(btn, channelId, username) {
    if (this.isDeleting) return;
    if (!(await confirmAction('Nettoyer', `Supprimer vos messages ET vos réactions avec ${username} ? Le DM restera ouvert.`))) return;
    this.isDeleting = true;
    btn.disabled = true;

    try {
      await deleteDMMessages({
        channelId,
        username,
        electronAPI: window.electronAPI,
        skipRefresh: true,
        onComplete: () => {},
      });
    } catch (error) {
      console.error('Clean both (messages) failed:', error);
    }

    try {
      await removeReactionsFromChannel({
        channelId,
        channelName: username,
        electronAPI: window.electronAPI,
        onComplete: () => {},
      });
    } catch (error) {
      console.error('Clean both (reactions) failed:', error);
    } finally {
      this.isDeleting = false;
      btn.disabled = false;
      this.refreshDMsList(true);
    }
  }

  openCleaningMode(anchor) {
    openCleaningModeSelector(anchor, {
      onSelect: (mode) => this.executeCleaningMode(mode),
    });
  }

  async executeCleaningMode(mode) {
    if (this.isDeleting) return;
    const selected = Array.from(document.querySelectorAll('.dm-checkbox:checked')).map(checkbox => {
      const item = checkbox.closest('.bento-card');
      return { channelId: item.dataset.id, username: decodeURIComponent(item.dataset.username) };
    });
    if (selected.length === 0) return;

    const modeLabels = {
      messages: 'supprimer les messages',
      reactions: 'supprimer les réactions',
      both: 'supprimer messages et réactions',
      full: 'supprimer messages, réactions et fermer les DM'
    };
    if (!(await confirmAction('Nettoyer', `Confirmer : ${modeLabels[mode]} dans ${selected.length} DM(s) sélectionné(s) ?`))) return;

    this.isDeleting = true;
    try {
      for (const dm of selected) {
        if (mode === 'messages' || mode === 'both' || mode === 'full') {
          try {
            await deleteDMMessages({ channelId: dm.channelId, username: dm.username, electronAPI: window.electronAPI, onComplete: () => {}, skipRefresh: true, quiet: true });
          } catch (e) { console.error('Cleaning delete failed:', e); }
        }
        if (mode === 'reactions' || mode === 'both' || mode === 'full') {
          try {
            await removeReactionsFromChannel({ channelId: dm.channelId, channelName: dm.username, electronAPI: window.electronAPI, onComplete: () => {} });
          } catch (e) { console.error('Cleaning reactions failed:', e); }
        }
        if (mode === 'full') {
          try { await window.electronAPI.closeDM(dm.channelId); } catch (e) { console.error('Cleaning close failed:', e); }
        }
      }
      this.refreshDMsList(true);
    } finally {
      this.isDeleting = false;
    }
  }
}
