// Tests des correctifs d'audit (agent D) : PackageManager (fils, scroll,
// galerie, suppression) et le champ additif `thread_metadata` de main.cjs.
// main.cjs n'est pas chargeable sous Node nu (`require('electron')` echoue des
// le chargement) : ce point est verrouille par lecture du source, comme dans
// test/auditFixes.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PackageManager } from '../src/components/PackageManager.js';

function makeArea() {
  return {
    innerHTML: '',
    className: '',
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

function paquet(canalMessages = {}) {
  const messages = new Map();
  for (const [id, list] of Object.entries(canalMessages)) messages.set(id, list);
  const channels = Object.entries(canalMessages).map(([id, list]) => ({
    id, name: `salon-${id}`, type: 'DM', guildId: null, guildName: null, recipient: { id: 'r', username: 'r' }, isLeft: false, messagesCount: list.length,
  }));
  const total = channels.reduce((sum, channel) => sum + channel.messagesCount, 0);
  return { user: { id: '9', username: 'tester' }, guilds: [], channels, messages, totalMessages: total, packageSizeBytes: 1 };
}

function message(id) {
  return { id, timestamp: '2024-01-01T00:00:00.000Z', content: `texte ${id}`, attachments: [] };
}

// ---------------------------------------------------------------------------
// BUG-007 : un fil actif ne doit jamais etre (de)archive par le nettoyage
// ---------------------------------------------------------------------------
test('BUG-007 : main.cjs transmet thread_metadata dans discord:getChannel', () => {
  const src = fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  assert.ok(src.includes('thread_metadata: r.data?.thread_metadata ?? null'), 'champ additif present');
});

test('BUG-007 : un fil deja actif n est ni desarchive ni rearchive', async () => {
  const manager = new PackageManager(makeArea());
  const calls = [];
  globalThis.window = {
    electronAPI: {
      getChannel: async () => ({ success: true, channel: { id: '777', type: 11, thread_metadata: { archived: false } } }),
      setThreadArchived: async (id, archived) => { calls.push(archived ? 'archive' : 'reactive'); return { success: true }; },
      deletePackageMessage: async () => ({ success: true }),
    },
  };
  try {
    const counts = { deleted: 0, missing: 0, forbidden: 0, failed: 0 };
    const outcome = await manager.deleteChannelGroup({ id: '777', type: 'THREAD' }, [{ channelId: '777', messageId: 'a' }], counts, null);
    assert.equal(outcome.threadState, 'active', 'le fil etait actif');
    assert.equal(outcome.reactivated, false);
    assert.deepEqual(calls, [], 'un fil actif n est jamais touche');
    assert.equal(counts.deleted, 1, 'la suppression a bien lieu');
  } finally {
    delete globalThis.window;
  }
});

test('BUG-007 : un fil archive est bel et bien reactive puis reassigne', async () => {
  const manager = new PackageManager(makeArea());
  const calls = [];
  globalThis.window = {
    electronAPI: {
      getChannel: async () => ({ success: true, channel: { id: '777', type: 11, thread_metadata: { archived: true } } }),
      setThreadArchived: async (id, archived) => { calls.push(archived ? 'archive' : 'reactive'); return { success: true }; },
      deletePackageMessage: async () => ({ success: true }),
    },
  };
  try {
    const counts = { deleted: 0, missing: 0, forbidden: 0, failed: 0 };
    const outcome = await manager.deleteChannelGroup({ id: '777', type: 'THREAD' }, [{ channelId: '777', messageId: 'a' }], counts, null);
    assert.equal(outcome.threadState, 'reactivated');
    assert.equal(outcome.reactivated, true);
    assert.deepEqual(calls, ['reactive', 'archive'], 'desarchive pour nettoyer, rearchive ensuite');
  } finally {
    delete globalThis.window;
  }
});

// ---------------------------------------------------------------------------
// BUG-015 : le scroll du panneau de messages survit a une case cochee
// ---------------------------------------------------------------------------
test('BUG-015 : cocher un message restaure le scroll de la liste', async () => {
  const area = makeArea();
  let lookups = 0;
  const seen = [];
  area.querySelector = selector => {
    if (selector !== '.package-message-list') return null;
    lookups += 1;
    const scroller = { scrollTop: lookups === 1 ? 137 : 0 };
    seen.push(scroller);
    return scroller;
  };
  const manager = new PackageManager(area);
  manager.package = paquet({ c1: [message('m1'), message('m2')] });
  manager.render = () => {};

  const box = { dataset: { messageKey: 'c1:m1' }, checked: true, matches: () => false, closest: selector => (selector === '[data-message-key]' ? box : null) };
  await manager.handleChange({ target: box, shiftKey: false });

  assert.equal(lookups, 2, 'le scroll est sauve puis restaure');
  assert.equal(seen[1].scrollTop, 137, 'la position de lecture est conservee');
  assert.ok(manager.selectedMessages.has('c1:m1'));
});

// ---------------------------------------------------------------------------
// BUG-016 : un rate limit persistant est agrege comme echec, pas ignore
// ---------------------------------------------------------------------------
test('BUG-016 : 4x429 devient un echec « rate limit persistant »', async () => {
  const manager = new PackageManager(makeArea());
  manager.package = paquet({ c1: [message('m1')] });
  let calls = 0;
  globalThis.window = {
    electronAPI: {
      deletePackageMessage: async () => { calls += 1; return { success: false, status: 429, error: 'Rate limited', retryAfter: -1 }; },
    },
  };
  try {
    const counts = { deleted: 0, missing: 0, forbidden: 0, failed: 0, reasons: {} };
    const outcome = await manager.deleteOnePackageMessage({ channelId: 'c1', messageId: 'm1' }, counts);
    assert.equal(calls, 4, 'les quatre essais ont lieu');
    assert.equal(outcome, 'failed');
    assert.equal(counts.failed, 1, 'le compteur d echecs est incremente');
    assert.equal(counts.retry, undefined, 'aucun compteur retry fantome');
    assert.equal(counts.reasons['rate limit persistant'], 1, 'la cause est nommee');
  } finally {
    delete globalThis.window;
  }
});

// ---------------------------------------------------------------------------
// BUG-017 : changer de paquet remet la galerie et la cle de miroir a zero
// ---------------------------------------------------------------------------
test('BUG-017 : le setter package reinitialise vue, filtre et cle de miroir', () => {
  const manager = new PackageManager(makeArea());
  manager.view = 'gallery';
  manager.galleryFilter.channelId = '222';
  manager.mediaMirrorKey = 'cle-perimee';
  manager.mediaManifest = new Map([['https://cdn/x.png', 'media://k/x.png']]);

  manager.package = paquet({ c1: [message('m1')] });

  assert.equal(manager.view, 'messages', 'retour aux messages');
  assert.equal(manager.galleryFilter.channelId, '', 'filtre de galerie remis a zero');
  assert.equal(manager.mediaMirrorKey, '', 'cle de miroir perimee effacee');
  assert.equal(manager.mediaManifest.size, 0, 'manifeste local vide');
});

// ---------------------------------------------------------------------------
// BUG-018 : le cache de peinture de la galerie est invalide quand le manifeste
// change (sync ou purge), sinon des media:// morts restent affiches.
// ---------------------------------------------------------------------------
test('BUG-018 : syncMediaManifest invalide le HTML de galerie en cache', async () => {
  const manager = new PackageManager(makeArea());
  manager.package = paquet({ c1: [message('m1')] });
  manager.galleryHtml = '<div>cache perime</div>';
  manager.galleryPainted = 0;
  manager.galleryPaintedEnd = 1;
  globalThis.window = {
    electronAPI: {
      mediaMirror: {
        status: async () => ({ key: 'k', entries: [{ url: 'https://cdn/x.png', state: 'done', localUrl: 'media://mirror/k/x.png' }] }),
      },
    },
  };
  try {
    await manager.syncMediaManifest([{ url: 'https://cdn/x.png', fileName: 'x.png', kind: 'image', channelId: 'c1' }]);
    assert.equal(manager.galleryHtml, '', 'le cache est invalide avant le rendu');
    assert.equal(manager.galleryPainted, -1, 'la fenetre peinte est oubliee');
    assert.equal(manager.mediaManifest.get('https://cdn/x.png'), 'media://mirror/k/x.png');
  } finally {
    delete globalThis.window;
  }
});

test('BUG-018 : purgeMedia invalide aussi le cache de galerie (source)', () => {
  const src = fs.readFileSync(new URL('../src/components/PackageManager.js', import.meta.url), 'utf8');
  const purge = src.slice(src.indexOf('async purgeMedia()'), src.indexOf('// La largeur se lit'));
  assert.ok(purge.includes('this.resetGalleryPaint(true)'), 'purgeMedia oublie le cache sans cet appel');
});

// ---------------------------------------------------------------------------
// BUG-026 : menus refermes, pagination recalcee, messages supprimes retires
// ---------------------------------------------------------------------------
test('BUG-026 : un menu deroulant est referme apres le clic sur une entree', async () => {
  const manager = new PackageManager(makeArea());
  manager.package = paquet({ c1: [message('m1')] });
  const details = { removed: false, attr: null, removeAttribute(name) { this.removed = true; this.attr = name; } };
  const menuItem = { closest: selector => (selector === 'details.package-menu' ? details : null) };
  const actionButton = { dataset: { packageAction: 'purge-media' } };
  const target = {
    closest: selector => {
      if (selector === '.package-menu-item') return menuItem;
      if (selector === '[data-package-action]') return actionButton;
      return null;
    },
  };
  let purge = 0;
  manager.purgeMedia = () => { purge += 1; };

  await manager.handleClick({ target });
  assert.equal(details.removed, true, 'le menu est referme');
  assert.equal(details.attr, 'open');
  assert.equal(purge, 1, 'l action est tout de meme lancee');
});

test('BUG-026 : messagePageOffset est clampe quand un filtre change la liste', () => {
  const manager = new PackageManager(makeArea());
  manager.package = paquet({ c1: [message('m1'), message('m2'), message('m3')] });
  manager.selectedChannelId = 'c1';
  manager.messagePageSize = 1;
  manager.messagePageOffset = 10;

  manager.render();
  assert.equal(manager.messagePageOffset, 2, 'offset borne au dernier page valide');
});

test('BUG-026 : un message supprime disparait du paquet et de la selection', async () => {
  const manager = new PackageManager(makeArea());
  manager.package = paquet({ c1: [message('m1'), message('m2'), message('m3')] });
  const channel = manager.package.channels[0];
  manager.selectedMessages.add('c1:m1');
  globalThis.window = { electronAPI: { deletePackageMessage: async () => ({ success: true }) } };
  try {
    const outcome = await manager.deleteOnePackageMessage({ channelId: 'c1', messageId: 'm1' }, {});
    assert.equal(outcome, 'deleted');
    assert.equal(manager.selectedMessages.has('c1:m1'), false, 'plus selectionne');
    assert.equal(manager.package.messages.get('c1').length, 2, 'retire du paquet');
    assert.ok(!manager.package.messages.get('c1').some(item => item.id === 'm1'));
    assert.equal(channel.messagesCount, 2, 'compteur de salon ajuste');
    assert.equal(manager.package.totalMessages, 2, 'total ajuste');
  } finally {
    delete globalThis.window;
  }
});
