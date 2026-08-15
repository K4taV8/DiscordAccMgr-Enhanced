import { ProgressBar } from '../components/ProgressBar.js';
import { formatEmojiForApi, escHtml } from './emojiUtils.js';
import { scanLimiter, deleteLimiter } from './rateLimiter.js';

const MAX_MESSAGES = 2000;

// ─────────────────────────────────────────────────────────────────────────────
// MODÈLE DE FIABILITÉ (DM / groupes) — ne pas casser :
//   1. SCAN  : collecte UNIQUEMENT les réactions dont r.me === true.
//   2. DELETE: `formatEmojiForApi` (U+FE0F conservé) + 3 tentatives/429.
//              Un 404 = `noReaction` → succès (réaction déjà absente).
//   3. VÉRIF : re-scan + re-suppression des réactions restantes. On n'annonce
//              JAMAIS « supprimé » sans que Discord confirme l'absence.
// Exports purs (electronAPI + shouldStop injectés) → testables sans DOM.
// ─────────────────────────────────────────────────────────────────────────────

// Scan paginé : collecte les réactions de l'utilisateur (r.me === true) sur le
// canal. `shouldStop` est un getter pour re-lire l'annulation après chaque await.
export async function scanOwnReactions(channelId, isGroup, electronAPI, shouldStop) {
  const messages = [];
  let lastMessageId = null;
  let hasMore = true;
  let totalFetched = 0;

  while (hasMore && !shouldStop() && totalFetched < MAX_MESSAGES) {
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

    for (const msg of result.messages) {
      if (msg.reactions && msg.reactions.length > 0) {
        const mine = msg.reactions.filter(r => r.me === true);
        if (mine.length > 0) messages.push({ id: msg.id, reactions: mine });
      }
    }

    totalFetched += result.messages.length;
    if (result.messages.length < 100) hasMore = false;
    else lastMessageId = result.messages[result.messages.length - 1].id;
  }

  return { messages };
}

// Supprime les réactions d'une liste.
// Sémantique des retours de `removeOwnReaction` (main.cjs) :
//   success        → supprimé
//   noReaction(404)→ déjà absent → compté SUCCÈS (anti-fantôme, pas un échec)
//   invalidEmoji   → requête invalide (400) → compté ÉCHEC (visible, pas silencieux)
//   Rate limited   → retry borné (3×) avec Retry-After
export async function deleteReactionList(messages, channelId, electronAPI, shouldStop, onProgress) {
  let removed = 0;
  let failed = 0;
  let processed = 0;
  const total = messages.reduce((acc, msg) => acc + msg.reactions.length, 0);

  for (const msg of messages) {
    if (shouldStop()) break;
    for (const reaction of msg.reactions) {
      if (shouldStop()) break;

      const emojiStr = formatEmojiForApi(reaction.emoji);
      if (!emojiStr) { failed++; processed++; if (onProgress) onProgress(processed, removed, failed); continue; }

      let success = false;
      for (let attempt = 0; attempt < 3 && !shouldStop(); attempt++) {
        const release = await deleteLimiter.acquire();
        let r;
        try { r = await electronAPI.removeOwnReaction(channelId, msg.id, emojiStr); }
        finally { release(); }
        if (r.success || r.error === 'noReaction') { success = true; break; }
        if (r.error === 'Rate limited') {
          await new Promise(resolve => setTimeout(resolve, ((r.retryAfter || 3) * 1000) + 500));
        }
      }

      if (success) removed++;
      else failed++;

      processed++;
      if (onProgress) onProgress(processed, removed, failed);
    }
  }

  return { removed, failed, processed, total };
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
  const isCancelled = () => shouldStop;

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

  const $ = (id) => document.getElementById(id);
  const refreshCounters = (processed, removed, failed) => {
    $('processedCount').textContent = processed.toString();
    $('removedCount').textContent = removed.toString();
    $('failedCount').textContent = failed.toString();
  };

  try {
    // ---- Phase SCAN ----
    const { messages } = await scanOwnReactions(channelId, isGroup, electronAPI, isCancelled);

    if (shouldStop) throw new Error('Operation cancelled');

    const totalReactions = messages.reduce((acc, msg) => acc + msg.reactions.length, 0);
    $('totalCount').textContent = totalReactions.toString();

    if (totalReactions === 0) {
      progressBar.update(100);
      safeTimeout(() => { modalOverlay.remove(); onComplete(); }, 1000);
      return;
    }

    // ---- Phase DELETE ----
    const first = await deleteReactionList(messages, channelId, electronAPI, isCancelled, (processed, removed, failed) => {
      refreshCounters(processed, removed, failed);
      progressBar.update((processed / totalReactions) * 100);
    });

    let removed = first.removed;
    let failed = first.failed;

    // ---- Phase VÉRIFICATION anti-fantômes ----
    // Ne jamais annoncer « supprimé » sans que Discord confirme l'absence :
    // re-scan et re-supprime les réactions restantes (même principe que la
    // passe "ghost" du chemin serveur).
    if (!shouldStop) {
      log(`first pass done: removed=${first.removed}, failed=${first.failed} — verifying`);
      const { messages: ghosts } = await scanOwnReactions(channelId, isGroup, electronAPI, isCancelled);
      const ghostTotal = ghosts.reduce((acc, msg) => acc + msg.reactions.length, 0);

      if (ghostTotal > 0 && !shouldStop) {
        log(`verification: ${ghostTotal} reaction(s) still present — retrying`);
        const second = await deleteReactionList(ghosts, channelId, electronAPI, isCancelled, (processed, r, f) => {
          refreshCounters(first.processed + processed, removed + r, failed + f);
          progressBar.update(Math.min(100, ((first.processed + processed) / totalReactions) * 100));
        });
        removed += second.removed;
        failed += second.failed;
        log(`verification done: removed=${second.removed}, failed=${second.failed}`);
      } else {
        log('verification: clean');
      }
    }

    log(`Completed: removed=${removed}, failed=${failed}, total=${totalReactions}`);
    progressBar.update(100);
    refreshCounters(totalReactions, removed, failed);
  } catch (error) {
    console.error('Remove reactions error:', error);
    const progressContainer = document.getElementById('progressContainer');
    if (progressContainer) progressContainer.innerHTML = `<p class="error">${error.message}</p>`;
  } finally {
    clearTimers();
    safeTimeout(() => { modalOverlay.remove(); onComplete(); }, 1000);
  }
}

