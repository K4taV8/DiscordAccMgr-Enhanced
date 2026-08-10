// Persistance locale (CJS, main process) — lectures/écritures asynchrones et atomiques.
// Aucune dépendance. tmp + rename → jamais de fichier tronqué sur arrêt brutal.

const fsp = require('fs/promises');
const path = require('path');

async function readJson(file) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeJson(file, data) {
  const tmp = file + '.tmp';
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(tmp, JSON.stringify(data));
  await fsp.rename(tmp, file);
}

module.exports = { readJson, writeJson };
