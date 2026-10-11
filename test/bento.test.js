import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bentoCard, normalizeSearch, listSearchHtml, filterBentoCards, applyListSearch } from '../src/components/bento.js';

test('bentoCard renders all actions directly with emoji + theme', () => {
  const html = bentoCard({
    id: '123',
    name: 'CaffeineMC',
    meta: '@caf',
    icon: 'https://cdn.discordapp.com/x.png',
    fallbackIcon: '/discord.png',
    checkboxClass: 'server-checkbox',
    badge: { label: 'Owner', className: 'is-owner' },
    quick: [
      { action: 'mute', label: 'Mute', emoji: '🔕' },
      { action: 'deleteMessages', label: 'Delete Msgs', theme: 'danger', emoji: '🗑️' },
      { action: 'removeReactions', label: 'Rm Reactions', theme: 'amber', emoji: '💥' },
      { action: 'leave', label: 'Leave', theme: 'crimson', emoji: '🚪' },
    ],
  });
  assert.ok(html.includes('class="bento-card"'));
  assert.ok(html.includes('data-id="123"'));
  assert.ok(html.includes('class="server-checkbox" data-action="updateSelected"'));
  assert.ok(html.includes('bento-badge is-owner'));
  assert.ok(html.includes('data-fallback="/discord.png"'));
  assert.ok(html.includes('class="bento-foot"'));
  // 4 actions visibles directement, avec emoji et thème.
  assert.ok(html.includes('class="foot-btn" data-action="mute">🔕 Mute'));
  assert.ok(html.includes('class="foot-btn danger" data-action="deleteMessages">🗑️ Delete Msgs'));
  assert.ok(html.includes('class="foot-btn amber" data-action="removeReactions">💥 Rm Reactions'));
  assert.ok(html.includes('class="foot-btn crimson" data-action="leave">🚪 Leave'));
});

test('bentoCard keeps the selection circle in its own header zone', () => {
  const html = bentoCard({ id: '1', name: 'x', icon: 'i', checkboxClass: 'c' });
  // La checkbox vit dans la HeaderBar (avant le body), jamais sur l'avatar.
  const head = html.slice(0, html.indexOf('bento-body'));
  assert.ok(head.includes('type="checkbox"'));
  const body = html.slice(html.indexOf('bento-body'), html.indexOf('bento-ident'));
  assert.ok(body.includes('class="bento-avatar"'));
  assert.ok(body.includes('<img'));
  assert.ok(!body.includes('type="checkbox"'));
});

test('bentoCard uses custom avatarHtml when provided (group stack)', () => {
  const html = bentoCard({
    id: '1',
    name: 'g',
    icon: null,
    checkboxClass: 'c',
    avatarHtml: '<span class="group-avatar-stack"><img src="a1"><img src="a2"></span>',
  });
  const avatarBlock = html.slice(html.indexOf('bento-avatar'), html.indexOf('bento-ident'));
  assert.ok(avatarBlock.includes('group-avatar-stack'));
  assert.ok(avatarBlock.includes('src="a1"'));
  assert.ok(avatarBlock.includes('src="a2"'));
  assert.ok(!avatarBlock.includes('src="null"'));
});

test('bentoCard forwards extra attrs on quick action buttons', () => {
  const html = bentoCard({
    id: '1',
    name: 'x',
    icon: 'i',
    checkboxClass: 'c',
    quick: [{ action: 'deleteMessages', label: 'Delete Msgs', theme: 'danger', attrs: ' data-oldest="true"' }],
  });
  assert.ok(html.includes('data-action="deleteMessages" data-oldest="true"'));
  assert.ok(html.includes('class="foot-btn danger"'));
});

test('bentoCard renders inline [ID] badge next to the name', () => {
  const html = bentoCard({ id: '1', name: 'x', icon: 'i', checkboxClass: 'c' });
  const nameRow = html.slice(html.indexOf('bento-name-row'), html.indexOf('bento-foot'));
  assert.ok(nameRow.includes('class="id-badge" data-action="copy"'));
  assert.ok(nameRow.includes('>ID</button>'));
  assert.ok(!html.includes('>Copy ID</button>'));
});

test('bentoCard escapes injected HTML in name and badge', () => {
  const html = bentoCard({
    id: '1',
    name: '<script>x</script>',
    icon: 'i',
    checkboxClass: 'c',
    badge: { label: '<img onerror=x>' },
  });
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img onerror'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('&lt;img'));
});

