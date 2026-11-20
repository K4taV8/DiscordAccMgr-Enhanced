const DB_NAME = 'dam-package-archive';
const DB_VERSION = 1;
const STORE_NAME = 'packages';
const DEFAULT_MAX_ARCHIVES = 5;
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('IndexedDB est indisponible dans cet environnement.')); return; }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Impossible d’ouvrir le stockage des archives.'));
  });
}

function requestTransaction(mode, operation) {
  return openDatabase().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const result = operation(tx.objectStore(STORE_NAME));
    tx.oncomplete = () => { db.close(); resolve(result?.result ?? result); };
    tx.onerror = () => { db.close(); reject(tx.error || new Error('La transaction de stockage des archives a échoué.')); };
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
  const { remove } = selectPackageArchivesToPrune(archives, { maxArchives, maxBytes });
  if (remove.length) await requestTransaction('readwrite', store => { remove.forEach(id => store.delete(id)); });
  return remove;
}

// Choisit, dans une liste TRIEE du plus recent au plus ancien, ce qui survit.
// On n'elague QUE la queue (les plus anciennes) : des qu'une archive ne rentre
// plus (en nombre ou en octets), toutes celles qui la suivent partent aussi.
// `bytes` accumule la taille des archives CONSERVEES, pas le total : sinon le
// budget etait deja depasse au premier tour et la purge supprimait l'archive la
// PLUS RECENTE. L'archive la plus recente est toujours conservee, quitte a
// depasser `maxBytes` une fois si elle est seule plus grosse que la limite.
export function selectPackageArchivesToPrune(archives, { maxArchives = DEFAULT_MAX_ARCHIVES, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const keep = [];
  const remove = [];
  let keptBytes = 0;
  let dropping = false;
  archives.forEach((archive, index) => {
    const size = Number(archive.metadata?.size || archive.packageData?.packageSizeBytes || 0);
    const withinCount = keep.length < maxArchives;
    const withinBytes = index === 0 || keptBytes + size <= maxBytes;
    if (!dropping && withinCount && withinBytes) {
      keep.push(archive);
      keptBytes += size;
    } else {
      dropping = true;
      remove.push(archive.id);
    }
  });
  return { keep, remove };
}

// L'id `${name}:${size}:${lastModified}` peut entrer en collision : deux
// fichiers DIFFERENTS (exports d'un meme compte) partageant ces trois valeurs
// s'ecrasaient en base. On ajoute un discriminant stable par objet `file` (donc
// le meme fichier re-importe garde le meme id), unique entre objets distincts.
const archiveIdDiscriminants = new WeakMap();
let archiveIdSequence = 0;

export function createPackageArchiveId(file) {
  // Le test AVANT tout dereferencement : `createPackageArchiveId(null)` levait
  // sur `file.name`, et la garde qui suivait ne servait donc a rien. Un fichier
  // absent ou non-objet n a pas d id : on rend une chaine stable, sans lever.
  if (!file || typeof file !== 'object') return `${file?.name}:${file?.size}:${file?.lastModified}`;
  const base = `${file.name}:${file.size}:${file.lastModified}`;
  let discriminant = archiveIdDiscriminants.get(file);
  if (!discriminant) {
    archiveIdSequence += 1;
    discriminant = String(archiveIdSequence);
    archiveIdDiscriminants.set(file, discriminant);
  }
  return `${base}:${discriminant}`;
}

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
