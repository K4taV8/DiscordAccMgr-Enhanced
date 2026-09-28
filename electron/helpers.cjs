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

// Canaux de guilde porteurs d'un chat texte. Le chat intégré d'un salon vocal
// (2) et d'une scène (13) s'adresse par l'ID du salon lui-même, donc Discord
// sert /channels/{id}/messages dessus exactement comme sur un salon texte.
// 1/3 (DM, groupe) passent par d'autres endpoints, 4 (catégorie) et
// 14 (répertoire) n'ont aucun chat.
const MESSAGE_BEARING_CHANNEL_TYPES = [0, 2, 5, 10, 11, 12, 13, 15, 16];
const isMessageBearingChannel = (type) => MESSAGE_BEARING_CHANNEL_TYPES.includes(type);

module.exports = { routeKeyFor, isSnowflake, isOp, MESSAGE_BEARING_CHANNEL_TYPES, isMessageBearingChannel };
