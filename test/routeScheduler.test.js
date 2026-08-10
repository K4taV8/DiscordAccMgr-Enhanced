import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { makeRouteScheduler } = require('../electron/rateLimiter.cjs');

const fast = () => makeRouteScheduler({ nominalRatePerSec: 1000, burst: 1000, maxConcurrent: 100 });

test('scheduler waits when route bucket exhausted until reset (zero-429)', async () => {
  const s = fast();
  s.applyHeaders('/channels/:id/messages', { 'x-ratelimit-remaining': '2', 'x-ratelimit-reset-after': '0.05' });
  (await s.acquire('/channels/:id/messages'))();
  (await s.acquire('/channels/:id/messages'))();
  const t0 = Date.now();
  const release = await s.acquire('/channels/:id/messages');
  assert.ok(Date.now() - t0 >= 40, '3rd acquire should wait for reset');
  release();
});

test('scheduler blocks all routes on global bucket exhaustion', async () => {
  const s = fast();
  s.applyHeaders('/a', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '0.05', 'x-ratelimit-global': 'true' });
  const t0 = Date.now();
  const release = await s.acquire('/b');
  assert.ok(Date.now() - t0 >= 40, 'global exhausted must pause any route');
  release();
});

test('scheduler enforces Retry-After on 429 and recovers', async () => {
  const s = fast();
  s.applyHeaders('/channels/:id/messages', { 'retry-after': '0.05' });
  const t0 = Date.now();
  const release = await s.acquire('/channels/:id/messages');
  assert.ok(Date.now() - t0 >= 40, 'retry-after should pause the route');
  release();
});

test('scheduler falls back to nominal rate before any header', async () => {
  const s = makeRouteScheduler({ nominalRatePerSec: 10, burst: 5, maxConcurrent: 100 });
  const t0 = Date.now();
  for (let i = 0; i < 15; i++) { (await s.acquire('/fresh'))(); }
  assert.ok(Date.now() - t0 >= 900, '15 tokens @10/s burst 5 needs >= 1s');
});

test('scheduler never deadlocks after stale exhausted bucket', async () => {
  const s = fast();
  s.applyHeaders('/x', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '0.02' });
  await sleep(60); // le reset passe : le budget doit retomber en repli nominal
  const release = await s.acquire('/x');
  release();
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
