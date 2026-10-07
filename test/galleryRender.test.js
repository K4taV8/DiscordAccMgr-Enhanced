import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PackageManager } from '../src/components/PackageManager.js';
import { GALLERY_COLUMNS, GALLERY_GAP } from '../src/services/galleryIndex.service.js';

// La mosaique des 2 208 pieces jointes n a pas de DOM dans ce depot : les
// assertions portent sur la chaine HTML rendue, comme dans packageRender.
// makeArea() est repris a l identique de test/packageRender.test.js:13-21.

function makeArea() {
  return {
    innerHTML: '',
    className: '',
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

// Fixture propre a ce fichier : un salon avec des medias de chaque genre,
// un salon sans aucun media (le cas dominant dans les 667 salons), et un
// nom de fichier Discord qui n est pas une donnee fiable.
function paquetAvecMedias() {
  const messages = new Map();
  messages.set('111', [
    { id: 'm1', timestamp: '2024-03-01T10:00:00.000Z', content: 'captures', attachments: [
      { url: 'https://cdn.discordapp.com/attachments/1/2/photo.png', fileName: 'photo.png' },
      { url: 'https://cdn.discordapp.com/attachments/1/2/clip.mp4', fileName: 'clip.mp4' },
    ] },
    { id: 'm2', timestamp: '2024-02-01T10:00:00.000Z', content: 'sons et fichiers', attachments: [
      { url: 'https://cdn.discordapp.com/attachments/1/2/voix.ogg', fileName: 'voix.ogg' },
      { url: 'https://cdn.discordapp.com/attachments/1/2/archive.zip', fileName: 'archive.zip' },
      { url: 'https://cdn.discordapp.com/attachments/1/2/piege.png', fileName: '<img src=x onerror=alert(1)>.png' },
    ] },
  ]);
  messages.set('222', [
    { id: 'm3', timestamp: '2024-01-05T10:00:00.000Z', content: 'rien a afficher', attachments: [] },
  ]);
  return {
    user: { id: '9', username: 'tester', globalName: 'Testeur', avatar: null },
    guilds: [{ id: 'g1', name: 'Les Pangolins', icon: null }],
    channels: [
      { id: '111', name: 'general', type: 'SERVER_TEXT', guildId: 'g1', guildName: 'Les Pangolins', recipient: null, isLeft: false, messagesCount: 2 },
      { id: '222', name: 'sans-media', type: 'SERVER_TEXT', guildId: 'g1', guildName: 'Les Pangolins', recipient: null, isLeft: false, messagesCount: 1 },
    ],
    messages,
    totalMessages: 3,
    packageSizeBytes: 10,
  };
}

function galerieDeTest() {
  const manager = new PackageManager(makeArea());
  manager.package = paquetAvecMedias();
  manager.view = 'gallery';
  manager.render();
  return manager;
}

test('la galerie rend une grille de 4 colonnes de tuiles carrees', () => {
  const manager = galerieDeTest();
  const html = manager.contentArea.innerHTML;
  assert.equal(GALLERY_COLUMNS, 4, 'quatre colonnes, venu du service');
  assert.ok(html.includes('grid-template-columns: repeat(4'), 'quatre colonnes dans le HTML rendu');
  assert.ok(html.includes('aspect-ratio: 1'), 'le ratio reserve la place : aucune dimension d image n est connue');
  assert.ok(html.includes('data-gallery-tile="0"'), 'premiere tuile');
  // Largeur non mesurable au premier rendu (makeArea ne rend rien) : la grille
  // sort COMPLETE, pas vide. Les cinq pieces jointes sont la.
  assert.ok(html.includes('data-gallery-tile="4"'), 'grille complete sans windowing tant que la largeur est nulle');
  assert.ok(html.includes(`gap: ${GALLERY_GAP}px`), 'gouttiere prise a GALLERY_GAP, pas a un literal');
});

test('un nom de fichier piege est echappe dans la tuile', () => {
  const html = galerieDeTest().contentArea.innerHTML;
  assert.ok(!html.includes('<img src=x'), 'aucune injection d element');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;.png'), 'nom echappe dans la tuile');
});

test('une tuile video et une tuile audio ne chargent aucun media', () => {
  const html = galerieDeTest().contentArea.innerHTML;
  assert.ok(!html.includes('<video'), 'aucun element video dans la grille');
  assert.ok(!html.includes('<audio'), 'aucun element audio dans la grille');
  assert.ok(html.includes('clip.mp4'), 'nom de la video affiche');
  assert.ok(html.includes('voix.ogg'), 'nom de l audio affiche');
  assert.ok(html.includes('data-gallery-open'), 'les tuiles restent cliquables');
});

test('un filtre qui ne laisse rien affiche un etat vide explicite', () => {
  const manager = galerieDeTest();
  manager.galleryFilter.channelId = '222';
  manager.render();
  const html = manager.contentArea.innerHTML;
  assert.ok(html.includes('Aucun media dans ce salon'), 'etat vide explicite');
  assert.ok(html.includes('data-gallery-filter'), 'les filtres restent accessibles');
  assert.ok(html.includes('data-gallery-kind'), 'puces de genre presentes');
  assert.ok(html.includes('data-gallery-channel'), 'selecteur de salon present');
});

test('la tuile image est chargee paresseusement et passe par mediaSourceFor', () => {
  const manager = galerieDeTest();
  const urls = manager.galleryIndex.map(item => item.url);
  assert.ok(urls.length > 0, 'index construit au premier affichage');
  manager.mediaSourceFor = () => 'sentinelle://miroir-local';
  manager.render();
  const html = manager.contentArea.innerHTML;
  assert.ok(html.includes('loading="lazy"'), 'chargement paresseux');
  assert.ok(html.includes('decoding="async"'), 'decodage asynchrone');
  assert.ok(html.includes('data-attachment-img'), 'meme attribut que le rendu dans les messages');
  assert.ok(html.includes('src="sentinelle://miroir-local"'), 'le src vient du point de couture');
  for (const url of urls) assert.ok(!html.includes(url), `item.url jamais inline : ${url}`);
});

test('le tri recent-par-defaut propose un bouton qui inverse', async () => {
  const manager = galerieDeTest();
  assert.equal(manager.galleryFilter.tri, 'recent', 'tri par defaut');
  assert.ok(manager.contentArea.innerHTML.includes('data-gallery-sort="ancien"'), 'le bouton propose lint inverse');

  const cible = { dataset: { gallerySort: 'ancien' } };
  await manager.handleClick({
    target: { closest: selector => (selector === '[data-gallery-sort]' ? cible : null) },
  });
  assert.equal(manager.galleryFilter.tri, 'ancien', 'le bouton inverse le tri');
  assert.ok(manager.contentArea.innerHTML.includes('data-gallery-sort="recent"'), 'le bouton propose le retour');
});

test('le lecteur rend une video avec ses controles et son lancement', () => {
  const m = new PackageManager(makeArea());
  const html = m.lightboxHtml([{ url: 'https://cdn.discordapp.com/a/b/c.mp4', fileName: 'c.mp4', kind: 'video' }], 0);
  assert.match(html, /<video /);
  assert.match(html, /controls/);
  assert.match(html, /playsinline/);
  assert.match(html, /preload="metadata"/);
});

test('le lecteur rend un audio, et pas un <img>', () => {
  const m = new PackageManager(makeArea());
  const html = m.lightboxHtml([{ url: 'https://cdn.discordapp.com/a/b/c.ogg', fileName: 'c.ogg', kind: 'audio' }], 0);
  assert.match(html, /<audio /);
  assert.doesNotMatch(html, /<img /, 'un audio dans un img ne donnerait rien');
});

test('un format non lisible est nomme, explique, et propose l enregistrement', () => {
  // 5 .mov et 1 .mkv resteront muets : Chromium n'a pas ces decodeurs.
  const m = new PackageManager(makeArea());
  const html = m.lightboxHtml([{ url: 'https://cdn.discordapp.com/a/b/c.mov', fileName: 'c.mov', kind: 'video' }], 0);
  assert.match(html, /c\.mov/, 'le nom du fichier est nomme');
  assert.match(html, /non lisible/i);
  assert.match(html, /data-save-attachment/, 'une sortie reelle, pas un cul-de-sac');
});

test('le lecteur navigue entre media lisibles et ignore les fichiers ordinaires', () => {
  const m = new PackageManager(makeArea());
  const liste = [
    { url: 'https://cdn.discordapp.com/a/b/c.png', fileName: 'c.png', kind: 'image' },
    { url: 'https://cdn.discordapp.com/a/b/d.pdf', fileName: 'd.pdf', kind: 'file' },
    { url: 'https://cdn.discordapp.com/a/b/e.mp4', fileName: 'e.mp4', kind: 'video' },
  ];
  const html = m.lightboxHtml(liste, 2);
  assert.match(html, /e\.mp4/, 'on est sur la video demandee');
  assert.match(html, /2 sur 2|2 \/ 2/, 'le compteur ignore le pdf (2 medias lisibles)');
  // La position est compte a partir de 1 et suit l ordre de lecture : le premier
  // des deux medias lisibles doit afficher « 1 / 2 », pas le denominateur.
  const premier = m.lightboxHtml(liste, 0);
  assert.match(premier, /1 sur 2|1 \/ 2/, 'la premiere position est 1, pas 2');
});

test('le repli d une image cassee ne redirige plus vers la visionneuse', () => {
  // Aujourd hui : preventDefault puis openLightbox, qui rafraichit la meme
  // image cassee. Et target="_blank est refuse par setWindowOpenHandler.
  const m = new PackageManager(makeArea());
  const html = m.attachmentHtml({ url: 'https://cdn.discordapp.com/a/b/c.png', fileName: 'c.png' }, 0, 'k');
  assert.doesNotMatch(html, /target="_blank"/, 'la sortie refusee ne doit plus etre proposee');
});

test('le compteur du lecteur augmente avec la position, jamais ne decompte', () => {
  const m = new PackageManager(makeArea());
  const images = [
    { url: 'https://cdn.discordapp.com/a/1.png', fileName: '1.png', kind: 'image' },
    { url: 'https://cdn.discordapp.com/a/2.png', fileName: '2.png', kind: 'image' },
    { url: 'https://cdn.discordapp.com/a/3.png', fileName: '3.png', kind: 'image' },
  ];
  assert.match(m.lightboxHtml(images, 0), /1 \/ 3/, 'le premier des trois est « 1 / 3 »');
  assert.match(m.lightboxHtml(images, 1), /2 \/ 3/, 'le deuxieme des trois est « 2 / 3 »');
  assert.match(m.lightboxHtml(images, 2), /3 \/ 3/, 'le dernier des trois est « 3 / 3 »');
});

test('une tuile de fichier ordinaire propose l enregistrement, pas un onglet mort', () => {
  const m = new PackageManager(makeArea());
  m.package = paquetAvecMedias();
  m.galleryIndex = [
    { channelId: '111', channelName: 'general', messageId: 'm2', timestamp: '2024-02-01T10:00:00.000Z',
      url: 'https://cdn.discordapp.com/attachments/1/2/archive.zip', fileName: 'archive.zip', kind: 'file', ext: 'zip' },
  ];
  const appels = [];
  m.saveAttachment = attachment => { appels.push(attachment); };
  m.openGalleryTile({ dataset: { galleryTile: '0', attachmentIndex: '0' } });
  assert.equal(appels.length, 1, 'le clic enregistre le fichier au lieu de n rien faire');
  assert.match(appels[0].url, /archive\.zip/);
  assert.equal(appels[0].fileName, 'archive.zip');
});

test('le mode focus a disparu du composant', () => {
  const src = readFileSync(new URL('../src/components/PackageManager.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /focusMode/, 'ni le champ');
  assert.doesNotMatch(src, /data-package-action="focus"/, 'ni le bouton');
  assert.doesNotMatch(src, /package-focus-mode/, 'ni la classe');
});

test('le mode focus a disparu de la feuille de style', () => {
  const css = readFileSync(new URL('../src/styles/app.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /\.package-focus-mode/, 'les deux regles CSS');
});

test('la toolbar propose la galerie, la ou etait le focus', () => {
  const m = new PackageManager(makeArea());
  m.package = paquetAvecMedias();
  m.view = 'messages';
  m.render();
  assert.match(m.contentArea.innerHTML, /data-package-action="gallery"/);
});
