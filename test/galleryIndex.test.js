import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GALLERY_COLUMNS, GALLERY_GAP, mediaKindOf, buildMediaIndex, filterMedia, tileSizeFor, galleryWindow,
} from '../src/services/galleryIndex.service.js';

// Reperes de la section 5.3 : la CSP interdit file://, donc une copie locale
// ne peut pas passer par un src de fichier. Ce point de couture est ce que le
// plan 2 remplira.

// Sur l'archive reelle : 667 salons, 27 325 messages, 2 208 pieces jointes
// (1 778 images, 225 videos, 161 audios, 44 fichiers). Toutes les tuiles ne
// peuvent pas etre rendues d'un coup : d'ou le windowing, calque sur
// channelWindow(), que ce service reproduit en rangs de grille.
function paquetDeTest() {
  return {
    user: { id: '1' },
    guilds: [],
    channels: [{ id: '111111111111111111', name: 'general', type: 0 }],
    messages: new Map([
      ['111111111111111111', [
        { id: 'a1', timestamp: '2024-01-01T10:00:00.000Z',
          attachments: [{ url: 'https://cdn.discordapp.com/attachments/1/2/a.png', fileName: 'a.png' }] },
        { id: 'a2', timestamp: '2024-03-01T10:00:00.000Z',
          attachments: [
            { url: 'https://cdn.discordapp.com/attachments/1/2/b.mp4', fileName: 'b.mp4' },
            { url: 'https://cdn.discordapp.com/attachments/1/2/c.pdf', fileName: 'c.pdf' },
          ] },
        { id: 'a3', timestamp: '2024-02-01T10:00:00.000Z', attachments: [] },
      ]],
    ]),
  };
}

test('chaque piece jointe devient une entree, la plus recente en premier', () => {
  const items = buildMediaIndex(paquetDeTest());
  assert.equal(items.length, 3, 'trois pieces jointes, un message vide n ajoute rien');
  assert.deepEqual(items.map(i => i.fileName), ['b.mp4', 'c.pdf', 'a.png']);
  assert.equal(items[0].channelName, 'general');
  assert.equal(items[0].channelId, '111111111111111111');
  assert.equal(items[0].kind, 'video');
  assert.equal(items[0].messageId, 'a2', 'le message source reste trace');
  assert.equal(items[0].url, 'https://cdn.discordapp.com/attachments/1/2/b.mp4');
  assert.equal(items[2].timestamp, '2024-01-01T10:00:00.000Z');
});

test('le genre se deduit de l extension, jamais du chemin ni de la requete', () => {
  assert.equal(mediaKindOf('photo.png'), 'image');
  assert.equal(mediaKindOf('clip.mp4'), 'video');
  assert.equal(mediaKindOf('voice.ogg'), 'audio');
  assert.equal(mediaKindOf('doc.pdf'), 'file');
  assert.equal(mediaKindOf('IMG_0042.JPG'), 'image', 'la casse ne compte pas');

  // Les URL de Discord sont signees : ?ex=&is=&hm= contient des points qui
  // trompent une simple recherche du dernier point de la chaine. Si le genre
  // sortait de l'URL, la video ci-dessous vaudrait "file" (9f8e7d6c n'est pas
  // une extension) et l'image aussi (son chemin n'a aucun point).
  const paquet = paquetDeTest();
  const messages = paquet.messages.get('111111111111111111');
  messages.length = 0;
  messages.push(
    { id: 's1', timestamp: '2024-05-01T10:00:00.000Z', attachments: [{
      url: 'https://cdn.discordapp.com/attachments/1/2/clip.mp4?ex=6612a1b2&is=6612b3c4&hm=a1b2c3d4.9f8e7d6c',
      fileName: 'clip.mp4' }] },
    { id: 's2', timestamp: '2024-06-01T10:00:00.000Z', attachments: [{
      url: 'https://cdn.discordapp.com/attachments/1/2/photo?ex=6612a1b2&is=6612b3c4&hm=a1b2c3d4.9f8e7d6c',
      fileName: 'photo.png' }] },
  );
  const items = buildMediaIndex(paquet);
  const video = items.find(i => i.messageId === 's1');
  const image = items.find(i => i.messageId === 's2');
  assert.equal(video.kind, 'video', "le point de hm= ne doit pas decider du genre");
  assert.equal(video.ext, 'mp4');
  assert.equal(image.kind, 'image', "le chemin de l'URL n'a aucun point : seul fileName compte");
  assert.equal(image.ext, 'png');
});

