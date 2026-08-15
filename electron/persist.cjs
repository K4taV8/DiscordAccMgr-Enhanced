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

// BUG-03 : file d'attente par fichier — sérialise les écritures concurrentes
// vers le même chemin (ex : 8 workers de scan écrivent le même checkpoint).
// tmp+rename reste atomique ; sans cette file, deux rename pouvaient se
// télescoper et perdre une progression.
const writeQueues = new Map();

async function writeJson(file, data) {
  const prev = writeQueues.get(file) || Promise.resolve();
  const run = prev.catch(() => {}).then(async () => {
    const tmp = file + '.tmp';
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(tmp, JSON.stringify(data));
    await fsp.rename(tmp, file);
  });
  writeQueues.set(file, run.catch(() => {}));
  return run;
}

module.exports = { readJson, writeJson };