test('bentoCard omits empty foot/badge sections', () => {
  const html = bentoCard({ id: '1', name: 'x', icon: 'i', checkboxClass: 'c' });
  assert.ok(!html.includes('bento-foot'));
  assert.ok(!html.includes('bento-badge'));
});

// ─── Recherche de liste (Friends / DMs / Servers) ────────────────────────────

test('normalizeSearch ignore la casse et les accents', () => {
  assert.equal(normalizeSearch('  Émile  '), '  emile  ');
  assert.equal(normalizeSearch('CAFÉ'), 'cafe');
  assert.equal(normalizeSearch(null), '');
});

test('listSearchHtml rend un champ avec cle de liste et valeur re-injectee', () => {
  const html = listSearchHtml('dms', 'bob "x"');
  assert.ok(html.includes('class="list-search"'));
  assert.ok(html.includes('data-list-search="dms"'));
  assert.ok(html.includes('type="search"'));
  assert.ok(html.includes('value="bob &quot;x&quot;"'), 'valeur echappee (pas d injection)');
});

function carteFactice(name, meta = '') {
  const classes = new Set();
  return {
    querySelector: (sel) => (sel === '.bento-name' ? { textContent: name } : sel === '.bento-meta' ? { textContent: meta } : null),
    classList: { toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); }, contains: (c) => classes.has(c) },
    classes,
  };
}
const listeFactice = (cards) => ({ querySelectorAll: (sel) => (sel === '.bento-card' ? cards : []) });

test('filterBentoCards masque les non-correspondances (nom + meta, accents ignores)', () => {
  const a = carteFactice('Émile Durand', '@emile');
  const b = carteFactice('Bob', '@bobby');
  const c = carteFactice('Le CAFÉ', '@cafe');
  const list = listeFactice([a, b, c]);
  assert.equal(filterBentoCards(list, 'emile'), 1, 'accents ignores');
  assert.ok(!a.classes.has('search-hidden'));
  assert.ok(b.classes.has('search-hidden'));
  assert.equal(filterBentoCards(list, 'bobby'), 1, 'la ligne meta est aussi cherchee');
  assert.equal(filterBentoCards(list, 'cafe'), 1);
  assert.equal(filterBentoCards(list, ''), 3, 'requete vide = tout visible');
  assert.ok(!b.classes.has('search-hidden'));
  assert.equal(filterBentoCards(list, 'introuvable'), 0);
  assert.equal(filterBentoCards(null, 'x'), 0, 'liste absente : pas de crash');
});

test('applyListSearch met a jour le badge X / N et l etat vide', () => {
  const a = carteFactice('Alice');
  const b = carteFactice('Bob');
  const list = listeFactice([a, b]);
  const countEl = { textContent: '0' };
  const emptyEl = { hidden: true, textContent: '' };
  applyListSearch({ listEl: list, countEl, emptyEl, query: '', total: 2 });
  assert.equal(countEl.textContent, '2', 'sans filtre : total seul');
  assert.equal(emptyEl.hidden, true);
  applyListSearch({ listEl: list, countEl, emptyEl, query: 'ali', total: 2 });
  assert.equal(countEl.textContent, '1 / 2');
  assert.equal(emptyEl.hidden, true);
  applyListSearch({ listEl: list, countEl, emptyEl, query: 'zzz', total: 2 });
  assert.equal(countEl.textContent, '0 / 2');
  assert.equal(emptyEl.hidden, false, 'etat vide affiche');
  assert.match(emptyEl.textContent, /zzz/);
});

test('les 3 listes exposent la barre de recherche, le filtrage et l etat vide', () => {
  for (const f of ['FriendsManager', 'DMManager', 'ServerManager']) {
    const src = readFileSync(new URL(`../src/components/${f}.js`, import.meta.url), 'utf8');
    assert.ok(src.includes('listSearchHtml('), `${f} : champ de recherche present`);
    assert.ok(src.includes('applySearchTo('), `${f} : filtrage applique`);
    assert.ok(src.includes('bindListSearch('), `${f} : champ cable (input + Echap)`);
    assert.ok(src.includes('data-list-empty'), `${f} : etat vide present`);
  }
});

test('select-all ne coche que les elements visibles (filtre actif)', () => {
  for (const f of ['FriendsManager', 'DMManager', 'ServerManager']) {
    const src = readFileSync(new URL(`../src/components/${f}.js`, import.meta.url), 'utf8');
    assert.ok(src.includes('checkVisibleBoxes('), `${f} : select-all tient compte du filtre`);
  }
});
