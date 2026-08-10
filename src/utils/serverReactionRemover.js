import { formatEmojiForApi } from './emojiUtils.js';
import { autoConcurrency, createTaskPanel } from './serverTaskUtils.js';
import { scanLimiter, deleteLimiter } from './rateLimiter.js';
import { confirmAction } from './ui.js';
import {
  OP_REACTIONS, loadCheckpoint, saveCheckpoint, clearCheckpoint, newCheckpoint, touch,
  loadWatermark, saveWatermark, watermarkFresh,
  loadLedger, addLedger, ledgerKey, ledgerFilter,
} from './persist.js';

const decodeQueue = (str) => {
  const [cid, mid, ...rest] = str.split(':');
  return { channelId: cid, messageId: mid, emojiStr: rest.join(':') };
};

async function scanChannelReactions(channel, electronAPI, log, isCancelled, onPage, opts = {}) {
  const { stopAtId, suppressed } = opts;
  const reactions = [];
  let lastId = null;
  let pages = 0;
  let newestId = null;
  const isBounded = (id) => stopAtId && BigInt(id) <= BigInt(stopAtId);
  while (!isCancelled()) {
    let result;
    const release = await scanLimiter.acquire();
    try { result = await electronAPI.getChannelMessages(channel.id, lastId); }
    catch { release(); return { reactions, skipped: true, newestId }; }
    release();

    if (!result.success) {
      if (result.error === 'Rate limited') {
        scanLimiter.throttle(result.retryAfter || 1);
        await new Promise(resolve => setTimeout(resolve, ((result.retryAfter || 1) * 1000) + 500));
        continue;
      }
      if (result.error === 'No access') return { reactions, skipped: false, newestId };
      return { reactions, skipped: true, newestId };
    }
    if (!result.messages || !result.messages.length) break;
    if (newestId === null) newestId = result.messages[0].id;
    for (const msg of result.messages) {
      if (isBounded(msg.id)) break;
      if (msg.reactions) {
        for (const r of msg.reactions) {
          if (r.me !== true) continue;
          const emojiStr = formatEmojiForApi(r.emoji);
          if (!emojiStr) continue;
          // anti-fantômes : réaction déjà confirmée supprimée (204/404) → ignorée
          if (suppressed && suppressed.has(ledgerKey(channel.id, msg.id, emojiStr))) continue;
          reactions.push({ channelId: channel.id, messageId: msg.id, emojiStr });
        }
      }
    }
    pages++;
    if (onPage) onPage(pages);
    const lastMsg = result.messages[result.messages.length - 1];
    if (result.messages.length < 100 || isBounded(lastMsg.id)) break;
    lastId = lastMsg.id;
  }
  return { reactions, skipped: false, newestId };
}

