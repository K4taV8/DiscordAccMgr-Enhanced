import { fmt, autoConcurrency, createTaskPanel } from './serverTaskUtils.js';
import { scanLimiter, deleteLimiter } from './rateLimiter.js';

const DISCORD_EPOCH = 1420070400000;

// ponytail: snowflake timestamp extraction + generation for time-segmented parallel scanning
function snowflakeTs(id) { return Number(BigInt(id) >> 22n) + DISCORD_EPOCH; }
function snowflakeForDate(d) { return ((BigInt(d.getTime()) - BigInt(DISCORD_EPOCH)) << 22n).toString(); }

async function scanSegment(channel, uid, electronAPI, isCancelled, beforeId, stopBeforeId) {
  const found = [];
  let lastId = beforeId;
  while (!isCancelled()) {
    let result;
    const release = await scanLimiter.acquire();
    try { result = await electronAPI.getChannelMessages(channel.id, lastId); }
    catch { release(); return { found, skipped: true }; }
    release();

    // ponytail: 3 tentatives réseau avant d'abandonner le segment (résilience scan)
    for (let attempt = 0; (!result?.success || !result.messages) && attempt < 2; attempt++) {
      if (result?.error === 'Rate limited') {
        scanLimiter.throttle(result.retryAfter || 1);
        await new Promise(r => setTimeout(r, ((result.retryAfter || 1) * 1000) + 500));
      } else {
        await new Promise(r => setTimeout(r, 1500));
      }
      const release2 = await scanLimiter.acquire();
      try { result = await electronAPI.getChannelMessages(channel.id, lastId); }
      catch { release2(); return { found, skipped: true }; }
      release2();
    }
    if (!result?.success) return { found, skipped: true };
    if (!result.messages?.length) break;

    for (const msg of result.messages) {
      if (msg.author?.id === uid) {
        const hasContent = (typeof msg.content === 'string' && msg.content.trim().length > 0)
          || (msg.attachments?.length)
          || (msg.sticker_items?.length)
          || (msg.embeds?.length)
          || (msg.message_snapshots?.length)
          || msg.message_reference;
        if (hasContent) found.push({ channelId: channel.id, msg });
      }
    }
    if (result.messages.length < 100) break;

    const oldestInPage = result.messages[result.messages.length - 1];
    if (stopBeforeId && BigInt(oldestInPage.id) <= BigInt(stopBeforeId)) break;
    lastId = oldestInPage.id;
  }
  return { found, skipped: false };
}

async function scanChannelMessages(channel, knownUserId, electronAPI, log, isCancelled, onProgress) {
  const uid = knownUserId;

  // Get the earliest message to determine channel timespan (1 API call)
  let oldestResult;
  try { oldestResult = await electronAPI.getChannelMessages(channel.id, null, '0'); } catch {}
  if (!oldestResult?.success || !oldestResult.messages?.length) return { channelId: channel.id, messages: [], currentUserId: uid };

  const oldestId = oldestResult.messages[0].id;
  const ts = snowflakeTs(oldestId);
  const ageDays = (Date.now() - ts) / 86400000;

  // Sequential scan for channels under 1 day old
  if (ageDays < 1) {
    const { found, skipped } = await scanSegment(channel, uid, electronAPI, isCancelled, null, null);
    log(`#${channel.name}: ${found.length}m seq${skipped ? ' (partial)' : ''}`);
    return { channelId: channel.id, messages: found, currentUserId: uid, skipped };
  }

  // Parallel time-segmented scan — the global scanLimiter caps the combined request rate
  const segments = Math.min(12, Math.max(2, Math.ceil(ageDays / 7)));
  const now = new Date();
  const bounds = [null]; // first segment starts from newest messages
  for (let i = 1; i < segments; i++) {
    const t = new Date(now.getTime() - Math.round((now.getTime() - ts) * (i / segments)));
    bounds.push(snowflakeForDate(t));
  }

  if (onProgress) onProgress(`#${channel.name}: ${segments}x parallel`);
  const results = await Promise.all(
    bounds.map((b, i) => scanSegment(channel, uid, electronAPI, isCancelled, b, i < segments - 1 ? bounds[i + 1] : '0'))
  );

  const messages = results.flatMap(r => r.found);
  const skipped = results.some(r => r.skipped);
  log(`#${channel.name}: ${messages.length}m (${segments}x${skipped ? ', partial' : ''})`);
  return { channelId: channel.id, messages, currentUserId: uid, skipped };
}

