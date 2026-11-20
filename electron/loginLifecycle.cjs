'use strict';

// POSSIBLE 3 de l'audit : `Promise.race([login, timeout])` rejette au timeout,
// mais `login()` peut aboutir APRÈS. Sans nettoyage, une session gateway
// orpheline peut subsister. On attache donc un nettoyage à la résolution
// tardive : si le client a expiré entre-temps, il est détruit à nouveau.
function loginWithTimeout(client, token, timeoutMs) {
  if (!client || typeof client.login !== 'function') {
    return Promise.reject(new Error('Client Discord invalide'));
  }

  let minuteur = null;
  let expire = false;
  const connexion = Promise.resolve().then(() => client.login(token));

  // `then` + `catch` séparés : la résolution tardive est observée sans créer de
  // rejet non géré quand `login()` échoue.
  connexion.then(() => {
    if (!expire) return;
    try {
      const destruction = client.destroy?.();
      if (destruction?.catch) destruction.catch(() => {});
    } catch {}
  }).catch(() => {});

  const delai = new Promise((_, rejeter) => {
    minuteur = setTimeout(() => {
      expire = true;
      rejeter(new Error('Délai de connexion dépassé (30 s)'));
    }, timeoutMs);
  });

  return Promise.race([connexion, delai]).finally(() => {
    if (minuteur) clearTimeout(minuteur);
  });
}

module.exports = { loginWithTimeout };
