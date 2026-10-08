import { ProgressBar } from '../components/ProgressBar.js';
import { escHtml } from './emojiUtils.js';
import { humanDelay, sleep } from './delay.js';
import { scanLimiter, deleteLimiter } from './rateLimiter.js';
import { showNotification } from './ui.js';

export async function deleteDMMessages({
  channelId,
  username,
  electronAPI,
  onComplete = () => {},
  isGroup = false,
  oldestFirst = false,
  quiet = false,
  isStopSignal = null
}) {
  let modalOverlay = null;
  let progressBar = null;

  if (!quiet) {
    modalOverlay = document.createElement('div');
    modalOverlay.className = 'modal-overlay';
    modalOverlay.innerHTML = `
      <div class="modal-content">
        <h2>Deleting messages ${isGroup ? 'in' : 'with'} ${escHtml(username)}</h2>
        <div id="progressContainer">
          <div class="message-counter">
            <span id="deletedCount">0</span> / <span id="totalCount">calculating...</span> messages
            <span id="etaText" class="eta-text"></span>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modalOverlay);

    progressBar = new ProgressBar('progressContainer', {
      showCancelButton: true
    });
    progressBar.create();
    progressBar.show();
  }

  let shouldStop = false;
  progressBar?.onCancel(() => {
    shouldStop = true;
    progressBar.setCancelButtonText('Cancelling...');
    progressBar.disableCancelButton();
  });

  const timers = [];
  const clearTimers = () => { timers.forEach(clearTimeout); timers.length = 0; };
  const safeTimeout = (fn, ms) => { const id = setTimeout(fn, ms); timers.push(id); return id; };

  try {
    let deletedCount = 0;
    let failedCount = 0;
    let totalMessages = 0;
    let lastMessageId = null;
    let hasMore = true;
    let currentUserId = null;
    let deletableMessages = [];

    while (hasMore && !shouldStop && !(isStopSignal?.())) {
      const release = await scanLimiter.acquire();
      let result;
      try {
        result = isGroup 
          ? await electronAPI.getChannelMessages(channelId, lastMessageId)
          : await electronAPI.getDMMessages(channelId, lastMessageId);
      } finally {
        release();
      }

      if (!result.success) {
        throw new Error(`Failed to fetch messages: ${result.error?.message || String(result.error || 'network error')} — deletion aborted, remaining messages preserved.`);
      }

      if (!Array.isArray(result.messages) || !result.messages.length) {
        hasMore = false;
        continue;
      }

      if (!currentUserId && result.currentUserId) {
        currentUserId = result.currentUserId;
      }

      const messages = result.messages;
      const newDeletableMessages = messages.filter(msg => {
        if (isGroup) {
          if (!msg.author || msg.author.id !== currentUserId) return false;
          // BUG-01 : msg.type est un entier Discord, pas une chaîne — la
          // comparaison à 'VOICE_MESSAGE' était morte. Les messages vocaux sont
          // portés par attachments (audio), déjà couverts ci-dessous.
          return (
            (typeof msg.content === 'string' && msg.content.trim().length > 0) ||
            (msg.attachments || 0) > 0 ||
            (msg.embeds || 0) > 0
          );
        } else {
          return msg.isDeletable;
        }
      });
      
      deletableMessages.push(...newDeletableMessages);
      totalMessages = deletableMessages.length;
      const totalCountEl = document.getElementById('totalCount');
      if (totalCountEl) totalCountEl.textContent = totalMessages.toString();
      
      if (messages.length < 100) {
        hasMore = false;
      } else {
        lastMessageId = messages[messages.length - 1].id;
      }
    }

    if (shouldStop || isStopSignal?.()) {
      return 'cancelled';
    }

    if (totalMessages === 0) {
      progressBar?.update(100);
      return 'done';
    }

    if (oldestFirst) {
      deletableMessages.reverse();
    }

    const startedAt = Date.now();
    const etaText = quiet ? null : document.getElementById('etaText');

    for (const message of deletableMessages) {
      if (shouldStop || isStopSignal?.()) break;

      try {
        if (isGroup) {
          let ok = false;
          for (let attempt = 0; attempt < 3; attempt++) {
            const release = await deleteLimiter.acquire();
            let r;
            try { r = await electronAPI.deleteGroupMessage(channelId, message.id); }
            finally { release(); }
            if (r.success) { ok = true; break; }
            if (r.error === 'Rate limited') {
              await new Promise(resolve => setTimeout(resolve, ((r.retryAfter || 5) * 1000) + 1000));
            } else break;
          }
          if (!ok) { failedCount++; continue; }
        } else {
          let ok = false;
          for (let attempt = 0; attempt < 3; attempt++) {
            const release = await deleteLimiter.acquire();
            let r;
            try { r = await electronAPI.deleteDMMessage(channelId, message.id); }
            finally { release(); }
            if (r.success) { ok = true; break; }
            if (r.error === 'Rate limited') {
              await new Promise(resolve => setTimeout(resolve, ((r.retryAfter || 5) * 1000) + 1000));
            } else break;
          }
          if (!ok) { failedCount++; continue; }
        }
        
        deletedCount++;
        const deletedCountEl = document.getElementById('deletedCount');
        if (deletedCountEl) deletedCountEl.textContent = deletedCount.toString();
        progressBar?.update((deletedCount / totalMessages) * 100);

        const elapsed = Date.now() - startedAt;
        const perMsg = elapsed / Math.max(1, deletedCount);
        const remainingSec = Math.round((totalMessages - deletedCount) * perMsg / 1000);
        if (etaText && remainingSec > 5 && deletedCount >= 5) {
          const m = Math.floor(remainingSec / 60);
          const s = remainingSec % 60;
          etaText.textContent = m > 0 ? `— ETA ${m}m ${s}s` : `— ETA ${s}s`;
        }

        await sleep(humanDelay(200));
      } catch (error) {
        console.error('Unexpected IPC error:', error);
        failedCount++;
        await new Promise(resolve => setTimeout(resolve, 2500));
      }
    }

    if (!shouldStop && failedCount === 0) {
      progressBar?.update(100);
    }

    if (shouldStop || isStopSignal?.()) return 'cancelled';
    if (failedCount > 0) {
      console.warn(`[DelMessages] ${failedCount}/${totalMessages} suppression(s) échouée(s)`);
      // L'utilisateur doit savoir qu'il reste des messages : sans quoi un
      // statut « partial » invisible passe pour un succès complet.
      showNotification(`${failedCount} message(s) non supprimé(s)`);
      return 'partial';
    }
    return 'done';
  } catch (error) {
    console.error('Delete messages error:', error);
    const progressContainer = document.getElementById('progressContainer');
    if (progressContainer) {
      progressContainer.innerHTML = `<p class="error">${escHtml(error.message)}</p>`;
    }
  } finally {
    clearTimers();
    if (modalOverlay) {
      safeTimeout(() => {
        modalOverlay.remove();
        onComplete();
      }, 1000);
    } else {
      onComplete();
    }
  }
}
