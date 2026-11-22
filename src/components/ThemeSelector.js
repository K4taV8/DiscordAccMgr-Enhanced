// Selecteur de theme flottant — petit ilot vitre, centre en bas de la fenetre.
//
// Le menu NE se ferme pas au choix d'un theme : on selectionne pour comparer,
// pas pour s'en aller. Il se ferme sur clic dehors, Echap, ou second clic sur
// le bouton.
//
// Mots differents de HelpModal.js : celui-la pose un `.modal-overlay` en
// `position: fixed; inset: 0` et ferme sur `e.target === overlay`. Ca ne peut
// pas etre reutilise tel quel : un popover de ~200 px ne couvre pas la fenetre,
// donc `e.target` ne sera jamais l'overlay. D'ou le `pointerdown` en phase
// capture ci-dessous, avec exclusion explicite du bouton et du popover.
//
// Le contenu n'est jamais reconstruit a partir d'une liste en dur : les tuiles
// viennent de THEMES, donc ajouter un theme n'exige rien d'autre qu'une entree
// de plus dans le registre.

import { escHtml } from '../utils/emojiUtils.js';
import { THEMES, applyTheme, currentTheme, themeLabel } from '../utils/theme.js';

// Ordre d'affichage voulu pour la rangée unique : Light, Dark, Discord, Mono.
const DISPLAY_ORDER = ['light', 'dark', 'discord', 'mono', 'oled-lavender', 'oled-mono'];
const MARGIN = 8; // px de marge minimale contre les bords de la fenetre
const BOTTOM_MARGIN = 28; // px entre le bas de l'ilot et le bas de la fenetre

let open = null; // { anchor, close } — une seule instance, comme le bouton

export function isThemeSelectorOpen(anchor) {
  return !!open && open.anchor === anchor;
}

export function closeThemeSelector() {
  open?.close();
}

// Cale l'ilot en bas de la fenetre, centre horizontalement, au-dessus de la
// barre d'action batch si elle est visible (meme axe, sinon chevauchement).
// Le redimensionnement repositionne tant que le menu est ouvert.
function place(pop) {
  const { width, height } = pop.getBoundingClientRect();
  const dock = document.querySelector('.selection-dock.show');
  const bottom = dock ? dock.getBoundingClientRect().height + BOTTOM_MARGIN : BOTTOM_MARGIN;
  const left = Math.max(MARGIN, (window.innerWidth - width) / 2);
  const top = Math.max(MARGIN, window.innerHeight - height - bottom);
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

export function openThemeSelector(anchor, cfg = {}) {
  closeThemeSelector();
  if (!anchor) return null;

  const active = currentTheme();
  const pop = document.createElement('div');
  pop.className = 'theme-popover';
  pop.setAttribute('role', 'menu');
  pop.setAttribute('aria-label', 'Thème');
  const ordered = [...THEMES].sort((a, b) => DISPLAY_ORDER.indexOf(a.id) - DISPLAY_ORDER.indexOf(b.id));
  pop.innerHTML = `<div class="theme-popover-header">
    <span class="theme-popover-title">Thème</span>
    <span class="theme-popover-now">${escHtml(themeLabel(active))}</span>
  </div>
  <div class="theme-grid">
    ${ordered.map((t) => `
      <button type="button" class="theme-tile${t.id === active ? ' is-active' : ''}"
        role="menuitemradio" aria-checked="${t.id === active}" data-theme-id="${escHtml(t.id)}">
        <span class="theme-tile-icon">${t.icon}</span>
        <span class="theme-tile-label">${escHtml(t.label)}</span>
      </button>`).join('')}
  </div>`;

  document.body.appendChild(pop);
  place(pop);

  const close = () => {
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('resize', onResize);
    anchor.setAttribute('aria-expanded', 'false');
    if (open?.close === close) open = null;
    // Sortie : micro fade-out avant retrait du noeud (une passe aussi, même
    // pas de garde reduced-motion). Le noeud vit encore ~200 ms : inerte,
    // tous ses listeners sont déjà retirés. transitionend retire d'abord, le
    // setTimeout ne sert que de filet si la transition ne démarre pas.
    pop.classList.add('is-closing');
    const done = () => pop.remove();
    pop.addEventListener('transitionend', done, { once: true });
    setTimeout(done, 220);
    cfg.onClose?.();
  };

  function onPointerDown(e) {
    if (pop.contains(e.target) || anchor.contains(e.target)) return;
    close();
  }

  function onKeyDown(e) {
    if (e.key !== 'Escape') return;
    close();
    anchor.focus();
  }

  const onResize = () => place(pop);

  // Capture : on gagne la course contre le focus, qui ne declenche pas de
  // click mais pourrait voler la selection a la fermeture.
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('resize', onResize);

  pop.addEventListener('click', (e) => {
    const tile = e.target.closest('.theme-tile');
    if (!tile) return;
    const applied = applyTheme(tile.dataset.themeId);
    // L'en-tête suit la sélection : le mini-texte à droite du titre reflète le
    // thème courant tant que l'îlot reste ouvert (on compare sans fermer).
    const now = pop.querySelector('.theme-popover-now');
    if (now) now.textContent = themeLabel(applied);
    // Un seul theme actif : on decoche les autres tuiles.
    let active = null;
    pop.querySelectorAll('.theme-tile').forEach((el) => {
      const on = el.dataset.themeId === applied;
      el.classList.toggle('is-active', on);
      el.setAttribute('aria-checked', String(on));
      if (on) active = el;
    });
    // Le menu reste OUVERT : on choisit un theme pour le comparer, pas pour
    // partir. Fermeture par clic dehors, Echap, ou un second clic sur le
    // bouton. Le focus suit la tuile active pour que le clavier reste pilotable.
    active?.focus();
    cfg.onSelect?.(applied);
  });

  anchor.setAttribute('aria-expanded', 'true');
  open = { anchor, close };
  cfg.onOpen?.();
  return { close, element: pop };
}

export function toggleThemeSelector(anchor, cfg = {}) {
  if (isThemeSelectorOpen(anchor)) {
    closeThemeSelector();
    return null;
  }
  return openThemeSelector(anchor, cfg);
}
