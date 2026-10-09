// Préchargement des pages : pendant le login (warm-up des 4 listes) ou au
// survol d'un nav-item. Un seul refresh en vol par page (le warm login et un
// survol simultanés ne dupliquent pas le fetch), erreurs avalées silencieuses
// (une page en échec ne doit jamais bloquer la connexion).

export const LIST_CACHE_TTL = 30000;

// pageId -> { manager, refresh }   (câblé depuis main.js)
let preloads = {};

// pageId -> Promise du refresh en cours
const inFlight = new Map();

// Incrementé à chaque purge (changement de compte) : un refresh en vol dont la
// génération a changé ne doit pas laisser son résultat dans le cache.
let generation = 0;

export function configurePreloads(map) {
  preloads = map;
}

export function preloadPage(pageId) {
  const p = preloads[pageId];
  if (!p) return Promise.resolve();
  if (inFlight.has(pageId)) return inFlight.get(pageId);
  const gen = generation;
  const job = Promise.resolve()
    .then(() => p.refresh())
    .catch(() => {})
    .finally(() => {
      inFlight.delete(pageId);
      // Compte changé pendant le refresh : le cache écrit (compte précédent) est
      // périmé, on l'annule pour ne pas afficher les données de l'autre compte.
      if (gen !== generation && p.manager) p.manager._cache = null;
    });
  inFlight.set(pageId, job);
  return job;
}

export function preloadPages(pageIds) {
  return Promise.allSettled(pageIds.map(preloadPage));
}

export function isPageCachedFresh(pageId, now = Date.now()) {
  const cache = preloads[pageId]?.manager?._cache;
  return !!(cache && now - cache.at < LIST_CACHE_TTL);
}

export function clearPageCaches() {
  generation += 1;
  inFlight.clear();
  for (const p of Object.values(preloads)) {
    if (p.manager) p.manager._cache = null;
  }
}