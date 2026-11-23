// Verrou UI — barre de titre custom OA-DESK.
// La fenêtre Electron est sans cadre : toute la barre est rendue par le
// renderer, et les seules zones déplaçables sont `.titlebar-drag`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const lire = (chemin) => readFileSync(new URL(chemin, import.meta.url), 'utf8');
const INDEX = lire('../index.html');
const APP = lire('../src/styles/app.css');
const THEME = lire('../src/styles/theme.css');
const MAIN = lire('../electron/main.cjs');
const PRELOAD = lire('../electron/preload.cjs');
const MAINJS = lire('../src/main.js');
const UI = lire('../src/utils/ui.js');

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

test('la barre de titre reprend la structure OA-DESK : logo, drag et 4 boutons', () => {
  assert.match(INDEX, /<header[^>]*class="titlebar"[^>]*id="titlebar"/, 'header .titlebar');
  assert.match(INDEX, /class="titlebar-drag" id="titlebar-drag"/, 'zone de drag séparée');
  assert.match(INDEX, /class="titlebar-logo"/, 'bloc logo + nom');
  assert.match(INDEX, /<img[^>]*width="18"[^>]*height="18"[^>]*alt=""[^>]*>/, 'logo 18 × 18');
  assert.ok(INDEX.includes('>Discord Account Manager - Enhanced<'), 'nom exact de l’application');

  assert.match(INDEX, /id="settingsBtn"/, 'engrenage applicatif');
  assert.match(INDEX, /M11 11h2v6h-2zm0-4h2v2h-2z/, 'icône info carrée fournie');
  assert.match(INDEX, /M19 3H5c-1\.1 0-2 \.9-2 2v14c0 1\.1\.9 2 2 2h14c1\.1 0 2-\.9 2-2V5c0-1\.1-\.9-2-2-2m0 16H5V5h14z/, 'cadre carré de l’icône info');
  assert.doesNotMatch(INDEX, /M19\.4 15a1\.65/, 'l’ancien engrenage est retiré');
  assert.match(INDEX, /id="minimizeBtn"/, 'minimiser');
  assert.match(INDEX, /id="maximizeBtn"/, 'agrandir');
  assert.match(INDEX, /id="closeBtn"/, 'fermer');
  assert.match(INDEX, /class="icon-max"/, 'icône agrandir');
  assert.match(INDEX, /class="icon-restore"/, 'icône restaurer');
  assert.match(INDEX, /class="titlebar-buttons"/, 'groupe de boutons');
});

