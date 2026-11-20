// Verrou anti-régression — BUG-005 : le main process doit laisser une trace
// persistée de ses incidents. Le journal est borné (rotation) et ne doit JAMAIS
// lever : un disque plein ne peut pas aggraver un crash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createMainLogger } = require('../electron/logger.cjs');

function withTempDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dame-log-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('BUG-005 : écrit une ligne horodatée avec le niveau et le contexte', () => {
  withTempDir((dir) => {
    const logger = createMainLogger({ dir, fileName: 'main.log' });
    assert.equal(logger.error('uncaughtException:', new Error('boum')), true);
    const text = readFileSync(path.join(dir, 'main.log'), 'utf8');
    assert.match(text, /^\d{4}-\d{2}-\d{2}T/, 'horodatage ISO');
    assert.match(text, /ERROR/);
    assert.match(text, /uncaughtException:/);
    assert.match(text, /boum/);
  });
});

test('BUG-005 : crée le dossier de journaux manquant', () => {
  withTempDir((dir) => {
    const nested = path.join(dir, 'data', 'logs');
    const logger = createMainLogger({ dir: nested });
    assert.equal(logger.log('bonjour'), true);
    assert.equal(existsSync(path.join(nested, 'main.log')), true);
  });
});

test('BUG-005 : le journal tourne au-delà de la taille maximale', () => {
  withTempDir((dir) => {
    const logger = createMainLogger({ dir, fileName: 'main.log', maxBytes: 180, maxFiles: 3 });
    for (let i = 0; i < 6; i += 1) logger.log(`ligne ${i} — ${'x'.repeat(60)}`);
    assert.equal(existsSync(path.join(dir, 'main.log.1')), true, 'archive créée');
    const current = statSync(path.join(dir, 'main.log')).size;
    assert.ok(current <= 180, `journal courant borné (${current} octets)`);
  });
});

test('BUG-005 : un chemin invalide ne lève jamais', () => {
  const logger = createMainLogger({ dir: path.join(tmpdir(), 'dame\0invalide') });
  assert.doesNotThrow(() => logger.error('disque plein'));
  assert.equal(logger.error('disque plein'), false, 'échec silencieux signalé par le retour');
});