export async function removeServerReactions({
  serverId, serverName, electronAPI, onComplete = () => {},
}) {
  // Checkpoint / reprise
  let checkpoint = await loadCheckpoint(OP_REACTIONS, serverId);
  if (checkpoint && checkpoint.phase !== 'done') {
    const resume = await confirmAction('Reprendre ?',
      `Opération précédente interrompue (${checkpoint.progress.done}/${checkpoint.progress.total} traitées). Reprendre là où elle s'est arrêtée ?`, 'Reprendre');
    if (!resume) { await clearCheckpoint(OP_REACTIONS, serverId); checkpoint = null; }
  }
  const suppressed = ledgerFilter(await loadLedger());
  const watermark = await loadWatermark(serverId);
  const ledgerPending = [];

  const flushLedger = async () => {
    if (!ledgerPending.length) return;
    const keys = ledgerPending.splice(0, ledgerPending.length);
    for (const k of keys) suppressed.set(k, Date.now());
    await addLedger(keys);
  };

  const finalizeWatermark = async () => {
    const wm = {};
    let changed = false;
    for (const [chId, state] of Object.entries(checkpoint.channels)) {
      if (state.status === 'scanned' && state.newestId) { wm[chId] = { newestId: state.newestId, scannedAt: Date.now() }; changed = true; }
    }
    if (changed) await saveWatermark(serverId, wm);
  };

  const t = createTaskPanel(serverName, '[RmReactions]');
  const { phase, status, details, progressNum, totalNum, actionBtn, updateBar, cleanExit, log, safeTimeout, shouldStop } = t;

  try {
    log('start');
    const chRes = await electronAPI.getServerChannels(serverId);
    if (!chRes.success || !chRes.channels.length) {
      if (status) status.textContent = 'No channels found';
      if (checkpoint) await clearCheckpoint(OP_REACTIONS, serverId);
      safeTimeout(() => cleanExit(onComplete), 1500);
      return;
    }
    const channels = chRes.channels;

    if (!checkpoint) checkpoint = newCheckpoint(OP_REACTIONS, serverId, serverName, channels);
    for (const ch of channels) {
      if (!checkpoint.channels[ch.id]) {
        checkpoint.channels[ch.id] = { name: ch.name, status: 'pending', cursor: null, found: 0, newestId: null };
      }
    }
    // dédupe : re-scan d'un canal partiel ne doit pas dupliquer les items déjà en file
    const seenKeys = new Set(checkpoint.queue);

    const concurrency = autoConcurrency(channels.length);
    if (status) status.textContent = `Scanning ${channels.length} channels (${concurrency}x)`;
    if (totalNum) totalNum.textContent = channels.length.toString();
    if (phase) phase.textContent = 'Scanning';

    // ---- Phase SCAN ----
    if (checkpoint.phase === 'scan') {
      let scanned = 0;
      let partialChannels = 0;
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
            // Delta (watermark) : canal inchangé → skip ; sinon scan borné aux nouveaux messages
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
                  await saveCheckpoint(OP_REACTIONS, serverId, checkpoint);
                  scanned++;
                  updateBar((scanned / channels.length) * 100);
                  continue;
                }
                stopAtId = wm.newestId;
              }
            }
            state.status = 'scanning';
            const { reactions, skipped, newestId } = await scanChannelReactions(ch, electronAPI, log, shouldStop, p => {
              if (details) details.textContent = `#${ch.name}: page ${p}`;
            }, { stopAtId, suppressed });
            state.newestId = newestId || state.newestId;
            state.status = skipped ? 'partial' : 'scanned';
            state.found = reactions.length;
            if (skipped) partialChannels++;
            for (const r of reactions) {
              const k = `${r.channelId}:${r.messageId}:${r.emojiStr}`;
              if (!seenKeys.has(k)) { seenKeys.add(k); checkpoint.queue.push(k); }
            }
            checkpoint = touch(checkpoint);
            await saveCheckpoint(OP_REACTIONS, serverId, checkpoint);
            scanned++;
            updateBar((scanned / channels.length) * 100);
          } catch (e) {
            log(`#${ch.name} ${e.message}`);
          }
        }
      }

      await Promise.all(Array.from({ length: Math.min(concurrency, channels.length) }, () => worker()));
      if (shouldStop()) {
        checkpoint = touch(checkpoint);
        await saveCheckpoint(OP_REACTIONS, serverId, checkpoint);
        log('cancelled (checkpoint sauvegardé)');
        cleanExit(onComplete);
        return;
      }

      const queue = checkpoint.queue;
      const total = queue.length;
      if (totalNum) totalNum.textContent = total.toString();
      log(`scan done: ${total}`);
      if (partialChannels > 0) log(`WARNING: ${partialChannels} channel(s) scanned partially — some reactions may be missing`);

      if (total === 0) {
        if (status) status.textContent = 'No reactions found';
        if (phase) { phase.textContent = 'Done'; phase.style.background = '#3ba55d'; }
        updateBar(100);
        if (details) details.textContent = 'Nothing to remove';
        actionBtn.textContent = 'Close';
        actionBtn.style.background = '#3ba55d';
        actionBtn.disabled = false;
        actionBtn.onclick = () => cleanExit(onComplete);
        await finalizeWatermark();
        await clearCheckpoint(OP_REACTIONS, serverId);
        safeTimeout(() => cleanExit(onComplete), 3000);
        return;
      }

      checkpoint.phase = 'delete';
      checkpoint.progress.total = total;
      checkpoint = touch(checkpoint);
      await saveCheckpoint(OP_REACTIONS, serverId, checkpoint);
    }

    // ---- Phase DELETE (reprend à progress.done) ----
    const queue = checkpoint.queue.map(decodeQueue);
    const total = queue.length;
    if (phase) { phase.textContent = 'Removing'; phase.style.background = '#faa81a'; }
    if (status) status.textContent = `Removing ${total} reactions...`;
    if (progressNum) progressNum.textContent = checkpoint.progress.done.toString();
    actionBtn.textContent = 'Stop';
    actionBtn.disabled = false;
    updateBar(total ? (checkpoint.progress.done / total) * 100 : 0);

    let removed = checkpoint.progress.done;
    let failed = checkpoint.progress.failed;

    for (let i = checkpoint.progress.done; i < total && !shouldStop(); i++) {
      const item = queue[i];
      let ok = false;
      for (let attempt = 0; attempt < 3 && !shouldStop(); attempt++) {
        try {
          const release = await deleteLimiter.acquire();
          let r;
          try { r = await electronAPI.removeOwnReaction(item.channelId, item.messageId, item.emojiStr); }
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

      if (ok) {
        removed++;
        ledgerPending.push(ledgerKey(item.channelId, item.messageId, item.emojiStr));
      } else failed++;

      checkpoint.progress.done = i + 1;
      checkpoint.progress.failed = failed;
      checkpoint.progress.total = total;
      if ((i + 1) % 25 === 0 || shouldStop()) {
        await flushLedger();
        checkpoint = touch(checkpoint);
        await saveCheckpoint(OP_REACTIONS, serverId, checkpoint);
      }

      if (progressNum) progressNum.textContent = removed.toString();
      updateBar(((i + 1) / total) * 100);
      if (details) details.textContent = `Removed ${removed}/${i + 1}${failed > 0 ? ` (${failed} failed)` : ''}`;
    }

    await flushLedger();
    if (shouldStop()) {
      checkpoint = touch(checkpoint);
      await saveCheckpoint(OP_REACTIONS, serverId, checkpoint);
      log('cancelled (checkpoint sauvegardé)');
      cleanExit(onComplete);
      return;
    }

    // ---- Phase VÉRIFICATION (fantômes, 2 passes) ----
    checkpoint.phase = 'verifying';
    checkpoint = touch(checkpoint);
    await saveCheckpoint(OP_REACTIONS, serverId, checkpoint);

    const recheckChannels = channels.filter(ch => (checkpoint.channels[ch.id]?.found || 0) > 0);
    for (let pass = 0; pass < 2 && !shouldStop(); pass++) {
      if (phase) { phase.textContent = 'Verifying'; phase.style.background = '#faa81a'; }
      if (status) status.textContent = `Verifying pass ${pass + 1}...`;
      const ghosts = [];
      for (const ch of recheckChannels) {
        const { reactions } = await scanChannelReactions(ch, electronAPI, log, shouldStop, p => {
          if (details) details.textContent = `Verify #${ch.name}: page ${p}`;
        }, { suppressed });
        ghosts.push(...reactions);
      }
      if (!ghosts.length) { if (status) status.textContent = `Clean: ${removed} removed, ${failed} failed`; break; }
      log(`ghost pass ${pass + 1}: ${ghosts.length}`);
      let gRemoved = 0, gFailed = 0;
      for (const item of ghosts) {
        if (shouldStop()) break;
        let ok = false;
        for (let attempt = 0; attempt < 3 && !shouldStop(); attempt++) {
          try {
            const release = await deleteLimiter.acquire();
            let r;
            try { r = await electronAPI.removeOwnReaction(item.channelId, item.messageId, item.emojiStr); }
            finally { release(); }
            if (r.success || r.error === 'noReaction') { ok = true; break; }
            if (r.error === 'Rate limited') {
              deleteLimiter.throttle(r.retryAfter || 3);
              await new Promise(resolve => setTimeout(resolve, ((r.retryAfter || 3) * 1000) + 500));
            }
          } catch (e) {
            log(`ghost del err ${item.messageId}: ${e.message}`);
            await new Promise(resolve => setTimeout(resolve, 1500));
          }
        }
        if (ok) {
          gRemoved++;
          ledgerPending.push(ledgerKey(item.channelId, item.messageId, item.emojiStr));
        } else gFailed++;
      }
      await flushLedger();
      removed += gRemoved;
      failed += gFailed;
      checkpoint.progress.failed = failed;
      checkpoint = touch(checkpoint);
      await saveCheckpoint(OP_REACTIONS, serverId, checkpoint);
    }

    if (shouldStop()) {
      checkpoint = touch(checkpoint);
      await saveCheckpoint(OP_REACTIONS, serverId, checkpoint);
      log('cancelled (checkpoint sauvegardé)');
      cleanExit(onComplete);
      return;
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

    await finalizeWatermark();
    await clearCheckpoint(OP_REACTIONS, serverId);
    safeTimeout(() => cleanExit(onComplete), 5000);
  } catch (err) {
    console.error(err);
    log(`err: ${err.message}`);
    if (status) status.textContent = `Error: ${err.message}`;
    if (phase) { phase.textContent = 'Error'; phase.style.background = '#ed4245'; }
    if (checkpoint) {
      checkpoint = touch(checkpoint);
      await saveCheckpoint(OP_REACTIONS, serverId, checkpoint).catch(() => {});
    }
    safeTimeout(() => cleanExit(onComplete), 3000);
  }
}