export async function deleteServerMessages({
  serverId, serverName, electronAPI, onComplete = () => {},
}) {
  const t = createTaskPanel(serverName, '[DelMessages]');
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

    const allMessages = [];
    let partialChannels = 0;
    let uid = chRes.currentUserId || null;
    let scanned = 0;
    let channelIdx = 0;

    async function worker() {
      while (channelIdx < channels.length && !shouldStop()) {
        const idx = channelIdx++;
        const ch = channels[idx];
        if (status) status.textContent = `#${ch.name} (${idx + 1}/${channels.length})`;
        if (progressNum) progressNum.textContent = (idx + 1).toString();
        try {
          const result = await scanChannelMessages(ch, uid, electronAPI, log, shouldStop, msg => {
            if (details) details.textContent = msg;
          });
          uid = uid || result.currentUserId;
          if (result.skipped) partialChannels++;
          allMessages.push(...result.messages);
          scanned++;
          updateBar((scanned / channels.length) * 100);
        } catch (e) {
          console.error('[SCAN] err', ch.name, e.message);
          log(`#${ch.name} ${e.message}`);
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, channels.length) }, () => worker()));
    if (shouldStop()) { log('cancel'); cleanExit(onComplete); return; }

    const total = allMessages.length;
    if (totalNum) totalNum.textContent = total.toString();
    log(`done: ${total}`);
    if (partialChannels > 0) {
      log(`WARNING: ${partialChannels} channel(s) scanned partially — some messages may be missing`);
    }

    if (total === 0) {
      if (status) status.textContent = 'No messages to delete';
      if (phase) { phase.textContent = 'Done'; phase.style.background = '#3ba55d'; }
      updateBar(100);
      if (details) details.textContent = 'Nothing to delete';
      actionBtn.textContent = 'Close';
      actionBtn.style.background = '#3ba55d';
      actionBtn.disabled = false;
      actionBtn.onclick = () => cleanExit(onComplete);
      safeTimeout(() => cleanExit(onComplete), 3000);
      return;
    }

    if (phase) { phase.textContent = 'Deleting'; phase.style.background = '#faa81a'; }
    if (status) status.textContent = `Deleting ${total} messages...`;
    if (totalNum) totalNum.textContent = total.toString();
    actionBtn.textContent = 'Stop';
    actionBtn.disabled = false;

    let deleted = 0;
    const delStart = Date.now();

    for (const item of allMessages) {
      if (shouldStop()) break;
      let ok = false;
      for (let attempt = 0; attempt < 3 && !shouldStop(); attempt++) {
        try {
          const release = await deleteLimiter.acquire();
          let r;
          try { r = await electronAPI.deleteGroupMessage(item.channelId, item.msg.id); }
          finally { release(); }
          if (r.success) { ok = true; break; }
          if (r.error === 'Rate limited') {
            deleteLimiter.throttle(r.retryAfter || 5);
            await new Promise(resolve => setTimeout(resolve, ((r.retryAfter || 5) * 1000) + 1000));
          } else break;
        } catch (e) { console.error('Delete msg error:', e); await new Promise(resolve => setTimeout(resolve, 2500)); break; }
      }

      if (ok) deleted++;
      if (progressNum) progressNum.textContent = deleted.toString();
      updateBar((deleted / total) * 100);

      if (details) {
        const elapsed = (Date.now() - delStart) / 1000;
        const rate = elapsed > 0 ? deleted / elapsed : 0;
        const eta = rate > 0 ? (total - deleted) / rate : 0;
        details.textContent = eta > 0 && isFinite(eta) ? `Deleted ${deleted}/${total} — ETA ${fmt(eta)}` : `Deleted ${deleted}/${total}`;
      }
    }

    log(`fin: ${deleted} ${fmt((Date.now() - delStart) / 1000)}`);
    updateBar(100);
    if (phase) { phase.textContent = 'Done'; phase.style.background = '#3ba55d'; }
    if (status) status.textContent = `Deleted ${deleted} messages`;
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
