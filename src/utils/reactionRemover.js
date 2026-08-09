import { ProgressBar } from '../components/ProgressBar.js';
import { formatEmojiForApi, escHtml } from './emojiUtils.js';
import { scanLimiter, deleteLimiter } from './rateLimiter.js';

export async function removeReactionsFromChannel({
  channelId,
  channelName,
  electronAPI,
  onComplete = () => {},
  skipRefresh = false,
  isGroup = false
}) {
  const modalOverlay = document.createElement('div');
  modalOverlay.className = 'modal-overlay';
  modalOverlay.innerHTML = `
    <div class="modal-content">
      <h2>Removing your reactions ${isGroup ? 'in' : 'with'} ${escHtml(channelName)}</h2>
      <div id="progressContainer">
        <div class="message-counter">
          <span id="processedCount">0</span> / <span id="totalCount">0</span> processed
          — <span id="removedCount">0</span> removed, <span id="failedCount">0</span> failed
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modalOverlay);

  const progressBar = new ProgressBar('progressContainer', {
    showCancelButton: true
  });
  progressBar.create();
  progressBar.show();

  let shouldStop = false;
  let currentUserId = null;

  progressBar.onCancel(() => {
    shouldStop = true;
    progressBar.setCancelButtonText('Cancelling...');
    progressBar.disableCancelButton();
  });

  const timers = [];
  const clearTimers = () => { timers.forEach(clearTimeout); timers.length = 0; };
  const safeTimeout = (fn, ms) => {
    clearTimers();
    const id = setTimeout(fn, ms);
    timers.push(id);
    return id;
  };

  const log = (msg) => {
    try { window.log?.(`[RmReactions] ${msg}`); } catch {}
    console.log(`[RmReactions] ${msg}`);
  };

  try {
    let messages = [];
    let lastMessageId = null;
    let hasMore = true;
    let totalMessagesFetched = 0;
    const MAX_MESSAGES = 2000;

    while (hasMore && !shouldStop && totalMessagesFetched < MAX_MESSAGES) {
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
        if (result.error === 'Rate limited') {
          await new Promise(resolve => setTimeout(resolve, ((result.retryAfter || 5) * 1000) + 1000));
          continue;
        }
        hasMore = false;
        continue;
      }

      if (!result.messages || result.messages.length === 0) {
        hasMore = false;
        continue;
      }

      if (!currentUserId && result.currentUserId) currentUserId = result.currentUserId;

      for (const msg of result.messages) {
        if (msg.reactions && msg.reactions.length > 0) {
          const userReactions = msg.reactions.filter(r => r.me === true);
          if (userReactions.length > 0) messages.push({ id: msg.id, reactions: userReactions });
        }
      }

      totalMessagesFetched += result.messages.length;

      if (result.messages.length < 100) hasMore = false;
      else lastMessageId = result.messages[result.messages.length - 1].id;
    }

    if (shouldStop) throw new Error('Operation cancelled');

    const totalReactions = messages.reduce((acc, msg) => acc + msg.reactions.length, 0);
    document.getElementById('totalCount').textContent = totalReactions.toString();

    if (totalReactions === 0) {
      progressBar.update(100);
      safeTimeout(() => { modalOverlay.remove(); onComplete(); }, 1000);
      return;
    }

    let removed = 0;
    let failed = 0;
    let processed = 0;

    const $ = (id) => document.getElementById(id);
    const refreshCounters = () => {
      $('processedCount').textContent = processed.toString();
      $('removedCount').textContent = removed.toString();
      $('failedCount').textContent = failed.toString();
    };

    for (const msg of messages) {
      if (shouldStop) break;
      for (const reaction of msg.reactions) {
        if (shouldStop) break;

        const emojiStr = formatEmojiForApi(reaction.emoji);
        if (!emojiStr) { failed++; processed++; refreshCounters(); continue; }

        let success = false;
        for (let attempt = 0; attempt < 3 && !shouldStop; attempt++) {
          const release = await deleteLimiter.acquire();
          let r;
          try { r = await electronAPI.removeOwnReaction(channelId, msg.id, emojiStr); }
          finally { release(); }
          if (r.success || r.error === 'noReaction') { success = true; break; }
          if (r.error === 'Rate limited') {
            deleteLimiter.throttle(r.retryAfter || 3);
            await new Promise(resolve => setTimeout(resolve, ((r.retryAfter || 3) * 1000) + 500));
          }
        }

        if (success) removed++;
        else failed++;

        processed++;
        refreshCounters();
        progressBar.update((processed / totalReactions) * 100);
      }
    }

    log(`Completed: removed=${removed}, failed=${failed}, total=${totalReactions}`);
  } catch (error) {
    console.error('Remove reactions error:', error);
    const progressContainer = document.getElementById('progressContainer');
    if (progressContainer) progressContainer.innerHTML = `<p class="error">${error.message}</p>`;
  } finally {
    clearTimers();
    safeTimeout(() => { modalOverlay.remove(); onComplete(); }, 1000);
  }
}
