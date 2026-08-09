import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escHtml, escJs, formatEmojiForApi } from '../src/utils/emojiUtils.js';
import { humanDelay, sleep } from '../src/utils/delay.js';

test('escHtml neutralizes HTML metacharacters', () => {
  assert.equal(escHtml('&'), '&amp;');
  assert.equal(escHtml('<img onerror=x>'), '&lt;img onerror=x&gt;');
  assert.equal(escHtml('"hi"'), '&quot;hi&quot;');
  assert.equal(escHtml("'it'"), '&#39;it&#39;');
});

test('escJs blocks attribute breakout (XSS regression — SEC-02)', () => {
  const malicious = '"><img src=x onerror=alert(1)>';
  const attr = `onclick="window.dm.deleteDMMessages('1', '${escJs(malicious)}')"`;
  // After HTML parsing, the attribute value must decode to a JS call containing
  // the payload as a *string*, never to a closing quote + new element.
  const hasBreakout = /onclick="[^"]*"[^>]*onerror="?alert/.test(attr);
  assert.equal(hasBreakout, false, `escJs let the attribute break out: ${attr}`);
});

test('escJs survives round-trip through attribute + string parsing', () => {
  const name = `a"b'c&d\\e\nf`;
  const attr = `onclick="fn('${escJs(name)}')"`;
  const match = attr.match(/onclick="fn\('((?:[^'\\]|\\.)*)'\)"/);
  assert.ok(match, 'attribute remained single-slot');
  // Browser HTML parsing decodes entity references first, then JS string rules.
  const decodedHtml = match[1]
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
  const decoded = decodedHtml
    .replace(/\\\\/g, '\u0000')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\'/g, "'")
    .replace(/\u0000/g, '\\');
  assert.equal(decoded, name);
});

test('formatEmojiForApi handles id+name, unicode, and empty', () => {
  assert.equal(formatEmojiForApi({ id: '123', name: 'wave' }), 'wave:123');
  assert.equal(formatEmojiForApi({ id: '123' }), '_:123');
  const unicode = formatEmojiForApi({ name: '👍\uFE0F' });
  assert.match(unicode, /^%F0%9F%/);
  assert.notEqual(unicode, ''); // unicode emoji yields an encoded URL-safe string
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