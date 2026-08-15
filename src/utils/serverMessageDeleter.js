import { fmt, autoConcurrency, createTaskPanel } from './serverTaskUtils.js';
import { scanLimiter, deleteLimiter } from './rateLimiter.js';
import { confirmAction } from './ui.js';
import {
  OP_MESSAGES, loadCheckpoint, saveCheckpoint, clearCheckpoint, newCheckpoint, touch,
  loadWatermark, saveWatermark, watermarkFresh,
} from './persist.js';

export const DISCORD_EPOCH = 1420070400000;

// ponytail: snowflake timestamp extraction + generation for time-segmented parallel scanning
export function snowflakeTs(id) { return Number(BigInt(id) >> 22n) + DISCORD_EPOCH; }
export function snowflakeForDate(d) {
  // BUG-09 : borne basse à l'epoch Discord — un shift négatif produirait un id invalide.
  return ((BigInt(Math.max(d.getTime(), DISCORD_EPOCH)) - BigInt(DISCORD_EPOCH)) << 22n).toString();
}

async function scanSegment(channel, uid, electronAPI, isCancelled, beforeId, stopBeforeId) {
  const found = [];
  let lastId = beforeId;
  let newestId = null;
  while (!isCancelled()) {
    let result;
    const release = await scanLimiter.acquire();
    try { result = await electronAPI.getChannelMessages(channel.id, lastId); }
    catch { release(); return { found, skipped: true, newestId }; }
    release();

    // ponytail: 3 tentatives réseau avant d'abandonner le segment (résilience scan)
    for (let attempt = 0; (!result?.success || !result.messages) && attempt < 2; attempt++) {
      if (result?.error === 'Rate limited') {
        await new Promise(r => setTimeout(r, ((result.retryAfter || 1) * 1000) + 500));
      } else {
        await new Promise(r => setTimeout(r, 1500));
      }
      const release2 = await scanLimiter.acquire();
      try { result = await electronAPI.getChannelMessages(channel.id, lastId); }
      catch { release2(); return { found, skipped: true, newestId }; }
      release2();
    }
    if (!result?.success) return { found, skipped: true, newestId };
    if (!result.messages?.length) break;

    if (newestId === null && beforeId === null) newestId = result.messages[0].id;

    for (const msg of result.messages) {
      if (msg.author?.id === uid) {
        const hasContent = (typeof msg.content === 'string' && msg.content.trim().length > 0)
          || (msg.attachments || 0) > 0
          || (msg.sticker_items || 0) > 0
          || (msg.embeds || 0) > 0
          || (msg.message_snapshots || 0) > 0
          || msg.message_reference;
        if (hasContent) found.push({ channelId: channel.id, msg });
      }
    }
    if (result.messages.length < 100) break;

    const oldestInPage = result.messages[result.messages.length - 1];
    if (stopBeforeId && BigInt(oldestInPage.id) <= BigInt(stopBeforeId)) break;
    lastId = oldestInPage.id;
  }
  return { found, skipped: false, newestId };
}

async function scanChannelMessages(channel, knownUserId, electronAPI, log, isCancelled, onProgress, stopAtId) {
  const uid = knownUserId;

  // Get the earliest message to determine channel timespan (1 API call)
  let oldestResult;
  try { oldestResult = await electronAPI.getChannelMessages(channel.id, null, '0'); } catch {}
  if (!oldestResult?.success || !oldestResult.messages?.length) return { channelId: channel.id, messages: [], currentUserId: uid, newestId: null };

  const oldestId = oldestResult.messages[0].id;
  const ts = snowflakeTs(oldestId);
  const ageDays = (Date.now() - ts) / 86400000;

  // Sequential scan for channels under 1 day old (borné par le watermark si delta)
  if (ageDays < 1) {
    const { found, skipped, newestId } = await scanSegment(channel, uid, electronAPI, isCancelled, null, stopAtId || null);
    log(`#${channel.name}: ${found.length}m seq${skipped ? ' (partial)' : ''}`);
    return { channelId: channel.id, messages: found, currentUserId: uid, skipped, newestId };
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
    bounds.map((b, i) => scanSegment(channel, uid, electronAPI, isCancelled, b, i < segments - 1 ? bounds[i + 1] : (stopAtId || '0')))
  );

  const messages = results.flatMap(r => r.found);
  const skipped = results.some(r => r.skipped);
  const newestId = results[0]?.newestId || null; // segment 0 scanne depuis le plus récent
  log(`#${channel.name}: ${messages.length}m (${segments}x${skipped ? ', partial' : ''})`);
  return { channelId: channel.id, messages, currentUserId: uid, skipped, newestId };
}

