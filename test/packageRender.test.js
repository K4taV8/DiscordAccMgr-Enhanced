import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PackageManager } from '../src/components/PackageManager.js';
import { isSystemNotification, countSystemNotifications, attachmentKind, attachmentExtension } from '../src/services/packageData.service.js';
import { isCurrentPackageArchive, PACKAGE_SCHEMA_VERSION } from '../src/services/packageStorage.service.js';
import { closeProgressPanel, finishProgressPanel, isProgressPanelOpen, progressPanelHtml, showProgressPanel, updateProgressPanel } from '../src/utils/progressPanel.js';

// Regression : deux pannes consecutives de l affichage venaient d une variable
// non declaree dans le template de render() (selectedChannel). Ni node --check
// ni les autres tests ne le voyaient : la faute n existe qu a l execution.
// Ce test EXECUTE donc render() avec un DOM minimal.

function makeArea() {
  return {
    innerHTML: '',
    className: '',
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

function samplePackage() {
  const messages = new Map();
  messages.set('111', [
    { id: '1', timestamp: '2024-01-01T00:00:00.000Z', content: 'bonjour', attachments: [] },
  ]);
  messages.set('222', [
    { id: '2', timestamp: '2024-01-02T00:00:00.000Z', content: 'salut', attachments: [] },
  ]);
  return {
    user: { id: '999', username: 'tester', globalName: 'Testeur', avatar: null },
    guilds: [{ id: 'g1', name: 'Les Pangolins', icon: null }],
    channels: [
      { id: '111', name: 'general', type: 'SERVER_TEXT', guildId: 'g1', guildName: 'Les Pangolins', recipient: null, isLeft: false, messagesCount: 1 },
      { id: '222', name: 'alice', type: 'DM', guildId: null, guildName: null, recipient: { id: '333', username: 'bob', avatar: null }, isLeft: false, messagesCount: 1 },
      { id: '333', name: null, type: 'GROUP', guildId: null, guildName: null, recipient: null, isLeft: false, messagesCount: 0 },
    ],
    messages,
    totalMessages: 2,
    packageSizeBytes: 10,
  };
}

test('render() ne leve pas quand un package est charge', () => {
  const manager = new PackageManager(makeArea());
  manager.package = samplePackage();
  manager.selectedChannelId = '111';

  assert.doesNotThrow(() => manager.render());
  assert.ok(manager.contentArea.innerHTML.length > 0, 'la vue est bien construite');
});

test('render() produit les sections de salons', () => {
  const manager = new PackageManager(makeArea());
  manager.package = samplePackage();

  manager.render();
  const html = manager.contentArea.innerHTML;
  assert.ok(html.includes('Messages directs'), 'section MP');
  assert.ok(html.includes('Groupes'), 'section groupes');
  assert.ok(html.includes('Les Pangolins'), 'section du serveur');
});

test('render() gere un salon selectionne (en-tete de conversation)', () => {
  const manager = new PackageManager(makeArea());
  manager.package = samplePackage();
  manager.selectedChannelId = '111';

  manager.render();
  assert.ok(manager.contentArea.innerHTML.includes('Messages'), 'le contenu du salon est rendu');
});

test('render() fonctionne aussi sans selection', () => {
  const manager = new PackageManager(makeArea());
  manager.package = samplePackage();
  manager.selectedChannelId = null;

  assert.doesNotThrow(() => manager.render());
});

test('render() fonctionne avec un package sans salon selectionnable', () => {
  const manager = new PackageManager(makeArea());
  manager.package = { ...samplePackage(), channels: [], messages: new Map() };
  manager.selectedChannelId = 'inconnu';

  assert.doesNotThrow(() => manager.render());
});

// Regression : importDiscordPackage attend un objet d options
// ({ onProgress, onEntry, shouldStop }). Tant que le second argument etait
// la fonction de progression, celle-ci recevait l objet d options : current
// valait undefined, le pourcentage restait bloque a 0 et la barre de
// progression ne bougeait plus sur un gros export. Ce test fige le calcul.
function manyChannels(dmCount, guildChannelCount) {
  const channels = [];
  for (let i = 0; i < dmCount; i += 1) channels.push({ id: `dm${i}`, name: `user${i}`, type: 'DM', guildId: null, guildName: null, recipient: null, isLeft: false, messagesCount: dmCount - i });
  for (let i = 0; i < guildChannelCount; i += 1) channels.push({ id: `s${i}`, name: `salon-${i}`, type: 'SERVER_TEXT', guildId: 'g1', guildName: 'Serveur Un', recipient: null, isLeft: false, messagesCount: guildChannelCount - i });
  return channels;
}

function bigPackage(dmCount = 300, guildChannelCount = 100) {
  const channels = manyChannels(dmCount, guildChannelCount);
  return { ...samplePackage(), channels, messages: new Map(), totalMessages: channels.length };
}

// Virtualisation : le menu de gauche rendait 667 salons d'un coup (667 noeuds +
// 667 images). On ne rend que la fenetre visible, les deux tampons de hauteur
// reconstituant la barre de defilement.

test('le modele compte les en-tetes et les lignes a leur hauteur reelle', () => {
  const manager = new PackageManager(makeArea());
  const model = manager.buildChannelModel(bigPackage(300, 100).channels);

  // 300 MP + 100 salons => 2 en-tetes (Messages directs, Serveur Un) + 400 lignes.
  assert.equal(model.rows.filter(row => row.type === 'header').length, 2);
  assert.equal(model.rows.filter(row => row.type === 'channel').length, 400);
  assert.equal(model.total, 402);
  assert.equal(model.height, 400 * 56 + 2 * 34);
});

test('la liste ne rend que la fenetre visible, pas tous les salons', () => {
  const manager = new PackageManager(makeArea());
  manager.package = bigPackage();
  manager.channelViewport = 800;

  manager.render();
  const rendered = (manager.contentArea.innerHTML.match(/data-channel-id="/g) || []).length;
  assert.ok(rendered > 0, 'des lignes sont rendues');
  assert.ok(rendered < 80, `seule la fenetre est rendue (${rendered} lignes)`);
});

test('les tampons reconstituent la hauteur totale sans perte ni doublon', () => {
  const manager = new PackageManager(makeArea());
  manager.package = bigPackage();
  manager.channelViewport = 800;

  manager.render();
  const model = manager.channelModel;
  const slice = manager.channelWindowSlice();
  const renderedHeight = model.offsets[slice.end] - model.offsets[slice.start];
  assert.equal(slice.padTop + renderedHeight + slice.padBottom, model.height);
  assert.equal(slice.padTop, model.offsets[slice.start], 'le tampon haut suit les offsets');
});

test('defiler loin deplace la fenetre et grossit le tampon haut', () => {
  const manager = new PackageManager(makeArea());
  manager.package = bigPackage();
  manager.channelViewport = 800;

  manager.render();
  const before = manager.channelWindowSlice();
  manager.channelScrollTop = 56 * 200;
  const after = manager.channelWindowSlice();
  assert.ok(after.start > before.start, 'la tranche avance');
  assert.ok(after.padTop > before.padTop, 'le tampon haut grossit');
  assert.equal(after.padTop, manager.channelModel.offsets[after.start]);
});

test('une fenetre qui deborde en bas est bornee sur le dernier element', () => {
  const manager = new PackageManager(makeArea());
  manager.package = bigPackage();
  manager.channelViewport = 800;
  manager.channelScrollTop = 1e9;

  manager.render();
  const slice = manager.channelWindowSlice();
  assert.equal(slice.end, manager.channelModel.total);
  assert.equal(slice.padBottom, 0);
});

// La virtualisation fait disparaitre l en-tete d une section des que l on
// descend loin dedans : sans rappel, on ne sait plus ou l on se trouve.
test('la section courante est rappelee quand son en-tete sort de la fenetre', () => {
  const manager = new PackageManager(makeArea());
  manager.package = bigPackage();
  manager.channelViewport = 800;

  manager.render();
  assert.equal(manager.currentSectionLabel(), 'Messages directs', 'au sommet, premiere section');

  manager.channelScrollTop = 56 * 200;
  manager.render();
  const label = manager.currentSectionLabel();
  assert.ok(label, 'un libelle reste disponible meme loin du premier en-tete');
  const html = manager.contentArea.innerHTML;
  assert.ok(html.includes('data-channel-context'), 'la barre de contexte est presente');
  assert.ok(html.includes('>Messages directs<') || html.includes('>Serveur Un<'), `le libelle rendu correspond a la section (${label})`);
});

test('le libelle de section suit le defilement', () => {
  const manager = new PackageManager(makeArea());
  manager.package = bigPackage();
  manager.channelViewport = 800;
  manager.render();

  manager.channelScrollTop = manager.channelModel.height;
  assert.equal(manager.currentSectionLabel(), 'Serveur Un', 'en bas, section des salons');
});

// ---------------------------------------------------------------------------
// Selection de salon et suppression en lot.
// Les filtres de liste et notifications systeme.
// ---------------------------------------------------------------------------

test('la case a cocher est un vrai controle et porte l identifiant du salon', () => {
  const manager = new PackageManager(makeArea());
  manager.package = samplePackage();
  const html = manager.channelRowHtml(manager.package.channels.find(c => c.type === 'DM'));
  assert.match(html, /<input[^>]*data-select-channel="222"/, 'controle identifiable');
  assert.doesNotMatch(html, /<span class="package-selection-state/, 'ce n est plus un simple span');
});

test('cocher un salon selectionne tous ses messages', () => {
  const manager = new PackageManager(makeArea());
  manager.package = filteredPackage();
  manager.render = () => {};

  const box = { dataset: { selectChannel: 'dm-avec-texte' }, checked: true, matches: () => false, closest: selector => (selector === '[data-select-channel]' ? box : null), id: '' };
  manager.handleChange({ target: box });

  assert.deepEqual([...manager.selectedMessages], ['dm-avec-texte:a']);
  assert.equal(manager.channelSelectionState({ id: 'dm-avec-texte' }), 'all');
});

test('decocher un salon retire ses messages de la selection', () => {
  const manager = new PackageManager(makeArea());
  manager.package = filteredPackage();
  manager.render = () => {};
  manager.selectedMessages.add('dm-avec-texte:a');
  manager.selectedMessages.add('srv:s1');

  const box = { dataset: { selectChannel: 'dm-avec-texte' }, checked: false, matches: () => false, closest: selector => (selector === '[data-select-channel]' ? box : null), id: '' };
  manager.handleChange({ target: box });

  assert.deepEqual([...manager.selectedMessages], ['srv:s1'], 'les autres salons sont intacts');
});

test('un salon sans message ne casse pas la selection', () => {
  const manager = new PackageManager(makeArea());
  manager.package = filteredPackage();
  manager.render = () => {};

  const box = { dataset: { selectChannel: 'dm-vide' }, checked: true, matches: () => false, closest: selector => (selector === '[data-select-channel]' ? box : null), id: '' };
  assert.doesNotThrow(() => manager.handleChange({ target: box }));
  assert.equal(manager.selectedMessages.size, 0);
});

test('tout cocher ne touche que les salons filtres', () => {
  const manager = new PackageManager(makeArea());
  manager.package = filteredPackage();
  manager.render = () => {};

  manager.channelKindFilter = 'dm';
  manager.hideEmptyDms = true;
  manager.toggleAllFiltered(true);
  assert.deepEqual([...manager.selectedMessages].sort(), ['dm-avec-texte:a', 'dm-notifs-seulement:n1', 'dm-notifs-seulement:n2']);

  manager.toggleAllFiltered(false);
  assert.equal(manager.selectedMessages.size, 0, 'tout decocher vide la selection');
});

test('le clic sur la case ne ouvre pas la conversation', () => {
  const manager = new PackageManager(makeArea());
  manager.package = filteredPackage();
  let opened = 0;
  manager.selectChannel = () => { opened += 1; };

  const box = { dataset: { selectChannel: 'dm-avec-texte' }, closest: selector => (selector === '[data-select-channel]' ? box : null) };
  manager.handleClick({ target: box });
  assert.equal(opened, 0, 'la navigation ne se declenche pas');
});

test('la suppression en lot part des messages des salons coches', async () => {
  const manager = new PackageManager(makeArea());
  manager.package = filteredPackage();
  manager.channelKindFilter = 'dm';
  manager.hideEmptyDms = true;
  manager.toggleAllFiltered(true);

  const deletes = [];
  globalThis.window = { electronAPI: { getChannel: async () => ({ success: true }), deletePackageMessage: async (c, m) => { deletes.push(`${c}:${m}`); return { success: true }; } } };
  try {
    const counts = { deleted: 0, missing: 0, forbidden: 0, failed: 0 };
    const byChannel = new Map();
    for (const key of manager.selectedMessages) {
      const [channelId, messageId] = key.split(':');
      if (!byChannel.has(channelId)) byChannel.set(channelId, []);
      byChannel.get(channelId).push({ channelId, messageId });
    }
    for (const group of byChannel.values()) for (const target of group) await manager.deleteOnePackageMessage(target, counts);

    assert.deepEqual(deletes.sort(), ['dm-avec-texte:a', 'dm-notifs-seulement:n1', 'dm-notifs-seulement:n2']);
    assert.equal(counts.deleted, 3);
  } finally {
    delete globalThis.window;
  }
});

// Le bandeau de section rappelait le nom en permanence, juste au-dessus de
// l en-tete identique : le meme libelle s affichait deux fois de suite.
test('le bandeau de section ne s affiche que quand l en-tete est hors champ', () => {
  const manager = new PackageManager(makeArea());
  manager.package = bigPackage();
  manager.channelViewport = 800;
  manager.render();

  const html = manager.contentArea.innerHTML;
  assert.doesNotMatch(html, /data-channel-context[^>]*>[^<]+</, 'en haut, l en-tete est visible donc pas de bandeau');

  manager.channelScrollTop = 56 * 200;
  manager.render();
  const deep = manager.contentArea.innerHTML;
  assert.match(deep, /data-channel-context[^>]*>Messages directs</, 'loin du premier en-tete, le rappel revient');
});

test('une notification systeme est un message sans texte ni piece jointe', () => {
  assert.equal(isSystemNotification({ content: '', attachments: [] }), true);
  assert.equal(isSystemNotification({ content: '   ', attachments: [] }), true, 'un texte blanc ne compte pas');
  assert.equal(isSystemNotification({ content: '', attachments: [{ url: 'x' }] }), false, 'une image n est pas une notification');
  assert.equal(isSystemNotification({ content: 'coucou', attachments: [] }), false);
  assert.equal(isSystemNotification(null), false);
});

test('compter les notifications systeme d un salon', () => {
  const messages = [
    { content: 'a', attachments: [] },
    { content: '', attachments: [] },
    { content: '', attachments: [{ url: 'x' }] },
    { content: '', attachments: [] },
  ];
  assert.equal(countSystemNotifications(messages), 2);
  assert.equal(countSystemNotifications([]), 0);
});

function filteredPackage() {
  const messages = new Map();
  messages.set('dm-avec-texte', [{ id: 'a', timestamp: '2024-01-01T00:00:00.000Z', content: 'bonjour', attachments: [] }]);
  messages.set('dm-vide', []);
  messages.set('dm-notifs-seulement', [
    { id: 'n1', timestamp: '2024-01-02T00:00:00.000Z', content: '', attachments: [] },
    { id: 'n2', timestamp: '2024-01-02T00:05:00.000Z', content: '', attachments: [] },
  ]);
  messages.set('grp', [{ id: 'g1', timestamp: '2024-01-03T00:00:00.000Z', content: 'salut', attachments: [] }]);
  messages.set('srv', [{ id: 's1', timestamp: '2024-01-04T00:00:00.000Z', content: 'texte', attachments: [] }]);

  return {
    user: { id: '999', username: 'tester', globalName: 'Testeur', avatar: null },
    guilds: [{ id: 'g1', name: 'Les Pangolins', icon: null }],
    channels: [
      { id: 'dm-avec-texte', name: 'alice', type: 'DM', guildId: null, guildName: null, recipient: { id: '1', username: 'alice', avatar: null }, isLeft: false, messagesCount: 1 },
      { id: 'dm-vide', name: 'bob', type: 'DM', guildId: null, guildName: null, recipient: { id: '2', username: 'bob', avatar: null }, isLeft: false, messagesCount: 0 },
      { id: 'dm-notifs-seulement', name: 'carol', type: 'DM', guildId: null, guildName: null, recipient: { id: '3', username: 'carol', avatar: null }, isLeft: false, messagesCount: 2 },
      { id: 'grp', name: null, type: 'GROUP', guildId: null, guildName: null, recipient: null, isLeft: false, messagesCount: 1 },
      { id: 'srv', name: 'general', type: 'SERVER_TEXT', guildId: 'g1', guildName: 'Les Pangolins', recipient: null, isLeft: false, messagesCount: 1 },
    ],
    messages,
    totalMessages: 5,
    packageSizeBytes: 10,
  };
}

test('le filtre par type ne garde que la famille demandee', () => {
  const manager = new PackageManager(makeArea());
  manager.package = filteredPackage();

  assert.equal(manager.filteredChannels().length, 5, 'par defaut tout est visible');
  manager.channelKindFilter = 'dm';
  assert.deepEqual(manager.filteredChannels().map(c => c.id).sort(), ['dm-avec-texte', 'dm-notifs-seulement', 'dm-vide']);
  manager.channelKindFilter = 'group';
  assert.deepEqual(manager.filteredChannels().map(c => c.id), ['grp']);
  manager.channelKindFilter = 'server';
  assert.deepEqual(manager.filteredChannels().map(c => c.id), ['srv']);
});

test('masquer les MP vides ne touche pas ceux qui n ont que des notifications', () => {
  const manager = new PackageManager(makeArea());
  manager.package = filteredPackage();
  manager.channelKindFilter = 'dm';
  manager.hideEmptyDms = true;

  const ids = manager.filteredChannels().map(c => c.id).sort();
  assert.ok(!ids.includes('dm-vide'), 'le MP sans aucun message part');
  assert.ok(ids.includes('dm-notifs-seulement'), 'un MP avec des notifications reste visible');
  assert.ok(ids.includes('dm-avec-texte'), 'et un MP avec du texte aussi');
});

test('le filtre se combine avec la recherche textuelle', () => {
  const manager = new PackageManager(makeArea());
  manager.package = filteredPackage();
  manager.channelKindFilter = 'dm';
  manager.hideEmptyDms = true;
  manager.channelQuery = 'carol';

  assert.deepEqual(manager.filteredChannels().map(c => c.id), ['dm-notifs-seulement']);
});

test('les notifications systeme sont masquees par defaut', () => {
  const manager = new PackageManager(makeArea());
  manager.package = filteredPackage();
  const channel = manager.package.channels.find(c => c.id === 'dm-notifs-seulement');

  assert.equal(manager.hideSystemNotes, true, 'masquees par defaut');
  assert.equal(manager.visibleMessages(channel).length, 0, 'rien ne s affiche');
  assert.equal(manager.systemNotesHiddenCount(channel), 2, 'mais le nombre est annonce');

  manager.hideSystemNotes = false;
  assert.equal(manager.visibleMessages(channel).length, 2, 'le filtre se desactive');
  assert.equal(manager.systemNotesHiddenCount(channel), 0);
});

test('une conversation masquee l explique au lieu de paraitre vide', () => {
  const manager = new PackageManager(makeArea());
  manager.package = filteredPackage();
  manager.render();
  const channel = manager.package.channels.find(c => c.id === 'dm-notifs-seulement');

  const html = manager.renderMessages(channel);
  assert.match(html, /notifications? syst/);
  assert.match(html, /2/, 'le compte est affiche');
});

test('les boutons de filtre affichent l etat actif', () => {
  const manager = new PackageManager(makeArea());
  manager.package = filteredPackage();
  manager.channelKindFilter = 'dm';
  manager.hideEmptyDms = true;

  const html = manager.renderChannelFilterBar();
  assert.match(html, /data-channel-filter="dm"[^>]*class="[^"]*is-active|class="[^"]*is-active[^"]*"[^>]*data-channel-filter="dm"/);
  assert.match(html, /data-hide-empty checked/);
  assert.match(html, /data-hide-system checked/, 'notifications systeme masquees par defaut');
});

test('l export ZIP produit une archive, pas un JSON renomme', () => {
  const manager = new PackageManager(makeArea());
  manager.package = samplePackage();

  const target = manager.buildExportBlob('zip');
  assert.equal(target.filename, 'discord-data-package.zip');
  assert.equal(target.blob.type, 'application/zip');
  assert.ok(target.blob.size > 0, 'l archive n est pas vide');
});

test('l export JSON reste disponible et distinct du ZIP', () => {
  const manager = new PackageManager(makeArea());
  manager.package = samplePackage();

  const target = manager.buildExportBlob('json');
  assert.equal(target.filename, 'discord-data-package.json');
  assert.equal(target.blob.type, 'application/json');
});

test('sans package charge, aucun export n est produit', () => {
  const manager = new PackageManager(makeArea());
  assert.equal(manager.buildExportBlob('zip'), null);
});

test('un succes de suppression est compte et decoche le message', async () => {
  const manager = new PackageManager(makeArea());
  manager.package = samplePackage();
  manager.selectedMessages.add('111:1');
  globalThis.window = { electronAPI: { deletePackageMessage: async () => ({ success: true }) } };
  try {
    const counts = {};
    const outcome = await manager.deleteOnePackageMessage({ channelId: '111', messageId: '1' }, counts);
    assert.equal(outcome, 'deleted');
    assert.equal(counts.deleted, 1);
    assert.equal(manager.selectedMessages.size, 0, 'le message n est plus selectionne');
  } finally {
    delete globalThis.window;
  }
});

test('un acces refuse est classe sans decocher ni reessayer', async () => {
  const manager = new PackageManager(makeArea());
  manager.package = samplePackage();
  manager.selectedMessages.add('111:1');
  let calls = 0;
  globalThis.window = { electronAPI: { deletePackageMessage: async () => { calls += 1; return { success: false, error: 'HTTP 403' }; } } };
  try {
    const counts = {};
    const outcome = await manager.deleteOnePackageMessage({ channelId: '111', messageId: '1' }, counts);
    assert.equal(outcome, 'forbidden');
    assert.equal(counts.forbidden, 1);
    assert.equal(calls, 1, 'un 403 ne se reessaye pas');
    assert.equal(manager.selectedMessages.size, 1, 'le message reste selectionne');
  } finally {
    delete globalThis.window;
  }
});

test('un rate limit est reessaye jusqu au succes', async () => {
  const manager = new PackageManager(makeArea());
  manager.package = samplePackage();
  manager.selectedMessages.add('111:1');
  let calls = 0;
  globalThis.window = {
    electronAPI: {
      deletePackageMessage: async () => {
        calls += 1;
        return calls === 1 ? { success: false, error: 'Rate limited', retryAfter: 0 } : { success: true };
      },
    },
  };
  try {
    const counts = {};
    const outcome = await manager.deleteOnePackageMessage({ channelId: '111', messageId: '1' }, counts);
    assert.equal(outcome, 'deleted');
    assert.equal(calls, 2, 'un seul nouvel essai');
    assert.equal(counts.deleted, 1);
  } finally {
    delete globalThis.window;
  }
});

test('l hydratation API recupere le pseudo et l avatar des MP ouverts', async () => {
  const manager = new PackageManager(makeArea());
  manager.package = samplePackage();
  manager.renderThrottled = () => {};
  globalThis.window = {
    electronAPI: {
      getDMs: async () => ({ success: true, dms: [{ id: '222', username: 'bob', displayName: 'Bob', avatar: 'https://cdn.discordapp.com/avatars/333/hash.png?size=64' }] }),
    },
  };
  try {
    const updated = await manager.hydrateDmPartners();
    assert.equal(updated, 1, 'un seul MP correspond');
    const dm = manager.package.channels.find(channel => channel.id === '222');
    assert.equal(dm.recipient.username, 'bob');
    assert.match(dm.avatar, /avatars\/333\/hash\.png/);
  } finally {
    delete globalThis.window;
  }
});

test('sans API ou sans correspondance, l hydratation ne casse rien', async () => {
  const manager = new PackageManager(makeArea());
  manager.package = samplePackage();
  manager.renderThrottled = () => {};
  assert.equal(await manager.hydrateDmPartners(), 0, 'pas d API disponible');

  globalThis.window = { electronAPI: { getDMs: async () => ({ success: true, dms: [] }) } };
  try {
    assert.equal(await manager.hydrateDmPartners(), 0, 'aucun MP encore ouvert');
  } finally {
    delete globalThis.window;
  }
});

test('seuls les MP portent un bouton Ouvrir', () => {
  const manager = new PackageManager(makeArea());
  manager.package = samplePackage();
  const dm = manager.package.channels.find(channel => channel.type === 'DM');
  const server = manager.package.channels.find(channel => channel.type === 'SERVER_TEXT');

  assert.match(manager.channelRowHtml(dm), /data-open-dm="333"/, 'le MP a son bouton');
  assert.doesNotMatch(manager.channelRowHtml(server), /data-open-dm/, 'un salon de serveur non');
});

test('la ligne est un div, pas un bouton, pour autoriser le bouton imbrique', () => {
  const manager = new PackageManager(makeArea());
  manager.package = samplePackage();
  const html = manager.channelRowHtml(manager.package.channels[0]);
  assert.match(html, /role="button"/);
  assert.match(html, /tabindex="0"/, 'reste atteignable au clavier');
  assert.doesNotMatch(html, /<button class="package-channel"/);
});

// Repeindre la fenetre a chaque frame recreait les noeuds visibles et
// rechargait leurs images : le cache de peinture evite ce travail inutile.
test('la fenetre n est repeinte que lorsqu elle sort de la zone peinte', () => {
  const manager = new PackageManager(makeArea());
  manager.package = bigPackage();
  manager.channelViewport = 800;
  manager.render();

  const spacerTop = { style: {} };
  const spacerBottom = { style: {} };
  const rows = { innerHTML: '<initial>' };
  const context = { textContent: '' };
  const scroller = { scrollTop: 0, clientHeight: 800, addEventListener() {} };
  manager.channelRefs = { scroller, top: spacerTop, rows, bottom: spacerBottom, context };

  manager.renderChannelWindow();
  assert.notEqual(rows.innerHTML, '<initial>', 'le premier appel peint la fenetre');
  assert.equal(context.textContent, '', 'en haut l en-tete est visible, aucun rappel ne_double le libelle');

  const painted = rows.innerHTML;
  scroller.scrollTop = 400;
  manager.renderChannelWindow();
  assert.equal(rows.innerHTML, painted, 'defiler dans la zone peinte ne repeint rien');

  scroller.scrollTop = 5000;
  manager.renderChannelWindow();
  assert.notEqual(rows.innerHTML, painted, 'sortir de la zone peinte declenche le repeint');
  assert.equal(context.textContent, 'Messages directs', 'le rappel de section revient quand l en-tete sort');
});

test('les hauteurs mesurees remplacent les constantes CSS', () => {
  const manager = new PackageManager(makeArea());
  manager.package = bigPackage();
  manager.channelRowHeight = 54;
  manager.channelHeaderHeight = 35;

  const model = manager.buildChannelModel(bigPackage().channels);
  manager.channelModel = model;
  assert.equal(model.height, 400 * 54 + 2 * 35, 'le modele suit les hauteurs reelles');

  manager.channelScrollTop = 0;
  assert.equal(manager.channelWindowSlice().padTop, 0, 'aucun tampon en haut');
  manager.channelScrollTop = 54 * 200;
  const slice = manager.channelWindowSlice();
  assert.equal(slice.padTop, model.offsets[slice.start], 'les tampons restent coherents');
  assert.equal(slice.padTop + (model.offsets[slice.end] - model.offsets[slice.start]) + slice.padBottom, model.height, 'aucun pixel perdu');
});

// La ligne est un div pour autoriser le bouton imbrique ; l'activation clavier
// doit donc etre restauree a la main.
test('entree ou espace active une ligne comme le faisait le bouton natif', () => {
  const manager = new PackageManager(makeArea());
  manager.package = samplePackage();
  const selected = [];
  manager.selectChannel = id => selected.push(id);

  const row = { dataset: { channelId: '111' }, closest: selector => (selector === '[data-channel-id]' ? row : null) };
  manager.handleKeydown({ key: 'Enter', target: row, preventDefault() {} });
  manager.handleKeydown({ key: ' ', target: row, preventDefault() {} });
  assert.deepEqual(selected, ['111', '111'], 'les deux touches ouvrent la ligne');

  selected.length = 0;
  manager.handleKeydown({ key: 'a', target: row, preventDefault() {} });
  assert.deepEqual(selected, [], 'une autre touche ne fait rien');
});

test('le clic sur Ouvrir ne selectionne pas le salon', () => {
  const manager = new PackageManager(makeArea());
  manager.package = samplePackage();
  manager.selectChannel = () => { throw new Error('la ligne ne doit pas etre selectionnee'); };
  const opened = [];
  manager.openDmChannel = (id, name) => opened.push([id, name]);

  const openButton = { dataset: { openDm: '333', openDmName: '@bob' } };
  const target = { closest: selector => (selector === '[data-open-dm]' ? openButton : null) };
  manager.handleClick({ target });

  assert.deepEqual(opened, [['333', '@bob']], 'l ouverture est lancee');
});

// Un salon d'un serveur quitte repond 403 : sans test prealable, l outil
// epuisait une requete par message pour apprendre la meme mauvaise nouvelle.
test('un salon inaccessible est saute entierement, sans appel de suppression', async () => {
  const manager = new PackageManager(makeArea());
  manager.package = samplePackage();

  const calls = { getChannel: [], delete: [] };
  globalThis.window = {
    electronAPI: {
      getChannel: async id => { calls.getChannel.push(id); return { success: id !== '222' }; },
      deletePackageMessage: async (channelId, messageId) => { calls.delete.push(`${channelId}:${messageId}`); return { success: true }; },
    },
  };
  try {
    const targets = [
      { channelId: '111', messageId: '1' },
      { channelId: '222', messageId: '2' },
      { channelId: '222', messageId: '3' },
      { channelId: '222', messageId: '4' },
    ];
    const counts = { deleted: 0, missing: 0, forbidden: 0, failed: 0 };
    const skipped = [];
    manager.channelIsAccessible = async id => globalThis.window.electronAPI.getChannel(id).then(r => r.success);

    for (const target of targets) {
      // regroupement par salon, comme dans deleteSelectedMessages
      void target;
    }
    const byChannel = new Map();
    for (const target of targets) {
      if (!byChannel.has(target.channelId)) byChannel.set(target.channelId, []);
      byChannel.get(target.channelId).push(target);
    }
    for (const [channelId, group] of byChannel) {
      if (!(await manager.channelIsAccessible(channelId))) {
        counts.forbidden += group.length;
        skipped.push({ channelId, count: group.length });
        continue;
      }
      for (const target of group) await manager.deleteOnePackageMessage(target, counts);
    }

    assert.deepEqual(calls.getChannel, ['111', '222'], 'un seul controle par salon');
    assert.deepEqual(calls.delete, ['111:1'], 'aucune suppression dans le salon inaccessible');
    assert.equal(counts.deleted, 1);
    assert.equal(counts.forbidden, 3, 'les 3 messages sont comptes comme refuses');
    assert.deepEqual(skipped, [{ channelId: '222', count: 3 }]);
  } finally {
    delete globalThis.window;
  }
});

test('sans verification prealable disponible, on tente la suppression', async () => {
  const manager = new PackageManager(makeArea());
  manager.package = samplePackage();
  assert.equal(await manager.channelIsAccessible('111'), true, 'pas d API : on ne bloque pas');
});

test('un salon en erreur de lecture est traite comme inaccessible', async () => {
  const manager = new PackageManager(makeArea());
  globalThis.window = { electronAPI: { getChannel: async () => ({ success: false, status: 500, error: 'boom' }) } };
  try {
    assert.equal(await manager.channelIsAccessible('111'), false);
  } finally {
    delete globalThis.window;
  }
});

test('la progression avance pour les messages sautes', async () => {
  const manager = new PackageManager(makeArea());
  manager.package = samplePackage();
  manager.channelIsAccessible = async () => false;
  const counts = { deleted: 0, missing: 0, forbidden: 0, failed: 0 };
  const skipped = [];

  manager.deleteProgress = { done: 0, total: 3 };
  const group = [{ channelId: '222', messageId: '2' }, { channelId: '222', messageId: '3' }, { channelId: '222', messageId: '4' }];
  if (!(await manager.channelIsAccessible('222'))) {
    counts.forbidden += group.length;
    skipped.push({ channelId: '222', count: group.length });
    manager.deleteProgress.done += group.length;
  }
  assert.equal(manager.deleteProgress.done, manager.deleteProgress.total, 'la barre arrive a 100 %');
  assert.equal(counts.forbidden, 3);
  assert.equal(skipped.length, 1);
});

test('un 404 alors que le message existe est un echec, pas un deja absent', async () => {
  const manager = new PackageManager(makeArea());
  manager.package = samplePackage();
  manager.selectedMessages.add('111:1');
  const reasons = {};
  const counts = { deleted: 0, missing: 0, forbidden: 0, failed: 0, reasons };
  globalThis.window = {
    electronAPI: {
      deletePackageMessage: async () => ({ success: false, status: 404, error: 'Unknown Message' }),
      getMessage: async () => ({ success: true }),
    },
  };
  try {
    const outcome = await manager.deleteOnePackageMessage({ channelId: '111', messageId: '1' }, counts);
    assert.equal(outcome, 'failed', 'le message existe, la suppression a ete refusee');
    assert.equal(counts.missing, 0, 'rien n est compte comme deja absent');
    assert.ok(reasons['suppression refusée, message toujours présent']);
    assert.equal(manager.selectedMessages.size, 1, 'il reste selectionne, donc retry possible');
  } finally {
    delete globalThis.window;
  }
});

test('un vrai message disparu reste compte comme deja absent', async () => {
  const manager = new PackageManager(makeArea());
  manager.package = samplePackage();
  const counts = { deleted: 0, missing: 0, forbidden: 0, failed: 0 };
  let checks = 0;
  globalThis.window = {
    electronAPI: {
      deletePackageMessage: async () => ({ success: false, status: 404, error: 'Unknown Message' }),
      getMessage: async () => { checks += 1; return { success: false, status: 404 }; },
    },
  };
  try {
    const outcome = await manager.deleteOnePackageMessage({ channelId: '111', messageId: '1' }, counts);
    assert.equal(outcome, 'missing');
    assert.equal(counts.missing, 1);
    assert.equal(checks, 1, 'une seule verification, pas de boucle');
  } finally {
    delete globalThis.window;
  }
});

test('sans verification disponible, le 404 est pris tel quel', async () => {
  const manager = new PackageManager(makeArea());
  manager.package = samplePackage();
  const counts = { deleted: 0, missing: 0, forbidden: 0, failed: 0 };
  globalThis.window = { electronAPI: { deletePackageMessage: async () => ({ success: false, status: 404, error: 'not found' }) } };
  try {
    assert.equal(await manager.deleteOnePackageMessage({ channelId: '111', messageId: '1' }, counts), 'missing');
  } finally {
    delete globalThis.window;
  }
});

test('une archive analysee par un import anterieur n est pas resservie', () => {
  // L identifiant d archive ne change pas quand l import est corrige : sans
  // version de schema, le cache ressort les identifiants arrondis indefiniment.
  const stale = { id: 'a', packageData: { user: { id: '1' }, channels: [], messages: new Map(), schemaVersion: 1 } };
  const current = { id: 'b', packageData: { user: { id: '1' }, channels: [], messages: new Map(), schemaVersion: PACKAGE_SCHEMA_VERSION } };
  const sansVersion = { id: 'c', packageData: { user: { id: '1' }, channels: [], messages: new Map() } };

  assert.equal(isCurrentPackageArchive(current), true, 'la version courante est servie');
  assert.equal(isCurrentPackageArchive(stale), false, 'une version anterieure est ecartee');
  assert.equal(isCurrentPackageArchive(sansVersion), false, 'une archive sans version est ecartee');
  assert.equal(isCurrentPackageArchive(null), false);
});

test('la version du schema est un nombre comparable', () => {
  assert.equal(typeof PACKAGE_SCHEMA_VERSION, 'number');
  assert.ok(PACKAGE_SCHEMA_VERSION >= 2, 'elle a ete incrementee apres la correction des snowflakes');
});

test('un 400 sur un message present devient un refus explicite', async () => {
  const manager = new PackageManager(makeArea());
  manager.package = samplePackage();
  const reasons = {};
  const counts = { deleted: 0, missing: 0, forbidden: 0, failed: 0, reasons };
  let checks = 0;
  globalThis.window = {
    electronAPI: {
      deletePackageMessage: async () => ({ success: false, status: 400, error: 'Invalid Form Body', code: 50035 }),
      getMessage: async () => { checks += 1; return { success: true }; },
    },
  };
  try {
    const outcome = await manager.deleteOnePackageMessage({ channelId: '111', messageId: '1' }, counts);
    assert.equal(outcome, 'failed');
    assert.equal(checks, 1, 'une seule verification');
    const keys = Object.keys(reasons);
    assert.equal(keys.length, 1);
    assert.match(keys[0], /message présent, suppression refusée/);
    assert.match(keys[0], /400/, 'le code HTTP reste visible');
  } finally {
    delete globalThis.window;
  }
});

// Un fil archive refuse toute suppression. Le cycle reactiver / supprimer /
// reassigner est le seul passage possible par l API, et le reassignage doit
// avoir lieu meme si une exception survient : sinon on laisse des fils ouverts
// sur le serveur, ce que l utilisateur n'a jamais demande.
test('un fil archive est reactive, purge, puis reassigne', async () => {
  const manager = new PackageManager(makeArea());
  const calls = [];
  globalThis.window = {
    electronAPI: {
      setThreadArchived: async (id, archived) => { calls.push(`${id}:${archived ? 'archive' : 'reactive'}`); return { success: true }; },
      deletePackageMessage: async (c, m) => { calls.push(`supprime:${m}`); return { success: true }; },
    },
  };
  try {
    const counts = { deleted: 0, missing: 0, forbidden: 0, failed: 0 };
    const channel = { id: '777', type: 'THREAD' };
    const group = [{ channelId: '777', messageId: 'a' }, { channelId: '777', messageId: 'b' }];
    const progress = [];
    const outcome = await manager.deleteChannelGroup(channel, group, counts, async () => { progress.push('tick'); });

    assert.deepEqual(calls, ['777:reactive', 'supprime:a', 'supprime:b', '777:archive']);
    assert.equal(outcome.reactivated, true);
    assert.equal(counts.deleted, 2);
    assert.equal(progress.length, 2, 'la progression avance par message');
  } finally {
    delete globalThis.window;
  }
});

test('le fil est reassigne meme si la suppression leve', async () => {
  const manager = new PackageManager(makeArea());
  const calls = [];
  globalThis.window = {
    electronAPI: {
      setThreadArchived: async (id, archived) => { calls.push(archived ? 'archive' : 'reactive'); return { success: true }; },
      deletePackageMessage: async () => { throw new Error('bip'); },
    },
  };
  try {
    const counts = { deleted: 0, missing: 0, forbidden: 0, failed: 0 };
    const outcome = await manager.deleteChannelGroup({ id: '777', type: 'THREAD' }, [{ channelId: '777', messageId: 'a' }], counts, null);
    assert.deepEqual(calls, ['reactive', 'archive'], 'le fil est referme quoi qu il arrive');
    assert.equal(counts.failed, 1, 'l exception est comptee comme echec');
    assert.equal(outcome.reactivated, true);
  } finally {
    delete globalThis.window;
  }
});

test('un fil que l on ne peut pas reactiver n est jamais reassigne', async () => {
  const manager = new PackageManager(makeArea());
  const calls = [];
  globalThis.window = {
    electronAPI: {
      setThreadArchived: async (id, archived) => { calls.push(archived ? 'archive' : 'reactive'); return { success: false, status: 403, error: 'Missing Permissions' }; },
      deletePackageMessage: async () => { calls.push('supprime'); return { success: true }; },
    },
  };
  try {
    const counts = { deleted: 0, missing: 0, forbidden: 0, failed: 0 };
    const outcome = await manager.deleteChannelGroup({ id: '777', type: 'THREAD' }, [{ channelId: '777', messageId: 'a' }], counts, null);
    assert.equal(outcome.reactivated, false);
    assert.ok(!calls.includes('archive'), 'rien n est reassigne puisque rien n a ete ouvert');
    assert.ok(calls.includes('supprime'), 'la suppression est tentee quand meme');
  } finally {
    delete globalThis.window;
  }
});

test('un salon ordinaire n est jamais desarchive ni rearchive', async () => {
  const manager = new PackageManager(makeArea());
  const calls = [];
  globalThis.window = {
    electronAPI: {
      setThreadArchived: async (id, archived) => { calls.push(`${id}:${archived}`); return { success: true }; },
      deletePackageMessage: async () => ({ success: true }),
    },
  };
  try {
    const counts = { deleted: 0, missing: 0, forbidden: 0, failed: 0 };
    const outcome = await manager.deleteChannelGroup({ id: '111', type: 'SERVER_TEXT' }, [{ channelId: '111', messageId: 'a' }], counts, null);
    assert.equal(outcome.reactivated, false);
    assert.deepEqual(calls, [], 'aucun appel sur un salon');
    assert.equal(counts.deleted, 1);
  } finally {
    delete globalThis.window;
  }
});

test('sans API de fil, la suppression reste possible', async () => {
  const manager = new PackageManager(makeArea());
  const counts = { deleted: 0, missing: 0, forbidden: 0, failed: 0 };
  globalThis.window = { electronAPI: { deletePackageMessage: async () => ({ success: true }) } };
  try {
    const outcome = await manager.deleteChannelGroup({ id: '777', type: 'THREAD' }, [{ channelId: '777', messageId: 'a' }], counts, null);
    assert.equal(outcome.reactivated, false);
    assert.equal(counts.deleted, 1, 'on ne bloque pas une suppression qui reussirait');
  } finally {
    delete globalThis.window;
  }
});

// ---------------------------------------------------------------------------
// Pieces jointes : sur le vrai export, 1778 images, 225 videos, 161 audios et
// 44 autres fichiers. Les URL sont signees (?ex=&is=&hm=) et peuvent expirer,
// donc chaque rendu prevoit un repli vers le lien.
// ---------------------------------------------------------------------------

test('le type d une piece jointe deduit de son extension', () => {
  const base = 'https://cdn.discordapp.com/attachments/1/2/';
  for (const [name, kind] of [['a.png', 'image'], ['b.JPG', 'image'], ['c.gif', 'image'], ['d.webp', 'image'], ['e.jpeg', 'image'],
    ['f.mp4', 'video'], ['g.webm', 'video'], ['h.mov', 'video'], ['i.mkv', 'video'],
    ['j.ogg', 'audio'], ['k.mp3', 'audio'], ['l.opus', 'audio'], ['m.wav', 'audio'],
    ['n.zip', 'file'], ['o.txt', 'file'], ['p.pdf', 'file'], ['q.cmd', 'file'], ['sans-point', 'file']]) {
    assert.equal(attachmentKind(base + name), kind, name);
  }
});

test('la signature de l URL ne fausse pas l extension', () => {
  const url = 'https://cdn.discordapp.com/attachments/1/2/image.png?ex=0&is=6abc1fb3&hm=357e65fc5ff';
  assert.equal(attachmentKind(url), 'image');
  assert.equal(attachmentExtension(url), 'png');
});

test('un nom encode en pourcentage reste lisible', () => {
  assert.equal(attachmentExtension('https://cdn.discordapp.com/a/b/Screenshot%202025-05-07.png'), 'png');
});

test('une extension decodee ne peut pas trahir une traversee de chemin', () => {
  assert.equal(attachmentExtension('https://x/file.png%2F..%2F..%2Fsecret'), '', 'un / et des .. decodes sont refuses');
  assert.equal(attachmentExtension('https://x/normal.tar.gz'), 'gz', 'une extension normale survit');
  assert.equal(attachmentExtension(`https://x/f.${'a'.repeat(30)}`), '', 'une extension absurdement longue est refusee');
});

test('une image est rendue en image, pas en lien', () => {
  const manager = new PackageManager(makeArea());
  const url = 'https://cdn.discordapp.com/attachments/1/2/photo.png';
  const html = manager.attachmentHtml({ url, fileName: 'photo.png' });
  assert.match(html, /<img /);
  assert.match(html, /src="https:\/\/cdn\.discordapp\.com/, 'la source est presente');
  assert.match(html, /loading="lazy"/, 'chargement paresseux : une page peut contenir 150 images');
  assert.match(html, /decoding="async"/);
  assert.match(html, /href="https:\/\/cdn\.discordapp\.com[^"]*"/, 'cliquable en pleine taille');
  // Tache 4 : tout `target="_blank"` est refuse par setWindowOpenHandler
  // (main.cjs), donc il a disparu de TOUTE la sortie de attachmentHtml.
  assert.doesNotMatch(html, /target="_blank"/);
});

test('une video et un audio ont leurs controles', () => {
  const manager = new PackageManager(makeArea());
  const video = manager.attachmentHtml({ url: 'https://cdn.discordapp.com/attachments/1/2/c.mp4', fileName: 'c.mp4' });
  assert.match(video, /<video /);
  assert.match(video, /controls/);

  const audio = manager.attachmentHtml({ url: 'https://cdn.discordapp.com/attachments/1/2/c.ogg', fileName: 'c.ogg' });
  assert.match(audio, /<audio /);
  assert.match(audio, /controls/);
});

test('un fichier ordinaire reste un lien, avec son nom', () => {
  const manager = new PackageManager(makeArea());
  const html = manager.attachmentHtml({ url: 'https://cdn.discordapp.com/attachments/1/2/notes.zip', fileName: 'notes.zip' });
  assert.match(html, /<a /);
  assert.doesNotMatch(html, /<img |<video |<audio /);
  assert.match(html, /notes\.zip/);
});

test('une piece jointe cassee se replie sur son lien', () => {
  const manager = new PackageManager(makeArea());
  const html = manager.attachmentHtml({ url: 'https://cdn.discordapp.com/attachments/1/2/photo.png', fileName: 'photo.png' });
  // Le conteneur porte un repli et l image un marqueur : si l URL signee expire,
  // l image disparait et un lien reste, plutot qu un trou.
  assert.match(html, /data-attachment-fallback/, 'le conteneur sait basculer');
  assert.match(html, /data-attachment-img/, 'l image est identifiee');
  assert.match(html, /Voir le fichier/);
});

test('une URL de piece jointe est echappee', () => {
  const manager = new PackageManager(makeArea());
  const html = manager.attachmentHtml({ url: 'https://cdn.discordapp.com/a/b/x.png?q="><script>', fileName: '<img onerror=1>' });
  assert.doesNotMatch(html, /<script>/, 'aucune balise injectee');
  // L echappement transforme le nom en texte inerte : c est bien cela qu on
  // verifie, pas l absence de la suite de caracteres.
  assert.match(html, /&lt;img onerror=1&gt;/, 'les chevrons du nom sont echappes');
  assert.match(html, /&quot;&gt;&lt;script&gt;/, 'ceux de l URL aussi');
});

// ---------------------------------------------------------------------------
// Visionneuse : un clic ouvre l image en grand. Les videos et l audio ne
// doivent pas rester une boite vide : preload="metadata" affiche la premiere
// image et la duree sans telecharger le fichier entier.
// ---------------------------------------------------------------------------

test('une image est cliquable pour la visionneuse', () => {
  const manager = new PackageManager(makeArea());
  const html = manager.attachmentHtml({ url: 'https://cdn.discordapp.com/attachments/1/2/photo.png', fileName: 'photo.png' });
  assert.match(html, /data-attachment-open/, 'la vignette declenche la visionneuse');
  assert.doesNotMatch(html, /preload="none"/);
});

test('video et audio affichent une apercu sans tout telecharger', () => {
  const manager = new PackageManager(makeArea());
  const video = manager.attachmentHtml({ url: 'https://cdn.discordapp.com/attachments/1/2/c.mp4', fileName: 'c.mp4' });
  assert.match(video, /preload="metadata"/, 'la premiere image est montree sans tout telecharger');
  const audio = manager.attachmentHtml({ url: 'https://cdn.discordapp.com/attachments/1/2/v.ogg', fileName: 'v.ogg' });
  assert.match(audio, /preload="metadata"/);
  assert.match(audio, /<audio /);
});

test('la visionneuse affiche une image a la fois, entouree de navigation', () => {
  const manager = new PackageManager(makeArea());
  const attachments = [
    { url: 'https://cdn.discordapp.com/a/1.png', fileName: '1.png' },
    { url: 'https://cdn.discordapp.com/a/2.png', fileName: '2.png' },
    { url: 'https://cdn.discordapp.com/a/3.png', fileName: '3.png' },
  ];
  const html = manager.lightboxHtml(attachments, 1);
  assert.match(html, /src="https:\/\/cdn\.discordapp\.com\/a\/2\.png"/, 'la deuxieme image est affichee');
  assert.match(html, /2 \/ 3/, 'la position est indiquee');
  assert.match(html, /data-lightbox-prev/);
  assert.match(html, /data-lightbox-next/);
});

test('la visionneuse n affiche ni fleche ni compteur quand il n y a qu une image', () => {
  const manager = new PackageManager(makeArea());
  const html = manager.lightboxHtml([{ url: 'https://cdn.discordapp.com/a/1.png', fileName: '1.png' }], 0);
  assert.doesNotMatch(html, /data-lightbox-prev/);
  assert.doesNotMatch(html, /data-lightbox-next/);
  assert.doesNotMatch(html, /package-lightbox-counter/, '« 1 / 1 » n apporte rien');
  assert.match(html, /data-lightbox-img/);
});

test('la visionneuse refuse un indice hors limites', () => {
  const manager = new PackageManager(makeArea());
  const attachments = [{ url: 'https://cdn.discordapp.com/a/1.png', fileName: '1.png' }];
  assert.equal(manager.clampLightboxIndex(5, 1), 0, 'un indice trop grand revient au debut');
  assert.equal(manager.clampLightboxIndex(-2, 1), 0);
  assert.equal(manager.clampLightboxIndex(0, 1), 0);
});

test('la visionneuse echappe les noms de fichiers', () => {
  const manager = new PackageManager(makeArea());
  const html = manager.lightboxHtml([{ url: 'https://cdn.discordapp.com/a/x.png', fileName: '<script>alert(1)</script>' }], 0);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
});

// ---------------------------------------------------------------------------
// Panneau de progression : sans lui, un nettoyage long donne l impression que
// l application ne fait rien.
// ---------------------------------------------------------------------------

test('le panneau affiche un compteur et un pourcentage', () => {
  const html = progressPanelHtml({ title: 'Nettoyage', done: 3, total: 12 });
  assert.match(html, /3 \/ 12/);
  assert.match(html, /width:25%/);
  assert.match(html, /Nettoyage/);
});

test('le detail de l operation en cours est affiche', () => {
  const html = progressPanelHtml({ title: 'Suppression', done: 1, total: 9, detail: '#general' });
  assert.match(html, /#general/);
});

test('un total inconnu ne produit pas de pourcentage faux', () => {
  const html = progressPanelHtml({ title: 'Import', done: 5, total: 0 });
  assert.doesNotMatch(html, /NaN/);
  assert.match(html, /width:0%/);
});

test('l etat termine est distingue de l etat en cours', () => {
  assert.match(progressPanelHtml({ title: 'X', done: 2, total: 2, state: 'done' }), /is-done/);
  assert.match(progressPanelHtml({ title: 'X', done: 0, total: 2, state: 'failed' }), /is-failed/);
});

test('le detail est echappe', () => {
  const html = progressPanelHtml({ title: '<script>', done: 0, total: 1, detail: '"><img onerror=1>' });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('le panneau se ferme et libere son etat', () => {
  closeProgressPanel();
  assert.equal(isProgressPanelOpen(), false, 'aucun document : le panneau reste fermable');
  // Sans DOM, showProgressPanel ne doit pas laisser d etat fantome.
  const state = showProgressPanel({ title: 'X', total: 1 });
  assert.equal(state.title, 'X');
  updateProgressPanel({ done: 1 });
  finishProgressPanel({ detail: 'termine', autoClose: 0 });
  closeProgressPanel();
  assert.equal(isProgressPanelOpen(), false);
});

test('la lecture puis l extraction remplissent une seule barre', () => {
  const manager = new PackageManager(makeArea());
  manager.renderThrottled = () => {};
  const item = { status: 'processing', percent: 0, startedAt: Date.now() - 4000 };

  // Lecture : 0 a 30 %, jamais jusqu a 100 %.
  manager.applyImportProgress(item, { current: 500, total: 1000, stage: 'Lecture du ZIP', bytes: true });
  assert.ok(item.percent <= 30, `la lecture reste dans son tiers (${item.percent})`);
  const afterRead = item.percent;

  // Extraction : le debut ne doit pas repartir de zero.
  manager.applyImportProgress(item, { current: 1, total: 667, stage: 'Extraction des messages' });
  assert.ok(item.percent > afterRead, `l extraction enchaîne sans remise à zéro (${afterRead} -> ${item.percent})`);
  assert.ok(item.percent >= 30);

  manager.applyImportProgress(item, { current: 667, total: 667, stage: 'Extraction des messages' });
  assert.equal(Math.round(item.percent), 100);
});

test('la progression ne recule jamais', () => {
  const manager = new PackageManager(makeArea());
  manager.renderThrottled = () => {};
  const item = { status: 'processing', percent: 0, startedAt: Date.now() - 1000 };
  const samples = [];
  manager.applyImportProgress(item, { current: 900, total: 1000, stage: 'Lecture du ZIP', bytes: true });
  samples.push(item.percent);
  for (let i = 0; i <= 20; i += 1) {
    manager.applyImportProgress(item, { current: i * 30, total: 667, stage: 'Extraction des messages' });
    samples.push(item.percent);
  }
  for (let i = 1; i < samples.length; i += 1) {
    assert.ok(samples[i] >= samples[i - 1] - 0.001, `recul entre ${samples[i - 1]} et ${samples[i]}`);
  }
});

test('l affichage annonce un pourcentage et un temps restant', () => {
  const manager = new PackageManager(makeArea());
  manager.renderThrottled = () => {};
  const item = { status: 'processing', percent: 0, startedAt: Date.now() - 5000 };
  manager.applyImportProgress(item, { current: 50, total: 100, stage: 'Lecture du ZIP', bytes: true });
  assert.match(item.statusText, /15 %/, 'la lecture ne depasse pas son tiers');
  assert.match(item.statusText, /restantes/, 'un temps restant est estime sur l avancement global');
});

test('la progression d import met a jour le pourcentage de la file', () => {
  const manager = new PackageManager(makeArea());
  const item = { file: { name: 'package.zip', size: 1 }, status: 'processing', percent: 0, startedAt: Date.now() - 4000 };

  manager.applyImportProgress(item, { current: 50, total: 200, stage: 'Extraction des messages' });

  assert.equal(Math.round(item.percent), 48, 'l extraction occupe les 70 % restants : 30 + 17,5');
  assert.match(item.statusText, /Extraction des messages/, 'le libelle reprend le stage');
});

test('la progression d import resiste a une info vide ou erronee', () => {
  const manager = new PackageManager(makeArea());
  const item = { file: { name: 'package.zip', size: 1 }, status: 'processing', percent: 0, startedAt: Date.now() };

  assert.doesNotThrow(() => manager.applyImportProgress(item, undefined));
  assert.equal(item.percent, 0, 'total inconnu ne donne pas NaN');
  assert.doesNotThrow(() => manager.applyImportProgress(item, {}));
  assert.equal(item.percent, 0, 'current absent ne donne pas NaN');
});

test('le rendu est throttle : plusieurs ticks ne produisent qu un rendu differe', async () => {
  const manager = new PackageManager(makeArea());
  manager.package = samplePackage();
  let renders = 0;
  manager.render = () => { renders += 1; };
  manager.renderTimer = null;

  manager.renderThrottled(5);
  manager.renderThrottled(5);
  manager.renderThrottled(5);
  assert.equal(renders, 0, 'rien ne part avant le delai');

  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(renders, 1, 'les trois ticks ont produit un seul rendu');

  manager.renderThrottled(5);
  manager.renderNow();
  assert.equal(renders, 2, 'renderNow force et purge le rendu en attente');
  assert.equal(manager.renderTimer, null, 'plus de timer en vol');
});

test('le filtre masque les serveurs quittes quand on l active', () => {
  const manager = new PackageManager(makeArea());
  const pkg = filteredPackage();
  pkg.channels.push({ id: 'quitte', name: 'salon-ancien', type: 'SERVER_TEXT', guildId: null, guildName: null, recipient: null, isLeft: true, messagesCount: 3 });
  manager.package = pkg;
  manager.channelKindFilter = 'all';
  assert.ok(manager.filteredChannels().some(c => c.id === 'quitte'), 'serveurs quittes visibles par defaut');
  manager.hideLeftServers = true;
  assert.ok(!manager.filteredChannels().some(c => c.id === 'quitte'), 'serveurs quittes masques quand le filtre est actif');
});

test('la barre de filtres propose masquer les serveurs quittes', () => {
  const manager = new PackageManager(makeArea());
  manager.package = filteredPackage();
  const html = manager.renderChannelFilterBar();
  assert.match(html, /data-hide-left/, 'interrupteur present');
  assert.doesNotMatch(html, /data-hide-left checked/, 'desactive par defaut');
  assert.match(html, /Masquer les serveurs quittés/);
});

test('la barre du haut regroupe les actions secondaires en menus', () => {
  const manager = new PackageManager(makeArea());
  manager.package = samplePackage();
  manager.render();
  const html = manager.contentArea.innerHTML;
  assert.match(html, /data-package-action="gallery"/);
  assert.match(html, /data-package-action="delete"/);
  assert.match(html, /data-package-action="close"/);
  assert.match(html, /data-package-action="download-all"/);
  assert.match(html, /data-package-action="purge-media"/);
  assert.match(html, /data-package-action="export" data-export-format="zip"/);
  assert.match(html, /data-package-action="export" data-export-format="json"/);
  assert.match(html, /package-menu-trigger/, 'les actions secondaires vivent dans des menus');
});

test('le filtre masque les groupes vides quand on l active', () => {
  const manager = new PackageManager(makeArea());
  const pkg = filteredPackage();
  pkg.channels.push({ id: 'grp-vide', name: 'groupe-vide', type: 'GROUP', guildId: null, guildName: null, recipient: null, isLeft: false, messagesCount: 0 });
  manager.package = pkg;
  manager.channelKindFilter = 'all';
  assert.ok(manager.filteredChannels().some(c => c.id === 'grp-vide'), 'groupes vides visibles par defaut');
  assert.match(manager.renderChannelFilterBar(), /data-hide-empty-groups/, 'interrupteur present');
  manager.hideEmptyGroups = true;
  assert.ok(!manager.filteredChannels().some(c => c.id === 'grp-vide'), 'groupes vides masques quand le filtre est actif');
});
