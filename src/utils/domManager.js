// BUG-08 : préserver le scroll après un refresh de liste (le scroll vit sur le .page-container)
import { LIST_CACHE_TTL } from './pagePreloader.js';
export function preservePageScroll(contentArea, render) {
  const scroller = contentArea.closest('.page-container') || contentArea;
  const top = scroller.scrollTop;
  const html = render();
  contentArea.innerHTML = html;
  scroller.scrollTop = top;
}

// Cache liste : navigation instantanée, refetch après 30s ; force=true après une mutation
export async function cachedListRefresh(self, fetchFn, renderFn, force = false, ttl = LIST_CACHE_TTL) {
  if (!force && self._cache && Date.now() - self._cache.at < ttl) {
    renderFn(self._cache.data);
    return;
  }
  const data = await fetchFn();
  self._cache = { data, at: Date.now() };
  renderFn(data);
}

// Update token list with icons
export function updateTokensList(tokens, handlers) {
  const tokenManagement = document.getElementById('tokenManagement');
  if (!tokenManagement) return;

  if (tokens.length === 0) {
    tokenManagement.innerHTML = '';
    return;
  }

  const tokenElements = tokens.map(t => {
    const div = document.createElement('div');
    div.className = 'token-item';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'name';
    nameSpan.textContent = t.corrupt ? `${t.name} (corrupted)` : t.name;
    if (t.corrupt) nameSpan.title = 'This token cannot be decrypted. Delete it and re-add it.';

    const buttonGroup = document.createElement('div');
    buttonGroup.className = 'button-group';

    const useBtn = document.createElement('button');
    useBtn.className = 'btn btn-secondary';
    useBtn.innerHTML = `
      Use
    `;
    useBtn.disabled = !!t.corrupt;
    useBtn.addEventListener('click', () => handlers.useToken(t.name));

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn-icon-danger';
    deleteBtn.title = 'Delete';
    deleteBtn.innerHTML = '<svg width="22" height="22" fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M17 6V4c0-1.1-.9-2-2-2H9c-1.1 0-2 .9-2 2v2H2v2h2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8h2V6zM9 4h6v2H9zM6 20V8h12v12z"></path><path d="M9 10h2v8H9zm4 0h2v8h-2z"></path></svg>';
    deleteBtn.addEventListener('click', () => handlers.deleteToken(t.name));

    buttonGroup.appendChild(useBtn);
    buttonGroup.appendChild(deleteBtn);

    div.appendChild(nameSpan);
    div.appendChild(buttonGroup);

    return div;
  });

  tokenManagement.innerHTML = '';
  tokenElements.forEach(el => tokenManagement.appendChild(el));
}

// --- CSP (R03b) : délégation d'événements — remplace les handlers inline ---
// Installe UN listener de clic + UN listener de change sur `container` et route
// les éléments `[data-action]` vers handlers[action](el, event). `el` est
// l'élément `[data-action]` (le bouton) — pratique pour le désactiver pendant
// une opération longue.
export function delegate(container, handlers) {
  const dispatch = (e) => {
    const el = e.target.closest('[data-action]');
    if (!el || !container.contains(el)) return;
    // Les checkboxes sont pilotées par `change` (sinon double-feu click+change).
    if (e.type === 'click' && el.matches('input[type="checkbox"]')) return;
    const fn = handlers[el.dataset.action];
    if (fn) fn(el, e);
  };
  container.addEventListener('click', dispatch);
  container.addEventListener('change', dispatch);
}

// Fallback des avatars : l'événement `error` des <img> ne remonte pas, il faut
// une capture globale. `data-fallback` → remplace la src ; `data-hide-on-error`
// → masque l'image cassée. Installée une seule fois (idempotent).
let avatarFallbackInstalled = false;
export function installAvatarFallbacks() {
  if (avatarFallbackInstalled) return;
  avatarFallbackInstalled = true;
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement)) return;
    if (img.dataset.fallback) {
      const fb = img.dataset.fallback;
      delete img.dataset.fallback; // évite une boucle si le fallback échoue aussi
      img.src = fb;
    } else if ('hideOnError' in img.dataset) {
      img.style.display = 'none';
    }
  }, true);
}