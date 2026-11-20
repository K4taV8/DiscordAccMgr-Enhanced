// Verrou anti-régression — BUG-007 : les miroirs TypeScript ne doivent plus
// pouvoir diverger silencieusement de la logique JS réellement exécutée.
//
// Node 22.18+/24 sait importer directement un `.ts` (type stripping) : on
// confronte donc les deux implémentations sur leurs fonctions pures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as persistJs from '../src/utils/persist.js';
import * as delayJs from '../src/utils/delay.js';
import * as emojiJs from '../src/utils/emojiUtils.js';
import * as discordJs from '../src/utils/discord.js';

// BUG-007 : Node 22.18+/24 importe directement un `.ts` (type stripping). On
// confronte donc le miroir à l'implémentation réellement exécutée — sans build
// intermédiaire ni dépendance supplémentaire.
const loadTs = (name) => import(`../src/utils/${name}.ts`);

test('BUG-007 : npm test exécute tsc (aucun miroir non vérifié)', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts.typecheck, 'tsc --noEmit', 'script typecheck présent');
  assert.match(pkg.scripts.test, /npm run typecheck/, 'le test lance le typecheck');
});

test('BUG-007 : persist.ts est le miroir exact de persist.js', async () => {
  const ts = await loadTs('persist');
  assert.equal(ts.OP_REACTIONS, persistJs.OP_REACTIONS);
  assert.equal(ts.OP_MESSAGES, persistJs.OP_MESSAGES);
  assert.equal(ts.LEDGER_TTL, persistJs.LEDGER_TTL);
  assert.equal(ts.WATERMARK_TTL, persistJs.WATERMARK_TTL);

  const seed = [{ id: 'c1', name: '#général' }];
  const clean = (cp) => ({ ...cp, createdAt: 0, updatedAt: 0 });
  assert.deepEqual(
    clean(ts.newCheckpoint('deleteMessages', 's1', 'Serveur', seed)),
    clean(persistJs.newCheckpoint('deleteMessages', 's1', 'Serveur', seed)),
  );

  assert.equal(ts.ledgerKey('c', 'm', '❤️'), persistJs.ledgerKey('c', 'm', '❤️'));
  const now = Date.now();
  const ledger = { vivant: now - 1000, perime: now - ts.LEDGER_TTL - 5000, invalide: 'x' };
  assert.deepEqual([...ts.ledgerFilter(ledger, 10000)], [...persistJs.ledgerFilter(ledger, 10000)]);
  assert.equal(ts.watermarkFresh(undefined), persistJs.watermarkFresh(undefined));
  assert.equal(
    ts.watermarkFresh({ scannedAt: now - 10 }, 1000),
    persistJs.watermarkFresh({ scannedAt: now - 10 }, 1000),
  );

  const cp = { updatedAt: 0 };
  assert.equal(ts.touch(cp), cp);
  assert.ok(cp.updatedAt > 0);
});

test('BUG-007 : persist.ts lit les mêmes enveloppes via persistAPI', async () => {
  const ts = await loadTs('persist');
  const saved = globalThis.window;
  globalThis.window = {
    persistAPI: {
      checkpointLoad: async () => ({ schemaVersion: 1, marque: 'ok' }),
      watermarkGet: async () => ({ c1: { scannedAt: 1 } }),
      ledgerGet: async () => ({ k: 1 }),
    },
  };
  try {
    assert.deepEqual(await ts.loadCheckpoint('deleteMessages', 's1'), await persistJs.loadCheckpoint('deleteMessages', 's1'));
    assert.deepEqual(await ts.loadWatermark('s1'), await persistJs.loadWatermark('s1'));
    assert.deepEqual(await ts.loadLedger(), await persistJs.loadLedger());
  } finally {
    globalThis.window = saved;
  }
});

test('BUG-007 : delay.ts reste le miroir exact de delay.js', async () => {
  const ts = await loadTs('delay');
  const savedRandom = Math.random;
  Math.random = () => 0.42;
  try {
    assert.equal(ts.humanDelay(1000, 0.35), delayJs.humanDelay(1000, 0.35));
    assert.equal(ts.humanDelay(250), delayJs.humanDelay(250));
  } finally {
    Math.random = savedRandom;
  }
  await Promise.all([ts.sleep(1), delayJs.sleep(1)]);
});

test('BUG-007 : emojiUtils.ts reste le miroir exact de emojiUtils.js', async () => {
  const ts = await loadTs('emojiUtils');
  const echantillons = [null, { name: '👍' }, { name: '❤️' }, { id: '123', name: 'party parrots' }, { name: 'a/b' }];
  for (const emoji of echantillons) {
    assert.equal(ts.formatEmojiForApi(emoji), emojiJs.formatEmojiForApi(emoji), `emoji ${JSON.stringify(emoji)}`);
  }
  const html = `<a href="x">Tom & Jerry's</a>`;
  assert.equal(ts.escHtml(html), emojiJs.escHtml(html));
});

test('BUG-007 : discord.ts garde le même contrat que discord.js', async () => {
  const ts = await loadTs('discord');
  const sauvegarde = globalThis.window;
  const api = (resultat) => ({
    getFriends: async () => resultat,
    getServers: async () => resultat,
    getDMs: async () => resultat,
  });
  try {
    globalThis.window = { electronAPI: api({ success: true, friends: [{ id: '1' }], servers: [{ id: '2' }], dms: [{ id: '3' }] }) };
    assert.deepEqual(await ts.getFriendsList(), await discordJs.getFriendsList());
    assert.deepEqual(await ts.getServersList(true), await discordJs.getServersList(true));
    assert.deepEqual(await ts.getDMsList(), await discordJs.getDMsList());

    globalThis.window = { electronAPI: api({ success: false, error: { message: 'refus IPC' } }) };
    await assert.rejects(() => ts.getFriendsList(), /refus IPC/);
    await assert.rejects(() => discordJs.getFriendsList(), /refus IPC/);
  } finally {
    globalThis.window = sauvegarde;
  }
});
