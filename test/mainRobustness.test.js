// Verrou anti-regression : crash du main process « ApplicationFlags is not a
// constructor » (bug amont de discord.js-selfbot-v13 3.4.6) + garde-fou global.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const MAIN = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');

test('correctif ApplicationFlags : le sous-module resout la classe apres patch', () => {
  const af = require('discord.js-selfbot-v13/src/util/ApplicationFlags');
  assert.equal(typeof af, 'function', 'le module de la lib exporte bien la classe');
  // Exactement ce que fait main.cjs avant de charger la lib.
  if (!af.ApplicationFlags) af.ApplicationFlags = af;
  const { ApplicationFlags } = require('discord.js-selfbot-v13/src/util/ApplicationFlags');
  assert.equal(typeof ApplicationFlags, 'function', 'le destructuring de Application.js resout la classe');
  assert.equal(new ApplicationFlags(0).bitfield, 0);
});

test('main.cjs applique le correctif AVANT de charger la lib', () => {
  const patch = MAIN.indexOf('af.ApplicationFlags = af');
  const lib = MAIN.indexOf("require('discord.js-selfbot-v13')");
  assert.ok(patch !== -1, 'correctif present');
  assert.ok(lib !== -1 && patch < lib, 'correctif applique avant le require de la lib');
});

test('main.cjs ne laisse plus une exception non capturee tuer le process', () => {
  assert.ok(MAIN.includes("process.on('uncaughtException'"), 'garde-fou uncaughtException');
  assert.ok(MAIN.includes("process.on('unhandledRejection'"), 'garde-fou unhandledRejection');
});
