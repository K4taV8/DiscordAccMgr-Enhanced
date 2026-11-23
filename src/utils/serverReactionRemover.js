import { formatEmojiForApi } from './emojiUtils.js';
import { autoConcurrency, createTaskPanel, setTaskActionClose } from './serverTaskUtils.js';
import { scanLimiter, deleteLimiter } from './rateLimiter.js';
import { confirmAction } from './ui.js';
import { countPartialChannels } from './serverMessageDeleter.js';
import {
  OP_REACTIONS, loadCheckpoint, saveCheckpoint, clearCheckpoint, newCheckpoint, touch,
  loadLedger, addLedger, ledgerKey, ledgerFilter,
} from './persist.js';

// Meme borne que le chemin DM : une erreur transitoire est retentee avant
// d'abandonner, pour ne pas marquer un salon « partial » sur un simple hoquet.
const SCAN_MAX_ATTEMPTS = 3;

export function decodeQueue(str) {
  const [cid, mid, ...rest] = str.split(':');
  return { channelId: cid, messageId: mid, emojiStr: rest.join(':') };
}

// BUG-022b : ne retirer les clés en attente qu'APRÈS une écriture réussie.
// Un `splice` préalable les effaçait de la mémoire alors que `write` pouvait
// échouer (disque plein, IPC) → réactions supprimées mais non journalisées,
// donc re-signalées comme fantômes au run suivant.
export async function drainLedger(pending, write) {
  if (!pending.length) return [];
  const keys = pending.slice();
  await write(keys);
  pending.splice(0, keys.length);
  return keys;
}

// BUG-023b : à la reprise, `progress.done` compte TOUT ce qui a été traité
// (succès ET échecs). Le nombre réellement supprimé est donc `done - failed` ;
// réutiliser `done` tel quel gonflait `removed` et donc `removed + failed`.
export function resumeCounts(progress) {
  const done = (progress && progress.done) || 0;
  const failed = (progress && progress.failed) || 0;
  return { removed: Math.max(0, done - failed), failed };
}

