// Verrou de style : le rayon global est « carré et saillant » (10 px).
// Les CTA ne doivent jamais redevenir des pilules (999px / 9999px / 50%).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const THEME = readFileSync(new URL('../src/styles/theme.css', import.meta.url), 'utf8');
const APP = readFileSync(new URL('../src/styles/app.css', import.meta.url), 'utf8');

const TOKENS = ['--radius-sm', '--radius-md', '--radius-lg', '--radius-xl', '--radius-item', '--radius-bento'];

test('le token --radius-sharp vaut 10px et alimente les tokens de rayon', () => {
  assert.match(THEME, /--radius-sharp:\s*10px\s*;/, '--radius-sharp doit valoir 10px');
  for (const token of TOKENS) {
    assert.match(
      THEME,
      new RegExp(`${token}:\\s*var\\(--radius-sharp\\)\\s*;`),
      `${token} doit pointer vers --radius-sharp`
    );
  }
  assert.match(THEME, /--radius-pill:\s*999px\s*;/, '--radius-pill reste réservé aux pastilles');
});

function blocs(css) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    out.push({
      selector: m[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim(),
      body: m[2],
    });
  }
  return out;
}

const CTA_RE = /(?:^|[\s,>+~])\.(?:btn(?:-[\w-]+)?|theme-tile|foot-btn|package-menu-item|package-filter-chip|package-link-btn|package-lightbox-save|package-row-action|package-channel-open|package-lightbox-nav|progress-panel-close|dl-btn)(?=$|[\s,.:#[\]>+~])/;

function estCta(selector) {
  return selector.split(',').some(part => CTA_RE.test(part.trim())) || /(?:^|,\s*)\.info-links a(?:\s*,|$)/.test(selector);
}

test('aucun CTA ne redevient une pilule', () => {
  const tous = [...blocs(THEME), ...blocs(APP)];
  const problemes = [];
  for (const bloc of tous) {
    if (!estCta(bloc.selector)) continue;
    const m = /border-radius\s*:\s*([^;]+);/.exec(bloc.body);
    if (!m) continue;
    const valeur = m[1].trim();
    if (/9999?px|50%|var\(--radius-pill\)|var\(--radius-full\)/i.test(valeur)) {
      problemes.push(`${bloc.selector} => ${valeur}`);
    }
  }
  assert.deepEqual(problemes, [], `CTA en pilule détecté(s) :\n${problemes.join('\n')}`);
});

test('les CTA qui déclarent un rayon utilisent --radius-sharp (ou un token qui y mène)', () => {
  const autorise = /^var\(--radius-(?:sharp|sm|md|lg|xl|item|bento)\)$/;
  const tous = [...blocs(THEME), ...blocs(APP)];
  const problemes = [];
  for (const bloc of tous) {
    if (!estCta(bloc.selector)) continue;
    const m = /border-radius\s*:\s*([^;]+);/.exec(bloc.body);
    if (!m) continue;
    const valeur = m[1].trim();
    if (!autorise.test(valeur)) problemes.push(`${bloc.selector} => ${valeur}`);
  }
  assert.deepEqual(problemes, [], `Rayon de CTA non tokenisé :\n${problemes.join('\n')}`);
});
