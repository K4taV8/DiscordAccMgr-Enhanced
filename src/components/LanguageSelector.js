import { LANGUAGES, getLanguage, setLanguage } from '../i18n/index.js';

// Bascule directe FR ↔ EN : plus de menu intermédiaire. L'appelant reçoit la
// nouvelle langue, ce qui rend le comportement testable sans DOM.
export function toggleLanguage() {
  const next = getLanguage() === 'en' ? 'fr' : 'en';
  setLanguage(next);
  return next;
}

// Met à jour le code affiché sur la pastille et le libellé d'action des deux
// contrôles. L'action décrit la langue vers laquelle le clic va basculer.
export function syncLanguageButtons() {
  const lang = getLanguage();
  const short = LANGUAGES.find((l) => l.id === lang)?.short || 'FR';
  const action = lang === 'en' ? 'Switch to French' : 'Passer en anglais';
  for (const id of ['languageBtnLogin', 'languageBtnRail']) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    const code = btn.querySelector('.language-code');
    if (code) code.textContent = short;
    btn.title = action;
    btn.setAttribute('aria-label', action);
    if (btn.hasAttribute('data-tooltip')) btn.setAttribute('data-tooltip', action);
  }
}

export function bindLanguageButtons() {
  for (const id of ['languageBtnLogin', 'languageBtnRail']) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    btn.addEventListener('click', toggleLanguage);
  }
  syncLanguageButtons();
  window.addEventListener('languagechange', syncLanguageButtons);
}
