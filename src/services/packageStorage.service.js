const DB_NAME = 'dam-package-archive';
const DB_VERSION = 1;
const STORE_NAME = 'packages';
const DEFAULT_MAX_ARCHIVES = 5;
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('IndexedDB is unavailable in this environment.')); return; }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Unable to open package storage.'));
  });
}

function requestTransaction(mode, operation) {
  return openDatabase().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const result = operation(tx.objectStore(STORE_NAME));
    tx.oncomplete = () => { db.close(); resolve(result?.result ?? result); };
    tx.onerror = () => { db.close(); reject(tx.error || new Error('Package storage transaction failed.')); };
  }));
}

function serialisePackage(value) { return { ...value, messages: [...value.messages.entries()] }; }
function hydratePackage(value) { return { ...value, messages: new Map(value.messages || []) }; }

export async function savePackageArchive(id, packageData, metadata = {}, limits = {}) {
  const record = { id, savedAt: Date.now(), metadata, packageData: serialisePackage(packageData) };
  await requestTransaction('readwrite', store => store.put(record));
  await prunePackageArchives(limits);
}

export async function listPackageArchives() {
  const records = await requestTransaction('readonly', store => store.getAll());
  return (records || []).sort((a, b) => b.savedAt - a.savedAt).map(record => ({
    id: record.id, savedAt: record.savedAt, metadata: record.metadata, packageData: hydratePackage(record.packageData),
  }));
}

export async function deletePackageArchive(id) { await requestTransaction('readwrite', store => store.delete(id)); }

export async function prunePackageArchives({ maxArchives = DEFAULT_MAX_ARCHIVES, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const archives = await listPackageArchives();
  let bytes = archives.reduce((sum, archive) => sum + Number(archive.metadata?.size || archive.packageData.packageSizeBytes || 0), 0);
  const keep = [];
  const remove = [];
  for (const archive of archives) {
    const size = Number(archive.metadata?.size || archive.packageData.packageSizeBytes || 0);
    if (keep.length < maxArchives && bytes <= maxBytes) keep.push(archive);
    else { remove.push(archive.id); bytes -= size; }
  }
  if (remove.length) await requestTransaction('readwrite', store => { remove.forEach(id => store.delete(id)); });
  return remove;
}

export async function getPackageMessagePage(archiveId, channelId, { offset = 0, limit = 100 } = {}) {
  const archives = await listPackageArchives();
  const archive = archives.find(item => item.id === archiveId);
  if (!archive) return { messages: [], total: 0, offset, limit };
  const messages = archive.packageData.messages.get(String(channelId)) || [];
  return { messages: messages.slice(offset, offset + limit), total: messages.length, offset, limit };
}

export function createPackageArchiveId(file) { return `${file.name}:${file.size}:${file.lastModified}`; }

// Version du schema de package en base. Une correction de l import ne change
// pas le fichier importe, donc l identifiant d archive reste identique : une
// archive deja sauvegardee continue d etre servie et masque la correction.
// Concretement, des identifiants de messages restent arrondis en base alors
// que l import les relit correctement. Une archive d une version differente
// est donc ecartee plutot que reappliquee.
export const PACKAGE_SCHEMA_VERSION = 2;

// Une archive sans version vient d'un build anterieur : elle est ecartee.
export function isCurrentPackageArchive(archive) {
  return Number(archive?.packageData?.schemaVersion) === PACKAGE_SCHEMA_VERSION;
}
export const PACKAGE_STORAGE_LIMITS = { maxArchives: DEFAULT_MAX_ARCHIVES, maxBytes: DEFAULT_MAX_BYTES };
