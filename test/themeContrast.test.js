import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// --brand-text est la couleur de texte a poser SUR UN FOND DE MARQUE. Il vaut
// #0B0B0C en theme sombre et #ffffff en theme clair : pose sur une carte, il
// est invisible dans les deux cas. Ce controle est mecanique, il rattrape ce
// que la relecture ne voit pas : un compteur de progression est devenu noir sur
// gris, et seul un apercu l'a montre.
//
// Regle : tout bloc qui pose color: var(--brand-text) doit poser dans le meme
// bloc un background de marque (--brand), jamais --brand-dim ni rien.

const here = dirname(fileURLToPath(import.meta.url));
const appCss = readFileSync(join(here, '..', 'src', 'styles', 'app.css'), 'utf8');
const themeCss = readFileSync(join(here, '..', 'src', 'styles', 'theme.css'), 'utf8');

function rulesOf(css) {
  // Les commentaires doivent partir avant l analyse : sinon ils sont captures
  // dans le selecteur et aucun parent ne peut etre retrouve par son nom.
  const cleaned = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = re.exec(cleaned))) {
    const selector = match[1].trim().replace(/\s+/g, ' ');
    if (!selector || selector.startsWith('@') || selector.startsWith('from') || selector.startsWith('to ')) continue;
    out.push({ selector, body: match[2] });
  }
  return out;
}

test('brand-text n est employe que sur un fond de marque', () => {
  const rules = rulesOf(appCss);
  const solidBrand = body => /background(-color)?:\s*var\(--brand\)(?![-\w])/.test(body);
  const offenders = [];
  for (const { selector, body } of rules) {
    if (!/color:\s*var\(--brand-text\)/.test(body)) continue;
    if (solidBrand(body)) continue;
    // Un pseudo-element herite du fond de son parent : la coche de la case
    // n declare pas de fond, elle recoit celui de .all.
    const base = selector.replace(/::?[a-z-]+(\([^)]*\))?$/i, '').trim();
    if (base && base !== selector) {
      const parent = rules.find(rule => rule.selector === base);
      if (parent && solidBrand(parent.body)) continue;
    }
    offenders.push(selector);
  }
  assert.deepEqual(offenders, [], `brand-text pose sans fond de marque :\n  ${offenders.join('\n  ')}`);
});

test('brand-dim ne sert jamais de fond a brand-text', () => {
  const offenders = [];
  for (const { selector, body } of rulesOf(appCss)) {
    if (!/color:\s*var\(--brand-text\)/.test(body)) continue;
    if (!/background(-color)?:\s*var\(--brand-dim\)/.test(body)) continue;
    offenders.push(selector);
  }
  assert.deepEqual(offenders, [], `--brand-dim est translucide : le texte de marque y disparait\n  ${offenders.join('\n  ')}`);
});

test('les variables de contraste existent dans tous les themes', () => {
  const blocks = themeCss.split(/}\s*(?=[:\w[])/).filter(block => /--brand-text\s*:/.test(block));
  assert.ok(blocks.length >= 2, 'plusieurs themes sont declares');
  for (const block of blocks) {
    assert.match(block, /--text-primary\s*:/, 'chaque theme definit aussi text-primary');
    assert.match(block, /--bg-card\s*:/, 'chaque theme definit aussi bg-card');
  }
});

// Le panneau de progression et le toast etaient tous deux en bas a droite : le
// resume d une suppression se superposait au panneau qui venait de se remplir.
test('le toast et le panneau de progression ne se chevauchent pas', () => {
  const rules = rulesOf(appCss);
  const offset = selector => {
    const rule = rules.find(item => item.selector === selector);
    if (!rule) return null;
    const bottom = /bottom:\s*(\d+)px/.exec(rule.body);
    return bottom ? Number(bottom[1]) : null;
  };
  const toast = offset('.copy-notification');
  const panel = offset('.progress-panel');
  assert.ok(toast !== null, 'le toast est positionne en px');
  assert.ok(panel !== null, 'le panneau aussi');
  assert.ok(toast > panel, `le toast (${toast}px) doit etre au-dessus du panneau (${panel}px)`);
});

test('le toast peut afficher un resume long', () => {
  const rule = rulesOf(appCss).find(item => item.selector === '.copy-notification');
  assert.match(rule.body, /max-width/, 'il est borne pour ne pas deborder');
  assert.match(rule.body, /white-space:\s*normal/, 'le texte passe a la ligne');
});
test('le texte de la surface est lisible sur la surface', () => {
  const hex = value => {
    const match = /#([0-9a-f]{6})/i.exec(value);
    return match ? match[1] : null;
  };
  const luminance = rgb => {
    const channels = [0, 2, 4].map(index => parseInt(rgb.slice(index, index + 2), 16) / 255)
      .map(channel => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const ratio = (a, b) => {
    const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (light + 0.05) / (dark + 0.05);
  };

  const themes = themeCss.split(/(?=^:root)/m).filter(block => /--bg-card\s*:/.test(block) && /--brand-text\s*:/.test(block));
  assert.ok(themes.length >= 2, 'au moins deux themes');
  for (const theme of themes) {
    const card = hex(theme.match(/--bg-card:\s*([^;]+);/)?.[1] || '');
    const text = hex(theme.match(/--text-primary:\s*([^;]+);/)?.[1] || '');
    const brandText = hex(theme.match(/--brand-text:\s*([^;]+);/)?.[1] || '');
    if (!card || !text || !brandText) continue;
    const name = (theme.match(/--bg-card:\s*([^;]+);/)?.[1] || '').trim();
    assert.ok(ratio(text, card) >= 4.5, `text-primary sur bg-card (${name}) : ${ratio(text, card).toFixed(2)}:1`);
    // C est exactement le piege : brand-text sur la carte, pas sur la marque.
    const brand = hex(theme.match(/--brand:\s*([^;]+);/)?.[1] || '');
    if (brand) assert.ok(ratio(brandText, brand) >= 4.5, `brand-text sur la marque (${name}) : ${ratio(brandText, brand).toFixed(2)}:1`);
  }
});