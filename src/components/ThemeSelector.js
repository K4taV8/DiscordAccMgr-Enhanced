// Selecteur de theme flottant — popover ancre sur le bouton.
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
import { THEMES, applyTheme, currentTheme } from '../utils/theme.js';

const GAP = 8; // px entre l'ancre et le popover
const MARGIN = 8; // px de marge minimale contre les bords de la fenetre

let open = null; // { anchor, close } — une seule instance, comme le bouton

export function isThemeSelectorOpen(anchor) {
  return !!open && open.anchor === anchor;
}

export function closeThemeSelector() {
  open?.close();
}

// Ancre le popover au-dessus du bouton, puis le borne a la fenetre. Passe en
// dessous si la place manque au-dessus. Le redimensionnement repositionne tant
// que le menu est ouvert, sinon il deborderait apres un redimensionnement.
function place(pop, anchor) {
  const a = anchor.getBoundingClientRect();
  const { width, height } = pop.getBoundingClientRect();
  const maxLeft = window.innerWidth - width - MARGIN;
  const maxTop = window.innerHeight - height - MARGIN;

  let top = a.top - height - GAP;
  if (top < MARGIN) top = a.bottom + GAP;

  pop.style.left = `${Math.min(Math.max(MARGIN, a.left), Math.max(MARGIN, maxLeft))}px`;
  pop.style.top = `${Math.min(Math.max(MARGIN, top), Math.max(MARGIN, maxTop))}px`;
}

export function openThemeSelector(anchor, cfg = {}) {
  closeThemeSelector();
  if (!anchor) return null;

  const active = currentTheme();
  const pop = document.createElement('div');
  pop.className = 'theme-popover';
  pop.setAttribute('role', 'menu');
  pop.setAttribute('aria-label', 'Thème');
  pop.innerHTML = `<div class="theme-grid">
    ${THEMES.map((t) => `
      <button type="button" class="theme-tile${t.id === active ? ' is-active' : ''}"
        role="menuitemradio" aria-checked="${t.id === active}" data-theme-id="${escHtml(t.id)}">
        <span class="theme-tile-icon">${t.icon}</span>
        <span class="theme-tile-label">${escHtml(t.label)}</span>
      </button>`).join('')}
  </div>`;

  document.body.appendChild(pop);
  place(pop, anchor);

  const close = () => {
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('resize', onResize);
    anchor.setAttribute('aria-expanded', 'false');
    pop.remove();
    if (open?.close === close) open = null;
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

  const onResize = () => place(pop, anchor);

  // Capture : on gagne la course contre le focus, qui ne declenche pas de
  // click mais pourrait voler la selection a la fermeture.
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('resize', onResize);

  pop.addEventListener('click', (e) => {
    const tile = e.target.closest('.theme-tile');
    if (!tile) return;
    const applied = applyTheme(tile.dataset.themeId);
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
