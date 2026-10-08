import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PackageManager } from '../src/components/PackageManager.js';
import { showProgressModal } from '../src/utils/ui.js';
import { GALLERY_COLUMNS, GALLERY_GAP } from '../src/services/galleryIndex.service.js';

// Un DOM minimal : `showProgressModal` construit des noeuds et les ecoute. Le
// depot n'a pas de jsdom, on fournit donc juste ce que la fonction touche.
function makeDocument() {
  const created = [];
  const document = {
    createElement(tag) {
      const el = {
        tag,
        children: [],
        listeners: {},
        className: '',
        textContent: '',
        style: {},
        disabled: false,
        appendChild(child) { this.children.push(child); return child; },
        addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
        remove() { this.removed = true; },
        focus() {},
        click() { (this.listeners.click || []).slice().forEach(fn => fn({})); },
      };
      created.push(el);
      return el;
    },
    body: { children: [], appendChild(el) { this.children.push(el); } },
  };
  return { document, created };
}

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

test('une tuile de fichier miree enregistre depuis l URL distante, pas la copie locale', () => {
  const m = new PackageManager(makeArea());
  m.package = paquetAvecMedias();
  m.galleryIndex = [
    { channelId: '111', channelName: 'general', messageId: 'm2', timestamp: '2024-02-01T10:00:00.000Z',
      url: 'https://cdn.discordapp.com/attachments/1/2/archive.zip', fileName: 'archive.zip', kind: 'file', ext: 'zip' },
  ];
  m.mediaManifest = new Map([['https://cdn.discordapp.com/attachments/1/2/archive.zip', 'media://mirror/k/111/abc-archive.zip']]);
  const appels = [];
  m.saveAttachment = attachment => { appels.push(attachment); };
  m.openGalleryTile({ dataset: { galleryTile: '0', attachmentIndex: '0' } });
  assert.equal(appels.length, 1, 'le clic enregistre le fichier');
  assert.doesNotMatch(appels[0].url, /^media:\/\//, 'saveAttachment est un telechargement : jamais la source locale');
  assert.equal(appels[0].url, 'https://cdn.discordapp.com/attachments/1/2/archive.zip', 'l URL distante d origine');
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

test('la source locale est preferee quand le manifeste la declare finie', () => {
  const m = new PackageManager(makeArea());
  m.mediaManifest = new Map([['https://cdn.discordapp.com/a/1.png', 'media://mirror/k/c/1.png']]);
  assert.equal(m.mediaSourceFor({ url: 'https://cdn.discordapp.com/a/1.png' }), 'media://mirror/k/c/1.png');
  assert.equal(m.mediaSourceFor({ url: 'https://cdn.discordapp.com/a/2.png' }), 'https://cdn.discordapp.com/a/2.png');
});

test('la toolbar propose le telechargement des medias', () => {
  const m = new PackageManager(makeArea());
  m.package = paquetAvecMedias();
  m.render();
  assert.match(m.contentArea.innerHTML, /data-package-action="download-all"/);
});

// ---------------------------------------------------------------------------
// F4 : la visionneuse charge la COPIE LOCALE quand le manifeste la declare
// finie, comme les tuiles. Sans cela, ouvrir une image locale repartait sur le
// CDN (et cassait si l'URL signee avait expire).
// ---------------------------------------------------------------------------

test('la visionneuse charge la copie locale pour img, video et audio (F4)', () => {
  const m = new PackageManager(makeArea());
  m.mediaManifest = new Map([
    ['https://cdn.discordapp.com/a/b/c.png', 'media://mirror/k/c/abc-c.png'],
    ['https://cdn.discordapp.com/a/b/d.mp4', 'media://mirror/k/c/def-d.mp4'],
    ['https://cdn.discordapp.com/a/b/e.ogg', 'media://mirror/k/c/ghi-e.ogg'],
  ]);
  const img = m.lightboxHtml([{ url: 'https://cdn.discordapp.com/a/b/c.png', fileName: 'c.png', kind: 'image' }], 0);
  assert.match(img, /src="media:\/\/mirror\/k\/c\/abc-c\.png"/);
  const video = m.lightboxHtml([{ url: 'https://cdn.discordapp.com/a/b/d.mp4', fileName: 'd.mp4', kind: 'video' }], 0);
  assert.match(video, /src="media:\/\/mirror\/k\/c\/def-d\.mp4"/);
  const audio = m.lightboxHtml([{ url: 'https://cdn.discordapp.com/a/b/e.ogg', fileName: 'e.ogg', kind: 'audio' }], 0);
  assert.match(audio, /src="media:\/\/mirror\/k\/c\/ghi-e\.ogg"/);
});

test('un format non lisible enregistre depuis l URL distante, pas la copie locale (F4)', () => {
  const m = new PackageManager(makeArea());
  m.mediaManifest = new Map([['https://cdn.discordapp.com/a/b/c.mov', 'media://mirror/k/c/abc-c.mov']]);
  const html = m.lightboxHtml([{ url: 'https://cdn.discordapp.com/a/b/c.mov', fileName: 'c.mov', kind: 'video' }], 0);
  assert.match(html, /data-save-url="https:\/\/cdn\.discordapp\.com\/a\/b\/c\.mov"/, 'enregistrer est un telechargement reseau');
  assert.doesNotMatch(html, /data-save-url="media:\/\//);
});

// ---------------------------------------------------------------------------
// F2 : l'annulation est cablee. `showProgressModal` accepte `onCancel` et rend
// un bouton « Annuler » ; un second clic ne peut pas empiler d'abonnement.
// ---------------------------------------------------------------------------

test('showProgressModal : sans onCancel, aucun bouton Annuler (retro-compatible)', () => {
  const { document, created } = makeDocument();
  const avant = globalThis.document;
  globalThis.document = document;
  try {
    const modal = showProgressModal('Téléchargement', 5);
    assert.equal(typeof modal.updateProgress, 'function');
    assert.equal(typeof modal.closeModal, 'function');
    assert.equal(created.some(el => el.textContent === 'Annuler'), false, 'aucun bouton quand onCancel est absent');
    assert.equal(created.some(el => el.textContent === '0/5'), true, 'la progression commence a 0/total');
  } finally {
    globalThis.document = avant;
  }
});

test('showProgressModal : onCancel rend un bouton Annuler qui se desactive', () => {
  const { document, created } = makeDocument();
  const avant = globalThis.document;
  globalThis.document = document;
  const appels = [];
  try {
    showProgressModal('Téléchargement', 5, { onCancel: () => appels.push('annule') });
    const bouton = created.find(el => el.textContent === 'Annuler');
    assert.ok(bouton, 'un bouton Annuler est rendu');
    bouton.click();
    assert.deepEqual(appels, ['annule'], 'le clic appelle onCancel une fois');
    assert.equal(bouton.disabled, true, 'et le bouton se desactive');
    bouton.click();
    assert.deepEqual(appels, ['annule'], 'un second clic ne rappelle pas onCancel');
  } finally {
    globalThis.document = avant;
  }
});

test('downloadAllMedia : un second clic desabonne la progression du premier (F2)', async () => {
  const m = new PackageManager(makeArea());
  m.package = paquetAvecMedias();
  m.mediaItems = () => [{ url: 'https://x/p.png', fileName: 'p.png', kind: 'image', channelId: 'c' }];
  m.syncMediaManifest = async () => {};

  let abonnes = 0;
  const desabonnements = [];
  const morts = new Set();
  const demarrages = [];
  const api = {
    mediaMirror: {
      start: () => new Promise(resolve => { demarrages.push(resolve); }),
      status: async () => ({ key: 'k', entries: [] }),
      cancel: async () => ({ ok: true }),
      onProgress: () => {
        abonnes += 1;
        const numero = abonnes;
        return () => { if (!morts.has(numero)) { morts.add(numero); desabonnements.push(numero); } };
      },
    },
  };
  const windowAvant = globalThis.window;
  const docAvant = globalThis.document;
  const { document } = makeDocument();
  globalThis.window = { electronAPI: api };
  globalThis.document = document;
  try {
    const premier = m.downloadAllMedia();
    const second = m.downloadAllMedia();
    assert.deepEqual(desabonnements, [1], 'le second abonnement desabonne d abord le premier');
    demarrages.forEach(resolve => resolve({ ok: true }));
    await Promise.all([premier, second]);
  } finally {
    globalThis.window = windowAvant;
    globalThis.document = docAvant;
  }
});

test('downloadAllMedia : le clic annuler appelle mediaMirror.cancel (F2)', async () => {
  const m = new PackageManager(makeArea());
  m.package = paquetAvecMedias();
  m.mediaItems = () => [{ url: 'https://x/p.png', fileName: 'p.png', kind: 'image', channelId: 'c' }];
  m.syncMediaManifest = async () => {};

  const annulations = [];
  let resolveStart;
  const api = {
    mediaMirror: {
      start: () => new Promise(resolve => { resolveStart = resolve; }),
      status: async () => ({ key: 'k', entries: [] }),
      cancel: async () => { annulations.push('cancel'); return { ok: true }; },
      onProgress: () => () => {},
    },
  };
  const windowAvant = globalThis.window;
  const docAvant = globalThis.document;
  const { document, created } = makeDocument();
  globalThis.window = { electronAPI: api };
  globalThis.document = document;
  try {
    const promesse = m.downloadAllMedia();
    const bouton = created.find(el => el.textContent === 'Annuler');
    assert.ok(bouton, 'la modale de progression propose Annuler');
    bouton.click();
    assert.deepEqual(annulations, ['cancel'], 'le clic annule le telechargement cote main');
    resolveStart?.({ ok: true });
    await promesse;
  } finally {
    globalThis.window = windowAvant;
    globalThis.document = docAvant;
  }
});

test('le defilement de la galerie desactive l ancrage de scroll', () => {
  const css = readFileSync(new URL('../src/styles/app.css', import.meta.url), 'utf8');
  const regle = css.match(/\.package-gallery-scroll\s*\{[^}]*\}/);
  assert.ok(regle, 'la regle .package-gallery-scroll existe');
  assert.match(regle[0], /overflow-anchor:\s*none/, 'sans overflow-anchor:none l ancrage fait s emballer la grille virtualisee');
});

// ---------------------------------------------------------------------------
// Recyclage : galleryTilesForRows borne le dernier rang partiel et garde
// l index ABSOLU de chaque tuile. Sans cela, une tuile ajoutee en tete aurait
// l index 0 et ouvrirait le premier media de la galerie, pas le sien.
// ---------------------------------------------------------------------------

test('galleryTilesForRows borne le dernier rang et garde les index absolus', () => {
  const m = galerieDeTest();
  const items = m.galleryIndex;
  assert.equal(items.length, 5, 'la fixture porte cinq medias');
  // Rangs 0..1 : les quatre premiers items, index absolus 0 a 3.
  const premier = m.galleryTilesForRows(items, 0, 1);
  assert.equal((premier.match(/data-gallery-tile=/g) || []).length, 4, 'un rang plein de quatre tuiles');
  assert.ok(premier.includes('data-gallery-tile="0"') && premier.includes('data-gallery-tile="3"'));
  // Rang 1..2 : un seul item restant : borne par items.length, pas 4.
  const dernier = m.galleryTilesForRows(items, 1, 2);
  assert.equal((dernier.match(/data-gallery-tile=/g) || []).length, 1, 'le dernier rang est partiel');
  assert.ok(dernier.includes('data-gallery-tile="4"'), 'l index reste ABSOLU, jamais renumberote');
  assert.ok(!dernier.includes('data-gallery-tile="0"'), 'aucune renumerotation');
  // Un rang entierement au dela de la fin ne rend rien, sans exception.
  assert.equal(m.galleryTilesForRows(items, 5, 6).trim(), '');
});

test('la galerie occupe toute la largeur, pas la colonne des salons', () => {
  const manager = galerieDeTest();
  assert.match(manager.contentArea.innerHTML, /package-layout-gallery/, 'mise en page une colonne en galerie');
});

test('la modale info monte son contenu dans l overlay', () => {
  const src = readFileSync(new URL('../src/utils/ui.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export const showInfoModal'), src.indexOf('export const showInputModal'));
  const montageContenu = fn.indexOf('modal.appendChild(content)');
  const montageOverlay = fn.indexOf('document.body.appendChild(modal)');
  assert.ok(montageContenu > -1, 'modal.appendChild(content) est present (sans lui, l overlay est vide)');
  assert.ok(montageContenu < montageOverlay, 'le contenu est monte AVANT l overlay');
});

test('l ecran de connexion propose Connexion avec Discord', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /id="discordLoginBtn"/);
  assert.match(html, /Connexion avec Discord/);
});