test('la géométrie et les survols respectent les valeurs OA-DESK', () => {
  const barre = bloc(APP, '.titlebar');
  assert.ok(barre, 'règle .titlebar');
  assert.match(barre.body, /height:\s*38px/, 'hauteur 38 px');
  assert.match(barre.body, /flex:\s*0 0 38px/, 'hauteur fixe dans le flex');
  assert.match(barre.body, /background:\s*var\(--titlebar-bg\)/, 'fond thémé');
  assert.match(barre.body, /border-bottom:\s*1px solid var\(--titlebar-border\)/, 'hairline basse');
  assert.match(barre.body, /overflow:\s*hidden/, 'coins coupés par la fenêtre');
  assert.match(barre.body, /user-select:\s*none/, 'aucun texte sélectionnable');
  assert.doesNotMatch(barre.body, /-webkit-app-region:\s*drag/, 'la barre entière ne porte pas le drag');
  assert.doesNotMatch(barre.body, /border-radius/, 'aucun arrondi porté par la barre');

  const drag = bloc(APP, '.titlebar-drag');
  assert.ok(drag, 'règle .titlebar-drag');
  assert.match(drag.body, /-webkit-app-region:\s*drag/, 'drag uniquement sur la zone vide');

  const boutons = bloc(APP, '.titlebar-buttons');
  assert.ok(boutons, 'règle .titlebar-buttons');
  assert.match(boutons.body, /-webkit-app-region:\s*no-drag/, 'boutons non déplaçables');

  const bouton = bloc(APP, '.tb-btn');
  assert.ok(bouton, 'règle .tb-btn');
  assert.match(bouton.body, /width:\s*46px/, 'largeur 46 px');
  assert.match(bouton.body, /height:\s*38px/, 'hauteur 38 px');
  assert.match(bouton.body, /flex:\s*0 0 46px/, 'largeur fixe');
  assert.match(bouton.body, /-webkit-app-region:\s*no-drag/, 'chaque bouton est no-drag');
  assert.match(bouton.body, /border-radius:\s*0(?:px)?;/, 'aucun arrondi sur les boutons');

  const survol = bloc(APP, '.tb-btn:hover');
  assert.ok(survol, 'règle .tb-btn:hover');
  assert.match(survol.body, /background:\s*var\(--titlebar-hover\)/, 'fond de survol thémé');
  assert.match(survol.body, /color:\s*var\(--titlebar-icon-hover\)/, 'icône de survol thémée');

  const fermer = bloc(APP, '.tb-close:hover');
  assert.ok(fermer, 'règle .tb-close:hover');
  assert.match(fermer.body, /background:\s*var\(--titlebar-close-bg\)/, 'fond lavande au survol');
  assert.match(fermer.body, /color:\s*var\(--titlebar-close-icon\)/, 'icône blanche au survol');

  const logo = bloc(APP, '.titlebar-logo');
  assert.ok(logo, 'règle .titlebar-logo');
  assert.match(logo.body, /font-size:\s*13px/, 'texte 13 px');
  assert.match(logo.body, /font-weight:\s*700/, 'texte 700');
  assert.match(logo.body, /gap:\s*9px/, 'espace logo / nom');

  const icone = bloc(APP, '.tb-btn svg');
  assert.ok(icone, 'règle .tb-btn svg');
  assert.match(icone.body, /width:\s*12px/, 'icônes 12 px');
  assert.match(icone.body, /height:\s*12px/, 'icônes 12 px');

  assert.match(APP, /\.tb-btn \.icon-restore\s*\{[^}]*display:\s*none/, 'restaurer masqué par défaut');
  assert.match(APP, /body\.is-maximized \.tb-btn \.icon-max\s*\{[^}]*display:\s*none/, 'agrandir masqué une fois maximisé');
  assert.match(APP, /body\.is-maximized \.tb-btn \.icon-restore\s*\{[^}]*display:\s*block/, 'restaurer affiché une fois maximisé');
});

