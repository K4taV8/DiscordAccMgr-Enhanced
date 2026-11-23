// i18n minimaliste, sans dépendance : le français reste la langue source du
// code, l'anglais est appliqué au DOM (texte + attributs) et aux chaînes
// dynamiques via des motifs. Aucun composant n'a besoin d'être réécrit.

import { EN_EXACT, EN_PATTERNS } from './en.js';

export const LANG_KEY = 'language';
export const FALLBACK_LANGUAGE = 'fr';
export const LANGUAGES = [
  { id: 'fr', label: 'Français', short: 'FR' },
  { id: 'en', label: 'English', short: 'EN' },
];

const TITLE_FR = 'Discord Account Manager - Enhanced';
const TITLE_EN = 'Discord Account Manager - Enhanced';

// Le contenu produit par l'utilisateur ou Discord ne doit jamais être traduit.
const SKIP_SELECTOR = [
  '[data-no-i18n]',
  'script', 'style', 'textarea', 'code', 'pre',
  '.bento-name', '.bento-meta',
  '.package-message-content', '.package-message-author',
  '.package-channel-name', '.package-channel-meta',
  '.package-channel-copy strong', '.package-conversation-title h3',
  '.package-message-meta strong', '.package-message-meta time',
  '.package-attachment-link', '.package-attachment-missing',
  '.package-file-name', '.package-lightbox-caption',
  '.profile-name', '.profile-username', '.profile-tag',
  '.info-author-copy strong',
  '.token-item .name',
  '.user-avatar', '.nav-avatar-box',
  '.server-name', '.group-name', '.dm-name',
  '.language-code', '.language-tile-code',
].join(',');

let current = FALLBACK_LANGUAGE;
let observer = null;
let translating = false;
let scheduled = false;

const textOriginals = new WeakMap();
const textApplied = new WeakMap();
const attrOriginals = new WeakMap();
const attrApplied = new WeakMap();

function storage() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

export function normalizeLanguage(id) {
  return id === 'en' ? 'en' : FALLBACK_LANGUAGE;
}

export function getLanguage() {
  return current;
}

export function translateToEnglish(value) {
  const text = String(value ?? '');
  if (!text) return text;
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  const core = m[2];
  if (!core.trim()) return text;
  const flat = core.replace(/\s+/g, ' ').trim();

  let translated = EN_EXACT[flat];
  if (translated === undefined) {
    for (const [pattern, replacement] of EN_PATTERNS) {
      if (pattern.test(flat)) { translated = flat.replace(pattern, replacement); break; }
    }
  }
  if (translated === undefined) return text;
  return `${m[1]}${translated}${m[3]}`;
}

export function translateText(value) {
  return current === 'en' ? translateToEnglish(value) : String(value ?? '');
}

function translateElementAttributes(element) {
  const attrs = ['placeholder', 'title', 'aria-label', 'data-tooltip'];
  let originals = attrOriginals.get(element);
  let applied = attrApplied.get(element);
  if (!originals) { originals = new Map(); attrOriginals.set(element, originals); }
  if (!applied) { applied = new Map(); attrApplied.set(element, applied); }

  for (const attr of attrs) {
    if (!element.hasAttribute(attr)) continue;
    const now = element.getAttribute(attr);
    if (!now || !now.trim()) continue;
    const last = applied.get(attr);
    const original = last !== undefined && now === last ? originals.get(attr) : now;
    originals.set(attr, original);
    const next = current === 'en' ? translateToEnglish(original) : original;
    if (next !== now) element.setAttribute(attr, next);
    applied.set(attr, next);
  }
}

export function translateDom(root) {
  if (typeof document === 'undefined' || !root) return;
  translating = true;
  try {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const parent = node.parentElement;
      if (parent && !parent.closest(SKIP_SELECTOR)) {
        const now = node.nodeValue || '';
        if (now.trim()) {
          const last = textApplied.get(node);
          const original = last !== undefined && now === last ? textOriginals.get(node) : now;
          textOriginals.set(node, original);
          const next = current === 'en' ? translateToEnglish(original) : original;
          if (next !== now) node.nodeValue = next;
          textApplied.set(node, next);
        }
      }
      node = walker.nextNode();
    }

    const elements = root.querySelectorAll ? root.querySelectorAll('[placeholder],[title],[aria-label],[data-tooltip]') : [];
    for (const element of elements) {
      if (!element.closest(SKIP_SELECTOR)) translateElementAttributes(element);
    }
  } finally {
    translating = false;
  }
}

function applyDocumentLanguage() {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = current;
  document.documentElement.dataset.language = current;
  document.title = current === 'en' ? TITLE_EN : TITLE_FR;
}

function scheduleTranslation() {
  if (scheduled || translating) return;
  scheduled = true;
  const run = () => {
    scheduled = false;
    if (!translating && typeof document !== 'undefined' && document.body) translateDom(document.body);
  };
  if (typeof queueMicrotask === 'function') queueMicrotask(run);
  else setTimeout(run, 0);
}

export function startDomTranslation() {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined' || observer) return;
  observer = new MutationObserver(() => {
    if (!translating) scheduleTranslation();
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['placeholder', 'title', 'aria-label', 'data-tooltip'],
  });
}

export function setLanguage(lang) {
  current = normalizeLanguage(lang);
  const store = storage();
  if (store) {
    try { store.setItem(LANG_KEY, current); } catch {}
  }
  applyDocumentLanguage();
  if (typeof document !== 'undefined') {
    translateDom(document.body);
    if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent('languagechange', { detail: current }));
    }
  }
  return current;
}

export function initLanguage() {
  const store = storage();
  const stored = store ? store.getItem(LANG_KEY) : null;
  current = normalizeLanguage(stored || FALLBACK_LANGUAGE);
  applyDocumentLanguage();
  if (typeof document !== 'undefined') {
    translateDom(document.body);
    startDomTranslation();
  }
  return current;
}

// Compatibilité pour les appelants futurs qui préfèrent une fonction courte.
export const t = translateText;
