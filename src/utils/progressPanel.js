// Panneau flottant de progression pour les operations longues.
//
// Le nettoyage de plusieurs DM respecte le debit de Discord : sans retour a
// l ecran, l utilisateur concluait que l application ne faisait rien. Les
// panneaux existants etaient un journal de debogage, pas un suivi d operation.
//
// L etat est rendu par une fonction pure (progressPanelHtml) pour rester
// testable hors DOM, et applique par-dessus.

let current = null;

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function progressPanelHtml({ title, detail = '', done = 0, total = 0, state = 'running' }) {
  const safeTotal = Math.max(0, Number(total) || 0);
  const safeDone = Math.max(0, Math.min(Number(done) || 0, safeTotal || Number(done) || 0));
  const percent = safeTotal > 0 ? Math.min(100, Math.round((safeDone / safeTotal) * 100)) : 0;
  const counter = safeTotal > 0 ? `${safeDone} / ${safeTotal}` : `${safeDone}`;
  const cls = state === 'done' ? ' is-done' : state === 'failed' ? ' is-failed' : '';

  return `<div class="progress-panel-head"><span class="progress-panel-title">${esc(title)}</span><button type="button" class="progress-panel-close" data-progress-close aria-label="Masquer">✕</button></div>
    <div class="progress-panel-body${cls}">
      <div class="progress-panel-count">${esc(counter)}</div>
      <div class="progress-panel-track"><span class="progress-panel-fill" style="width:${percent}%"></span></div>
      ${detail ? `<div class="progress-panel-detail">${esc(detail)}</div>` : ''}
    </div>`;
}

export function showProgressPanel({ title, detail = '', total = 0 } = {}) {
  closeProgressPanel();
  const state = { title, detail, done: 0, total, status: 'running', element: null };
  if (typeof document === 'undefined') return state;

  const panel = document.createElement('div');
  panel.className = 'progress-panel';
  panel.innerHTML = progressPanelHtml(state);
  panel.addEventListener('click', event => {
    if (event.target.closest('[data-progress-close]')) closeProgressPanel();
  });
  document.body.appendChild(panel);
  state.element = panel;
  current = state;
  return state;
}

function paint(state, status, done, total, detail) {
  if (status) state.status = status;
  if (done !== undefined && done !== null) state.done = done;
  if (total !== undefined && total !== null) state.total = total;
  if (detail !== undefined && detail !== null) state.detail = detail;
  if (state.element) state.element.innerHTML = progressPanelHtml(state);
}

export function updateProgressPanel({ done, total, detail }) {
  if (!current) return;
  paint(current, 'running', done, total, detail);
}

export function finishProgressPanel({ detail, autoClose = 6000, status = 'done' } = {}) {
  if (!current) return;
  paint(current, status, current.done, current.total, detail);
  const finished = current;
  if (typeof setTimeout === 'function' && autoClose > 0) setTimeout(() => { if (current === finished) closeProgressPanel(); }, autoClose);
}

export function closeProgressPanel() {
  if (!current) return;
  current.element?.remove();
  current = null;
}

export function isProgressPanelOpen() {
  return Boolean(current);
}