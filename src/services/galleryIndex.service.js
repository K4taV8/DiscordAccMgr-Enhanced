// Index des medias du Data Package, pour la galerie en mosaique.
//
// Mesure sur l'archive reelle : 2 208 pieces jointes, dont 1 778 images, 225
// videos, 161 audios et 44 fichiers ordinaires. Ce service n'en rend aucune :
// il produit la liste, les filtres et la tranche de grille a peindre, sur le
// modele de packageWindow.service.js, pour que la mosaique reste testable sans
// DOM. Que les 2 208 noeuds ne soient jamais crees d'un coup depend de la seule
// DONNEE que le renderer fournit : la hauteur d'un rang, par rowHeight. Ce
// service ne peut pas la deviner, donc cet engagement est conditionnel, et les
// deux degradations que son absence provoque sont mesurees sous galleryWindow.
//
// Aucune entree n'est ecartee. La spec prevoyait d'ignorer "les repertoires et
// les entrees de zero octet" : c'est sans objet ici, parce que l'entree de ce
// service est un message deja analyse, jamais une entree du ZIP, donc aucune
// entree de repertoire ne peut l'atteindre. Une piece jointe sans extension
// reste donc dans la galerie, avec une icone de fichier generique.
import { attachmentKind, attachmentExtension } from './packageData.service.js';

export const GALLERY_COLUMNS = 4;

// La tuile est carree : sa largeur vaut ce que donne tileSizeFor, et la
// gouttiere s ajoute entre deux tuiles. Ce defaut doit rester aligne sur le
// gap de la grille posee par le rendu.
export const GALLERY_GAP = 8;

// LE PORTEUR DE L INVARIANT EST LA SIGNATURE A UN ARGUMENT DE mediaKindOf, PAS
// L URL VIDE. Ici, aucune URL n est en portee : le seul argument est un nom de
// fichier, donc l ordre des arguments de attachmentKind est inobservable, donc
// sans risque. L URL vide est de la lisibilite, pas une protection. Un lecteur
// qui attribuerait la garantie a l URL vide est precisement celui qui
// supprimerait mediaKindOf pour appeler attachmentKind directement, sans URL
// vide, en croyant avoir garde la protection. D ou la signature a un argument,
// qui rend l URL impossible a passer.
export function mediaKindOf(fileName) {
  return attachmentKind('', fileName);
}

function channelNames(channels) {
  const noms = new Map();
  for (const channel of Array.isArray(channels) ? channels : []) {
    const id = String(channel?.id ?? '');
    if (id) noms.set(id, String(channel?.name ?? '') || `Salon ${id}`);
  }
  return noms;
}

// Une entree par piece jointe, pas par message : la meme URL repetee dans un
// message occupe deux emplacements reels, donc deux tuiles. Aucune
// deduplication, et aucun filtre : seule une liste attachments vide ou absente
// ne produit rien.
export function buildMediaIndex(pkg) {
  const noms = channelNames(pkg?.channels);
  const messages = pkg?.messages;
  const items = [];

  if (messages && typeof messages.forEach === 'function') {
    messages.forEach((list, key) => {
      const channelId = String(key ?? '');
      const channelName = noms.get(channelId) || (channelId ? `Salon ${channelId}` : '');
      for (const message of Array.isArray(list) ? list : []) {
        const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
        for (const attachment of attachments) {
          const fileName = String(attachment?.fileName ?? '');
          items.push({
            channelId,
            channelName,
            messageId: String(message?.id ?? ''),
            timestamp: String(message?.timestamp ?? ''),
            url: String(attachment?.url ?? ''),
            fileName,
            kind: mediaKindOf(fileName),
            // Meme fonction que celle de mediaKindOf, sur le meme argument et
            // avec la meme URL vide : ext et kind ne peuvent donc pas diverger,
            // y compris sur archive.tar.gz ou photo.2024.png. Reimplementer la
            // regle ici avait introduit une troisieme reponse a "quelle est
            // l extension", en plus de attachmentKind et de attachmentExtension.
            ext: attachmentExtension('', fileName),
          });
        }
      }
    });
  }

  // Tri decroissant par horodatage. Le comparateur renvoie 0 sur egalite, donc
  // le tri stable de V8 conserve l'ordre de parcours : les pieces jointes d'un
  // meme message, donc de meme horodatage, gardent l'ordre de la liste.
  items.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
  return items;
}

