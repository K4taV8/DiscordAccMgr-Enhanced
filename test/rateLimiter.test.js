import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../src/utils/rateLimiter.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('rate limiter respects ratePerSec over time', async () => {
  const lim = new RateLimiter({ ratePerSec: 10, burst: 10, maxConcurrent: 10 });
  const t0 = Date.now();
  for (let i = 0; i < 15; i++) { const rel = await lim.acquire(); rel(); }
  const elapsed = Date.now() - t0;
  // 15 tokens with burst 10 → 5 refills at 10/s ≈ 500ms minimum
  assert.ok(elapsed >= 400, `elapsed ${elapsed}ms — should have waited for refill`);
});

test('rate limiter caps concurrent in-flight requests', async () => {
  const lim = new RateLimiter({ ratePerSec: 1000, burst: 1000, maxConcurrent: 3 });
  let inFlight = 0;
  let peak = 0;
  const jobs = Array.from({ length: 10 }, async () => {
    const rel = await lim.acquire();
    inFlight++; peak = Math.max(peak, inFlight);
    await sleep(30);
    inFlight--;
    rel();
  });
  await Promise.all(jobs);
  assert.equal(peak, 3);
});

test('renderer limiter is a plain safety net (no throttle state)', async () => {
  const lim = new RateLimiter({ ratePerSec: 100, burst: 100, maxConcurrent: 10 });
  // P-02 : plus de throttle() côté renderer — le main (makeRouteScheduler) est l'autorité débit.
  assert.equal(typeof lim.throttle, 'undefined');
  assert.equal(lim.throttleFactor, undefined);
  assert.equal(lim.currentRate, undefined);
  const rel = await lim.acquire();
  rel();
});