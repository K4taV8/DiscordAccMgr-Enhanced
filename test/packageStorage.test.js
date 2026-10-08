import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  savePackageArchive,
  listPackageArchives,
  prunePackageArchives,
  createPackageArchiveId,
  selectPackageArchivesToPrune,
} from '../src/services/packageStorage.service.js';

// IndexedDB factice, sans dependance : le service n'utilise qu'un tout petit
// sous-ensemble de l'API (open / transaction / put / getAll / delete). Il permet
// de verifier la PURGE reelle, pas seulement une fonction pure extraite.
function installFakeIndexedDB() {
  const stores = new Map();
  return {
    open() {
      const request = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      setTimeout(() => {
        const db = {
          objectStoreNames: { contains: name => stores.has(name) },
          createObjectStore: name => { if (!stores.has(name)) stores.set(name, new Map()); },
          transaction(storeName) {
            const data = stores.get(storeName);
            const tx = { oncomplete: null, onerror: null, error: null };
            tx.objectStore = () => ({
              put: record => { data.set(record.id, record); return { result: record.id }; },
              getAll: () => ({ result: [...data.values()] }),
              delete: id => { data.delete(id); return { result: undefined }; },
            });
            setTimeout(() => { if (tx.oncomplete) tx.oncomplete(); }, 0);
            return tx;
          },
          close() {},
        };
        request.result = db;
        if (request.onupgradeneeded) request.onupgradeneeded();
        if (request.onsuccess) request.onsuccess();
      }, 0);
      return request;
    },
  };
}

beforeEach(() => { globalThis.indexedDB = installFakeIndexedDB(); });

function pkg(size) {
  return { messages: new Map(), packageSizeBytes: size, schemaVersion: 2, user: { id: '1' }, channels: [], guilds: [], totalMessages: 0 };
}

const BIG = { maxArchives: 999, maxBytes: 1e15 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// --- B2 : la purge comptait le TOTAL au lieu des octets CONSERVES. Des que le
// total depassait maxBytes, plus rien n'etait garde — y compris l'archive la plus
// recente, et un package unique plus gros que maxBytes s'auto-supprimait.

test('selectPackageArchivesToPrune ne supprime que la queue et garde la plus recente', () => {
  const archives = [
    { id: 'n', metadata: { size: 400 }, packageData: {} },
    { id: 'm', metadata: { size: 400 }, packageData: {} },
    { id: 'o', metadata: { size: 400 }, packageData: {} },
  ];
  const { keep, remove } = selectPackageArchivesToPrune(archives, { maxArchives: 5, maxBytes: 500 });
  assert.deepEqual(keep.map(a => a.id), ['n'], 'seule la plus recente tient dans le budget');
  assert.deepEqual(remove, ['m', 'o']);
});

test('une archive unique plus grosse que maxBytes est conservee', () => {
  const archives = [{ id: 'seule', metadata: { size: 10_000 }, packageData: {} }];
  const { keep, remove } = selectPackageArchivesToPrune(archives, { maxArchives: 5, maxBytes: 100 });
  assert.deepEqual(keep.map(a => a.id), ['seule']);
  assert.deepEqual(remove, []);
});

test('selectPackageArchivesToPrune borne aussi le nombre', () => {
  const archives = ['a', 'b', 'c', 'd'].map(id => ({ id, metadata: { size: 1 }, packageData: {} }));
  const { keep, remove } = selectPackageArchivesToPrune(archives, { maxArchives: 2, maxBytes: 1e9 });
  assert.deepEqual(keep.map(a => a.id), ['a', 'b']);
  assert.deepEqual(remove, ['c', 'd']);
});

test('une archive ancienne plus petite ne survit pas derriere une recente trop grosse', () => {
  const archives = [
    { id: 'n', metadata: { size: 300 }, packageData: {} },
    { id: 'm', metadata: { size: 300 }, packageData: {} },
    { id: 'o', metadata: { size: 1 }, packageData: {} },
  ];
  const { keep, remove } = selectPackageArchivesToPrune(archives, { maxArchives: 5, maxBytes: 400 });
  assert.deepEqual(keep.map(a => a.id), ['n'], 'on n elague que la queue, jamais au milieu');
  assert.deepEqual(remove, ['m', 'o']);
});

test('la purge reelle conserve la plus recente quand le total depasse maxBytes', async () => {
  await savePackageArchive('old', pkg(400), { size: 400 }, BIG);
  await sleep(4);
  await savePackageArchive('new', pkg(400), { size: 400 }, BIG);
  await sleep(4);

  await prunePackageArchives({ maxArchives: 5, maxBytes: 500 });

  const remaining = await listPackageArchives();
  assert.deepEqual(remaining.map(a => a.id), ['new'], 'la plus recente survit, l ancienne part');
});

test('un package unique plus gros que maxBytes n est pas auto-supprime a la sauvegarde', async () => {
  await savePackageArchive('big', pkg(10_000), { size: 10_000 }, { maxArchives: 5, maxBytes: 100 });

  const remaining = await listPackageArchives();
  assert.deepEqual(remaining.map(a => a.id), ['big'], 'la limite peut etre depassee une fois, mais rien n est perdu');
});

test('la purge reelle ne depasse pas maxArchives', async () => {
  for (const id of ['a', 'b', 'c', 'd']) {
    await savePackageArchive(id, pkg(1), { size: 1 }, BIG);
    await sleep(4);
  }

  await prunePackageArchives({ maxArchives: 2, maxBytes: 1e15 });

  const remaining = await listPackageArchives();
  assert.deepEqual(remaining.map(a => a.id), ['d', 'c'], 'les deux plus recentes restent');
});

// --- Mineur : `${name}:${size}:${lastModified}` collisionne pour deux fichiers
// distincts partageant ces metadonnees — le second ecrasait le premier en base.
test('l id d archive distingue deux fichiers aux memes metadonnees', () => {
  const a = { name: 'export.zip', size: 42, lastModified: 7 };
  const b = { name: 'export.zip', size: 42, lastModified: 7 };

  assert.notEqual(createPackageArchiveId(a), createPackageArchiveId(b), 'deux fichiers distincts ne s ecrasent pas');
  assert.equal(createPackageArchiveId(a), createPackageArchiveId(a), 'le meme fichier garde un id stable');
  assert.ok(createPackageArchiveId(a).startsWith('export.zip:42:7:'), 'le prefixe historique est preserve');
});

// --- S2 : la garde `if (!file || typeof file !== 'object')` etait placee APRES
// la construction de `${file.name}:…`, donc `createPackageArchiveId(null)`
// levait avant de l atteindre : garde morte. Elle est remontee avant tout
// dereferencement.
test('createPackageArchiveId ne leve pas sur un fichier absent ou non-objet', () => {
  assert.doesNotThrow(() => createPackageArchiveId(null));
  assert.doesNotThrow(() => createPackageArchiveId(undefined));
  assert.doesNotThrow(() => createPackageArchiveId('pas-un-fichier'));
  assert.equal(typeof createPackageArchiveId(null), 'string');
});

