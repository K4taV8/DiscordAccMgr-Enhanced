'use strict';

// Correctif d'un bug AMONT de discord.js-selfbot-v13 3.4.6 : Application.js fait
// `const { ApplicationFlags } = require('../../util/ApplicationFlags')` alors
// que ce module exporte la CLASSE directement (`module.exports = ApplicationFlags`).
// `ApplicationFlags` est donc undefined, et un message portant un `application`
// fait planter le main (« ApplicationFlags is not a constructor »).
//
// La classe doit être exposée sous la propriété attendue AVANT le chargement de
// la lib. Le correctif est isolé ici pour être vérifié par un faux `require`
// (BUG-008), au lieu d'une recherche de sous-chaîne dans main.cjs.

function patchApplicationFlags(requireFn = require) {
  const af = requireFn('discord.js-selfbot-v13/src/util/ApplicationFlags');
  if (af && typeof af === 'function' && !af.ApplicationFlags) af.ApplicationFlags = af;
  return af;
}

module.exports = { patchApplicationFlags };
