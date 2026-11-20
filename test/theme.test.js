import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  THEMES,
  FALLBACK_THEME,
  THEME_KEY,
  THEME_BUTTON_ICON,
  normalizeThemeId,
  themeIcon,
  applyTheme,
  readStoredTheme,
} from '../src/utils/theme.js';

// Doubles minimaux : le module ne doit toucher qu'à ces deux surfaces.
// Le setter de `dataset` est un piege : il prouve qu'on mute l'attribut
// (dataset.theme = ...) au lieu de remplacer l'objet entier.
function fakeDeps(stored = null) {
  const writes = [];
  const dataset = {};
  return {
    writes,
    dataset,
    root: {
      get dataset() { return dataset; },
      set dataset(v) { throw new Error('dataset ne doit pas etre remplace'); },
    },
    storage: {
      getItem: () => stored,
      setItem: (k, v) => writes.push([k, v]),
    },
  };
}

test('THEMES expose des descripteurs complets et des ids uniques', () => {
  assert.ok(THEMES.length >= 3, 'au moins 3 themes');
  const ids = THEMES.map(t => t.id);
  assert.equal(new Set(ids).size, ids.length, 'ids uniques');
  for (const t of THEMES) {
    assert.equal(typeof t.id, 'string');
    assert.ok(t.label.length > 0, `${t.id} a un libelle`);
    assert.ok(t.icon.includes('<svg'), `${t.id} a une icone svg`);
  }
  assert.ok(ids.includes(FALLBACK_THEME), 'le fallback est present dans le registre');
});

test('normalizeThemeId accepte un id connu et rejette le reste', () => {
  assert.equal(normalizeThemeId('light'), 'light');
  assert.equal(normalizeThemeId('discord'), 'discord');
  assert.equal(normalizeThemeId('inconnu'), FALLBACK_THEME);
  assert.equal(normalizeThemeId(''), FALLBACK_THEME);
  assert.equal(normalizeThemeId(null), FALLBACK_THEME);
  assert.equal(normalizeThemeId(undefined), FALLBACK_THEME);
  assert.equal(normalizeThemeId(42), FALLBACK_THEME);
});

test('themeIcon renvoie le svg du theme, et une chaine vide sinon', () => {
  assert.ok(themeIcon('discord').includes('<svg'));
  assert.equal(themeIcon('inconnu'), '');
});

// Le bouton n'affiche plus le theme courant mais une icone d'action fixe :
// elle doit suivre currentColor, sinon le Boxicons regular (sans attribut
// fill) s'afficherait en noir sur fond sombre.
test('THEME_BUTTON_ICON est un svg a heriter de currentColor, de taille fixee', () => {
  assert.ok(THEME_BUTTON_ICON.includes('<svg'), 'c est un svg');
  assert.ok(THEME_BUTTON_ICON.includes('fill="currentColor"'), 'il suit la couleur du theme');
  assert.ok(THEME_BUTTON_ICON.includes('width="24"'), 'il porte une taille explicite');
  assert.ok(THEME_BUTTON_ICON.includes('height="24"'));
  assert.ok(THEME_BUTTON_ICON.includes('<path d="M10.97 20.39'), 'c est le brush de Boxicons');
});

test('chaque icone de theme porte une taille explicite', () => {
  for (const t of THEMES) {
    assert.ok(t.icon.includes('width="24"'), `${t.id} declare width`);
    assert.ok(t.icon.includes('height="24"'), `${t.id} declare height`);
    assert.ok(t.icon.includes('fill="currentColor"'), `${t.id} suit currentColor`);
  }
});

// Convention semantique : soleil = jour = theme clair, lune = nuit = theme
// sombre. C'etait inverse au depart (soleil sur « Sombre »), trompeur.
test('l icone suit la semantique du theme : soleil=clair, lune=sombre', () => {
  const pathOf = (id) => /<path d="([^"]+)"/.exec(THEMES.find((t) => t.id === id).icon)[1];

  assert.ok(pathOf('light').startsWith('M12 17.01c2.76'), 'le theme Clair porte le soleil');
  assert.ok(pathOf('dark').startsWith('M12.2 22c4.53'), 'le theme Sombre porte la lune');
  assert.ok(pathOf('discord').startsWith('M14.82 4.26'), 'le theme Discord garde son logo');
});
// --- Theme monochrome (mono) ------------------------------------------------
// Le 4e theme est un N&B en nuances de gris. La contrainte imposee est
// explicitement « aucun noir pur », donc on la verifie SUR LA SOURCE CSS :
// sans DOM on ne peut pas lire les valeurs rendues. C'est aussi la contrainte
// la plus facile a reintroduire par erreur en copiant un bloc existant.

