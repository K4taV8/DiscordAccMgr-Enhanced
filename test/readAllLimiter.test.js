import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { makeRateLimiter } = require('../electron/rateLimiter.cjs');

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('readAll limiter respects ratePerSec over time', async () => {
  const lim = makeRateLimiter(10, 10);
  const t0 = Date.now();
  for (let i = 0; i < 15; i++) { await lim.acquire(); }
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 400, `elapsed ${elapsed}ms — should have waited for refills`);
});

test('readAll limiter serves burst tokens immediately', async () => {
  const lim = makeRateLimiter(10, 5);
  const t0 = Date.now();
  for (let i = 0; i < 5; i++) { await lim.acquire(); }
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 100, `burst of 5 should be immediate, took ${elapsed}ms`);
});

test('readAll limiter cannot exceed rate even under burst pressure', async () => {
  const lim = makeRateLimiter(20, 20);
  const t0 = Date.now();
  for (let i = 0; i < 60; i++) { await lim.acquire(); }
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 2000, `elapsed ${elapsed}ms — 60 tokens @ 20/s needs >= 2s`);
});
