// Rate limiter global partagé entre toutes les opérations (scan + suppression).
// Un seul budget de requêtes pour toute l'app : avec 200 serveurs séquentiels,
// chaque opération hérite du même débit — pas de pic local.

export class RateLimiter {
  constructor({ ratePerSec, burst, maxConcurrent }) {
    this.rate = ratePerSec;
    this.burst = burst;
    this.maxConcurrent = maxConcurrent;
    this.tokens = burst;
    this.lastRefill = Date.now();
    this.inFlight = 0;
    this.throttleFactor = 1;
    this.throttleUntil = 0;
  }

  get currentRate() {
    return Date.now() < this.throttleUntil ? this.rate * this.throttleFactor : this.rate;
  }

  // ponytail: token bucket + semaphore, poll à 20ms. Pas de file d'attente : le polling
  // est plus court à écrire et assez précis pour ~25 r/s.
  async acquire() {
    for (;;) {
      const now = Date.now();
      if (now > this.lastRefill) {
        this.tokens = Math.min(this.burst, this.tokens + ((now - this.lastRefill) / 1000) * this.currentRate);
        this.lastRefill = now;
      }
      if (this.tokens >= 1 && this.inFlight < this.maxConcurrent) {
        this.tokens -= 1;
        this.inFlight += 1;
        return () => { this.inFlight -= 1; };
      }
      await new Promise(r => setTimeout(r, 20));
    }
  }

  // Appelé après un 429 : débit réduit temporairement pour éviter la cascade.
  throttle(retryAfterMs = 0) {
    this.throttleFactor = Math.min(this.throttleFactor, 0.4);
    this.throttleUntil = Date.now() + Math.max(retryAfterMs * 1000, 10000) * 4;
    this.tokens = Math.min(this.tokens, 0); // refroidissement net : aucun envoi immédiat
  }
}

// ponytail : les limiters renderer ne contraignent plus le débit réel — le main
// (makeRouteScheduler, header-aware X-RateLimit-*) est l'autorité. Taux relevés
// pour ne pas brider les bursts que les en-têtes autorisent ; maxConcurrent gardé.
export const scanLimiter = new RateLimiter({ ratePerSec: 100, burst: 50, maxConcurrent: 12 });
export const deleteLimiter = new RateLimiter({ ratePerSec: 30, burst: 10, maxConcurrent: 4 });