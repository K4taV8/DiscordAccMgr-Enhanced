import { escHtml } from '../utils/emojiUtils.js';

// Icônes inline (stroke currentColor) pour les toolbars / menus.
export const icons = {
  grid: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
  list: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1" fill="currentColor"/><circle cx="4" cy="12" r="1" fill="currentColor"/><circle cx="4" cy="18" r="1" fill="currentColor"/></svg>',
};

// Toggle de vue Grid/List — un seul DOM, bascule CSS. État persisté par page.
export const listView = {
  isOn: (name) => localStorage.getItem(`bento:${name}`) === 'list',
  button: (name) =>
    `<button class="btn btn-ghost view-toggle" data-action="toggleView" title="Toggle view" aria-label="Toggle view">${listView.isOn(name) ? icons.grid : icons.list}</button>`,
  toggle: (listEl, name, btn) => {
    const on = listEl.classList.toggle('list-view');
    localStorage.setItem(`bento:${name}`, on ? 'list' : 'grid');
    if (btn) btn.innerHTML = on ? icons.grid : icons.list;
    return on;
  },
};

// BentoCard — rendu HTML d'une carte de grille. Fonction pure.
// cfg: { id, name, meta, icon, fallbackIcon, iconAlt, checkboxClass,
//        badge: {label,className}|null, attrs,
//        quick: [{action,label,emoji,theme,attrs}] }  // boutons texte, tous visibles
// theme: 'danger' | 'amber' | 'crimson' | undefined (slate neutre).
// HeaderBar = cercle de sélection (gauche) + badge statut (droite) ;
// l'avatar est libre de toute superposition ; pied = grille 2x2.
export function bentoCard(cfg) {
  const badge = cfg.badge
    ? `<span class="bento-badge${cfg.badge.className ? ' ' + cfg.badge.className : ''}">${escHtml(cfg.badge.label)}</span>`
    : '';
  const head = `<div class="bento-head">
        <input type="checkbox" class="${cfg.checkboxClass}" data-action="updateSelected" aria-label="Select">
        ${badge}
      </div>`;
  const foot = cfg.quick?.length
    ? `<div class="bento-foot">${cfg.quick.map(q => `
        <button type="button" class="foot-btn${q.theme ? ' ' + q.theme : ''}" data-action="${q.action}"${q.attrs || ''}>${q.emoji ? q.emoji + ' ' : ''}${escHtml(q.label)}</button>`).join('')}</div>`
    : '';
  return `
    <div class="bento-card" data-id="${escHtml(cfg.id)}"${cfg.attrs || ''}>
      ${head}
      <div class="bento-body">
        <div class="bento-avatar">
          ${cfg.avatarHtml || `<img src="${escHtml(cfg.icon)}" alt="${escHtml(cfg.iconAlt || cfg.name)}" loading="lazy"${cfg.fallbackIcon ? ` data-fallback="${escHtml(cfg.fallbackIcon)}"` : ''}>`}
        </div>
        <div class="bento-ident">
          <div class="bento-name-row">
            <span class="bento-name" title="${escHtml(cfg.name)}">${escHtml(cfg.name)}</span>
            <button type="button" class="id-badge" data-action="copy" title="Copy ID" aria-label="Copy ID">ID</button>
          </div>
          ${cfg.meta ? `<div class="bento-meta">${escHtml(cfg.meta)}</div>` : ''}
        </div>
      </div>
      ${foot}
    </div>`;
}

