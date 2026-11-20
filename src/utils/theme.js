// Etat des themes — registre unique et application a chaud.
//
// Le theme vit dans l'attribut `data-theme` de <html> ; le CSS de theme.css
// fait le reste. Aucun rechargement de fenetre n'est implique : basculer
// l'attribut suffit, ce qui est la contrainte de l'application.
//
// Pour ajouter un theme : une entree dans THEMES + un bloc `:root[data-theme=..]`
// dans theme.css. Aucun composant a modifier, la grille s'adapte toute seule.

export const THEME_KEY = 'theme';
export const FALLBACK_THEME = 'dark';

// Taille ecrite dans le markup ET overriddable en CSS : une icone sans
// width/height explicite herite d'une taille par defaut selon le conteneur,
// ce qui rendait le rendu de la pastille solarie aleatoire.
const svg = (path, size = 24) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">${path}</svg>`;

// Sombre / Clair / Discord proviennent des SVG en dur de index.html (avant le
// passage au selecteur). Mono est un ajout : un cercle au trait avec un demi-disque
// plein, c'est la convention ? contraste ?. On evite le glyphe demi-lune car il
// se confond avec l'icone de la nuit.
export const THEMES = [
  {
    id: 'dark',
    label: 'Sombre',
    icon: svg('<path d="M12.2 22c4.53 0 8.45-2.91 9.76-7.24a1.002 1.002 0 0 0-1.25-1.25c-.78.23-1.58.35-2.38.35-4.52 0-8.2-3.68-8.2-8.2 0-.8.12-1.6.35-2.38.11-.35.01-.74-.25-1s-.64-.36-1-.25A10.17 10.17 0 0 0 2 11.8C2 17.42 6.57 22 12.2 22M8.18 4.65c-.03.34-.05.68-.05 1.02 0 5.62 4.57 10.2 10.2 10.2.34 0 .68-.02 1.02-.05C17.93 18.38 15.23 20 12.2 20 7.68 20 4 16.32 4 11.8a8.15 8.15 0 0 1 4.18-7.15"/>'),
  },
  {
    id: 'light',
    label: 'Clair',
    icon: svg('<path d="M12 17.01c2.76 0 5.01-2.25 5.01-5.01S14.76 6.99 12 6.99 6.99 9.24 6.99 12s2.25 5.01 5.01 5.01M12 9c1.66 0 3.01 1.35 3.01 3.01s-1.35 3.01-3.01 3.01-3.01-1.35-3.01-3.01S10.34 9 12 9m1 10h-2v3h2zm0-17h-2v3h2zM2 11h3v2H2zm17 0h3v2h-3zM4.22 18.36l.71.71.71.71 1.06-1.06 1.06-1.06-.71-.71-.71-.71-1.06 1.06zM19.78 5.64l-.71-.71-.71-.71-1.06 1.06-1.06 1.06.71.71.71.71 1.06-1.06zm-12.02.7L6.7 5.28 5.64 4.22l-.71.71-.71.71L5.28 6.7l1.06 1.06.71-.71zm8.48 11.32 1.06 1.06 1.06 1.06.71-.71.71-.71-1.06-1.06-1.06-1.06-.71.71z"/>'),
  },
  {
    id: 'discord',
    label: 'Discord',
    icon: svg('<path d="M14.82 4.26a10 10 0 0 0-.53 1.1 14.7 14.7 0 0 0-4.58 0 10 10 0 0 0-.53-1.1 16 16 0 0 0-4.13 1.3 17.33 17.33 0 0 0-3 11.59 16.6 16.6 0 0 0 5.07 2.59A13 13 0 0 0 8.23 18a9.7 9.7 0 0 1-1.71-.83 3.4 3.4 0 0 0 .42-.33 11.66 11.66 0 0 0 10.12 0q.21.18.42.33a11 11 0 0 1-1.71.84 12.4 12.4 0 0 0 1.08 1.78 16.4 16.4 0 0 0 5.06-2.59 17.22 17.22 0 0 0-3-11.59 16 16 0 0 0-4.09-1.35M8.68 14.81a1.94 1.94 0 0 1-1.8-2 1.93 1.93 0 0 1 1.8-2 1.93 1.93 0 0 1 1.8 2 1.93 1.93 0 0 1-1.8 2m6.64 0a1.94 1.94 0 0 1-1.8-2 1.93 1.93 0 0 1 1.8-2 1.92 1.92 0 0 1 1.8 2 1.92 1.92 0 0 1-1.8 2"/>'),
  },
  {
    id: 'mono',
    label: 'Mono',
    icon: svg('<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 3a9 9 0 0 0 0 18V3z"/>'),
  },
];