test('le main transmet l état maximisé et le preload expose une API fenêtre sûre', () => {
  assert.match(MAIN, /frame:\s*false/, 'fenêtre sans cadre natif');
  assert.match(MAIN, /Menu\.setApplicationMenu\(null\)/, 'menu natif supprimé');
  assert.match(MAIN, /mainWindow\.on\('maximize'/, 'événement maximize écouté');
  assert.match(MAIN, /mainWindow\.on\('unmaximize'/, 'événement unmaximize écouté');
  assert.match(MAIN, /send\('window:maximized-state'/, 'état poussé au renderer');
  assert.match(MAIN, /ipcMain\.handle\('window:maximize'/, 'bascule maximiser/restaurer');
  assert.match(MAIN, /ipcMain\.handle\('window:isMaximized'/, 'lecture de l’état initial');
  assert.match(MAIN, /contextIsolation:\s*true/, 'contextIsolation conservé');
  assert.match(MAIN, /sandbox:\s*true/, 'sandbox conservée');

  assert.match(PRELOAD, /isMaximized:\s*\(\)\s*=>/, 'isMaximized exposé');
  assert.match(PRELOAD, /onMaximized:\s*\(callback\)/, 'abonnement à l’état exposé');
  assert.match(PRELOAD, /ipcRenderer\.on\('window:maximized-state'/, 'événement écouté dans le preload');
  assert.match(PRELOAD, /contextBridge\.exposeInMainWorld\('electronAPI'/, 'API passée par contextBridge');
  assert.doesNotMatch(PRELOAD, /exposeInMainWorld\(['"]ipcRenderer['"]/, 'ipcRenderer jamais exposé');
});

test('le renderer branche l engrenage, le double-clic et l icône restaurer', () => {
  assert.match(MAINJS, /getElementById\('settingsBtn'\)[^;]*showInfoModal/s, 'engrenage → informations applicatives');
  assert.match(MAINJS, /getElementById\('titlebar-drag'\)[^;]*dblclick/s, 'double-clic sur la zone de drag');
  assert.match(MAINJS, /electronAPI\.isMaximized\(\)/, 'état initial lu');
  assert.match(MAINJS, /electronAPI\.onMaximized\(/, 'état maximisé synchronisé');
  assert.match(MAINJS, /classList\.toggle\('is-maximized'/, 'icône agrandir/restaurer basculée');
});

test('les six thèmes définissent leurs couleurs de barre de titre', () => {
  const themes = ['dark', 'light', 'discord', 'mono', 'oled-lavender', 'oled-mono'];
  const tokens = [
    '--titlebar-bg',
    '--titlebar-border',
    '--titlebar-hover',
    '--titlebar-active',
    '--titlebar-text',
    '--titlebar-icon',
    '--titlebar-icon-hover',
    '--titlebar-close-bg',
    '--titlebar-close-icon',
  ];
  for (const theme of themes) {
    const entete = theme === 'dark'
      ? THEME.split(':root, :root[data-theme="dark"]')[1].split('}')[0]
      : THEME.split(`:root[data-theme="${theme}"]`)[1]?.split('}')[0];
    assert.ok(entete, `bloc du thème ${theme}`);
    for (const token of tokens) {
      assert.match(entete, new RegExp(`${token}:\\s*[^;]+;`), `${theme} définit ${token}`);
    }
  }

  const sombre = THEME.split(':root, :root[data-theme="dark"]')[1].split('}')[0];
  assert.match(sombre, /--titlebar-bg:\s*#151515;/, 'fond sombre #151515');
  assert.match(sombre, /--titlebar-hover:\s*#26262A;/i, 'survol #26262A');
  assert.match(sombre, /--titlebar-icon-hover:\s*#E0E0E6;/i, 'icône survol #E0E0E6');
  assert.match(sombre, /--titlebar-close-bg:\s*#8E95E1;/i, 'fermeture lavande #8E95E1');
  assert.match(sombre, /--titlebar-close-icon:\s*#FFFFFF;/i, 'croix blanche');
});

test('la modale Info garde l en-tête à gauche et centre le pied de colonne', () => {
  assert.match(APP, /\.info-modal \.info-description\s*\{[^}]*text-align:\s*left/, 'description alignée à gauche');
  assert.match(APP, /\.info-modal \.info-head-copy \.version-badge\s*\{[^}]*margin:\s*0/, 'badge version à gauche');
  assert.match(APP, /\.info-modal \.info-footer\s*\{[^}]*margin-top:\s*auto[^}]*margin-bottom:\s*auto/s, 'pied centré verticalement dans l’espace restant');
  assert.match(APP, /\.info-modal \.info-footer\s*\{[^}]*align-items:\s*center/s, 'contenu du pied centré');
  assert.match(APP, /\.info-modal \.info-links\s*\{[^}]*justify-content:\s*center/, 'liens centrés');
  assert.match(APP, /\.info-modal \.info-license\s*\{[^}]*text-align:\s*center/, 'licence centrée');
  assert.match(APP, /\.info-modal \.btn\.info-close-btn\s*\{[^}]*align-self:\s*center[^}]*justify-self:\s*center/s, 'bouton centré');
  assert.match(UI, /class="info-left"/, 'colonne gauche conteneur');
  assert.match(UI, /class="info-footer"/, 'pied de colonne conteneur');
});