test('l extension porte le dernier segment du nom, jamais un segment du milieu', () => {
  // Un nom a plusieurs points ne doit pas etre coupe au premier : sinon
  // archive.tar.gz afficherait "tar" et photo.2024.png afficherait "2024", donc
  // une tuile image etiquetee d'une annee. C est aussi ce qui aligne ext sur
  // kind, qui reste toujours decide par attachmentKind.
  const paquet = paquetDeTest();
  const messages = paquet.messages.get('111111111111111111');
  messages.length = 0;
  messages.push({ id: 'x1', timestamp: '2024-04-01T10:00:00.000Z', attachments: [
    { url: 'https://cdn.discordapp.com/attachments/1/2/archive.tar.gz', fileName: 'archive.tar.gz' },
    { url: 'https://cdn.discordapp.com/attachments/1/2/photo.2024.png', fileName: 'photo.2024.png' },
    { url: 'https://cdn.discordapp.com/attachments/1/2/sans.point', fileName: 'sans.point' },
  ] });
  const parNom = new Map(buildMediaIndex(paquet).map(i => [i.fileName, i]));
  assert.equal(parNom.get('archive.tar.gz').ext, 'gz');
  assert.equal(parNom.get('archive.tar.gz').kind, 'file');
  assert.equal(parNom.get('photo.2024.png').ext, 'png');
  assert.equal(parNom.get('photo.2024.png').kind, 'image', 'une photo reste une image');
  assert.equal(parNom.get('sans.point').ext, 'point');
  assert.equal(parNom.get('sans.point').kind, 'file');
  assert.equal(mediaKindOf('photo.2024.png'), 'image', 'le genre suit le meme segment');
});

test('une piece jointe sans extension reste un fichier, avec un nom', () => {
  // L archive reelle en contient une : le repli ne doit pas la perdre.
  const paquet = paquetDeTest();
  paquet.messages.get('111111111111111111')[0].attachments =
    [{ url: 'https://cdn.discordapp.com/attachments/1/2/sanspoint', fileName: 'sanspoint' }];
  const sansExt = buildMediaIndex(paquet).find(i => i.fileName === 'sanspoint');
  assert.ok(sansExt, 'elle est presente dans la galerie');
  assert.equal(sansExt.kind, 'file');
  assert.equal(sansExt.ext, '', 'aucune extension a afficher');
});

test('une piece jointe repetee deux fois dans un message donne deux tuiles', () => {
  const paquet = paquetDeTest();
  const msg = paquet.messages.get('111111111111111111')[0];
  msg.attachments = [msg.attachments[0], msg.attachments[0]];
  assert.equal(buildMediaIndex(paquet).length, 4, 'on ne deduplique pas : deux emplacements reels');
});

test('un paquet dont messages n est pas une Map rend une liste vide, sans erreur', () => {
  // Un repli silencieux vaut mieux qu une exception dans l interface, mais une
  // intention non verifiee devient un accident : les deux formes sont figees ici.
  assert.deepEqual(buildMediaIndex({ channels: [], messages: [] }), []);
  assert.deepEqual(buildMediaIndex({ channels: [], messages: {} }), []);
});

test('filtreMedia ne garde que ce qui est demande, et vide est un resultat valide', () => {
  const items = buildMediaIndex(paquetDeTest());
  assert.equal(filterMedia(items, { kind: 'image' }).length, 1);
  assert.equal(filterMedia(items, { kind: 'video' }).length, 1);
  assert.equal(filterMedia(items, { kind: 'audio' }).length, 0, 'aucun audio dans ce salon');
  assert.equal(filterMedia(items, { kind: 'all' }).length, 3);
  assert.equal(filterMedia(items, {}).length, 3, 'aucun filtre ne laisse tout passer');
  assert.equal(filterMedia(items, { channelId: '111111111111111111' }).length, 3);
  assert.equal(filterMedia(items, { channelId: '' }).length, 3, 'salon vide = tous les salons');
  assert.equal(filterMedia(items, { kind: 'video', channelId: '111111111111111111' }).length, 1, 'les deux filtres se cumulent');
  assert.equal(filterMedia(items, { channelId: '999' }).length, 0, 'salon sans media');
  assert.equal(filterMedia(items, { kind: 'image', channelId: '999' }).length, 0, 'combinaison vide');
});

test('tileSizeFor deduit la tuile de la largeur et des gouttieres', () => {
  assert.equal(GALLERY_COLUMNS, 4);
  assert.equal(tileSizeFor(1000, 4, 8), 244, '(1000 - 3*8) / 4');
  assert.equal(tileSizeFor(1000, 4, 0), 250);
  assert.equal(tileSizeFor(1000), 244, 'les defauts valent les valeurs du plan');
  assert.ok(tileSizeFor(10, 4, 8) > 0, 'jamais negatif ni nul');
});

