import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupChannels } from '../src/services/packageSections.service.js';

// La liste des 667 salons etait une unique colonne triee par volume : on ne
// pouvait pas retrouver un serveur ni distinguer MP / groupe / salon. On la
// decoupe en sections Navigables.

test('les MP et les groupes sont separes des salons de serveur', () => {
  const sections = groupChannels([
    { id: '1', type: 'DM', name: 'alice', messagesCount: 10 },
    { id: '2', type: 'GROUP', name: 'team', messagesCount: 5 },
    { id: '3', type: 'SERVER_TEXT', name: 'general', guildId: '9', guildName: 'Serveur', messagesCount: 20 },
  ]);

  const labels = sections.map(section => section.id);
  assert.deepEqual(labels, ['dm', 'group', 'guild-9']);
  assert.equal(sections[0].channels.length, 1);
  assert.equal(sections[1].channels.length, 1);
  assert.equal(sections[2].channels.length, 1);
});

test('les sections sont dans un ordre stable et utile', () => {
  const sections = groupChannels([
    { id: '3', type: 'SERVER_TEXT', name: 'general', guildId: '9', guildName: 'Serveur', messagesCount: 20 },
    { id: '1', type: 'DM', name: 'alice', messagesCount: 10 },
  ]);
  assert.deepEqual(sections.map(s => s.id), ['dm', 'guild-9']);
});

test('une section serveur porte le nom du serveur', () => {
  const sections = groupChannels([
    { id: '3', type: 'SERVER_TEXT', name: 'general', guildId: '9', guildName: 'Les Pangolins', messagesCount: 20 },
    { id: '4', type: 'SERVER_TEXT', name: 'general2', guildId: '9', guildName: 'Les Pangolins', messagesCount: 3 },
  ]);
  assert.equal(sections.length, 1, 'deux salons du meme serveur = une seule section');
  assert.equal(sections[0].label, 'Les Pangolins');
  assert.equal(sections[0].channels.length, 2);
});

test('les sections sont classees par volume decroissant', () => {
  const sections = groupChannels([
    { id: '1', type: 'DM', name: 'a', messagesCount: 5 },
    { id: '2', type: 'DM', name: 'b', messagesCount: 50 },
    { id: '3', type: 'SERVER_TEXT', name: 'c', guildId: '9', guildName: 'Gros', messagesCount: 900 },
  ]);
  const dm = sections.find(s => s.id === 'dm');
  assert.equal(dm.channels[0].name, 'b', 'le MP le plus gros en tete');
  const guild = sections.find(s => s.id === 'guild-9');
  assert.equal(sections.indexOf(guild) > sections.indexOf(dm), true, 'le serveur le plus actif apres les MP');
});

test('un salon sans serveur connu ne disparait pas', () => {
  const sections = groupChannels([{ id: '7', type: 'SERVER_TEXT', name: 'orphelin', messagesCount: 2 }]);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].channels.length, 1);
});

test('une liste vide ne produit aucune section', () => {
  assert.deepEqual(groupChannels([]), []);
});

test('le total des salons est preserve', () => {
  const input = [
    { id: '1', type: 'DM', name: 'a', messagesCount: 1 },
    { id: '2', type: 'GROUP', name: 'b', messagesCount: 1 },
    { id: '3', type: 'SERVER_TEXT', name: 'c', guildId: '9', guildName: 'G', messagesCount: 1 },
    { id: '4', type: 'SERVER_TEXT', name: 'd', guildId: '8', guildName: 'H', messagesCount: 1 },
  ];
  const total = groupChannels(input).reduce((sum, s) => sum + s.channels.length, 0);
  assert.equal(total, 4);
});