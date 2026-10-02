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

  if (error === 'Rate limited' || error === 'rate limited') return 'retry';
  if (/not found|unknown message/i.test(error) || STATUS_IN_ERROR.exec(error)?.[1] === '404') return 'missing';
  if (STATUS_IN_ERROR.exec(error)?.[1] === '403') return 'forbidden';
  return 'failed';
}

// Un acces refuse ou un message absent ne se reessaye pas : seul le 429
// merite un nouvel essai, avec le Retry-After fourni par Discord.
export function shouldRetryDelete(result) {
  return classifyDeleteResult(result) === 'retry';
}

export function summarizeDelete(counts) {
  const deleted = counts.deleted || 0;
  const missing = counts.missing || 0;
  const forbidden = counts.forbidden || 0;
  const failed = counts.failed || 0;
  const total = deleted + missing + forbidden + failed;

  const parts = [`${deleted} supprimé(s)`];
  if (missing) parts.push(`${missing} déjà absent(s)`);
  if (forbidden) parts.push(`${forbidden} accès refusé(s)`);
  if (failed) parts.push(`${failed} échec(s)`);

  return { total, text: parts.join(' · ') };
}