// Icone d'action du bouton, distincte des icones de theme : le bouton ouvre
// le selecteur, il ne represente donc plus le theme courant mais l'action
// « personnaliser ». Boxicons 2.1.4, jeu regular, licence CC BY 4.0 :
// le fichier d'origine ne porte aucun attribut fill, on l'ajoute ici pour que
// l'icone suive currentColor au lieu d'etre noire sur fond sombre.
export const THEME_BUTTON_ICON = svg(
  '<path d="M10.97 20.39c1.12-1.12 1.71-2.85 1.55-4.49l8.56-8.56c1.22-1.22 1.22-3.2 0-4.41s-3.2-1.22-4.41 0L7.8 11.78c-.71.06-1.41.27-2.01.64-1.17.72-1.81 1.89-1.81 3.29 0 .3.02.59.04.86.08 1.03.11 1.42-1.47 2.21-.32.16-.53.47-.55.82s.14.69.43.89c1 .69 2.76 1.49 4.62 1.49 1.35 0 2.74-.42 3.92-1.6Zm7.12-16.06c.44-.44 1.15-.44 1.59 0s.44 1.15 0 1.58l-7.86 7.86a4.4 4.4 0 0 0-1.65-1.52zM6.02 16.42a8 8 0 0 1-.04-.71c0-.7.29-1.23.86-1.59.68-.42 1.66-.49 2.31-.16.65.32.99.81 1.18 1.28l-.05.05.1.1c.05.16.09.32.12.47.18 1.09-.22 2.37-.96 3.11-1.44 1.44-3.31 1.1-4.58.61 1.09-.98 1.13-1.99 1.04-3.16Z"/>'
);

export function themeIcon(id) {
  return THEMES.find((t) => t.id === id)?.icon ?? '';
}

export function themeLabel(id) {
  return THEMES.find((t) => t.id === id)?.label ?? '';
}

// Tout id inconnu (valeur absente, corrompue, version future) retombe sur
// le fallback : un localStorage bricole ne doit jamais laisser la page sans
// data-theme valide, sinon theme.css ne s'applique plus.
export function normalizeThemeId(id) {
  return THEMES.some((t) => t.id === id) ? id : FALLBACK_THEME;
}

function resolveDeps(deps) {
  const d = deps || {};
  return {
    root: d.root ?? (typeof document !== 'undefined' ? document.documentElement : null),
    storage: d.storage ?? (typeof localStorage !== 'undefined' ? localStorage : null),
  };
}

// Point d'ecriture unique du theme. Les dependances sont injectees pour rester
// testable hors navigateur (node --test n'a ni document ni localStorage).
export function applyTheme(id, deps) {
  const { root, storage } = resolveDeps(deps);
  const normalized = normalizeThemeId(id);
  if (root) root.dataset.theme = normalized;
  if (storage) storage.setItem(THEME_KEY, normalized);
  return normalized;
}

// Lecture au demarrage : normalise et, si le stockage contenait une valeur
// invalide, la reecrit pour eviter de re-decouvrir la meme erreur a chaque
// lancement. Une absence de preference ne declenche aucune ecriture — on ne
// fabrique pas un choix que l'utilisateur n'a pas fait.
export function readStoredTheme(deps) {
  const { storage } = resolveDeps(deps);
  const stored = storage ? storage.getItem(THEME_KEY) : null;
  const normalized = normalizeThemeId(stored);
  if (storage && stored && stored !== normalized) storage.setItem(THEME_KEY, normalized);
  return normalized;
}

export function currentTheme() {
  const { root } = resolveDeps();
  return normalizeThemeId(root?.dataset?.theme);
}
