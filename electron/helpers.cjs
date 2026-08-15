// Helpers purs (CJS, main process) — extraits de main.cjs pour être testables
// unitairement sans charger Electron (QA-01).

// Clé de route normalisée : snowflakes masqués (~bucket Discord, major params).
function routeKeyFor(path) {
  return path.replace(/\/\d+(?=\/|$)/g, '/:id');
}

// Validation des snowflakes Discord : chaîne numérique de 1 à 32 chiffres.
const isSnowflake = (s) => typeof s === 'string' && /^\d+$/.test(s) && s.length <= 32;

// Opérations de persistance autorisées (checkpoints).
const isOp = (op) => op === 'removeReactions' || op === 'deleteMessages';

module.exports = { routeKeyFor, isSnowflake, isOp };
