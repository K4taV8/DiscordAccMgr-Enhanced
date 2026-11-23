// Verrou UI — la modale Info doit décrire l'outil et créditer l'auteur original.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { translateToEnglish } from '../src/i18n/index.js';

const UI = readFileSync(new URL('../src/utils/ui.js', import.meta.url), 'utf8');

const DESCRIPTION = 'Application de bureau pour gérer son propre compte Discord : nettoyage, serveurs, MP, groupes, archives et médias. Basé sur Discord Account Manager, créé par Bherl1.';

test('la modale Info contient une description courte et crédite Bherl1', () => {
  assert.match(UI, /class="info-description"/, 'bloc de description présent');
  assert.ok(UI.includes(DESCRIPTION), 'description courte présente');
  assert.ok(UI.includes('Bherl1'), 'crédit auteur original présent');
  assert.ok(UI.includes('Discord Account Manager - Enhanced'), 'nom complet de l’application');
});

test('le bouton de fermeture de la modale Info est compact et neutre', () => {
  assert.match(UI, /class="btn btn-secondary info-close-btn" id="infoCloseBtn"/);
  assert.ok(UI.includes('info-close-icon'), 'icône SVG de fermeture présente');
});

test('la description de la modale Info est traduite en anglais', () => {
  assert.equal(
    translateToEnglish(DESCRIPTION),
    'Desktop application for managing your own Discord account: cleaning, servers, DMs, groups, archives and media. Based on Discord Account Manager, created by Bherl1.',
  );
});