const cssSource = () => readFileSync(new URL('../src/styles/theme.css', import.meta.url), 'utf8');

// Tokens declares dans le bloc data-theme="<id>" de theme.css.
const tokensOf = (id) => {
  const body = cssSource().split(`:root[data-theme="${id}"]`)[1]?.split('}')[0];
  if (!body) return null;
  return new Set([...body.matchAll(/--([a-z0-9-]+)\s*:/g)].map((m) => m[1]));
};

test('le theme mono est au registre et son bloc CSS existe', () => {
  assert.ok(THEMES.some((t) => t.id === 'mono'), 'mono est enregistre');
  assert.ok(tokensOf('mono'), 'le bloc :root[data-theme="mono"] est present');
});

test('le theme mono n utilise aucun noir pur', () => {
  const block = cssSource().split(':root[data-theme="mono"]')[1].split('}')[0];
  assert.ok(!/#000\b/i.test(block), 'pas de #000 ni #000000');
  assert.ok(!/rgba?\(\s*0\s*,\s*0\s*,/i.test(block), 'pas de rgb(0, 0, 0) ni rgba(0, 0, 0, a)');
  // Le fond ne doit pas etre le noir absolu non plus, meme ecrit en minuscules.
  assert.ok(!/rgb\(\s*0\s*,\s*0\s*,\s*0\s*\)/i.test(block));
});

test('le bloc mono couvre tous les tokens des autres themes', () => {
  const mono = tokensOf('mono');
  for (const id of ['dark', 'light', 'discord']) {
    for (const tok of tokensOf(id)) {
      assert.ok(mono.has(tok), `mono definit --${tok}, present dans ${id}`);
    }
  }
});

// Contrainte explicite : changement a chaud, aucun rechargement de fenetre.
// Si le module reference location/window, l'import ou l'appel echouerait ici.
test('applyTheme ecrit dataset.theme et localStorage, sans autre effet', () => {
  const deps = fakeDeps();
  const applied = applyTheme('discord', deps);
  assert.equal(applied, 'discord');
  assert.equal(deps.root.dataset.theme, 'discord');
  assert.deepEqual(deps.writes, [[THEME_KEY, 'discord']]);
});

test('applyTheme refuse un id inconnu et retombe sur le fallback', () => {
  const deps = fakeDeps();
  const applied = applyTheme(' pirate', deps);
  assert.equal(applied, FALLBACK_THEME);
  assert.equal(deps.root.dataset.theme, FALLBACK_THEME);
  assert.deepEqual(deps.writes, [[THEME_KEY, FALLBACK_THEME]]);
});

test('readStoredTheme normalise une valeur corrompue et la reecrit', () => {
  const clean = fakeDeps('light');
  assert.equal(readStoredTheme(clean), 'light');
  assert.deepEqual(clean.writes, [], 'une valeur valide ne touche pas au stockage');

  const corrupt = fakeDeps('valeur-pourrie');
  assert.equal(readStoredTheme(corrupt), FALLBACK_THEME);
  assert.deepEqual(corrupt.writes, [[THEME_KEY, FALLBACK_THEME]], 'le stockage est realigne');
});

test('readStoredTheme sans valeur stockee donne le fallback sans ecrire', () => {
  const deps = fakeDeps(null);
  assert.equal(readStoredTheme(deps), FALLBACK_THEME);
  assert.deepEqual(deps.writes, []);
});

// --- Contrastes WCAG (AA = 4.5:1) ----------------------------------------------
// Le cas qui a motive ce test : en mono, --success est un gris clair (#8f8f8f),
// et .btn-saved posait un blanc DURE sur ce fond -> 3.23:1. Le blanc n'est
// lisible que parce que les autres themes ont un --success sature et sombre.
// On fige ici, dans les valeurs du CSS, que les paires interactives de la page
// de connexion restent lisibles SANS compter sur la couleur.

function parseColor(v) {
  v = v.trim().toLowerCase();
  let m = /^#([0-9a-f]{6})$/.exec(v);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = /^#([0-9a-f]{3})$/.exec(v);
  if (m) return [0, 1, 2].map((i) => parseInt(m[1][i] + m[1][i], 16));
  return null;
}

function luminance(hex) {
  const [r, g, b] = parseColor(hex).map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function monoTokens() {
  const block = cssSource().split(':root[data-theme="mono"]')[1].split('}')[0];
  const t = {};
  for (const m of block.matchAll(/--([a-z0-9-]+)\s*:\s*(#[0-9a-f]{6})\s*;/g)) t[m[1]] = m[2];
  return t;
}

test('paires interactives du theme mono en contraste AA', () => {
  const t = monoTokens();
  const pairs = [
    ['brand', 'brand-text', 'bouton Connect (fond --brand)'],
    ['success', 'on-success', 'bouton Save apres sauvegarde (fond --success)'],
    ['bg-card', 'text-primary', 'bouton Save au repos (:btn-secondary)'],
  ];
  for (const [bg, fg, label] of pairs.slice(0, 3)) {
    const r = contrast(t[bg], t[fg]);
    assert.ok(r >= 4.5, `${label} -> ${r.toFixed(2)}:1, AA exige 4.5:1`);
  }
});

test('btn-saved et loader n imposent plus un contraste par accident', () => {
  const appCss = readFileSync(new URL('../src/styles/app.css', import.meta.url), 'utf8');

  // .btn-saved doit utiliser --on-success (avec repli blanc pour les autres themes).
  assert.ok(appCss.includes('color: var(--on-success, #ffffff);'), '.btn-saved lit --on-success');

  // .loader suit currentColor, sinon son anneau (var(--text-primary), presque
  // blanc en mono) disparait sur un bouton clair.
  const loader = appCss.split('.loader {')[1].split('}')[0];
  assert.ok(loader.includes('currentColor'), '.loader herite de currentColor');
  assert.ok(!loader.includes('var(--text-primary)'), '.loader n impose plus la couleur du texte');
});
test('bouton Connect mono : fond gris franc + texte lisible (AA)', () => {
  // L'utilisateur a confirme que le bouton restait trop clair (quasi blanc,
  // #d4d4d4) meme avec texte noir. Le theme mono force maintenant un fond
  // nettement plus gris via --btn-primary-bg, avec liseré, pour le bouton
  // primaire UNIQUEMENT (les autres themes gardent --brand tel quel).
  const css = cssSource();
  const rule = css.split('[data-theme="mono"] .btn-primary,')[1]
    .split('}')[0]
    .replace('hover,', '')
    .replace('active', '')
    .replace('hover', '');
  const sel = /\[data-theme="mono"\] \.btn-primary/.test(css);
  assert.ok(sel, 'regle mono .btn-primary presente');
  assert.ok(rule.includes('background: var(--btn-primary-bg);'), 'fond via --btn-primary-bg');
  assert.ok(rule.includes('border: 1px solid') || rule.includes('border-color'), 'liseré pour delivrer le bouton');

  const t = monoTokens();
  assert.ok(t['btn-primary-bg'], '--btn-primary-bg defini en mono');
  const r = contrast(t['btn-primary-bg'], t['brand-text']);
  assert.ok(r >= 4.5, `Connect mono lisible (${r.toFixed(2)}:1, AA exige 4.5:1)`);
  // Le fond doit etre nettement plus sombre que l'ancien quasi-blanc (--brand),
  // pour que le bouton ne ressemble plus a un bloc blanc fade.
  assert.ok(luminance(t['btn-primary-bg']) < luminance(t.brand) * 0.7, 'fond nettement plus sombre que --brand');
  // Surtout : le fond du bouton ne doit plus etre confondu avec du blanc.
  assert.ok(luminance(t['btn-primary-bg']) < 0.5, "fond btn-primary plus sombre qu a mi chemin deja ailleurs");
});