// Regles de filtrage de l'import Discord — COPIE CommonJS, main process.
//
// ⚠ DUPLICATION ASSUMÉE, ET VERIFIÉE PAR UN TEST. La même règle existe dans
// `src/services/packageImporter.service.js` (module ESM du renderer). Les deux
// copies ne peuvent pas être une seule fonction : le renderer est un navigateur,
// il ne peut ni `require` un `.cjs` ni importer quoi que ce soit venant de
// `electron/`, et un `node:*` dans le bundle du renderer le casserait au premier
// `import`.
// Le test `les deux copies de la regle de bruit repondent pareil sur les cas du
// terrain` (test/packageIndex.test.js) compare les deux implémentations entrée
// par entrée sur un jeu de cas choisi pour couvrir les pièges réels : accents,
// majuscules, ponctuation, `__MACOSX/`, `.DS_Store`, `._`, segments vides,
// chemins sans barre oblique. Toute modification de la règle doit être
// répercutée des deux côtés, sinon ce test rougit.
//
// COPIER À L'IDENTIQUE : lignes MAX_ENTRY_BYTES / NOISE_PREFIXES /
// normalizeSegment / isNoisePath de src/services/packageImporter.service.js.
// Ne « factored » rien d'un côté seulement.

const MAX_ENTRY_BYTES = 128 * 1024 * 1024;

const NOISE_PREFIXES = [
  'activit', 'publicit', 'demandesdesupport', 'demandesdesoutien', 'demandesupport',
  'program', 'advertisement', 'ads', 'ticket', 'supportticket', 'supportrequests',
];

function normalizeSegment(segment) {
  return segment
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function isNoisePath(path) {
  const lower = path.toLowerCase();
  const name = lower.split('/').pop() || '';
  if (lower.startsWith('__macosx/') || name.startsWith('._') || name === '.ds_store') return true;
  // BUG-009 : le bruit de l'export est TOUJOURS un dossier de premier niveau
  // (Activite, Publicites, Demandes de soutien...). En ne testant que le premier
  // segment, un fichier legitime comme Comptes/activation.json n'est plus ecarte
  // a tort parce que son nom commence par un prefixe de bruit (« activit »).
  const first = normalizeSegment(lower.split('/')[0] || '');
  return first !== '' && NOISE_PREFIXES.some(prefix => first.startsWith(prefix));
}

module.exports = { MAX_ENTRY_BYTES, NOISE_PREFIXES, normalizeSegment, isNoisePath };
