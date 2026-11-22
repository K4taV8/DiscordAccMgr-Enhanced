// Stack technique de la modale Info : lignes icône + nom + rôle.
// Module pur pour rester testable hors DOM.

const stroke = (inner) =>
  `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${inner}</svg>`;

const ICONS = {
  electron: stroke('<circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none"/><ellipse cx="12" cy="12" rx="9" ry="3.6"/><ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(120 12 12)"/>'),
  node: stroke('<path d="M12 2.6 20.5 7.2v9.6L12 21.4 3.5 16.8V7.2Z"/><path d="M9 9.5v5l3 1.8 3-1.8v-5"/>'),
  js: `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="3.5" y="3.5" width="17" height="17" rx="3" fill="none" stroke="currentColor" stroke-width="1.6"/><text x="12" y="15.5" text-anchor="middle" font-size="8" font-weight="700" font-family="Arial, sans-serif" fill="currentColor">JS</text></svg>`,
  ts: `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="3.5" y="3.5" width="17" height="17" rx="3" fill="none" stroke="currentColor" stroke-width="1.6"/><text x="12" y="15.5" text-anchor="middle" font-size="8" font-weight="700" font-family="Arial, sans-serif" fill="currentColor">TS</text></svg>`,
  discord: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><path d="M14.82 4.26a10 10 0 0 0-.53 1.1 14.7 14.7 0 0 0-4.58 0 10 10 0 0 0-.53-1.1 16 16 0 0 0-4.13 1.3 17.33 17.33 0 0 0-3 11.59 16.6 16.6 0 0 0 5.07 2.59A13 13 0 0 0 8.23 18a9.7 9.7 0 0 1-1.71-.83 3.4 3.4 0 0 0 .42-.33 11.66 11.66 0 0 0 10.12 0q.21.18.42.33a11 11 0 0 1-1.71.84 12.4 12.4 0 0 0 1.08 1.78 16.4 16.4 0 0 0 5.06-2.59 17.22 17.22 0 0 0-3-11.59 16 16 0 0 0-4.09-1.35M8.68 14.81a1.94 1.94 0 0 1-1.8-2 1.93 1.93 0 0 1 1.8-2 1.93 1.93 0 0 1 1.8 2 1.93 1.93 0 0 1-1.8 2m6.64 0a1.94 1.94 0 0 1-1.8-2 1.93 1.93 0 0 1 1.8-2 1.92 1.92 0 0 1 1.8 2 1.92 1.92 0 0 1-1.8 2"/></svg>`,
  api: stroke('<path d="M9 7V3M15 7V3M6 7h12v4a6 6 0 0 1-12 0Z"/><path d="M12 17v4"/>'),
  html: stroke('<path d="M8 8 4 12l4 4M16 8l4 4-4 4"/>'),
  axios: stroke('<path d="M4 8h13l-3-3M20 16H7l3 3"/>'),
  zip: stroke('<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M12 3v7M10 6h4M10 9h4"/>'),
  builder: stroke('<path d="M4 8 12 4l8 4v8l-8 4-8-4z"/><path d="M4 8l8 4 8-4M12 12v8"/>'),
  test: stroke('<path d="M9 4h6M10 4v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V4"/><path d="M8 15h8"/>'),
};

export const TECH_ITEMS = [
  { id: 'electron', label: 'Electron', role: 'Runtime desktop' },
  { id: 'node', label: 'Node.js', role: 'Processus principal' },
  { id: 'js', label: 'JavaScript', role: 'Renderer & main' },
  { id: 'ts', label: 'TypeScript', role: 'Types & contrats' },
  { id: 'discord', label: 'discord.js-selfbot-v13', role: 'Client Discord', wide: true },
  { id: 'api', label: 'Discord API v9', role: 'REST + Gateway' },
  { id: 'html', label: 'HTML/CSS', role: 'Interface sans framework' },
  { id: 'axios', label: 'axios', role: 'HTTP contrôlé' },
  { id: 'zip', label: 'fflate', role: 'Archives ZIP' },
  { id: 'builder', label: 'electron-builder', role: 'Packaging Windows' },
  { id: 'test', label: 'node:test', role: 'Tests automatisés' },
];

export function techStackHtml() {
  const items = TECH_ITEMS.map((item) => `
    <div class="info-tech-item${item.wide ? ' is-wide' : ''}" title="${item.role}">
      <span class="info-tech-icon" aria-hidden="true">${ICONS[item.id]}</span>
      <span class="info-tech-copy"><strong>${item.label}</strong><small>${item.role}</small></span>
    </div>`).join('');
  return `<div class="info-tech-grid">${items}</div>`;
}
