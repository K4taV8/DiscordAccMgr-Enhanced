// Verrou UI — carte du profil connecté compacte et horizontale.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { translateToEnglish } from '../src/i18n/index.js';
import { formatMemberSince } from '../src/components/UserProfileModal.js';

const UI = readFileSync(new URL('../src/components/UserProfileModal.js', import.meta.url), 'utf8');
const APP = readFileSync(new URL('../src/styles/app.css', import.meta.url), 'utf8');

function blocs(css) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    out.push({
      selector: m[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim(),
      body: m[2],
    });
  }
  return out;
}
const bloc = (css, selector) => blocs(css).find((b) => b.selector === selector);

test('la carte profil abandonne le bandeau et passe en structure horizontale', () => {
  assert.doesNotMatch(UI, /profile-banner/, 'plus de bandeau vide');
  assert.match(UI, /class="profile-hero"/, 'rangée avatar + identité');
  assert.match(UI, /class="profile-avatar"/, 'avatar présent');
  assert.match(UI, /class="profile-identity"/, 'identité présente');
  assert.match(UI, /class="profile-meta"/, 'ligne plate pour la date');
  assert.match(UI, /profile-close-icon/, 'croix SVG dans le bouton de fermeture');
  assert.doesNotMatch(UI, />×</, 'plus de croix texte');
});

test('le type de compte est retiré', () => {
  assert.doesNotMatch(UI, /Type de compte/, 'plus de libellé Type de compte');
  assert.doesNotMatch(UI, /Compte Discord/, 'plus de valeur Compte Discord');
  assert.doesNotMatch(UI, /class="profile-details"/, 'plus de grille de tuiles');
});

test('la date de création est affichée à plat, sans tuile', () => {
  assert.match(UI, /class="profile-meta-label">Membre depuis</, 'libellé de date présent');
  assert.match(UI, /class="profile-meta-value"/, 'date présente');
  assert.doesNotMatch(APP, /\.profile-detail\s*\{/, 'plus de tuile .profile-detail');
  assert.doesNotMatch(APP, /\.profile-details\s*\{/, 'plus de grille .profile-details');

  const meta = bloc(APP, '.profile-meta');
  assert.ok(meta, 'règle .profile-meta');
  assert.match(meta.body, /display:\s*flex/, 'ligne plate');
  assert.match(meta.body, /justify-content:\s*space-between/, 'libellé et date aux deux extrémités');
  assert.match(meta.body, /border-top:\s*1px solid var\(--border-color\)/, 'simple hairline de séparation');
  assert.doesNotMatch(meta.body, /background:/, 'aucun fond de tuile');
  assert.doesNotMatch(meta.body, /border-radius:/, 'aucun arrondi de tuile');
});

test('la carte ne garde qu’une seule commande de fermeture : la croix', () => {
  assert.match(UI, /id="profileClose"/, 'croix de fermeture présente');
  assert.match(UI, /querySelector\('#profileClose'\)\.addEventListener\('click', close\)/, 'la croix ferme la modale');
  assert.doesNotMatch(UI, /profileCloseBtn/, 'plus de bouton Fermer');
  assert.doesNotMatch(UI, /profile-footer/, 'plus de pied de carte');
  assert.match(UI, /aria-label="Fermer"/, 'croix accessible');
});

test('le badge Connecté et sa pastille sont retirés', () => {
  assert.doesNotMatch(UI, /profile-status/, 'plus de statut Connecté');
  assert.doesNotMatch(UI, /profile-status-dot/, 'plus de pastille');
});

test('l ID copiable et son retour visuel restent intacts', () => {
  assert.match(UI, /id="profileCopyId"/, 'bouton ID présent');
  assert.match(UI, /copyToClipboard\(id\)/, 'copie de l’ID conservée');
  assert.match(UI, /copyBtn\.textContent = 'Copié'/, 'confirmation Copié conservée');
});

test('la carte est compacte et se termine après la ligne de date', () => {
  assert.doesNotMatch(APP, /\.profile-banner\s*\{/, 'règle du bandeau supprimée');
  assert.doesNotMatch(APP, /\.profile-footer\s*\{/, 'règle du pied de carte supprimée');
  assert.doesNotMatch(APP, /\.profile-close-btn\s*\{/, 'règle du bouton Fermer supprimée');
  assert.doesNotMatch(APP, /\.profile-status\s*\{/, 'règle du statut supprimée');

  const modal = bloc(APP, '.profile-modal');
  assert.ok(modal, 'règle .profile-modal');
  assert.match(modal.body, /width:\s*min\(500px, calc\(100vw - 40px\)\)/, 'largeur compacte 500 px');
  assert.match(modal.body, /padding:\s*24px/, 'padding compact');
  assert.match(modal.body, /gap:\s*18px/, 'espacements resserrés');

  const hero = bloc(APP, '.profile-hero');
  assert.ok(hero, 'règle .profile-hero');
  assert.match(hero.body, /display:\s*flex/, 'avatar et identité sur une ligne');
  assert.match(hero.body, /align-items:\s*center/, 'alignement vertical centré');

  const avatar = bloc(APP, '.profile-avatar');
  assert.ok(avatar, 'règle .profile-avatar');
  assert.match(avatar.body, /width:\s*72px/, 'avatar 72 px');
  assert.match(avatar.body, /height:\s*72px/, 'avatar 72 px');
  assert.doesNotMatch(avatar.body, /margin:\s*-46px/, 'plus de chevauchement de bandeau');

  const close = bloc(APP, '.profile-close');
  assert.ok(close, 'règle .profile-close');
  assert.match(close.body, /border-radius:\s*8px/, 'croix compacte carrée');
  assert.doesNotMatch(close.body, /rgba\(0, 0, 0, 0\.45\)/, 'plus de rond noir sur bandeau');
});

test('les libellés de la carte profil sont traduits en anglais', () => {
  assert.equal(translateToEnglish('Membre depuis'), 'Member since');
  assert.equal(translateToEnglish('Copié'), 'Copied');
});

test('la date Membre depuis suit la langue active', () => {
  assert.equal(formatMemberSince('747781155633496127', 'fr'), '25 août 2020');
  assert.equal(formatMemberSince('747781155633496127', 'en'), 'August 25, 2020');
  assert.equal(formatMemberSince('', 'fr'), '—');
});
