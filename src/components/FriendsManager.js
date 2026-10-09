import { showProgressModal, confirmAction, showNotification } from '../utils/ui.js';
import { copyToClipboard } from '../utils/clipboard.js';
import { escHtml } from '../utils/emojiUtils.js';
import { preservePageScroll, cachedListRefresh, delegate } from '../utils/domManager.js';
import { bentoCard, listView, FloatingSelectionDock } from './bento.js';

export class FriendsManager {
  constructor(contentArea) {
    this.contentArea = contentArea;
    this.isDeleting = false;

    // R03b : handlers inline → délégation d'événements (CSP sans 'unsafe-inline').
    const itemId = (el) => el.closest('.bento-card')?.dataset.id;
    this.actions = {
      updateSelected: () => this.updateSelectedCount(),
      toggleView: (el) => listView.toggle(document.getElementById('friendsList'), 'friends', el),
      copy: (el) => this.copyId(itemId(el)),
      remove: (el) => this.removeFriend(el, itemId(el)),
    };
    delegate(contentArea, this.actions);

    this.selectionDock = new FloatingSelectionDock({
      onSelectAll: () => this.selectAllFriends(),
      onDeselectAll: () => this.deselectAllFriends(),
      actions: [
        { label: '🚫 Supprimer', className: 'btn-danger', onClick: () => this.removeSelected() },
      ],
    });
  }

  async refreshFriendsList(force = false) {
    try {
      const render = (result) => {
        if (!result.success) {
          this.contentArea.innerHTML = `<p class="error">${escHtml(result.error)}</p>`;
          return;
        }
        const listMode = listView.isOn('friends');
        preservePageScroll(this.contentArea, () => `
        <div class="list-toolbar">
          <h2 class="page-title">Friends List <span class="list-count">${result.friends.length}</span></h2>
          <div class="toolbar-actions">${listView.button('friends')}</div>
        </div>
        <div id="friendsList" class="bento-grid${listMode ? ' list-view' : ''}">
          ${result.friends.map(friend => bentoCard({
            id: friend.id,
            name: friend.displayName,
            meta: friend.username ? `@${friend.username}` : '',
            icon: friend.avatar,
            iconAlt: friend.displayName,
            checkboxClass: 'friend-checkbox',
            badge: { label: 'Ami' },
            quick: [
              { action: 'remove', label: "Retirer l'ami", theme: 'crimson', emoji: '🚫' },
            ],
          })).join('')}
        </div>
      `);
        this.selectionDock.sync(0, 0);
      };
      await cachedListRefresh(this, () => window.electronAPI.getFriends(), render, force);
      // BUG-010 : ne pas conserver 30 s un échec en cache (sinon la liste reste
      // en erreur malgré un réseau revenu). `domManager` est hors périmètre :
      // on invalide le cache côté appelant.
      if (this._cache?.data?.success === false) this._cache = null;
    } catch (error) {
      this.contentArea.innerHTML = `<p class="error">${escHtml(error.message)}</p>`;
    }
  }

  selectAllFriends() {
    this.contentArea.querySelectorAll('.friend-checkbox').forEach(cb => { cb.checked = true; });
    this.updateSelectedCount();
  }

  deselectAllFriends() {
    this.contentArea.querySelectorAll('.friend-checkbox').forEach(cb => { cb.checked = false; });
    this.updateSelectedCount();
  }

  updateSelectedCount() {
    const total = this.contentArea.querySelectorAll('.friend-checkbox').length;
    const selected = this.contentArea.querySelectorAll('.friend-checkbox:checked').length;
    this.selectionDock.sync(selected, total);
  }

  async copyId(id) {
    await copyToClipboard(id);
  }

  async removeFriend(btn, friendId) {
    if (this.isDeleting) return;
    this.isDeleting = true;
    if (!(await confirmAction('Remove Friend', 'Remove this friend?'))) { this.isDeleting = false; return; }
    btn.disabled = true;
    try {
      const result = await window.electronAPI.deleteFriend(friendId);
      // BUG-009 : un {success:false} n'est pas un succès — ne pas rafraîchir
      // comme si l'ami avait disparu, et rendre le bouton utilisable.
      if (result?.success) {
        this.refreshFriendsList(true);
      } else {
        showNotification(result?.error || 'Échec : ami non retiré');
        btn.disabled = false;
      }
    } catch (error) {
      console.error('Failed to remove friend:', error);
      showNotification('Échec : ami non retiré');
      btn.disabled = false;
    } finally {
      this.isDeleting = false;
    }
  }

  async removeSelected() {
    if (this.isDeleting) return;
    this.isDeleting = true;
    // try/finally : une exception (confirmation, modale, IPC) ne doit jamais
    // laisser le verrou posé, sinon la page entière reste bloquée.
    try {
      const selectedFriends = this.contentArea.querySelectorAll('.friend-checkbox:checked');
      const total = selectedFriends.length;
      if (total === 0) return;
      if (!(await confirmAction('Remove Friends', `Remove ${total} selected friend(s)? This cannot be undone.`))) return;

      const { updateProgress, closeModal } = showProgressModal('Removing Friends', total);
      let completed = 0;
      let failed = 0;

      for (const checkbox of selectedFriends) {
        const friendId = checkbox.closest('.bento-card').dataset.id;
        try {
          const result = await window.electronAPI.deleteFriend(friendId);
          // BUG-009 : tester `success` — un {success:false} ne compte pas.
          if (result?.success) completed++;
          else failed++;
        } catch (error) {
          console.error('Failed to remove friend:', error);
          failed++;
        }
        updateProgress(completed + failed);
      }

      setTimeout(() => {
        closeModal();
        if (failed > 0) showNotification(`${failed} ami(s) non supprimé(s)`);
        this.refreshFriendsList(true);
      }, 1000);
    } finally {
      this.isDeleting = false;
    }
  }
}
