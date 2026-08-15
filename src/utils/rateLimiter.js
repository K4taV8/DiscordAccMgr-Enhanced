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
  }

  // ponytail: token bucket + semaphore, poll à 20ms. Pas de file d'attente : le polling
  // est plus court à écrire et assez précis pour ~25 r/s.
  async acquire() {
    for (;;) {
      const now = Date.now();
      if (now > this.lastRefill) {
        this.tokens = Math.min(this.burst, this.tokens + ((now - this.lastRefill) / 1000) * this.rate);
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

}

// ponytail : les limiters renderer ne contraignent plus le débit réel — le main
// (makeRouteScheduler, header-aware X-RateLimit-*) est l'autorité. Taux relevés
// pour ne pas brider les bursts que les en-têtes autorisent ; maxConcurrent gardé.
// P-02 : throttle() retiré — un 429 est absorbé par le main + sleep(retryAfter),
// plus de frein renderer résiduel.
export const scanLimiter = new RateLimiter({ ratePerSec: 100, burst: 50, maxConcurrent: 12 });
export const deleteLimiter = new RateLimiter({ ratePerSec: 30, burst: 10, maxConcurrent: 4 });