test('galleryWindow decoupe la grille en rangs et rend les tampons exacts', () => {
  // 10 items sur 4 colonnes = 3 rangs, de 100 px chacun.
  const w = galleryWindow({ total: 10, columns: 4, scrollTop: 0, viewport: 250, rowHeight: 100, overscan: 0 });
  assert.equal(w.startRow, 0);
  assert.equal(w.endRow, 3);
  assert.equal(w.padTop, 0);
  assert.equal(w.padBottom, 0);

  // 1000 items sur 4 colonnes = 250 rangs de 100 px ; a scrollTop 5000 on est
  // sur le rang 50, donc la fenetre vaut 48..56. Deux EGALITES, pas un
  // encadrement : un encadrement laissait passer une fenetre plus large de
  // quelques rangs, donc quelques tuiles peintes de trop a chaque scroll.
  const defile = galleryWindow({ total: 1000, columns: 4, scrollTop: 5000, viewport: 300, rowHeight: 100, overscan: 2 });
  assert.equal(defile.startRow, 48, '50 rangs precedents a 100 px, moins 2 de marge');
  assert.equal(defile.endRow, 56, '3 rangs visibles, plus 1 de rab, plus 2 de marge');
  assert.equal(defile.padTop, 4800);
  assert.equal(defile.padBottom, 19400, 'les 194 rangs sous la fenetre');
  assert.equal(defile.padTop + (defile.endRow - defile.startRow) * 100 + defile.padBottom, 25000, 'la hauteur totale est preservee au pixel pres');
});

test('la hauteur du rang vient du seul rowHeight', () => {
  // I1 : un rang de grille CSS repeat(4, 1fr) avec gap 8 et des tuiles carrees
  // fait tileSize + gap, pas tileSize. La hauteur est donc l affaire du
  // renderer, qui connait le aspect-ratio et le gap : galleryWindow ne doit plus
  // deduire de hauteur de nulle part ailleurs.
  const taille = tileSizeFor(1200);              // 294
  const hauteurRang = taille + GALLERY_GAP;       // 302 : ce que vaut un rang reellement
  const w = galleryWindow({ total: 2208, columns: 4, scrollTop: 40000, viewport: 800, rowHeight: hauteurRang, overscan: 2 });
  assert.equal(taille, 294);
  assert.equal(hauteurRang, 302);
  assert.equal(w.padTop % hauteurRang, 0, 'le tampon du haut est un nombre entier de rangs');
  assert.equal(w.padBottom % hauteurRang, 0, 'et celui du bas aussi');
  assert.equal(w.padTop + (w.endRow - w.startRow) * hauteurRang + w.padBottom, Math.ceil(2208 / 4) * hauteurRang, 'la barre de defilement mesure la grille reelle');

  // Un tileSize laisse par habitude n a plus aucune prise sur la geometrie.
  const parasite = galleryWindow({ total: 2208, columns: 4, scrollTop: 40000, viewport: 800, tileSize: taille, rowHeight: hauteurRang, overscan: 2 });
  assert.deepEqual(parasite, w, 'tileSize est ignore, pas utilise comme repli');

  // Et sans rowHeight il n y a plus de repli du tout : la hauteur de garde vaut
  // 1 px, donc la fenetre couvre toute la grille plutot que d inventer une
  // hauteur qui ferait mentir la barre de defilement.
  const sansHauteur = galleryWindow({ total: 10, columns: 4, scrollTop: 0, viewport: 300, tileSize: 302, overscan: 0 });
  assert.equal(sansHauteur.startRow, 0);
  assert.equal(sansHauteur.endRow, 3);
  assert.equal(sansHauteur.padTop, 0);
});

test('galleryWindow borne aux extremites et tolere un etat vide', () => {
  const vide = galleryWindow({ total: 0, columns: 4, scrollTop: 0, viewport: 300, rowHeight: 100 });
  assert.equal(vide.startRow, 0);
  assert.equal(vide.endRow, 0);
  assert.equal(vide.padTop, 0);
  assert.equal(vide.padBottom, 0);
  const debut = galleryWindow({ total: 3, columns: 4, scrollTop: 0, viewport: 300, rowHeight: 100, overscan: 5 });
  assert.equal(debut.startRow, 0, 'jamais de marge negative en haut');
  assert.equal(debut.endRow, 1);
  const fin = galleryWindow({ total: 10, columns: 4, scrollTop: 999999, viewport: 300, rowHeight: 100, overscan: 2 });
  assert.equal(fin.endRow, 3, 'un scrollTop aberrant ne sort pas de la grille');
  assert.ok(fin.startRow >= 0 && fin.startRow <= 2, 'et le debut de la fenetre non plus');
});