// Scan COMPLET d'un canal (paginé), sans borne de watermark.
// ⚠️ Fiabilité : pour les réactions, PAS de delta par watermark — une réaction
// peut être ajoutée à un ANCIEN message sans que le message le plus récent
// change. L'ancien watermark sautait des canaux « inchangés » et affichait
// « 0 réaction » alors qu'il en restait. D'où le scan complet à chaque run.
// (Le watermark reste légitime pour la SUPPRESSION DE MESSAGES : un message ne
// s'ajoute qu'à la fin.)
//
// `suppressed` = Set de clés ledger (réactions déjà confirmées supprimées/absentes)
// → les fantômes du cache `me:true` périmé de Discord sont ignorés.
export async function scanChannelReactions(channel, electronAPI, log, isCancelled, onPage, opts = {}) {
  const { suppressed } = opts;
  const reactions = [];
  let lastId = null;
  let pages = 0;
  let newestId = null;
  let echecs = 0;
  while (!isCancelled()) {
    let result;
    const release = await scanLimiter.acquire();
    try { result = await electronAPI.getChannelMessages(channel.id, lastId); }
    catch { result = { success: false, error: 'exception' }; }
    release();

    if (!result.success) {
      if (result.error === 'Rate limited') {
        await new Promise(resolve => setTimeout(resolve, ((result.retryAfter || 1) * 1000) + 500));
        continue;
      }
      // Definitive : le compte ne peut PAS lire ce salon (403). Rien n'y est
      // supprimable -> etat DISTINCT `noAccess`, jamais « partial » (sinon tout
      // le serveur echoue a cause de salons prives que le compte ne voit pas).
      if (result.error === 'No access') {
        log?.(`#${channel.name} : sans acces (ignore)`);
        return { reactions, skipped: true, noAccess: true, cancelled: isCancelled(), newestId };
      }
      // Erreur a priori transitoire (5xx, reseau) : on retente avant d'abandonner,
      // comme le chemin DM. Sans ca, un simple hoquet reseau marquait « partial ».
      if (echecs < SCAN_MAX_ATTEMPTS - 1 && !isCancelled()) {
        echecs++;
        await new Promise(resolve => setTimeout(resolve, 400 * echecs));
        continue;
      }
      log?.(`#${channel.name} : scan interrompu (${result.error})`);
      return { reactions, skipped: true, noAccess: false, cancelled: isCancelled(), newestId };
    }
    echecs = 0;
    if (!result.messages || !result.messages.length) break;
    if (newestId === null) newestId = result.messages[0].id;
    for (const msg of result.messages) {
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
    if (result.messages.length < 100) break;
    lastId = lastMsg.id;
  }
  // BUG-002 : sortie de boucle par annulation → le canal n'est PAS « scanné ».
  // `cancelled` le distingue de la fin naturelle pour que l'appelant le marque
  // « partial » (repris au prochain run) au lieu de le sauter.
  return { reactions, skipped: false, noAccess: false, cancelled: isCancelled(), newestId };
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
  const ledgerPending = [];

  const flushLedger = async () => {
    const keys = await drainLedger(ledgerPending, addLedger);
    for (const k of keys) suppressed.set(k, Date.now());
  };

  const partialChannelCount = () => countPartialChannels(checkpoint.channels);

  const t = createTaskPanel(serverName, '[RmReactions]');
  const { phase, status, details, progressNum, totalNum, actionBtn, updateBar, cleanExit, log, safeTimeout, shouldStop } = t;

  try {
    log('démarrage');
    const chRes = await electronAPI.getServerChannels(serverId);
    if (!chRes.success || !chRes.channels.length) {
      if (status) status.textContent = 'Aucun salon trouvé';
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
    if (status) status.textContent = `Analyse de ${channels.length} salon(s) (${concurrency}x)`;
    if (totalNum) totalNum.textContent = channels.length.toString();
    if (phase) phase.textContent = 'Analyse';

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
          if (state.status === 'scanned' || state.status === 'no-access') { scanned++; updateBar((scanned / channels.length) * 100); continue; }
          if (status) status.textContent = `#${ch.name} (${idx + 1}/${channels.length})`;
          if (progressNum) progressNum.textContent = (idx + 1).toString();
          try {
            // Fiabilité : PAS de delta par watermark. Une réaction peut être
            // ajoutée à un ANCIEN message sans que le message le plus récent
            // change → le watermark sautait des canaux et affichait « 0 réaction »
            // alors qu'il en restait. Scan complet à chaque run.
            state.status = 'scanning';
            const { reactions, skipped, cancelled, noAccess, newestId } = await scanChannelReactions(ch, electronAPI, log, shouldStop, p => {
              if (details) details.textContent = `#${ch.name}: page ${p}`;
            }, { suppressed });
            state.newestId = newestId || state.newestId;
            // BUG-002 : une annulation pendant le scan → canal « partial » (repris),
            // jamais « scanned » (sinon sauté à la reprise).
            if (noAccess) state.status = 'no-access';
            else state.status = (skipped || cancelled) ? 'partial' : 'scanned';
            state.found = reactions.length;
            if (!noAccess && (skipped || cancelled)) partialChannels++;
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
      log(`analyse terminée : ${total}`);
      if (partialChannels > 0) log(`ATTENTION : ${partialChannels} salon(s) analysé(s) partiellement — des réactions peuvent manquer`);

      if (total === 0) {
        const partialCount = partialChannelCount();
        // BUG-006 : canaux non scannés → ne pas effacer le checkpoint (reprise).
        if (partialCount > 0) {
          if (status) status.textContent = `Terminé, ${partialCount} canal(aux) non scanné(s)`;
          if (phase) { phase.textContent = 'Partiel'; phase.style.background = '#faa81a'; }
          updateBar(100);
          if (details) details.textContent = 'Relancez pour scanner les canaux restants';
          setTaskActionClose(actionBtn, () => cleanExit(onComplete));
          checkpoint = touch(checkpoint);
          await saveCheckpoint(OP_REACTIONS, serverId, checkpoint);
          safeTimeout(() => cleanExit(onComplete), 3000);
          return;
        }
        if (status) status.textContent = 'Aucune réaction trouvée';
        if (phase) { phase.textContent = 'Terminé'; phase.style.background = '#3ba55d'; }
        updateBar(100);
        if (details) details.textContent = 'Rien à retirer';
        setTaskActionClose(actionBtn, () => cleanExit(onComplete));
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
    if (phase) { phase.textContent = 'Retrait'; phase.style.background = '#faa81a'; }
    if (status) status.textContent = `Retrait de ${total} réaction(s)...`;
    if (progressNum) progressNum.textContent = checkpoint.progress.done.toString();
    actionBtn.textContent = 'Arrêter';
    actionBtn.disabled = false;
    updateBar(total ? (checkpoint.progress.done / total) * 100 : 0);

    // BUG-023b : à la reprise, `done` inclut les échecs → removed = done - failed.
    let { removed, failed } = resumeCounts(checkpoint.progress);

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
      if (details) details.textContent = `Retirées ${removed}/${i + 1}${failed > 0 ? ` (${failed} en échec)` : ''}`;
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
      if (phase) { phase.textContent = 'Vérification'; phase.style.background = '#faa81a'; }
      if (status) status.textContent = `Vérification passe ${pass + 1}...`;
      const ghosts = [];
      for (const ch of recheckChannels) {
        const { reactions } = await scanChannelReactions(ch, electronAPI, log, shouldStop, p => {
          if (details) details.textContent = `Vérification #${ch.name} : page ${p}`;
        }, { suppressed });
        ghosts.push(...reactions);
      }
      if (!ghosts.length) { if (status) status.textContent = `Terminé : ${removed} retirée(s), ${failed} en échec`; break; }
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

    log(`fin : retirées=${removed} échecs=${failed}`);

    // BUG-006 : des canaux n'ont pas pu être scannés (partial) → statut final
    // explicite et checkpoint CONSERVÉ (phase remise à « scan » pour les
    // reprendre), au lieu d'un « Done » trompeur suivi d'un effacement.
    const partialCount = partialChannelCount();
    if (partialCount > 0) {
      checkpoint.phase = 'scan';
      checkpoint = touch(checkpoint);
      await saveCheckpoint(OP_REACTIONS, serverId, checkpoint);
      log(`fin partielle: ${removed} supprimées, ${partialCount} canal(aux) non scanné(s)`);
      updateBar(100);
      if (phase) { phase.textContent = 'Partiel'; phase.style.background = '#faa81a'; }
      if (status) status.textContent = `Terminé, ${partialCount} canal(aux) non scanné(s)`;
      if (details) details.textContent = `${removed} supprimées — relancez pour scanner les canaux restants`;
      setTaskActionClose(actionBtn, () => cleanExit(onComplete));
      safeTimeout(() => cleanExit(onComplete), 5000);
      return;
    }

    updateBar(100);
    if (phase) { phase.textContent = 'Terminé'; phase.style.background = '#3ba55d'; }
    if (status) status.textContent = `Retirées ${removed} / ${removed + failed}${failed > 0 ? ` (${failed} en échec)` : ''}`;
    if (details) details.textContent = `${removed} retirée(s)${failed > 0 ? `, ${failed} en échec` : ''}`;
    setTaskActionClose(actionBtn, () => cleanExit(onComplete));

    await clearCheckpoint(OP_REACTIONS, serverId);
    safeTimeout(() => cleanExit(onComplete), 5000);
  } catch (err) {
    console.error(err);
    log(`err: ${err.message}`);
    if (status) status.textContent = `Erreur : ${err.message}`;
    if (phase) { phase.textContent = 'Erreur'; phase.style.background = '#ed4245'; }
    if (checkpoint) {
      checkpoint = touch(checkpoint);
      await saveCheckpoint(OP_REACTIONS, serverId, checkpoint).catch(() => {});
    }
    safeTimeout(() => cleanExit(onComplete), 3000);
  }
}
