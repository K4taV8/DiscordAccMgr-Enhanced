// Socle pur de la connexion Discord native : aucune dependance a `electron`,
// aucun acces disque. Le main process capte le user token dans le corps des
// reponses /api/v9/auth/* ; ces primitives le lisent et reconnaissent les URL.

'use strict';

// Motif d'un user token : trois segments non vides separes par des points.
// Sert au repli par scan de localStorage/sessionStorage quand aucune reponse
// d'auth n'a ete interceptee.
const MOTIF_TOKEN = /[\w-]{20,}\.[\w-]{6,}\.[\w-]{25,}/;

// Extrait le token d'un corps de reponse.
// 1) corps JSON portant `token` (chaine non vide) -> ce token ;
// 2) sinon repli sur la regex `"token":"..."` (corps embarque dans autre chose) ;
// 3) sinon `null`. Ne jette JAMAIS : JSON malforme, entree non chaine ou vide.
function extraireToken(corps) {
  if (typeof corps !== 'string' || corps.length === 0) return null;

  try {
    const donnees = JSON.parse(corps);
    if (donnees && typeof donnees.token === 'string' && donnees.token.length > 0) {
      return donnees.token;
    }
  } catch {
    // Corps non JSON : la regex ci-dessous peut encore le sauver.
  }

  const correspondance = /"token"\s*:\s*"([^"]+)"/.exec(corps);
  return correspondance ? correspondance[1] : null;
}

// Vrai si l'URL est un point d'entree d'authentification Discord (login, MFA,
// ou handshake du QR remote-auth).
function estUrlAuth(url) {
  if (typeof url !== 'string') return false;
  return url.includes('/api/v9/auth/') || url.includes('/remote-auth');
}

module.exports = { extraireToken, estUrlAuth, MOTIF_TOKEN };
