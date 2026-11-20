import { ProgressBar } from '../components/ProgressBar.js';
import { formatEmojiForApi, escHtml } from './emojiUtils.js';
import { scanLimiter, deleteLimiter } from './rateLimiter.js';
import { showNotification } from './ui.js';

// Plafond de SECURITE uniquement (garde-fou anti-boucle si l API renvoyait
// toujours la meme page). Il ne doit JAMAIS tronquer un historique normal : a
// 2000, un DM plus long n etait scanne qu en partie -> les reactions au-dela
// restaient en place et l audit signalait « scan incomplet » a tort.
const MAX_MESSAGES = 100000;
// BUG-004 : une erreur réseau n'est pas une fin d'historique. On retente les
// erreurs transitoires avant de conclure, et on borne les tentatives pour ne
// jamais boucler à l'infini sur une panne persistante.
const SCAN_MAX_ATTEMPTS = 3;

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
// Retourne `{ messages, complete }`. `complete === false` signifie que
// l'historique n'a PAS été parcouru en entier (erreur réseau persistante ou
// plafond MAX_MESSAGES atteint) : l'appelant doit le signaler, jamais le
// présenter comme un succès complet.
export async function scanOwnReactions(channelId, isGroup, electronAPI, shouldStop, { maxMessages = MAX_MESSAGES } = {}) {
  const messages = [];
  let lastMessageId = null;
  let hasMore = true;
  let totalFetched = 0;
  let complete = true;

  while (hasMore && !shouldStop() && totalFetched < maxMessages) {
    let result = null;
    let fetched = false;
    for (let attempt = 0; attempt < SCAN_MAX_ATTEMPTS && !shouldStop(); attempt++) {
      const release = await scanLimiter.acquire();
      try {
        result = isGroup
          ? await electronAPI.getChannelMessages(channelId, lastMessageId)
          : await electronAPI.getDMMessages(channelId, lastMessageId);
      } finally {
        release();
      }

      if (result.success) { fetched = true; break; }
      if (result.error === 'Rate limited') {
        // 429 : respecter Retry-After avant la tentative suivante.
        await new Promise(resolve => setTimeout(resolve, ((result.retryAfter || 5) * 1000) + 1000));
      }
      // Autres erreurs : retentées immédiatement (bornées par le compteur).
    }

    // BUG-004 : après épuisement des tentatives, on s'arrête MAIS on note que
    // le scan est incomplet — ne pas traiter un échec comme une fin de page.
    if (!fetched) {
      complete = false;
      hasMore = false;
      // Diagnostic : la raison exacte (statut / erreur) de l arret, visible en
      // console si l utilisateur signale encore un « scan incomplet ».
      try { console.warn(`[RmReactions] scan interrompu apres ${SCAN_MAX_ATTEMPTS} echecs — dernier resultat :`, result); } catch {}
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

  // BUG-004 : sortie de boucle avec `hasMore` encore vrai = plafond atteint
  // (ou annulation) -> le scan ne couvre pas tout l historique.
  if (hasMore && !shouldStop()) {
    complete = false;
    try { console.warn(`[RmReactions] plafond de securite atteint (${maxMessages} messages) — historique NON couvert en entier`); } catch {}
  }

  return { messages, complete };
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
  isGroup = false,
  quiet = false
}) {
  let modalOverlay = null;
  let progressBar = null;

  // BUG-006 : en mode lot (`quiet`) on ne crée AUCUNE modale — executeCleaningMode
  // en empilait une par salon. ProgressBar lit `#progressContainer` au
  // constructeur ET dans create() : il ne doit être construit qu'APRES que la
  // modale soit rattachée au document, sinon `getElementById` rend null.
  if (!quiet) {
    modalOverlay = document.createElement('div');
    modalOverlay.className = 'modal-overlay';
    modalOverlay.innerHTML = `
      <div class="modal-content">
        <h2>Retrait de vos réactions ${isGroup ? 'dans' : 'avec'} ${escHtml(channelName)}</h2>
        <div id="progressContainer">
          <div class="message-counter">
            <span id="processedCount">0</span> / <span id="totalCount">0</span> traitées
            — <span id="removedCount">0</span> retirées, <span id="failedCount">0</span> en échec
          </div>
          <div id="scanWarning" class="scan-warning"></div>
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
  const isCancelled = () => shouldStop;

  progressBar?.onCancel(() => {
    shouldStop = true;
    progressBar.setCancelButtonText('Annulation...');
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

  const $ = (id) => (quiet ? null : document.getElementById(id));
  const setText = (id, value) => { const el = $(id); if (el) el.textContent = value; };
  const refreshCounters = (processed, removed, failed) => {
    setText('processedCount', processed.toString());
    setText('removedCount', removed.toString());
    setText('failedCount', failed.toString());
  };

  try {
    // BUG-004 : `complete === false` = scan partiel → il DOIT être signalé, il
    // ne doit jamais passer pour un « tout est supprimé ».
    let scanComplete = true;
    const markScanIncomplete = () => {
      scanComplete = false;
      const warning = $('scanWarning');
      if (warning) warning.textContent = '⚠ scan incomplet — certaines réactions peuvent ne pas avoir été traitées';
      showNotification('Scan incomplet : l’historique n’a pas pu être parcouru en entier');
    };

    // ---- Phase SCAN ----
    const firstScan = await scanOwnReactions(channelId, isGroup, electronAPI, isCancelled);
    const messages = firstScan.messages;
    if (!firstScan.complete) markScanIncomplete();

    if (shouldStop) throw new Error('Opération annulée');

    const totalReactions = messages.reduce((acc, msg) => acc + msg.reactions.length, 0);
    setText('totalCount', totalReactions.toString());

    if (totalReactions === 0) {
      progressBar?.update(100);
      safeTimeout(() => { modalOverlay?.remove(); onComplete(); }, 1000);
      return;
    }

    // ---- Phase DELETE ----
    const first = await deleteReactionList(messages, channelId, electronAPI, isCancelled, (processed, removed, failed) => {
      refreshCounters(processed, removed, failed);
      progressBar?.update((processed / totalReactions) * 100);
    });

    let removed = first.removed;
    let failed = first.failed;

    // ---- Phase VÉRIFICATION anti-fantômes ----
    // Ne jamais annoncer « supprimé » sans que Discord confirme l'absence :
    // re-scan et re-supprime les réactions restantes (même principe que la
    // passe "ghost" du chemin serveur).
    if (!shouldStop) {
      log(`first pass done: removed=${first.removed}, failed=${first.failed} — verifying`);
      const verifyScan = await scanOwnReactions(channelId, isGroup, electronAPI, isCancelled);
      if (!verifyScan.complete) markScanIncomplete();
      const ghosts = verifyScan.messages;
      const ghostTotal = ghosts.reduce((acc, msg) => acc + msg.reactions.length, 0);

      if (ghostTotal > 0 && !shouldStop) {
        log(`verification: ${ghostTotal} reaction(s) still present — retrying`);
        const second = await deleteReactionList(ghosts, channelId, electronAPI, isCancelled, (processed, r, f) => {
          refreshCounters(first.processed + processed, removed + r, failed + f);
          progressBar?.update(Math.min(100, ((first.processed + processed) / totalReactions) * 100));
        });
        removed += second.removed;
        failed += second.failed;
        log(`verification done: removed=${second.removed}, failed=${second.failed}`);
      } else {
        log('verification: clean');
      }
    }

    log(`Completed: removed=${removed}, failed=${failed}, total=${totalReactions}, scanComplete=${scanComplete}`);
    progressBar?.update(100);
    refreshCounters(totalReactions, removed, failed);
  } catch (error) {
    console.error('Erreur du retrait des réactions :', error);
    if (quiet) showNotification(`Réactions : ${error?.message || String(error)}`);
    const progressContainer = document.getElementById('progressContainer');
    if (progressContainer) progressContainer.innerHTML = `<p class="error">${escHtml(error?.message || String(error))}</p>`;
  } finally {
    clearTimers();
    safeTimeout(() => { modalOverlay?.remove(); onComplete(); }, 1000);
  }
}
