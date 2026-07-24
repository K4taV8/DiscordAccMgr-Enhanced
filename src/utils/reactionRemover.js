import { ProgressBar } from '../components/ProgressBar.js';

function emojiKey(emoji) {
  return emoji.id ? `${emoji.name}:${emoji.id}` : emoji.name;
}

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
      <h2>Removing your reactions ${isGroup ? 'in' : 'with'} ${channelName}</h2>
      <div id="progressContainer">
        <div class="message-counter">
          <span id="processedCount">0</span> / <span id="totalCount">0</span> reactions
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
  progressBar.onCancel(() => {
    shouldStop = true;
    progressBar.setCancelButtonText('Cancelling...');
    progressBar.disableCancelButton();
  });

  try {
    let myReactions = [];
    let lastMessageId = null;
    let hasMore = true;

    while (hasMore && !shouldStop) {
      const result = isGroup
        ? await electronAPI.getGroupMessages(channelId, lastMessageId)
        : await electronAPI.getDMMessages(channelId, lastMessageId);

      if (!result.success || !result.messages.length) {
        hasMore = false;
        continue;
      }

      for (const msg of result.messages) {
        if (msg.reactions) {
          for (const r of msg.reactions) {
            // ponytail: me is unreliable from API, try removal for all
            myReactions.push({ messageId: msg.id, emoji: r.emoji });
          }
        }
      }

      if (result.messages.length < 100) {
        hasMore = false;
      } else {
        lastMessageId = result.messages[result.messages.length - 1].id;
      }

      await new Promise(resolve => setTimeout(resolve, 250));
    }

    if (shouldStop) throw new Error('Operation cancelled');

    const total = myReactions.length;
    document.getElementById('totalCount').textContent = total.toString();

    if (total === 0) {
      progressBar.update(100);
      return;
    }

    let processedCount = 0;

    for (const item of myReactions) {
      if (shouldStop) break;

      const result = await electronAPI.removeOwnReaction(channelId, item.messageId, emojiKey(item.emoji));

      if (result.success) {
        processedCount++;
      } else if (result.error === 'Rate limited') {
        const waitTime = ((result.retryAfter || 5) * 1000) + 1000;
        await new Promise(resolve => setTimeout(resolve, waitTime));
        const retry = await electronAPI.removeOwnReaction(channelId, item.messageId, emojiKey(item.emoji));
        if (retry.success) processedCount++;
      } else if (result.error === 'noReaction') {
        continue; // 404 = user didn't have this reaction, skip fast
      } else {
        await new Promise(resolve => setTimeout(resolve, 2500));
        continue;
      }

      document.getElementById('processedCount').textContent = processedCount.toString();
      progressBar.update((processedCount / total) * 100);

      if (processedCount % 5 === 0) {
        await new Promise(resolve => setTimeout(resolve, 3000));
      } else {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    if (!shouldStop) progressBar.update(100);
  } catch (error) {
    console.error('Remove reactions error:', error.message);
    const progressContainer = document.getElementById('progressContainer');
    progressContainer.innerHTML = `<p class="error">${error.message}</p>`;
  } finally {
    setTimeout(() => {
      modalOverlay.remove();
      onComplete();
    }, 1000);
  }
}
