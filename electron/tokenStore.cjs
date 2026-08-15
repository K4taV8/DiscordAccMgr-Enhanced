// Token store — encrypted at rest via safeStorage.
// Module pur : safeStorage et tokensPath sont INJECTÉS → testable sans Electron.
// Schéma sur disque : { schemaVersion: 1, tokens: [...] } (migré depuis l'ancien tableau plat).
//
// R05#2 : ce module extrait la logique token de main.cjs pour pouvoir la tester
// avec un safeStorage mocké (le flux complet save/get/delete/connectByName).

'use strict';

const fsp = require('fs/promises');

const TOKEN_SCHEMA_VERSION = 1;

function createTokenStore({ safeStorage, tokensPath }) {
  // BUG-03 : mutex — sérialise les read-modify-write (save/get/delete) pour
  // éviter les pertes de mise à jour lors d'écritures concurrentes.
  let tokenOp = Promise.resolve();
  const withLock = (fn) => {
    const p = tokenOp.then(fn);
    tokenOp = p.then(() => {}, () => {});
    return p;
  };

  async function readTokensFile() {
    const raw = await fsp.readFile(tokensPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      // Format legacy : tableau plat → enveloppe versionnée
      const migrated = { schemaVersion: TOKEN_SCHEMA_VERSION, tokens: parsed };
      await fsp.writeFile(tokensPath, JSON.stringify(migrated, null, 2));
      return migrated;
    }
    return parsed;
  }

  async function writeTokensFile(tokens) {
    // Écriture atomique (tmp + rename) — pas de fichier tronqué en cas de crash.
    const tmp = tokensPath + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify({ schemaVersion: TOKEN_SCHEMA_VERSION, tokens }, null, 2));
    await fsp.rename(tmp, tokensPath);
  }

  function encryptToken(token) {
    return 'enc:' + safeStorage.encryptString(token).toString('base64');
  }

  function decryptToken(stored) {
    if (typeof stored === 'string' && stored.startsWith('enc:')) {
      return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
    }
    return null;
  }

  const encryptionAvailable = () => !!safeStorage.isEncryptionAvailable?.();

  return {
    TOKEN_SCHEMA_VERSION,
    encryptToken,
    decryptToken,

    async save(name, token) {
      return withLock(async () => {
        if (!encryptionAvailable()) {
          return { success: false, error: 'Cannot save: secure storage unavailable. On Linux, install libsecret.' };
        }
        try {
          const store = await readTokensFile();
          const tokens = store.tokens || [];
          if (tokens.some(t => t.name === name)) {
            return { success: false, error: 'A token with this name already exists' };
          }
          tokens.push({ name, token: encryptToken(token) });
          await writeTokensFile(tokens);
          return { success: true };
        } catch (error) {
          return { success: false, error: 'Failed to save token' };
        }
      });
    },

    async list() {
      return withLock(async () => {
        try {
          const store = await readTokensFile();
          const tokens = store.tokens || [];
          let hasLegacy = false;

          // SEC-03 : métadonnées uniquement — le token (même chiffré) ne
          // retourne jamais au renderer. On valide seulement le déchiffrement.
          const result = tokens.map(t => {
            if (typeof t.token === 'string' && t.token.startsWith('enc:')) {
              try {
                safeStorage.decryptString(Buffer.from(t.token.slice(4), 'base64'));
                return { name: t.name, corrupt: false };
              } catch {
                return { name: t.name, corrupt: true }; // BUG-07 : garder l'entrée visible/supprimable
              }
            }
            hasLegacy = true;
            // Legacy en clair : inutilisable tant qu'il n'est pas chiffré (libsecret requis).
            return { name: t.name, corrupt: !encryptionAvailable() };
          });

          if (hasLegacy && encryptionAvailable()) {
            const encrypted = tokens.map(t => ({
              name: t.name,
              token: typeof t.token === 'string' && t.token.startsWith('enc:') ? t.token : encryptToken(t.token)
            }));
            await writeTokensFile(encrypted);
          }

          return { success: true, tokens: result };
        } catch (error) {
          return { success: false, error: 'Failed to load tokens' };
        }
      });
    },

    async remove(name) {
      return withLock(async () => {
        try {
          const store = await readTokensFile();
          const tokens = store.tokens || [];
          await writeTokensFile(tokens.filter(t => t.name !== name));
          return { success: true };
        } catch (error) {
          return { success: false, error: 'Failed to delete token' };
        }
      });
    },

    async removeAll() {
      return withLock(async () => {
        try {
          await writeTokensFile([]);
          return { success: true };
        } catch (error) {
          return { success: false, error: 'Failed to delete tokens' };
        }
      });
    },

    // SEC-03 : résout le secret déchiffré par nom — utilisé par tokens:connectByName.
    // Le mutex n'est tenu que pendant la lecture.
    async resolveByName(name) {
      return withLock(async () => {
        if (typeof name !== 'string' || !name) return { error: 'Invalid token name' };
        if (!encryptionAvailable()) {
          return { error: 'Cannot connect: secure storage unavailable. On Linux, install libsecret.' };
        }
        const store = await readTokensFile();
        const entry = (store.tokens || []).find(t => t.name === name);
        if (!entry) return { error: 'Token not found' };
        let token;
        try {
          token = decryptToken(entry.token);
        } catch {
          token = null;
        }
        if (!token) return { error: 'Token is corrupted or not securely stored (re-save it)' };
        return { token };
      });
    },
  };
}

module.exports = { createTokenStore, TOKEN_SCHEMA_VERSION };
