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

// ─────────────────────────────────────────────────────────────────────────────
// LOGIQUE DE REPRISE (pure, testable sans DOM).
//   Le curseur `progress.done` n'avance QUE sur un vrai succès : un échec le
//   laisse sur le message fautif pour qu'il soit retenté au prochain run.
//   Le watermark/checkpoint ne peuvent être finalisés QUE si TOUT a été
//   supprimé (aucun échec) — sinon on conserve le checkpoint (perte = 0).
// ─────────────────────────────────────────────────────────────────────────────
export function nextDeleteCursor(done, ok) {
  return ok ? done + 1 : done;
}

export function deletionsComplete(deleted, total, failed = 0) {
  return failed === 0 && deleted === total;
}

// BUG-006 : nombre de canaux restés « partial » (non scannés) dans un checkpoint.
// Pur/testable — sert à décider de conserver le checkpoint et à l'afficher.
export function countPartialChannels(channels) {
  return Object.values(channels || {}).filter(s => s && s.status === 'partial').length;
}

// Un message déjà absent (404 « Unknown Message » / « not found ») est un
// SUCCÈS : il n'existe plus, le curseur doit avancer. Un 404 « Unknown Channel »
// désigne un MAUVAIS identifiant de salon — ce n'est pas un succès. Les deux
// arrivent avec `status === 404`, seule la raison les distingue (main.cjs
// conserve le message de Discord pour cela).
export function isAlreadyDeleted(result) {
  if (result?.success) return true;
  if (/unknown channel/i.test(String(result?.error || ''))) return false;
  if (Number(result?.status) === 404) return true;
  return /not found|unknown message/i.test(String(result?.error || ''));
}

export async function scanSegment(channel, uid, electronAPI, isCancelled, beforeId, stopBeforeId) {
  const found = [];
  let lastId = beforeId;
  let newestId = null;
  while (!isCancelled()) {
    let result;
    const release = await scanLimiter.acquire();
    try { result = await electronAPI.getChannelMessages(channel.id, lastId); }
    catch { release(); return { found, skipped: true, cancelled: isCancelled(), newestId }; }
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
      catch { release2(); return { found, skipped: true, cancelled: isCancelled(), newestId }; }
      release2();
    }
    if (!result?.success) return { found, skipped: true, cancelled: isCancelled(), newestId };
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
  // BUG-002 : sortie par annulation → segment NON terminé (`cancelled`).
  return { found, skipped: false, cancelled: isCancelled(), newestId };
}

