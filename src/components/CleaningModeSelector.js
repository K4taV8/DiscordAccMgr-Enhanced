// Sélecteur de mode de nettoyage — petit îlot vitré, 4 modes en rangée unique.
// Comportement : ouvert par un bouton d'ancrage, reste ouvert après choix
// (comparaison), fermeture clic extérieur / Échap / 2ᵉ clic sur l'ancre.

import { escHtml } from '../utils/emojiUtils.js';

const MODES = [
  { id: 'messages', label: 'Messages', iconClass: 'icon-trash', title: 'Supprimer uniquement les messages' },
  { id: 'reactions', label: 'Réactions', icon: '💥', title: 'Supprimer uniquement les réactions' },
  { id: 'both', label: 'Msg + Réac', icon: '📦', title: 'Supprimer messages et réactions, sans quitter' },
  { id: 'full', label: 'Tout + Quitter', icon: '⚡', title: 'Nettoyage complet : messages → réactions → quitter' },
];

const MARGIN = 8;
const BOTTOM_MARGIN = 28;

let open = null;

export function closeCleaningModeSelector() {
  open?.close();
}

// L'îlot se cale en bas, centré, AU-DESSUS de la barre d'action batch quand
// elle est visible : les deux occupent le même axe, sinon ils se chevauchent.
function place(pop) {
  const { width, height } = pop.getBoundingClientRect();
  const dock = document.querySelector('.selection-dock.show');
  const bottom = dock ? dock.getBoundingClientRect().height + BOTTOM_MARGIN : BOTTOM_MARGIN;
  const left = Math.max(MARGIN, (window.innerWidth - width) / 2);
  const top = Math.max(MARGIN, window.innerHeight - height - bottom);
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

export function openCleaningModeSelector(anchor, cfg = {}) {
  closeCleaningModeSelector();
  if (!anchor) return null;

  const pop = document.createElement('div');
  pop.className = 'theme-popover clean-mode-popover';
  pop.setAttribute('role', 'menu');
  pop.setAttribute('aria-label', 'Mode de nettoyage');

  pop.innerHTML = `
    <div class="theme-popover-header">
      <span class="theme-popover-title">Mode de nettoyage</span>
    </div>
    <div class="theme-grid">
      ${MODES.map(m => `
        <button type="button" class="theme-tile" role="menuitemradio" aria-checked="false" data-mode="${m.id}" title="${escHtml(m.title)}">
          <span class="theme-tile-icon">${m.iconClass ? `<span class="icon icon-24 ${m.iconClass}" aria-hidden="true"></span>` : escHtml(m.icon)}</span>
          <span class="theme-tile-label">${escHtml(m.label)}</span>
        </button>`).join('')}
    </div>`;

  document.body.appendChild(pop);
  place(pop);

  const close = () => {
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('resize', onResize);
    anchor.setAttribute('aria-expanded', 'false');
    pop.classList.add('is-closing');
    const done = () => pop.remove();
    pop.addEventListener('transitionend', done, { once: true });
    setTimeout(done, 220);
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

  const onResize = () => place(pop);

  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('resize', onResize);

  pop.addEventListener('click', (e) => {
    const tile = e.target.closest('.theme-tile');
    if (!tile) return;
    const mode = tile.dataset.mode;
    pop.querySelectorAll('.theme-tile').forEach(el => {
      const on = el.dataset.mode === mode;
      el.classList.toggle('is-active', on);
      el.setAttribute('aria-checked', String(on));
    });
    cfg.onSelect?.(mode);
  });

  anchor.setAttribute('aria-expanded', 'true');
  open = { anchor, close };
  cfg.onOpen?.();
  return { close, element: pop };
}