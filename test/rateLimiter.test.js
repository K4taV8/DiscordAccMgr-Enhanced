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

test('throttle reduces throughput after 429', async () => {
  const lim = new RateLimiter({ ratePerSec: 100, burst: 100, maxConcurrent: 10 });
  lim.throttle(2); // 429 with retryAfter 2s
  const t0 = Date.now();
  const rel = await lim.acquire();
  rel();
  const waited = Date.now() - t0;
  // Throttle factor 0.4 → effective 40/s, so 1 token costs ~25ms, but throttle
  // also drains tokens to 50% burst → must have waited at least a few ms, and
  // certainly did not instantly fire at full speed.
  assert.ok(waited >= 10, `waited only ${waited}ms after throttle`);
  assert.ok(lim.currentRate < 100, 'currentRate should be reduced after throttle');
});