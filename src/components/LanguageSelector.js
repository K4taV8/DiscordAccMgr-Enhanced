import { LANGUAGES, getLanguage, setLanguage } from '../i18n/index.js';

const MARGIN = 8;
let open = null;

export function closeLanguageSelector() {
  open?.close();
}

function place(pop, anchor) {
  const rect = anchor.getBoundingClientRect();
  const width = pop.getBoundingClientRect().width;
  const height = pop.getBoundingClientRect().height;
  const left = Math.min(Math.max(MARGIN, rect.left), window.innerWidth - width - MARGIN);
  const top = rect.bottom + MARGIN + height <= window.innerHeight
    ? rect.bottom + MARGIN
    : Math.max(MARGIN, rect.top - height - MARGIN);
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

export function openLanguageSelector(anchor) {
  if (!anchor) return null;
  if (open?.anchor === anchor) { closeLanguageSelector(); return null; }
  closeLanguageSelector();

  const active = getLanguage();
  const pop = document.createElement('div');
  pop.className = 'theme-popover language-popover';
  pop.setAttribute('role', 'menu');
  pop.setAttribute('aria-label', 'Langue');
  pop.innerHTML = `
    <div class="theme-popover-header">
      <span class="theme-popover-title">Langue</span>
      <span class="theme-popover-now">${LANGUAGES.find((l) => l.id === active)?.label || ''}</span>
    </div>
    <div class="theme-grid language-grid">
      ${LANGUAGES.map((lang) => `
        <button type="button" class="theme-tile${lang.id === active ? ' is-active' : ''}"
                role="menuitemradio" aria-checked="${lang.id === active}" data-language="${lang.id}">
          <span class="language-tile-code">${lang.short}</span>
          <span class="theme-tile-label">${lang.label}</span>
        </button>`).join('')}
    </div>`;

  document.body.appendChild(pop);
  place(pop, anchor);

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
  };

  function onPointerDown(event) {
    if (pop.contains(event.target) || anchor.contains(event.target)) return;
    close();
  }
  function onKeyDown(event) {
    if (event.key !== 'Escape') return;
    close();
    anchor.focus();
  }
  const onResize = () => place(pop, anchor);

  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('resize', onResize);

  pop.addEventListener('click', (event) => {
    const tile = event.target.closest('[data-language]');
    if (!tile) return;
    setLanguage(tile.dataset.language);
    close();
  });

  anchor.setAttribute('aria-expanded', 'true');
  open = { anchor, close, element: pop };
  return { close, element: pop };
}

export function syncLanguageButtons() {
  const lang = getLanguage();
  const short = LANGUAGES.find((l) => l.id === lang)?.short || 'FR';
  const label = lang === 'en' ? 'Language' : 'Langue';
  for (const id of ['languageBtnLogin', 'languageBtnRail']) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    const code = btn.querySelector('.language-code');
    if (code) code.textContent = short;
    btn.title = label;
    btn.setAttribute('aria-label', label);
    if (btn.hasAttribute('data-tooltip')) btn.setAttribute('data-tooltip', label);
  }
}

export function bindLanguageButtons() {
  for (const id of ['languageBtnLogin', 'languageBtnRail']) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    btn.addEventListener('click', () => openLanguageSelector(btn));
  }
  syncLanguageButtons();
  window.addEventListener('languagechange', syncLanguageButtons);
}