export async function deleteServerMessages({
  serverId, serverName, electronAPI, onComplete = () => {},
}) {
  // Checkpoint / reprise
  let checkpoint = await loadCheckpoint(OP_MESSAGES, serverId);
  if (checkpoint && checkpoint.phase !== 'done') {
    const resume = await confirmAction('Reprendre ?',
      `Suppression précédente interrompue (${checkpoint.progress.done}/${checkpoint.progress.total} traitées). Reprendre là où elle s'est arrêtée ?`, 'Reprendre');
    if (!resume) { await clearCheckpoint(OP_MESSAGES, serverId); checkpoint = null; }
  }
  const watermark = await loadWatermark(serverId);

  const finalizeWatermark = async () => {
    const wm = {};
    let changed = false;
    for (const [chId, state] of Object.entries(checkpoint.channels)) {
      if (state.status === 'scanned' && state.newestId) { wm[chId] = { newestId: state.newestId, scannedAt: Date.now() }; changed = true; }
    }
    if (changed) await saveWatermark(serverId, wm);
  };

  const t = createTaskPanel(serverName, '[DelMessages]');
  const { phase, status, details, progressNum, totalNum, actionBtn, updateBar, cleanExit, log, safeTimeout, shouldStop } = t;

  try {
    log('start');
    const chRes = await electronAPI.getServerChannels(serverId);
    if (!chRes.success || !chRes.channels.length) {
      if (status) status.textContent = 'No channels found';
      if (checkpoint) await clearCheckpoint(OP_MESSAGES, serverId);
      safeTimeout(() => cleanExit(onComplete), 1500);
      return;
    }

    const channels = chRes.channels;
    if (!checkpoint) checkpoint = newCheckpoint(OP_MESSAGES, serverId, serverName, channels);
    for (const ch of channels) {
      if (!checkpoint.channels[ch.id]) {
        checkpoint.channels[ch.id] = { name: ch.name, status: 'pending', cursor: null, found: 0, newestId: null };
      }
    }
    const seenKeys = new Set(checkpoint.queue);

    const concurrency = autoConcurrency(channels.length);
    if (status) status.textContent = `Scanning ${channels.length} channels (${concurrency}x)`;
    if (totalNum) totalNum.textContent = channels.length.toString();
    if (phase) phase.textContent = 'Scanning';

    // ---- Phase SCAN ----
    if (checkpoint.phase === 'scan') {
      const allMessages = [];
      let partialChannels = 0;
      let uid = chRes.currentUserId || null;
      let scanned = 0;
      let channelIdx = 0;

      async function worker() {
        while (channelIdx < channels.length && !shouldStop()) {
          const idx = channelIdx++;
          const ch = channels[idx];
          const state = checkpoint.channels[ch.id];
          if (state.status === 'scanned') { scanned++; updateBar((scanned / channels.length) * 100); continue; }
          if (status) status.textContent = `#${ch.name} (${idx + 1}/${channels.length})`;
          if (progressNum) progressNum.textContent = (idx + 1).toString();
          try {
            let stopAtId = null;
            // Delta (watermark) : canal inchangé → skip
            const wm = watermark[ch.id];
            if (watermarkFresh(wm)) {
              const rel = await scanLimiter.acquire();
              let probe;
              try { probe = await electronAPI.getChannelMessages(ch.id, null); }
              finally { rel(); }
              if (probe.success && probe.messages?.length) {
                if (probe.messages[0].id === wm.newestId) {
                  state.status = 'scanned';
                  state.newestId = wm.newestId;
                  state.found = 0;
                  checkpoint = touch(checkpoint);
                  await saveCheckpoint(OP_MESSAGES, serverId, checkpoint);
                  scanned++;
                  updateBar((scanned / channels.length) * 100);
                  continue;
                }
                stopAtId = wm.newestId;
              }
            }
            state.status = 'scanning';
            const result = await scanChannelMessages(ch, uid, electronAPI, log, shouldStop, msg => {
              if (details) details.textContent = msg;
            }, stopAtId);
            uid = uid || result.currentUserId;
            state.newestId = result.newestId || state.newestId;
            state.status = result.skipped ? 'partial' : 'scanned';
            state.found = result.messages.length;
            if (result.skipped) partialChannels++;
            for (const item of result.messages) {
              const k = `${item.channelId}:${item.msg.id}`;
              if (!seenKeys.has(k)) { seenKeys.add(k); checkpoint.queue.push(k); }
            }
            allMessages.push(...result.messages);
            checkpoint = touch(checkpoint);
            await saveCheckpoint(OP_MESSAGES, serverId, checkpoint);
            scanned++;
            updateBar((scanned / channels.length) * 100);
          } catch (e) {
            console.error('[SCAN] err', ch.name, e.message);
            log(`#${ch.name} ${e.message}`);
          }
        }
      }

      await Promise.all(Array.from({ length: Math.min(concurrency, channels.length) }, () => worker()));
      if (shouldStop()) {
        checkpoint = touch(checkpoint);
        await saveCheckpoint(OP_MESSAGES, serverId, checkpoint);
        log('cancelled (checkpoint sauvegardé)');
        cleanExit(onComplete);
        return;
      }

      const total = checkpoint.queue.length;
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
        await finalizeWatermark();
        await clearCheckpoint(OP_MESSAGES, serverId);
        safeTimeout(() => cleanExit(onComplete), 3000);
        return;
      }

      checkpoint.phase = 'delete';
      checkpoint.progress.total = total;
      checkpoint = touch(checkpoint);
      await saveCheckpoint(OP_MESSAGES, serverId, checkpoint);
    }

    // ---- Phase DELETE (reprend à progress.done) ----
    const total = checkpoint.progress.total;
    if (phase) { phase.textContent = 'Deleting'; phase.style.background = '#faa81a'; }
    if (status) status.textContent = `Deleting ${total} messages...`;
    if (totalNum) totalNum.textContent = total.toString();
    if (progressNum) progressNum.textContent = checkpoint.progress.done.toString();
    actionBtn.textContent = 'Stop';
    actionBtn.disabled = false;
    updateBar(total ? (checkpoint.progress.done / total) * 100 : 0);

    let deleted = checkpoint.progress.done;
    const delStart = Date.now();

    for (let i = checkpoint.progress.done; i < total && !shouldStop(); i++) {
      const [channelId, msgId] = checkpoint.queue[i].split(':');
      let ok = false;
      for (let attempt = 0; attempt < 3 && !shouldStop(); attempt++) {
        try {
          const release = await deleteLimiter.acquire();
          let r;
          try { r = await electronAPI.deleteGroupMessage(channelId, msgId); }
          finally { release(); }
          if (r.success) { ok = true; break; }
          if (r.error === 'Rate limited') {
            await new Promise(resolve => setTimeout(resolve, ((r.retryAfter || 5) * 1000) + 1000));
          } else break;
        } catch (e) { console.error('Delete msg error:', e); await new Promise(resolve => setTimeout(resolve, 2500)); break; }
      }

      if (ok) deleted++;
      checkpoint.progress.done = i + 1;
      if ((i + 1) % 25 === 0 || shouldStop()) {
        checkpoint = touch(checkpoint);
        await saveCheckpoint(OP_MESSAGES, serverId, checkpoint);
      }
      if (progressNum) progressNum.textContent = deleted.toString();
      updateBar(((i + 1) / total) * 100);

      if (details) {
        const elapsed = (Date.now() - delStart) / 1000;
        const rate = elapsed > 0 ? deleted / elapsed : 0;
        const eta = rate > 0 ? (total - deleted) / rate : 0;
        details.textContent = eta > 0 && isFinite(eta) ? `Deleted ${deleted}/${total} — ETA ${fmt(eta)}` : `Deleted ${deleted}/${total}`;
      }
    }

    if (shouldStop()) {
      checkpoint = touch(checkpoint);
      await saveCheckpoint(OP_MESSAGES, serverId, checkpoint);
      log('cancelled (checkpoint sauvegardé)');
      cleanExit(onComplete);
      return;
    }

    log(`fin: ${deleted} ${fmt((Date.now() - delStart) / 1000)}`);
    updateBar(100);
    if (phase) { phase.textContent = 'Done'; phase.style.background = '#3ba55d'; }
    if (status) status.textContent = `Deleted ${deleted} messages`;
    actionBtn.textContent = 'Close';
    actionBtn.style.background = '#3ba55d';
    actionBtn.disabled = false;
    actionBtn.onclick = () => cleanExit(onComplete);

    await finalizeWatermark();
    await clearCheckpoint(OP_MESSAGES, serverId);
    safeTimeout(() => cleanExit(onComplete), 5000);
  } catch (err) {
    console.error(err);
    log(`err: ${err.message}`);
    if (status) status.textContent = `Error: ${err.message}`;
    if (phase) { phase.textContent = 'Error'; phase.style.background = '#ed4245'; }
    if (checkpoint) {
      checkpoint = touch(checkpoint);
      await saveCheckpoint(OP_MESSAGES, serverId, checkpoint).catch(() => {});
    }
    safeTimeout(() => cleanExit(onComplete), 3000);
  }
}
