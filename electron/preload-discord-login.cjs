// Preload MINIMAL de la fenetre de connexion Discord native.
//
// Pourquoi ce fichier existe : Electron/Chromium annonce le support de la
// "conditional mediation" WebAuthn (passkey dans l'autofill) via
// `PublicKeyCredential.isConditionalMediationAvailable()` et
// `getClientCapabilities().conditionalGet`. Discord s'en sert pour proposer les
// passkeys des le chargement. Or Electron ne sait pas afficher cette UI : il
// transforme la requete conditionnelle en requete WebAuthn normale, ce qui
// ouvre la fenetre Windows Hello / « Choisir une methode de connexion » a
// chaque ouverture de la page (voir electron/electron#41472).
//
// On declare donc la fonctionnalite indisponible AVANT les scripts de la page.
// Les passkeys EXPLICITES (bouton « Utiliser une passkey ») restent possibles :
// seul l'affichage automatique est coupe.
//
// Securite : preload sandboxe, contextIsolation, nodeIntegration=false. Il
// n'expose RIEN a la page distante (aucun contextBridge) ; il execute seulement
// ce script dans le monde principal, puis se termine.
'use strict';

let webFrame = null;
try {
  ({ webFrame } = require('electron'));
} catch {
  // Hors Electron (tests Node) : pas de webFrame, on exporte juste le script.
}

const SCRIPT_NEUTRALISER_PASSKEYS = `(() => {
  try {
    if (!window.PublicKeyCredential) return;

    const definir = (nom, valeur) => {
      try {
        Object.defineProperty(window.PublicKeyCredential, nom, {
          value: valeur,
          configurable: true,
          writable: true,
        });
      } catch {
        try { window.PublicKeyCredential[nom] = valeur; } catch {}
      }
    };

    definir('isConditionalMediationAvailable', () => Promise.resolve(false));

    const original = window.PublicKeyCredential.getClientCapabilities;
    if (typeof original === 'function') {
      definir('getClientCapabilities', async function () {
        const capacites = await original.call(window.PublicKeyCredential);
        return Object.assign({}, capacites, { conditionalGet: false });
      });
    }
  } catch {}
})();`;

if (webFrame && typeof webFrame.executeJavaScript === 'function') {
  try {
    const promesse = webFrame.executeJavaScript(SCRIPT_NEUTRALISER_PASSKEYS);
    if (promesse && typeof promesse.catch === 'function') promesse.catch(() => {});
  } catch {}
}

module.exports = { SCRIPT_NEUTRALISER_PASSKEYS };
