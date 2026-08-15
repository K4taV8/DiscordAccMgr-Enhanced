import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bentoCard } from '../src/components/bento.js';

test('bentoCard renders all actions directly, no dropdown menu', () => {
  const html = bentoCard({
    id: '123',
    name: 'CaffeineMC',
    meta: '@caf',
    icon: 'https://cdn.discordapp.com/x.png',
    fallbackIcon: '/discord.png',
    checkboxClass: 'server-checkbox',
    badge: { label: 'Owner', className: 'is-owner' },
    quick: [
      { action: 'mute', label: 'Mute' },
      { action: 'deleteMessages', label: 'Delete Msgs', danger: true },
      { action: 'removeReactions', label: 'Rm Reactions', danger: true },
      { action: 'leave', label: 'Leave', danger: true },
    ],
  });
  assert.ok(html.includes('class="bento-card"'));
  assert.ok(html.includes('data-id="123"'));
  assert.ok(html.includes('class="server-checkbox" data-action="updateSelected"'));
  assert.ok(html.includes('bento-badge is-owner'));
  assert.ok(html.includes('data-fallback="/discord.png"'));
  assert.ok(html.includes('class="bento-foot"'));
  // Les 4 actions sont visibles directement (pas de menuToggle/bento-menu).
  assert.ok(html.includes('class="foot-btn" data-action="mute">Mute'));
  assert.ok(html.includes('class="foot-btn danger" data-action="deleteMessages">Delete Msgs'));
  assert.ok(html.includes('class="foot-btn danger" data-action="removeReactions">Rm Reactions'));
  assert.ok(html.includes('class="foot-btn danger" data-action="leave">Leave'));
  assert.ok(!html.includes('menuToggle'));
  assert.ok(!html.includes('bento-menu'));
});

test('bentoCard forwards extra attrs on quick action buttons', () => {
  const html = bentoCard({
    id: '1',
    name: 'x',
    icon: 'i',
    checkboxClass: 'c',
    quick: [{ action: 'deleteMessages', label: 'Delete Msgs', attrs: ' data-oldest="true"', danger: true }],
  });
  assert.ok(html.includes('data-action="deleteMessages" data-oldest="true"'));
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
