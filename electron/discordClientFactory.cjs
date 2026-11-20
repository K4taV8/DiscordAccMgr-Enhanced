'use strict';

const { patchApplicationFlags } = require('./applicationFlags.cjs');

// Charge discord.js-selfbot-v13 en garantissant l'ordre du correctif amont :
// le patch d'abord, la lib ensuite. Un échec du patch (sous-module absent ou
// renommé) ne doit pas empêcher la connexion : on continue vers la lib, comme
// le faisait le `try/catch` d'origine dans main.cjs.
function loadDiscordClient(requireFn = require) {
  try {
    patchApplicationFlags(requireFn);
  } catch {}
  return requireFn('discord.js-selfbot-v13');
}

module.exports = { loadDiscordClient };