// FloatingSelectionDock — barre d'action batch, fixée en haut (sous l'en-tête).
// cfg: { onSelectAll: fn, onDeselectAll: fn, actions: [{label, tip, className, onClick}] }
// -- Recherche de liste (Friends / DMs / Servers) -----------------------------
// Normalisation : minuscules + accents retires, pour une recherche tolerante
// (« emile » trouve « Émile »).
export function normalizeSearch(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

// Champ de recherche d'une liste. `name` est la cle (data-list-search) ; `value`
// est re-injectee apres un rendu pour que le filtre survive aux refresh.
export function listSearchHtml(name, value = '') {
  return `<input type="search" class="list-search" data-list-search="${escHtml(name)}" value="${escHtml(value)}" placeholder="Rechercher…" aria-label="Rechercher dans la liste" spellcheck="false">`;
}

// Masque les cartes dont le nom (ou la ligne meta) ne contient pas `query`.
// Renvoie le nombre de cartes VISIBLES. Aucun acces reseau : on ne touche qu'a
// une classe CSS, donc le filtrage est instantane.
export function filterBentoCards(listEl, query) {
  if (!listEl) return 0;
  const q = normalizeSearch(query).trim();
  let shown = 0;
  for (const card of listEl.querySelectorAll('.bento-card')) {
    const texte = normalizeSearch(
      `${card.querySelector('.bento-name')?.textContent || ''} ${card.querySelector('.bento-meta')?.textContent || ''}`
    );
    const match = !q || texte.includes(q);
    card.classList.toggle('search-hidden', !match);
    if (match) shown += 1;
  }
  return shown;
}

// Applique le filtre a une liste et met a jour le badge de compte (X / N) et
// l'etat vide. Renvoie le nombre de cartes visibles.
export function applyListSearch({ listEl, countEl, emptyEl, query, total }) {
  const shown = filterBentoCards(listEl, query);
  const q = String(query || '').trim();
  if (countEl) countEl.textContent = q ? `${shown} / ${total}` : String(total);
  if (emptyEl) {
    const vide = q.length > 0 && shown === 0;
    emptyEl.hidden = !vide;
    if (vide) emptyEl.textContent = `Aucun résultat pour « ${q} »`;
  }
  return shown;
}

// Applique la recherche a la page de liste d'un manager (selecteurs communs).
export function applySearchTo(contentArea, query, total) {
  return applyListSearch({
    listEl: contentArea.querySelector('.bento-grid'),
    countEl: contentArea.querySelector('.list-count'),
    emptyEl: contentArea.querySelector('[data-list-empty]'),
    query,
    total,
  });
}

// Câble la recherche d'une liste : mémorise la requête sur `self.searchQuery`
// (survit aux refresh) et ré-applique le filtre. `apply` est la méthode du
// manager (elle connaît sa liste). Échap vide le champ.
export function bindListSearch(container, self, apply) {
  container.addEventListener('input', (event) => {
    if (!event.target?.matches?.('[data-list-search]')) return;
    self.searchQuery = event.target.value;
    apply();
  });
  container.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !event.target?.matches?.('[data-list-search]')) return;
    event.target.value = '';
    self.searchQuery = '';
    apply();
  });
}

// Coche UNIQUEMENT les cartes visibles (le filtrage actif ecarte les autres) et
// décoche les cachées, pour que « Tout cocher » corresponde à ce qui est affiché.
export function checkVisibleBoxes(contentArea, checkboxSelector) {
  contentArea.querySelectorAll(checkboxSelector).forEach(cb => {
    cb.checked = !cb.closest('.bento-card')?.classList.contains('search-hidden');
  });
}

export class FloatingSelectionDock {
  constructor(cfg) {
    this.cfg = cfg;
    this.el = null;
    this.countEl = null;
    this.selectAllBtn = null;
  }

  ensure() {
    if (this.el) return;
    const el = document.createElement('div');
    el.className = 'selection-dock';
    el.innerHTML = `
      <div class="dock-left">
        <span class="dock-count"><strong class="dock-count-num">0</strong> <span class="dock-count-label">sélectionné(s)</span></span>
        <button class="btn btn-secondary btn-xs dock-btn dock-select-all" data-tip="Sélectionner tous les éléments de la liste affichée">Tout sélectionner</button>
        <button class="btn btn-secondary btn-xs dock-btn dock-deselect-all" data-tip="Vider la sélection">Tout désélectionner</button>
      </div>
      <div class="dock-right">
        ${this.cfg.actions.map(a => `<button class="btn ${a.className || 'btn-secondary'} btn-xs dock-btn" data-i="${a.label}"${a.tip ? ` data-tip="${escHtml(a.tip)}"` : ''}>${escHtml(a.label)}${a.menu ? ' ▾' : ''}</button>`).join('')}
      </div>
    `;
    el.querySelectorAll('.dock-btn[data-i]').forEach((btn, i) => {
      btn.addEventListener('click', () => this.cfg.actions[i].onClick(btn));
    });
    this.selectAllBtn = el.querySelector('.dock-select-all');
    this.selectAllBtn.addEventListener('click', () => this.cfg.onSelectAll());
    this.deselectAllBtn = el.querySelector('.dock-deselect-all');
    this.deselectAllBtn.addEventListener('click', () => this.cfg.onDeselectAll());
    this.countEl = el.querySelector('.dock-count-num');
    document.body.appendChild(el);
    this.el = el;
  }

  // selected / total depuis la liste active ; dock masqué si sélection vide.
  sync(selected, total) {
    this.ensure();
    this.el.classList.toggle('show', selected > 0);
    this.countEl.textContent = selected;
  }

  hide() {
    this.ensure();
    this.el.classList.remove('show');
  }
}
