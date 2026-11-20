// Verrou anti-régression — BUG-008 : l'ordre « patch ApplicationFlags AVANT
// chargement de discord.js-selfbot-v13 » est vérifié sur un faux `require`,
// donc par comportement et non par position de sous-chaîne dans main.cjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { patchApplicationFlags } = require('../electron/applicationFlags.cjs');
const { loadDiscordClient } = require('../electron/discordClientFactory.cjs');

test('BUG-008 : le patch est appliqué avant le chargement de la lib', () => {
  const af = function ApplicationFlags() {};
  const moduleClient = { Client: class Client {} };
  const appels = [];
  const fauxRequire = (id) => {
    appels.push(id);
    if (id === 'discord.js-selfbot-v13/src/util/ApplicationFlags') return af;
    if (id === 'discord.js-selfbot-v13') return moduleClient;
    throw new Error(`module inattendu : ${id}`);
  };

  const charge = loadDiscordClient(fauxRequire);
  assert.equal(charge, moduleClient);
  assert.equal(af.ApplicationFlags, af, 'la classe est exposée sous la propriété attendue');
  assert.deepEqual(appels, [
    'discord.js-selfbot-v13/src/util/ApplicationFlags',
    'discord.js-selfbot-v13',
  ], 'le patch passe en premier');
});

test('BUG-008 : un patch déjà valide n’est pas écrasé', () => {
  const marqueur = function Marqueur() {};
  const af = function ApplicationFlags() {};
  af.ApplicationFlags = marqueur;
  const rendu = patchApplicationFlags((id) => {
    assert.equal(id, 'discord.js-selfbot-v13/src/util/ApplicationFlags');
    return af;
  });
  assert.equal(rendu, af);
  assert.equal(af.ApplicationFlags, marqueur);
});

test('BUG-008 : un échec du patch ne bloque pas le chargement de la lib', () => {
  const moduleClient = { Client: class Client {} };
  const charge = loadDiscordClient((id) => {
    if (id === 'discord.js-selfbot-v13/src/util/ApplicationFlags') throw new Error('sous-module absent');
    return moduleClient;
  });
  assert.equal(charge, moduleClient);
});
