import { confirmAction, showNotification } from '../utils/ui.js';
import { copyToClipboard } from '../utils/clipboard.js';
import { deleteDMMessages } from '../utils/messageDeleter.js';
import { removeReactionsFromChannel } from '../utils/reactionRemover.js';
import { escHtml } from '../utils/emojiUtils.js';
import { preservePageScroll, cachedListRefresh, delegate } from '../utils/domManager.js';
import { bentoCard, listView, FloatingSelectionDock } from './bento.js';
import { openCleaningModeSelector } from './CleaningModeSelector.js';
import { finishProgressPanel, showProgressPanel, updateProgressPanel } from '../utils/progressPanel.js';

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
      onSelectAll: () => this.selectAll(),
      onDeselectAll: () => this.deselectAll(),
      actions: [
        // Un seul bouton : les 4 modes de « Nettoyer » couvrent messages,
        // réactions, les deux, et sortie du groupe. Pas de doublon dans la barre.
        { label: '🧹 Nettoyer', tip: 'Ouvrir les 4 modes : messages, réactions, les deux, ou tout + quitter le groupe.', className: 'dock-combo', menu: true, onClick: (btn) => this.openCleaningMode(btn) },
      ],
    });
  }

  async refreshGroupsList(force = false) {
    try {
      const render = (result) => {
        if (!result.success) {
          this.contentArea.innerHTML = '<p class="error">Échec du chargement des groupes</p>';
          return;
        }
        const listMode = listView.isOn('groups');
        const GROUP_DEFAULT_AVATAR = 'https://cdn.discordapp.com/embed/avatars/0.png';
        // recipients exclut l'utilisateur connecté → +1 pour le total.
        const memberLabel = (count) => {
          const total = (count || 0) + 1;
          return total === 1 ? '1 membre (Seul)' : `${total} membres`;
        };
        // Avatar : icone de groupe si l'export en fournit une (rendue par
        // bentoCard), sinon l'avatar Discord par defaut — jamais du vide.
        const avatarFor = (g) => {
          if (g.icon) return null; // image CDN standard (rendue par bentoCard)
          return `<img src="${escHtml(GROUP_DEFAULT_AVATAR)}" alt="${escHtml(g.name)}" loading="lazy">`;
        };
        preservePageScroll(this.contentArea, () => `
        <div class="list-toolbar">
          <h2 class="page-title">Liste des groupes <span class="list-count">${result.groups.length}</span></h2>
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
            badge: { label: 'Groupe' },
            quick: [
              { action: 'deleteMessages', label: 'Supprimer les messages', theme: 'danger', emoji: '🗑️' },
              { action: 'removeReactions', label: 'Retirer les réactions', theme: 'amber', emoji: '💥' },
              { action: 'leave', label: 'Quitter le groupe', theme: 'crimson', emoji: '🚪' },
            ],
          })).join('')}
        </div>
      `);
        this.selectionDock.sync(0, 0);
      };
      await cachedListRefresh(this, () => window.electronAPI.getGroups(), render, force);
      // BUG-010 : un échec ne doit pas rester en cache 30 s.
      if (this._cache?.data?.success === false) this._cache = null;
    } catch (error) {
      this.contentArea.innerHTML = `<p class="error">${escHtml(error.message)}</p>`;
    }
  }

  selectAll() {
    this.contentArea.querySelectorAll('.group-checkbox').forEach(cb => { cb.checked = true; });
    this.updateSelectedCount();
  }

  // Vide la sélection quoi qu'il reste de coché.
  deselectAll() {
    this.contentArea.querySelectorAll('.group-checkbox').forEach(cb => { cb.checked = false; });
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
    this.isDeleting = true;
    if (!skipRefresh && !(await confirmAction('Supprimer les messages', `Supprimer TOUS vos messages dans ${groupName} ? Cette action est irréversible.`))) { this.isDeleting = false; return; }

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
    if (this.isDeleting) return;
    this.isDeleting = true;
    if (!(await confirmAction('Quitter le groupe', 'Quitter ce groupe ? Cette action est irréversible.'))) { this.isDeleting = false; return; }
    btn.disabled = true;
    try {
      const result = await window.electronAPI.leaveGroup(groupId);
      // BUG-009 : {success:false} ignoré avant — bouton laissé désactivé sans
      // explication. On notifie et on réactive.
      if (result?.success) {
        this.refreshGroupsList(true);
      } else {
        showNotification(result?.error || 'Échec : groupe non quitté');
        btn.disabled = false;
      }
    } catch (error) {
      console.error('Failed to leave group:', error);
      showNotification('Échec : groupe non quitté');
      btn.disabled = false;
    } finally {
      this.isDeleting = false;
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

  openCleaningMode(anchor) {
    openCleaningModeSelector(anchor, {
      onSelect: (mode) => this.executeCleaningMode(mode),
    });
  }

  // Un seul point d'entrée pour les 4 modes de nettoyage. L'ordre des étapes
  // est fixe (messages → réactions → sortie) et chaque étape tolère l'échec.
  async executeCleaningMode(mode) {
    if (this.isDeleting) return;
    this.isDeleting = true;
    const selected = Array.from(this.contentArea.querySelectorAll('.group-checkbox:checked')).map(checkbox => {
      const item = checkbox.closest('.bento-card');
      return { groupId: item.dataset.id, name: decodeURIComponent(item.dataset.name) };
    });
    if (selected.length === 0) { this.isDeleting = false; return; }

    const modeLabels = {
      messages: 'supprimer vos messages',
      reactions: 'supprimer vos réactions',
      both: 'supprimer vos messages ET vos réactions',
      full: 'supprimer vos messages, vos réactions et quitter',
    };
    if (!(await confirmAction('Nettoyer', `${modeLabels[mode]} dans ${selected.length} groupe(s) sélectionné(s) ?`))) { this.isDeleting = false; return; }

    // Comme pour les DM : le debit de Discord impose des attentes, le panneau
    // donne le sentiment d avance et nomme le groupe traite.
    // BUG-023c : `both` exécute 2 étapes (messages + réactions) — l'ancienne
    // formule ne comptait rien pour ce mode, et la barre s'arrêtait à 50 %.
    const steps = (mode === 'messages' ? 1 : 0) + (mode === 'reactions' ? 1 : 0)
      + (mode === 'both' ? 2 : 0) + (mode === 'full' ? 3 : 0);
    let done = 0;
    let failures = 0;
    showProgressPanel({ title: 'Nettoyage des groupes', total: selected.length * Math.max(1, steps), detail: 'démarrage' });
    try {
      for (const g of selected) {
        if (mode === 'messages' || mode === 'both' || mode === 'full') {
          let status = 'failed';
          try {
            status = await deleteDMMessages({
              channelId: g.groupId,
              username: g.name,
              electronAPI: window.electronAPI,
              isGroup: true,
              skipRefresh: true,
              quiet: true,
              onComplete: () => {},
            });
          } catch (e) { console.error('Cleaning delete failed:', e); }
          // BUG-014 : agréger le statut — `partial`/`cancelled`/`undefined`
          // n'est pas un succès et ne doit pas passer pour « traité ».
          if (status !== 'done') failures++;
          done += 1;
        }
        if (mode === 'reactions' || mode === 'both' || mode === 'full') {
          try {
            await removeReactionsFromChannel({ channelId: g.groupId, channelName: g.name, electronAPI: window.electronAPI, isGroup: true, quiet: true, onComplete: () => {} });
          } catch (e) { console.error('Cleaning reactions failed:', e); failures++; }
          done += 1;
        }
        if (mode === 'full') {
          // BUG-009 : vérifier `success` au lieu de compter un échec comme traité.
          let ok = false;
          try { const r = await window.electronAPI.leaveGroup(g.groupId); ok = !!r?.success; }
          catch (e) { console.error('Cleaning leave failed:', e); }
          if (!ok) failures++;
          done += 1;
        }
        updateProgressPanel({ done, detail: g.name });
      }
      this.refreshGroupsList(true);
      if (failures > 0) {
        finishProgressPanel({ detail: `${selected.length} groupe(s) traité(s) — ${failures} étape(s) en échec`, status: 'failed' });
        showNotification(`${failures} opération(s) en échec lors du nettoyage`);
      } else {
        finishProgressPanel({ detail: `${selected.length} groupe(s) traité(s)` });
      }
    } finally {
      this.isDeleting = false;
    }
  }
}
