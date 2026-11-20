// Verrou applicatif global des operations longues (BUG-001).
//
// Les verrous historiques (`isDeleting`) etaient portes par chaque manager :
// un nettoyage de MP et un nettoyage de groupes pouvaient donc piloter le meme
// panneau de progression en parallele. Ce verrou est unique pour toute
// l'application ; il se prend avant de demarrer et se relache dans un
// `finally`, quoi qu'il arrive.
//
// Le jeton retourne identifie le proprietaire : un appelant ne peut pas
// relacher le verrou d'un autre (par exemple un `finally` tardif).

let current = null;
let nextId = 0;

export function acquireOperation(name = 'opération') {
  if (current) return null;
  const token = { id: ++nextId, name: String(name || 'opération') };
  current = token;
  return token;
}

export function releaseOperation(token) {
  if (!current) return false;
  if (token && current !== token) return false;
  current = null;
  return true;
}

export function currentOperation() {
  return current ? current.name : null;
}

export function isOperationActive() {
  return Boolean(current);
}
