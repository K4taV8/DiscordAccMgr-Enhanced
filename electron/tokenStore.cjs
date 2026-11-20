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
          return { success: false, error: 'Enregistrement impossible : stockage sécurisé indisponible. Sous Linux, installe libsecret.' };
        }
        try {
          const store = await readTokensFile();
          const tokens = store.tokens || [];
          if (tokens.some(t => t.name === name)) {
            return { success: false, error: 'Un token portant ce nom existe déjà' };
          }
          tokens.push({ name, token: encryptToken(token) });
          await writeTokensFile(tokens);
          return { success: true };
        } catch (error) {
          return { success: false, error: 'Échec de l’enregistrement du token' };
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
          return { success: false, error: 'Échec du chargement des tokens' };
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
          return { success: false, error: 'Échec de la suppression du token' };
        }
      });
    },

    async removeAll() {
      return withLock(async () => {
        try {
          await writeTokensFile([]);
          return { success: true };
        } catch (error) {
          return { success: false, error: 'Échec de la suppression des tokens' };
        }
      });
    },

    // SEC-03 : résout le secret déchiffré par nom — utilisé par tokens:connectByName.
    // Le mutex n'est tenu que pendant la lecture.
    async resolveByName(name) {
      return withLock(async () => {
        if (typeof name !== 'string' || !name) return { error: 'Nom de token invalide' };
        if (!encryptionAvailable()) {
          return { error: 'Connexion impossible : stockage sécurisé indisponible. Sous Linux, installe libsecret.' };
        }
        const store = await readTokensFile();
        const entry = (store.tokens || []).find(t => t.name === name);
        if (!entry) return { error: 'Token introuvable' };
        let token;
        try {
          token = decryptToken(entry.token);
        } catch {
          token = null;
        }
        if (!token) return { error: 'Token corrompu ou mal stocké (réenregistre-le)' };
        // userId optionnel : stocke cote main, sert a reutiliser la session en
        // cours ("meme compte") au lieu de re-loggner - perf + limite de sessions.
        return entry.userId ? { token, userId: String(entry.userId) } : { token };
      });
    },

    // Enrichit une entree avec l'identifiant du compte apres un login reussi.
    async setUserId(name, userId) {
      return withLock(async () => {
        if (typeof name !== 'string' || !name) return { success: false, error: 'Nom de token invalide' };
        const store = await readTokensFile();
        const tokens = store.tokens || [];
        const entry = tokens.find(t => t.name === name);
        if (!entry) return { success: false, error: 'Token introuvable' };
        entry.userId = String(userId);
        try {
          await writeTokensFile(tokens);
          return { success: true };
        } catch {
          return { success: false, error: 'Échec de la mise à jour du token' };
        }
      });
    },
  };
}

module.exports = { createTokenStore, TOKEN_SCHEMA_VERSION };