// Suppression en masse (plusieurs DM / groupes) : UNE seule modal avec une
// progression agrégée. Corrige l'ancien chemin qui empilait une modal par cible
// et perdait les ids du DOM (le rendu « se lance et se termine direct »).
export async function removeReactionsBulk({ targets, electronAPI, isGroup = false, onComplete = () => {} }) {
  const total = targets.length;
  let completed = 0;
  let removed = 0;
  let failed = 0;
  let shouldStop = false;

  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-content">
      <h2>Removing your reactions — ${total} ${isGroup ? 'group' : 'DM'}${total > 1 ? 's' : ''}</h2>
      <div class="progress-container">
        <div class="progress-track"><div class="progress-fill" style="width:0%"></div></div>
        <div class="progress-text">0/${total} — 0 removed, 0 failed</div>
      </div>
      <button class="btn btn-danger" id="bulkCancelBtn" style="margin-top:12px">Cancel All</button>
    </div>
  `;
  document.body.appendChild(modal);

  const fill = modal.querySelector('.progress-fill');
  const text = modal.querySelector('.progress-text');
  const cancelBtn = modal.querySelector('#bulkCancelBtn');
  cancelBtn.addEventListener('click', () => {
    shouldStop = true;
    cancelBtn.disabled = true;
    text.textContent += ' — cancelling…';
  });

  const isCancelled = () => shouldStop;
  const log = (msg) => {
    try { window.log?.(`[RmReactions] ${msg}`); } catch {}
    console.log(`[RmReactions] ${msg}`);
  };

  const updateProgress = () => {
    fill.style.width = `${(completed / total) * 100}%`;
    text.textContent = `${completed}/${total} — ${removed} removed, ${failed} failed`;
  };

  try {
    for (const target of targets) {
      if (shouldStop) break;

      const { messages } = await scanOwnReactions(target.channelId, isGroup, electronAPI, isCancelled);
      if (shouldStop) break;
      log(`${target.channelName}: ${messages.reduce((a, m) => a + m.reactions.length, 0)} reaction(s) found`);

      const first = await deleteReactionList(messages, target.channelId, electronAPI, isCancelled);
      removed += first.removed;
      failed += first.failed;

      // Vérification anti-fantômes (même passe que la méthode individuelle)
      if (!shouldStop) {
        const { messages: ghosts } = await scanOwnReactions(target.channelId, isGroup, electronAPI, isCancelled);
        const ghostTotal = ghosts.reduce((a, m) => a + m.reactions.length, 0);
        if (ghostTotal > 0 && !shouldStop) {
          log(`${target.channelName}: ${ghostTotal} ghost(s) — retrying`);
          const second = await deleteReactionList(ghosts, target.channelId, electronAPI, isCancelled);
          removed += second.removed;
          failed += second.failed;
        }
      }

      completed++;
      updateProgress();
    }

    log(`bulk done: removed=${removed}, failed=${failed} (${completed}/${total})`);
    fill.style.width = '100%';
    text.textContent = `${completed}/${total} — ${removed} removed, ${failed} failed`;
  } catch (error) {
    console.error('Bulk remove reactions error:', error);
    text.textContent = `Error: ${error.message}`;
  } finally {
    setTimeout(() => { modal.remove(); onComplete(); }, 1000);
  }
}
