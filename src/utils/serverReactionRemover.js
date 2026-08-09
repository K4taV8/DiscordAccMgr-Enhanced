import { formatEmojiForApi } from './emojiUtils.js';
import { fmt, autoConcurrency, createTaskPanel } from './serverTaskUtils.js';
import { scanLimiter, deleteLimiter } from './rateLimiter.js';

async function scanChannelReactions(channel, electronAPI, log, isCancelled, onPage) {
  const reactions = [];
  let lastId = null;
  let pages = 0;
  while (!isCancelled()) {
    let result;
    const release = await scanLimiter.acquire();
    try { result = await electronAPI.getChannelMessages(channel.id, lastId); }
    catch { release(); return { reactions, skipped: true }; }
    release();

    if (!result.success) {
      if (result.error === 'Rate limited') {
        scanLimiter.throttle(result.retryAfter || 1);
        await new Promise(resolve => setTimeout(resolve, ((result.retryAfter || 1) * 1000) + 500));
        continue;
      }
      if (result.error === 'No access') return { reactions, skipped: false };
      return { reactions, skipped: true };
    }
    if (!result.messages || !result.messages.length) break;
    for (const msg of result.messages) {
      if (msg.reactions) {
        const userReactions = msg.reactions.filter(r => r.me === true);
        for (const r of userReactions) {
          reactions.push({ channelId: channel.id, messageId: msg.id, emoji: r.emoji });
        }
      }
    }
    pages++;
    if (onPage) onPage(pages);
    if (result.messages.length < 100) break;
    lastId = result.messages[result.messages.length - 1].id;
  }
  return { reactions, skipped: false };
}

