// Classification des resultats de suppression depuis un Data Package.
//
// Le code d avant annoncait « supprime » quoi qu il arrive : un salon quitte
// (403) ou un message deja efface (404) etaient comptes comme des succes. La
// regle G6 du projet impose aussi un delai entre deux DELETE, et le retry 429
// etait cassee (sa condition sortait de boucle au premier essai).

export const DELETE_OUTCOMES = ['deleted', 'missing', 'forbidden', 'retry', 'failed'];

const STATUS_IN_ERROR = /HTTP\s+(\d{3})/i;

export function classifyDeleteResult(result) {
  if (result?.success) return 'deleted';
  const error = String(result?.error || '');
  // « Unknown Channel » ne veut pas dire message absent : c est l identifiant
  // du salon qui est mauvais. Ce controle passe AVANT le statut, sinon le
  // 404 serait d'abord classe « deja absent » et la cause resterait invisible.
  if (/unknown channel/i.test(error)) return 'failed';
  // Le statut HTTP fait foi quand il est fourni : le message de Discord
  // ("Missing Access", "Missing Permissions") ne contient aucun code, et une
  // simple recherche de « HTTP 403 » laissait passer un vrai refus en « echec ».
  const status = Number(result?.status);
  if (Number.isFinite(status) && status > 0) {
    if (status === 404) return 'missing';
    if (status === 403) return 'forbidden';
    if (status === 429) return 'retry';
  }

  if (error === 'Rate limited' || error === 'rate limited') return 'retry';
  if (/not found|unknown message/i.test(error) || STATUS_IN_ERROR.exec(error)?.[1] === '404') return 'missing';
  if (STATUS_IN_ERROR.exec(error)?.[1] === '403') return 'forbidden';
  return 'failed';
}

export function describeDeleteFailure(result) {
  const status = Number(result?.status);
  const error = String(result?.error || '').trim();
  if (Number.isFinite(status) && status > 0 && error) return `${status} ${error}`;
  if (error) return error;
  return `HTTP ${Number.isFinite(status) ? status : '?'}`;
}

// Un acces refuse ou un message absent ne se reessaye pas : seul le 429
// merite un nouvel essai, avec le Retry-After fourni par Discord.
export function shouldRetryDelete(result) {
  return classifyDeleteResult(result) === 'retry';
}

// Un « echec » sans raison est inexploitable : sur un salon ou l on a acces,
// la cause peut etre un 400 de corps de requete invalide, un 401 de jeton,
// ou une exception IPC. Les motifs distincts sont donc comptes et rappeles.
export function summarizeDelete(counts, reasons = null) {
  const deleted = counts.deleted || 0;
  const missing = counts.missing || 0;
  const forbidden = counts.forbidden || 0;
  const failed = counts.failed || 0;
  const total = deleted + missing + forbidden + failed;

  const parts = [`${deleted} supprimé(s)`];
  if (missing) parts.push(`${missing} déjà absent(s)`);
  if (forbidden) parts.push(`${forbidden} accès refusé(s)`);
  if (failed) parts.push(`${failed} échec(s)`);

  if (failed && reasons) {
    const distinct = [...new Set(Object.keys(reasons).filter(key => key))];
    if (distinct.length) parts.push(`(${distinct.slice(0, 2).join(' / ')}${distinct.length > 2 ? ` +${distinct.length - 2}` : ''})`);
  }

  return { total, text: parts.join(' · ') };
}