export async function scanChannelMessages(channel, knownUserId, electronAPI, log, isCancelled, onProgress, stopAtId) {
  const uid = knownUserId;

  // Sonde initiale : plus ancien message (1 appel), sert à déduire l'âge du canal.
  // BUG-003 : un échec de cette sonde (429, timeout, « no access ») ne signifie
  // PAS « canal vide ». On retente le 429 (retryAfter), et tout échec résiduel
  // est remonté `skipped:true` pour que le canal soit repris — jamais marqué
  // `scanned` avec 0 message.
  let oldestResult;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { oldestResult = await electronAPI.getChannelMessages(channel.id, null, '0'); }
    catch { oldestResult = null; }
    if (oldestResult?.success) break;
    if (oldestResult?.error === 'Rate limited') {
      await new Promise(r => setTimeout(r, ((oldestResult.retryAfter || 1) * 1000) + 500));
      continue;
    }
    break; // « No access » / autre erreur : inutile d'insister
  }
  if (!oldestResult?.success) {
    return { channelId: channel.id, messages: [], currentUserId: uid, newestId: null, skipped: true, cancelled: false };
  }
  // Succès + liste vide = canal réellement vide (scanné, rien à faire).
  if (!oldestResult.messages?.length) {
    return { channelId: channel.id, messages: [], currentUserId: uid, newestId: null, skipped: false, cancelled: false };
  }

  const oldestId = oldestResult.messages[0].id;
  const ts = snowflakeTs(oldestId);
  const ageDays = (Date.now() - ts) / 86400000;

  // Sequential scan for channels under 1 day old (borné par le watermark si delta)
  if (ageDays < 1) {
    const { found, skipped, cancelled, newestId } = await scanSegment(channel, uid, electronAPI, isCancelled, null, stopAtId || null);
    log(`#${channel.name}: ${found.length}m seq${skipped ? ' (partial)' : ''}`);
    return { channelId: channel.id, messages: found, currentUserId: uid, skipped, cancelled, newestId };
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
  const cancelled = results.some(r => r.cancelled);
  const newestId = results[0]?.newestId || null; // segment 0 scanne depuis le plus récent
  log(`#${channel.name}: ${messages.length}m (${segments}x${skipped ? ', partial' : ''})`);
  return { channelId: channel.id, messages, currentUserId: uid, skipped, cancelled, newestId };
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

  const partialChannelCount = () => countPartialChannels(checkpoint.channels);

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
            // BUG-002 : annulation en cours de scan → canal « partial » (repris),
            // surtout pas « scanned » (sinon sauté à la reprise).
            state.status = (result.skipped || result.cancelled) ? 'partial' : 'scanned';
            state.found = result.messages.length;
            if (result.skipped || result.cancelled) partialChannels++;
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
        // BUG-006 : des canaux n'ont pas pu être scannés → ne pas effacer le
        // checkpoint ni prétendre « Done » (phase reste « scan » pour les reprendre).
        const partialCount = partialChannelCount();
        if (partialCount > 0) {
          if (status) status.textContent = `Terminé, ${partialCount} canal(aux) non scanné(s)`;
          if (phase) { phase.textContent = 'Partial'; phase.style.background = '#faa81a'; }
          updateBar(100);
          if (details) details.textContent = 'Relancez pour scanner les canaux restants';
          actionBtn.textContent = 'Close';
          actionBtn.style.background = '#faa81a';
          actionBtn.disabled = false;
          actionBtn.onclick = () => cleanExit(onComplete);
          checkpoint = touch(checkpoint);
          await saveCheckpoint(OP_MESSAGES, serverId, checkpoint);
          safeTimeout(() => cleanExit(onComplete), 3000);
          return;
        }
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
    let failed = 0;
    // Index du PREMIER échec réel : la reprise y repart. `-1` = aucun échec.
    let firstFail = -1;
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
          // 404 « Unknown Message » / déjà absent = SUCCÈS : le message n'existe
          // plus, le curseur doit avancer. Seul le 429 se réessaie.
          if (isAlreadyDeleted(r)) { ok = true; break; }
          if (r.error === 'Rate limited') {
            await new Promise(resolve => setTimeout(resolve, ((r.retryAfter || 5) * 1000) + 1000));
          } else break;
        } catch (e) { console.error('Delete msg error:', e); await new Promise(resolve => setTimeout(resolve, 2500)); break; }
      }

      if (ok) {
        deleted++;
      } else if (!shouldStop()) {
        // Échec réel (hors annulation) : on consigne l'index fautif mais on
        // N'INTERROMPT PAS la file — le reste des messages est quand même
        // traité. Le curseur, lui, reste figé sur ce premier échec, donc la
        // reprise repart exactement là et rien n'est sauté (pas de livelock).
        failed++;
        if (firstFail === -1) firstFail = i;
        checkpoint.progress.failed = failed;
        log(`delete failed @${i} (${channelId}/${msgId}) — file poursuivie`);
      }

      // Le curseur n'avance QUE tant qu'aucun échec n'a été vu : dès le premier
      // échec il se fige sur son index, y compris pour les succès suivants.
      checkpoint.progress.done = nextDeleteCursor(checkpoint.progress.done, ok && failed === 0);
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

    // Des suppressions ont échoué : NE PAS finaliser le watermark (sinon les
    // canaux inchangés seraient sautés au prochain run alors que des messages
    // restent) ni supprimer le checkpoint — la reprise retente les échecs.
    if (!deletionsComplete(deleted, total, failed)) {
      // La reprise repart du PREMIER échec : tout ce qui suit a pu échouer aussi,
      // on ne saute donc rien (les succès ultérieurs seront rejoués en 404 =
      // succès). Le watermark reste NON finalisé tant qu'un échec subsiste.
      if (firstFail >= 0) checkpoint.progress.done = firstFail;
      checkpoint = touch(checkpoint);
      await saveCheckpoint(OP_MESSAGES, serverId, checkpoint);
      log(`incomplete: ${deleted}/${total} (${failed} échec(s)) — reprise @${checkpoint.progress.done}`);
      updateBar(total ? (deleted / total) * 100 : 0);
      if (phase) { phase.textContent = 'Incomplete'; phase.style.background = '#ed4245'; }
      if (status) status.textContent = `Deleted ${deleted} / ${total} — ${failed} failed (resume available)`;
      if (details) details.textContent = 'Des suppressions ont échoué — relancez pour réessayer';
      actionBtn.textContent = 'Close';
      actionBtn.style.background = '#ed4245';
      actionBtn.disabled = false;
      actionBtn.onclick = () => cleanExit(onComplete);
      safeTimeout(() => cleanExit(onComplete), 5000);
      return;
    }

    log(`fin: ${deleted} ${fmt((Date.now() - delStart) / 1000)}`);

    // BUG-006 : si des canaux sont restés « partial », ne PAS effacer le
    // checkpoint. Le watermark ne doit PAS être finalisé pour ces canaux
    // (finalizeWatermark ne traite déjà que les canaux « scanned ») ; on
    // revient à la phase « scan » pour reprendre les canaux manquants.
    const partialCount = partialChannelCount();
    if (partialCount > 0) {
      await finalizeWatermark();
      checkpoint.phase = 'scan';
      checkpoint = touch(checkpoint);
      await saveCheckpoint(OP_MESSAGES, serverId, checkpoint);
      log(`fin partielle: ${deleted} supprimés, ${partialCount} canal(aux) non scanné(s)`);
      updateBar(100);
      if (phase) { phase.textContent = 'Partial'; phase.style.background = '#faa81a'; }
      if (status) status.textContent = `Terminé, ${partialCount} canal(aux) non scanné(s)`;
      if (details) details.textContent = `${deleted} supprimés — relancez pour scanner les canaux restants`;
      actionBtn.textContent = 'Close';
      actionBtn.style.background = '#faa81a';
      actionBtn.disabled = false;
      actionBtn.onclick = () => cleanExit(onComplete);
      safeTimeout(() => cleanExit(onComplete), 5000);
      return;
    }

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
