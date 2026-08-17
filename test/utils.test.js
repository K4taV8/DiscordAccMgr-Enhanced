import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escHtml, formatEmojiForApi } from '../src/utils/emojiUtils.js';
import { humanDelay, sleep } from '../src/utils/delay.js';

test('escHtml neutralizes HTML metacharacters', () => {
  assert.equal(escHtml('&'), '&amp;');
  assert.equal(escHtml('<img onerror=x>'), '&lt;img onerror=x&gt;');
  assert.equal(escHtml('"hi"'), '&quot;hi&quot;');
  assert.equal(escHtml("'it'"), '&#39;it&#39;');
});

test('formatEmojiForApi matches Discord reference encoding (preserves U+FE0F)', () => {
  // custom emoji → "name:id" (nom brut, jamais encodé)
  assert.equal(formatEmojiForApi({ id: '123', name: 'wave' }), 'wave:123');
  // unicode SANS variation selector → codé
  assert.equal(formatEmojiForApi({ name: '👍' }), '%F0%9F%91%8D');
  // unicode AVEC variation selector (U+FE0F) → CONSERVÉ
  // (régression : l'ancien code strippait U+FE0F → DELETE visait ❤ au lieu de ❤️
  //  → 404 → l'outil annonçait « supprimé » alors que la réaction restait)
  assert.equal(formatEmojiForApi({ name: '❤️' }), '%E2%9D%A4%EF%B8%8F');
  // empty / undefined
  assert.equal(formatEmojiForApi(undefined), '');
  assert.equal(formatEmojiForApi({}), '');
});

test('humanDelay returns jittered delay in expected range', () => {
  for (let i = 0; i < 100; i++) {
    const d = humanDelay(1000);
    assert.ok(d >= 650 && d <= 1350, `delay ${d} out of [-35%,+35%] band`);
  }
  assert.equal(humanDelay(1000, 0), 1000);
});

test('sleep resolves after roughly ms', async () => {
  const t0 = Date.now();
  await sleep(30);
  assert.ok(Date.now() - t0 >= 25);
});