// Fonction pure : `kind` a 'all' ou absent laisse passer tout, `channelId` a
// '' ou absent laisse passer tous les salons, et les deux se cumulent. Sur les
// 667 salons proposes presque tous sont vides : un resultat vide est valide,
// pas une erreur.
export function filterMedia(items, { kind = 'all', channelId = '' } = {}) {
  const tousGenres = !kind || kind === 'all';
  const tousSalons = !channelId || channelId === 'all';
  return (Array.isArray(items) ? items : []).filter(item => (
    (tousGenres || item?.kind === kind) && (tousSalons || item?.channelId === channelId)
  ));
}

// Plancher a 1 px : une largeur residuelle, ou un conteneur non mesure, ne doit
// pas produire une tuile de 0 ou negative qui casserait la mise en page.
export function tileSizeFor(width, columns = GALLERY_COLUMNS, gap = GALLERY_GAP) {
  const totale = Math.max(0, Number(width) || 0);
  const colonnes = Math.max(1, Math.floor(Number(columns) || GALLERY_COLUMNS));
  const gouttiere = Math.max(0, Number(gap) || 0);
  return Math.max(1, Math.floor((totale - (colonnes - 1) * gouttiere) / colonnes));
}

// Meme fenetrage que channelWindow(), transpose en rangs de grille. Les deux
// tampons reconstituent la hauteur totale, sans quoi la barre de defilement
// raccourcirait et la position de scroll deviendrait fausse : c'est
// padTop + (endRow - startRow) * rowHeight + padBottom qui vaut rows * rowHeight.
//
// La hauteur d un rang N EST PAS UN REPLI, C EST UNE DONNEE : un rang de grille
// CSS `repeat(4, 1fr)` avec gap 8 et des tuiles carrees vaut tileSize + gap, pas
// tileSize. Un repli sur tileSize aurait produit une grille 8 px trop courte par
// rang, soit 4 416 px manquants sur 552 rangs, et une barre de defilement
// fautive. Le renderer, qui connait le aspect-ratio et le gap, la fournit donc
// par rowHeight.
//
// SANS ELLE, LA DEGRADATION EST EN DEUX REGIMES. Mesure sur 2 208 elements en
// 552 rangs, viewport 800, overscan 2, nombre de noeuds peints :
//   - scrollTop de 0 a rows - 1 : endRow vaut toujours rows, donc la fenetre
//     contient tout ce qui est SOUS la position de scroll. Les noeuds peints
//     decroissent lineairement, 2 208 a scrollTop 0 (la grille entiere) puis
//     1 816 a 100, 616 a 400, et padTop ne vaut que le scroll. C est de la
//     lenteur, rien de plus.
//   - scrollTop >= rows - 1 : firstRow sature sur le dernier rang, donc la
//     fenetre est FIGEE sur les 3 derniers rangs, 12 noeuds peints et 549 px de
//     tampon vide au-dessus, quel que soit le scroll. La vue ne suit plus.
//     C est une perte de fonction, pas un cout.
// D ou la regle, elle est aussi dans le nom du test : le renderer fournit
// toujours rowHeight. `overscan` vaut 2 par defaut.
export function galleryWindow({ total = 0, columns = GALLERY_COLUMNS, scrollTop = 0, viewport = 0, rowHeight = 0, overscan = 2 } = {}) {
  const count = Math.max(0, Math.floor(Number(total) || 0));
  const colonnes = Math.max(1, Math.floor(Number(columns) || GALLERY_COLUMNS));
  const hauteur = Math.max(1, Number(rowHeight) || 1);
  const visible = Math.max(0, Number(viewport) || 0);
  const offset = Math.max(0, Number(scrollTop) || 0);
  const marge = Math.max(0, Math.floor(Number(overscan) || 0));

  const rows = Math.ceil(count / colonnes);
  // Un scrollTop aberrant, plus grand que la grille, ne doit pas produire une
  // tranche hors bornes : on borne sur le dernier rang existant.
  const firstRow = Math.min(Math.max(0, rows - 1), Math.floor(offset / hauteur));
  const visibleRows = Math.ceil(visible / hauteur) + 1;
  const startRow = Math.max(0, firstRow - marge);
  const endRow = Math.min(rows, firstRow + visibleRows + marge);

  return {
    startRow,
    endRow,
    padTop: startRow * hauteur,
    padBottom: Math.max(0, (rows - endRow) * hauteur),
  };
}
