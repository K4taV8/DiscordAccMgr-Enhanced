import { ProgressBar } from '../components/ProgressBar.js';
import { escHtml } from './emojiUtils.js';
import { humanDelay, sleep } from './delay.js';
import { scanLimiter, deleteLimiter } from './rateLimiter.js';

export async function deleteDMMessages({
  channelId,
  username,
  electronAPI,
  onComplete = () => {},
  skipRefresh = false,
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
        throw new Error(`Failed to fetch messages: ${result.error || 'network error'} — deletion aborted, remaining messages preserved.`);
      }

      if (!result.messages.length) {
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
          return (
            (typeof msg.content === 'string' && msg.content.trim().length > 0) ||
            (msg.attachments && msg.attachments.length > 0) ||
            (msg.embeds && msg.embeds.length > 0) ||
            msg.type === 'VOICE_MESSAGE'
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

      await sleep(humanDelay(250));
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
              deleteLimiter.throttle(r.retryAfter || 5);
              await new Promise(resolve => setTimeout(resolve, ((r.retryAfter || 5) * 1000) + 1000));
            } else break;
          }
          if (!ok) continue;
        } else {
          let ok = false;
          for (let attempt = 0; attempt < 3; attempt++) {
            const release = await deleteLimiter.acquire();
            let r;
            try { r = await electronAPI.deleteDMMessage(channelId, message.id); }
            finally { release(); }
            if (r.success) { ok = true; break; }
            if (r.error === 'Rate limited') {
              deleteLimiter.throttle(r.retryAfter || 5);
              await new Promise(resolve => setTimeout(resolve, ((r.retryAfter || 5) * 1000) + 1000));
            } else break;
          }
          if (!ok) continue;
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
        await new Promise(resolve => setTimeout(resolve, 2500));
      }
    }

    if (!shouldStop) {
      progressBar?.update(100);
    }

    if (shouldStop || isStopSignal?.()) return 'cancelled';
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
