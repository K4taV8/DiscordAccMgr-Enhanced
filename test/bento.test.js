import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bentoCard } from '../src/components/bento.js';

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
