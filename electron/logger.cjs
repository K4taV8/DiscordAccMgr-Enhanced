'use strict';

// Journal fichier du process principal (BUG-005).
//
// Electron ne remplit `app.getPath('logs')` que si l'application est lancee
// avec `--enable-logging`. Les garde-fous `uncaughtException` /
// `unhandledRejection` n'ecrivaient donc que sur une console invisible en
// production : apres un incident, l'utilisateur n'avait aucune trace a
// transmettre.
//
// Ce module reste volontairement minimal et synchrone :
//   - il ne leve JAMAIS (disque plein, dossier invalide, droits) ;
//   - il tourne au-dela de `maxBytes` en conservant `maxFiles` archives ;
//   - il est injectable (dossier, taille, horloge) pour rester testable.

const fs = require('fs');
const path = require('path');
const util = require('util');

function createMainLogger({
  dir,
  fileName = 'main.log',
  maxBytes = 5 * 1024 * 1024,
  maxFiles = 3,
  now = () => new Date(),
} = {}) {
  const baseDir = dir || '.';
  const filePath = path.join(baseDir, fileName);
  let dirReady = false;

  const ensureDir = () => {
    if (dirReady) return true;
    try {
      fs.mkdirSync(baseDir, { recursive: true });
      dirReady = true;
      return true;
    } catch {
      return false;
    }
  };

  const rotate = () => {
    try {
      for (let index = maxFiles - 1; index >= 1; index -= 1) {
        const from = index === 1 ? filePath : `${filePath}.${index - 1}`;
        const to = `${filePath}.${index}`;
        if (!fs.existsSync(from)) continue;
        try { fs.rmSync(to, { force: true }); } catch {}
        try { fs.renameSync(from, to); } catch {}
      }
    } catch {}
  };

  const write = (level, args) => {
    try {
      if (!ensureDir()) return false;
      const line = `${now().toISOString()} ${level} ${util.format(...args)}\n`;
      const size = Buffer.byteLength(line, 'utf8');
      let currentSize = 0;
      try { currentSize = fs.statSync(filePath).size; } catch {}
      if (currentSize > 0 && currentSize + size > maxBytes) rotate();
      fs.appendFileSync(filePath, line, 'utf8');
      return true;
    } catch {
      return false;
    }
  };

  return {
    filePath,
    log: (...args) => write('INFO', args),
    info: (...args) => write('INFO', args),
    warn: (...args) => write('WARN', args),
    error: (...args) => write('ERROR', args),
    fatal: (...args) => write('FATAL', args),
  };
}

module.exports = { createMainLogger };