async function removeReactionBatch(items, electronAPI, log, shouldStop, status, details, progressNum, totalNum, updateBar, phase, actionBtn) {
  let removed = 0, failed = 0;
  const total = items.length;
  if (total === 0) return { removed, failed };
  if (phase) { phase.textContent = 'Removing'; phase.style.background = '#faa81a'; }
  if (status) status.textContent = `Removing ${total} reactions...`;
  if (progressNum) progressNum.textContent = '0';
  actionBtn.textContent = 'Stop';
  actionBtn.disabled = false;
  updateBar(0);

  for (let i = 0; i < total && !shouldStop(); i++) {
    const item = items[i];
    const emojiStr = formatEmojiForApi(item.emoji);
    if (!emojiStr) { failed++; continue; }

    let ok = false;
    for (let attempt = 0; attempt < 3 && !shouldStop(); attempt++) {
      try {
        const release = await deleteLimiter.acquire();
        let r;
        try { r = await electronAPI.removeOwnReaction(item.channelId, item.messageId, emojiStr); }
        finally { release(); }
        if (r.success || r.error === 'noReaction') { ok = true; break; }
        if (r.error === 'Rate limited') {
          deleteLimiter.throttle(r.retryAfter || 3);
          const waitTime = ((r.retryAfter || 3) * 1000) + 500;
          log(`429 wait ${waitTime}ms (attempt ${attempt + 1})`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      } catch (e) {
        log(`del err ${item.messageId}: ${e.message}`);
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
    }

    if (ok) removed++;
    else failed++;

    if (progressNum) progressNum.textContent = removed.toString();
    updateBar(((i + 1) / total) * 100);
    if (details) details.textContent = `Removed ${removed}/${i + 1}${failed > 0 ? ` (${failed} failed)` : ''}`;
  }
  return { removed, failed };
}

export async function removeServerReactions({
  serverId, serverName, electronAPI, onComplete = () => {},
}) {
  const t = createTaskPanel(serverName, '[RmReactions]');
  const { phase, status, details, progressNum, totalNum, actionBtn, updateBar, cleanExit, log, safeTimeout, shouldStop } = t;

  try {
    log('start');
    const chRes = await electronAPI.getServerChannels(serverId);
    if (!chRes.success || !chRes.channels.length) {
      if (status) status.textContent = 'No channels found';
      safeTimeout(() => cleanExit(onComplete), 1500);
      return;
    }

    const channels = chRes.channels;
    if (!channels.length) {
      if (status) status.textContent = 'No channels found';
      safeTimeout(() => cleanExit(onComplete), 1500);
      return;
    }

    const concurrency = autoConcurrency(channels.length);
    if (status) status.textContent = `Scanning ${channels.length} channels (${concurrency}x)`;
    if (totalNum) totalNum.textContent = channels.length.toString();
    if (phase) phase.textContent = 'Scanning';

    const allReactions = [];
    const chWithReactions = new Set();
    let scanned = 0;
    let partialChannels = 0;
    let channelIdx = 0;

    async function worker() {
      while (channelIdx < channels.length && !shouldStop()) {
        const idx = channelIdx++;
        const ch = channels[idx];
        if (status) status.textContent = `#${ch.name} (${idx + 1}/${channels.length})`;
        if (progressNum) progressNum.textContent = (idx + 1).toString();
        try {
          const { reactions, skipped } = await scanChannelReactions(ch, electronAPI, log, shouldStop, p => {
            if (details) details.textContent = `#${ch.name}: page ${p} — ${allReactions.length} reactions found so far`;
          });
          if (reactions.length) chWithReactions.add(ch.id);
          if (skipped) partialChannels++;
          allReactions.push(...reactions);
          scanned++;
          updateBar((scanned / channels.length) * 100);
        } catch (e) {
          log(`#${ch.name} ${e.message}`);
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, channels.length) }, () => worker()));
    if (shouldStop()) { log('cancelled'); cleanExit(onComplete); return; }

    const total = allReactions.length;
    if (totalNum) totalNum.textContent = total.toString();
    log(`scan done: ${total}`);
    if (partialChannels > 0) {
      log(`WARNING: ${partialChannels} channel(s) scanned partially — some reactions may be missing`);
    }

    if (total === 0) {
      if (status) status.textContent = 'No reactions found';
      if (phase) { phase.textContent = 'Done'; phase.style.background = '#3ba55d'; }
      updateBar(100);
      if (details) details.textContent = 'Nothing to remove';
      actionBtn.textContent = 'Close';
      actionBtn.style.background = '#3ba55d';
      actionBtn.disabled = false;
      actionBtn.onclick = () => cleanExit(onComplete);
      safeTimeout(() => cleanExit(onComplete), 3000);
      return;
    }

    // First pass: remove all found reactions
    let r1 = await removeReactionBatch(allReactions, electronAPI, log, shouldStop, status, details, progressNum, totalNum, updateBar, phase, actionBtn);
    let removed = r1.removed, failed = r1.failed;

    // Verification passes: re-scan channels that had reactions, remove ghosts (Discord API cache)
    const recheckChannels = channels.filter(ch => chWithReactions.has(ch.id));
    for (let pass = 0; pass < 2 && !shouldStop(); pass++) {
      if (phase) { phase.textContent = 'Verifying'; phase.style.background = '#faa81a'; }
      if (status) status.textContent = `Verifying pass ${pass + 1}...`;
      const ghosts = [];
      for (const ch of recheckChannels) {
        const { reactions } = await scanChannelReactions(ch, electronAPI, log, shouldStop, p => {
          if (details) details.textContent = `Verify #${ch.name}: page ${p}`;
        });
        ghosts.push(...reactions);
      }
      if (!ghosts.length) { if (status) status.textContent = `Clean: ${removed} removed, ${failed} failed`; break; }
      log(`ghost pass ${pass + 1}: ${ghosts.length}`);
      const r = await removeReactionBatch(ghosts, electronAPI, log, shouldStop, status, details, progressNum, totalNum, updateBar, phase, actionBtn);
      removed += r.removed; failed += r.failed;
    }

    log(`fin: removed=${removed} failed=${failed}`);
    updateBar(100);
    if (phase) { phase.textContent = 'Done'; phase.style.background = '#3ba55d'; }
    if (status) status.textContent = `Removed ${removed} / ${removed + failed}${failed > 0 ? ` (${failed} failed)` : ''}`;
    if (details) details.textContent = `${removed} removed${failed > 0 ? `, ${failed} failed` : ''}`;
    actionBtn.textContent = 'Close';
    actionBtn.style.background = '#3ba55d';
    actionBtn.disabled = false;
    actionBtn.onclick = () => cleanExit(onComplete);
    safeTimeout(() => cleanExit(onComplete), 5000);
  } catch (err) {
    console.error(err);
    log(`err: ${err.message}`);
    if (status) status.textContent = `Error: ${err.message}`;
    if (phase) { phase.textContent = 'Error'; phase.style.background = '#ed4245'; }
    safeTimeout(() => cleanExit(onComplete), 3000);
  }
}
