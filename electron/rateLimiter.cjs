// Rate limiting côté main process (CJS).
// makeRateLimiter : token-bucket nominal (repli). makeRouteScheduler :
// pilotage au budget réel renvoyé par les en-têtes X-RateLimit-* (zéro 429).

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ponytail: token-bucket nominal. Pas de file d'attente : polling 20ms,
// assez précis pour les débits visés (quelques dizaines de req/s).
function makeRateLimiter(ratePerSec, burst) {
  let tokens = burst;
  let last = Date.now();
  return {
    async acquire() {
      for (;;) {
        const now = Date.now();
        tokens = Math.min(burst, tokens + ((now - last) / 1000) * ratePerSec);
        last = now;
        if (tokens >= 1) { tokens -= 1; return; }
        await sleep(20);
      }
    }
  };
}

// Ordonnanceur conscient des en-têtes de débit Discord.
// - Avant chaque requête : `acquire(routeKey)`.
//   * Si le bucket de la route (ou le bucket global) annonce `remaining <= 0`,
//     attendre jusqu'à `resetAt` (X-RateLimit-Reset-After) — jamais de 429.
//   * Si les en-têtes sont connus, le budget annoncé est consommé de façon
//     optimiste (décrement) → bursts sûrs jusqu'à `remaining`.
//   * Sans en-têtes (première requête d'une route), repli sur le token-bucket
//     nominal (seuil sûr calibré).
// - Après chaque réponse : `applyHeaders(routeKey, headers)` resynchronise
//   les buckets (dont Retry-After sur 429, qui force une pause).
// ponytail: bucket par route normalisée (IDs de snowflake masqués), pas de
// modèle exact des "major params" de Discord — suffisant pour éviter les 429.
function makeRouteScheduler({ nominalRatePerSec, burst, maxConcurrent }) {
  const nominal = makeRateLimiter(nominalRatePerSec, burst);
  const routes = new Map();
  const globalBucket = { remaining: null, resetAt: 0 };
  let inflight = 0;

  const bucketFor = (key) => {
    let b = routes.get(key);
    if (!b) { b = { remaining: null, resetAt: 0 }; routes.set(key, b); }
    return b;
  };

  function applyHeaders(key, headers) {
    if (!headers) return;
    const b = bucketFor(key);
    const rem = headers['x-ratelimit-remaining'];
    const resetAfter = headers['x-ratelimit-reset-after'];
    const isGlobal = headers['x-ratelimit-global'] === 'true';

    if (rem !== undefined) {
      b.remaining = Number(rem);
      if (isGlobal) globalBucket.remaining = Number(rem);
    }
    if (resetAfter !== undefined) {
      const at = Date.now() + Number(resetAfter) * 1000;
      b.resetAt = at;
      if (isGlobal) globalBucket.resetAt = at;
    }
    const retryAfter = headers['retry-after'];
    if (retryAfter !== undefined) {
      b.remaining = 0;
      b.resetAt = Date.now() + Number(retryAfter) * 1000;
    }
  }

  async function acquire(key) {
    for (;;) {
      const now = Date.now();
      if (inflight >= maxConcurrent) { await sleep(10); continue; }

      // budget global périmé (reset dépassé) → repli nominal, pas de blocage
      if (globalBucket.remaining !== null && globalBucket.remaining <= 0 && now >= globalBucket.resetAt) {
        globalBucket.remaining = null;
      }
      if (globalBucket.remaining !== null && globalBucket.remaining <= 0) {
        await sleep(Math.min(globalBucket.resetAt - now, 60000));
        continue;
      }

      const b = bucketFor(key);
      // budget de route périmé (reset dépassé) → repli nominal, pas de blocage
      if (b.remaining !== null && b.remaining <= 0 && now >= b.resetAt) {
        b.remaining = null;
        b.resetAt = 0;
      }
      if (b.remaining !== null) {
        if (b.remaining <= 0) {
          await sleep(Math.min(b.resetAt - now, 60000));
          continue;
        }
        b.remaining -= 1; // consommation optimiste du budget annoncé
      } else {
        await nominal.acquire(); // repli : en-têtes pas encore vus → débit nominal sûr
      }

      inflight += 1;
      return () => { inflight -= 1; };
    }
  }

  return { acquire, applyHeaders };
}

module.exports = { makeRateLimiter, makeRouteScheduler };
