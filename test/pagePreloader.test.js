import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIST_CACHE_TTL,
  configurePreloads,
  preloadPage,
  preloadPages,
  isPageCachedFresh,
  clearPageCaches,
} from '../src/utils/pagePreloader.js';

// Faux manager : _cache (le champ lu par cachedListRefresh) + un refresh stub.
function stubManager(cachedAt = null, refresh = async () => 'data') {
  return { _cache: cachedAt === null ? null : { data: 'cached', at: cachedAt }, refresh };
}

test('preloadPage résout la valeur renvoyée par le refresh', async () => {
  const mgr = stubManager();
  mgr.refresh = async () => 'friends-data';
  configurePreloads({ f: { manager: mgr, refresh: () => mgr.refresh() } });
  assert.equal(await preloadPage('f'), 'friends-data');
});

test('preloadPage avale un refresh en échec (erreur silencieuse)', async () => {
  const mgr = stubManager();
  mgr.refresh = async () => { throw new Error('Réseau en panne'); };
  configurePreloads({ p: { manager: mgr, refresh: () => mgr.refresh() } });
  await preloadPage('p'); // ne doit pas rejeter-> sinon le login serait bloqué par une page
});

test('deux preloadPage simultanés ne lancent qu un seul refresh', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const mgr = stubManager();
  mgr.refresh = async () => { calls++; await gate; return 'ok'; };
  configurePreloads({ p: { manager: mgr, refresh: () => mgr.refresh() } });

  const p1 = preloadPage('p');
  const p2 = preloadPage('p');
  await Promise.resolve(); // laisser le microtask lancer refresh() avant d'observer
  assert.equal(calls, 1);
  release();
  await Promise.all([p1, p2]);
  assert.equal(calls, 1, 'le refresh ne doit tourner qu une fois, même pendant le warm login + survol');
});

test('une fois terminé, un nouveau preloadPage relance le refresh (le dedup ne vit qu en vol)', async () => {
  let calls = 0;
  const mgr = stubManager();
  mgr.refresh = async () => { calls++; return 'ok'; };
  configurePreloads({ p: { manager: mgr, refresh: () => mgr.refresh() } });
  await preloadPage('p');
  await preloadPage('p');
  assert.equal(calls, 2);
});

test('isPageCachedFresh honore le TTL de 30 s', () => {
  const now = 1_000_000;
  configurePreloads({
    fresh: { manager: stubManager(now - 1000), refresh: async () => {} },
    expired: { manager: stubManager(now - LIST_CACHE_TTL - 1), refresh: async () => {} },
    empty: { manager: stubManager(), refresh: async () => {} },
  });
  assert.equal(isPageCachedFresh('fresh', now), true);
  assert.equal(isPageCachedFresh('expired', now), false);
  assert.equal(isPageCachedFresh('empty', now), false);
});

test('clearPageCaches vide les caches de toutes les pages', () => {
  const a = stubManager(Date.now());
  const b = stubManager(Date.now());
  configurePreloads({
    a: { manager: a, refresh: async () => {} },
    b: { manager: b, refresh: async () => {} },
  });
  clearPageCaches();
  assert.equal(a._cache, null);
  assert.equal(b._cache, null);
});

test('preloadPages fait le tour des pages et un échec ne fait pas tomber le lot', async () => {
  const ok = stubManager(); ok.refresh = async () => 'ok';
  const ko = stubManager(); ko.refresh = async () => { throw new Error('nope'); };
  configurePreloads({
    ok: { manager: ok, refresh: () => ok.refresh() },
    ko: { manager: ko, refresh: () => ko.refresh() },
  });
  const results = await preloadPages(['ok', 'ko']);
  assert.equal(results.length, 2);
});

test('page inconnue : preloadPage est un no-op résolu', async () => {
  configurePreloads({});
  assert.equal(await preloadPage('ghost'), undefined);
});