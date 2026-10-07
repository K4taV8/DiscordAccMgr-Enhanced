import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
// ORACLE, et non un moyen de contourner un garde-fou : ce test tourne dans Node,
// jamais dans le renderer. Il sert a trois choses — enregistrer le message que zlib
// rend sur des octets illisibles (pour exiger que le refus le conserve), verifier
// la SEMANTIQUE de `maxOutputLength`, dont depend la borne de la decompression, et
// mesurer ce que deflate peut engendrer de plus que son entree. `node:zlib` reste
// interdit dans src/ : le renderer est un navigateur.
import { inflateRawSync, deflateRawSync } from 'node:zlib';
import { zipSync, unzipSync, strToU8, inflateSync, deflateSync } from '../node_modules/fflate/esm/browser.js';

const require = createRequire(import.meta.url);
const { readZipIndex, localHeaderOffset, MAX_CENTRAL_BYTES } = require('../electron/zipIndex.cjs');
const { selectEntries, MAX_ENTRY_BYTES, inflateEntry, importViaIndex, importPackageWithFallback, openArchiveReader, aplatitPackagePourIpc, buildImportResponse, importArchiveDepuisChemin, ecartTailleAnnonce, routeProgression } = require('../electron/packageImporter.service.cjs');
const { NOISE_PREFIXES, normalizeSegment, isNoisePath } = require('../electron/packageImporter.rules.cjs');
const parseurs = require('../electron/packageImporter.parse.cjs');

// Un export Discord de 394 Mo passait 12 s, dont 90 % pour decompresser des
// fichiers que l'outil jette. Le plan : piloter l'import par le REPERTOIRE
// CENTRAL, qui tient en fin de fichier, afin de n'ouvrir que les entrees
// utiles. Ce fichier teste ce pilote (electron/zipIndex.cjs), pas l'import.
//
// Contrat de lecture : un objet { name, size, slice(start, end) } suffit, la
// tranche renvoyant un objet porteur de arrayBuffer(). C'est deja la forme
// consommee par chunkOnlyFile dans test/packageImporter.test.js ; s'en tenir a
// slice() prouve qu'aucune allocation globale n'est reintroduite.

function fileFromBlob(bytes, name = 'package.zip') {
  const blob = new Blob([bytes]);
  return {
    name,
    size: blob.size,
    slice(start, end) { return blob.slice(start, end); },
  };
}

// Taille attendue de la fenetre de fin. La norme autorise un commentaire
// d'archive de 65 535 octets, et l'EOCD (22 octets) precede ce commentaire :
// il peut donc se placer 22 + 65 535 = 65 557 octets avant la fin du fichier.
// Une fenetre de 65 536 octets l arreterait 22 octets trop tot.
const TAIL_WINDOW = 65536 + 22;

// Fichier qui COMPTABILISE ses lectures : chaque plage demandee est notee dans
// `slices`. Un resultat correct ne prouve rien sur le nombre de lectures ; la
// plage demandee, si. C'est ce qui permet de figer le contrat "2 lectures,
// pas 2 + N ".
function countedFile(bytes, name = 'package.zip') {
  const base = fileFromBlob(bytes, name);
  const slices = [];
  return {
    name,
    size: base.size,
    slices,
    slice(start, end) { slices.push([start, end]); return base.slice(start, end); },
  };
}

// Oracle du format ZIP, ecrit sans reprendre le module teste : on relit l'EOCD
// (22 octets, signature 0x06054b50) pour en tirer l'offset du repertoire
// central et sa position absolue. C'est ce qui permet d'AFFIRMER que la
// deuxieme lecture est bien le repertoire central, au lieu de le supposer.
function centralRangeOf(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = bytes.length - 22; at >= 0; at -= 1) {
    if (view.getUint32(at, true) !== 0x06054b50) continue;
    return { start: view.getUint32(at + 16, true), end: at };
  }
  throw new Error('aucun EOCD dans l archive du test');
}

// Position de l enregistrement central de chaque entree. Le test doit pouvoir
// PATCHER le repertoire central, et le seul moyen de trouver un enregistrement
// est de le parcourir — independamment du module teste, donc avec la seule
// longueur des champs variables.
function centralRecordsOf(bytes) {
  const vue = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const { start, end } = centralRangeOf(bytes);
  const decodeur = new TextDecoder();
  const records = [];
  let at = start;
  while (at + 46 <= end) {
    assert.equal(vue.getUint32(at, true), 0x02014b50, `le central doit commencer sur une signature centrale a ${at}`);
    const nameLength = vue.getUint16(at + 28, true);
    records.push({
      nom: decodeur.decode(bytes.subarray(at + 46, at + 46 + nameLength)),
      at,
      localOffset: vue.getUint32(at + 42, true),
    });
    at += 46 + nameLength + vue.getUint16(at + 30, true) + vue.getUint16(at + 32, true);
  }
  return records;
}

// Remplissage incompressible (xorshift32) : deflate ne peut pas le reduire, il
// survit donc a la compression et repousse le repertoire central hors de
// portee d'une fenetre de 64 KiB.
function incompressible(size) {
  const out = new Uint8Array(size);
  let seed = 2463534242;
  for (let i = 0; i < size; i += 1) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    out[i] = seed & 0xff;
  }
  return out;
}

// Concateneration de tampons. fflate l exporte sous le nom `concat` dans son
// build node.js, mais PAS dans browser.js : on l'ecrit ici plutot que d'importer
// une entree qui varie selon le point d'entree du paquet.
function joinBytes(parts) {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// Archive a une seule entree, ecrite OCTET PAR OCTET : c'est la seule facon de
// faire dire au repertoire central autre chose que la verite. Les deux pieges
// que le pilote doit refuser tiennent la-dessus -- une taille annoncee plus
// petite que ce que l'entree produit reellement, et une sentinelle ZIP64 a la
// place d'une valeur -- et ni l'un ni l'autre ne peut etre produit par un
// compresseur, qui ecrit toujours la verite.
//
// Le reste du format est valide, et les EN-TETES LOCAUX portent toujours la
// verite : le mensonge ne vit que dans le repertoire central, la ou le pilote
// lit. C'est bien la ou sont les mensonges.
//
// Chaque champ non fourni vaut la verite et se remplace par une cle du meme
// nom : `payload`, `method`, `compressedSize`, `uncompressedSize`, `localOffset`.
// Les deux champs de l en-tete LOCAL se forcent aussi, par `localCompressedSize`
// et `localUncompressedSize`, qui valent la verite par defaut — c'est la seule
// facon de produire une archive HONNETE et trop grosse, ou les deux en-tetes
// disent la meme chose (cf. archiveComplete).
function handMadeZip({
  name = 'a.json',
  method = 0,
  payload = strToU8('{}'),
  compressedSize,
  uncompressedSize,
  localCompressedSize,
  localUncompressedSize,
  localOffset = 0,
} = {}) {
  const nom = strToU8(name);
  const compressee = compressedSize === undefined ? payload.length : compressedSize;
  const decompressee = uncompressedSize === undefined ? payload.length : uncompressedSize;
  const compresseeLocale = localCompressedSize === undefined ? payload.length : localCompressedSize;
  const decompresseeLocale = localUncompressedSize === undefined ? payload.length : localUncompressedSize;

  // Bit 11 du « general purpose flag », MIS SUR LES DEUX EN-TETES quand le nom
  // n'est pas de l'ASCII — exactement ce que fait `zipSync` (verifie : 0x800 sur
  // le local d'un nom accentue, absent sur celui d'un nom ASCII), et exactement ce
  // que porte l export reel (mesure : 2 178 entrees, le drapeau est pose sur les
  // 18 seules dont le nom n'est pas ASCII).
  //
  // Ce n'est pas un detail : SANS ce drapeau, le chemin de reference decode le nom
  // en latin1 (fflate : `strFromU8(..., !(flag & 2048))`) pendant que le chemin
  // par index le decode en UTF-8 — et les deux n'afficheraient pas le meme nom
  // pour la meme entree. Les deux entetes sont ecrites a la main ici, donc le
  // drapeau ne se poserait pas tout seul.
  const drapeauUtf8 = nom.some(octet => octet >= 0x80) ? 0x0800 : 0;

  const local = new Uint8Array(30 + nom.length + payload.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true); // signature locale
  lv.setUint16(4, 20, true); // version minimale
  lv.setUint16(6, drapeauUtf8, true); // general purpose flag
  lv.setUint16(8, method, true); // methode de compression
  lv.setUint32(18, compresseeLocale, true); // taille compressee
  lv.setUint32(22, decompresseeLocale, true); // taille decompressee
  lv.setUint16(26, nom.length, true); // longueur du nom
  lv.setUint16(28, 0, true); // longueur du champ extra
  local.set(nom, 30);
  local.set(payload, 30 + nom.length);

  const central = new Uint8Array(46 + nom.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true); // signature centrale
  cv.setUint16(4, 20, true); // version d origine
  cv.setUint16(6, 20, true); // version minimale
  cv.setUint16(8, drapeauUtf8, true); // general purpose flag, le MEME qu en local
  cv.setUint16(10, method, true); // methode
  cv.setUint32(20, compressee, true); // taille compressee, mensonge possible
  cv.setUint32(24, decompressee, true); // taille decompressee, mensonge possible
  cv.setUint16(28, nom.length, true); // longueur du nom
  cv.setUint32(42, localOffset, true); // offset de l en-tete local, mensonge possible
  central.set(nom, 46);

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); // signature EOCD
  ev.setUint16(8, 1, true); // nombre de disques
  ev.setUint16(10, 1, true); // nombre d entrees
  ev.setUint32(12, central.length, true); // taille du repertoire central
  ev.setUint32(16, local.length, true); // offset du repertoire central

  return joinBytes([local, central, eocd]);
}

function zipWithUncompressedSize(uncompressedSize) {
  return handMadeZip({ name: 'a.json', method: 0, payload: strToU8('{"id":1}'), uncompressedSize });
}

// Ecrivain de bits pour deflate, partage par les deux fabriques de flux
// ci-dessous.
//
// deflate range les champs multi-bits en commençant par le bit de poids
// faible, mais pose les codes Huffman du poids FORT vers le faible : melanger
// les deux ordres donne un flux que zlib refuse, ce qui est un indice utile si
// un de ces tests rougit un jour pour la mauvaise raison.
function bitsDeflate() {
  const bytes = [];
  let accu = 0;
  let bits = 0;
  const bit = (valeur) => {
    accu |= valeur << bits;
    bits += 1;
    if (bits === 8) { bytes.push(accu & 0xff); accu = 0; bits = 0; }
  };
  return {
    poidFaible(valeur, largeur) { for (let i = 0; i < largeur; i += 1) bit((valeur >>> i) & 1); },
    codeHuffman(valeur, largeur) { for (let i = largeur - 1; i >= 0; i -= 1) bit((valeur >>> i) & 1); },
    fin() { if (bits > 0) { bytes.push(accu & 0xff); accu = 0; bits = 0; } return new Uint8Array(bytes); },
  };
}

// Amorce commune : BFINAL = 1, BTYPE = 01 (Huffman fixe), puis un litteral 0
// (code 0x30 sur 8 bits), qui amorce la distance 1.
function amorceDeflate(bits) {
  bits.poidFaible(1, 1); // BFINAL
  bits.poidFaible(1, 2); // BTYPE = 01
  bits.codeHuffman(0x30, 8); // litteral 0
}

// Longueurs de match, d'apres zlib lui-meme (lbase / lext de inflate.c). Le
// tableau de la RFC 1951 affiche « 4 bits » pour les symboles 281 a 284 alors
// qu'il en faut 5 : c'est ce 5 qui fait tenir 163-194 sous le symbole 282. Une
// table recopiee de la RFC produit donc des longueurs que zlib refuse, et le
// deflateFixe ci-dessous ne peut produire que les tailles qu'il sait exprimer.
const LONGUEURS = [
  [257, 3, 0], [258, 4, 0], [259, 5, 0], [260, 6, 0], [261, 7, 0], [262, 8, 0], [263, 9, 0], [264, 10, 0],
  [265, 11, 1], [266, 13, 1], [267, 15, 1], [268, 17, 1],
  [269, 19, 2], [270, 23, 2], [271, 27, 2], [272, 31, 2],
  [273, 35, 3], [274, 43, 3], [275, 51, 3], [276, 59, 3],
  [277, 67, 4], [278, 83, 4], [279, 99, 4], [280, 115, 4],
  [281, 131, 5], [282, 163, 5], [283, 195, 5], [284, 227, 5],
  [285, 258, 0],
];

// Un match de `longueur` octets a distance 1. Les symboles 256 a 279 tiennent
// sur 7 bits (code = symbole - 256), les symboles 280 a 285 sur 8 bits
// (0xc0 + symbole - 280) : 285 est donc 0xc5, le code utilise par deflateBomb.
function ecrireMatch(bits, longueur) {
  const ligne = LONGUEURS.find(([, base, extra]) => (extra === 0 ? longueur === base : longueur >= base && longueur < base + (1 << extra)));
  if (!ligne) throw new Error(`longueur de match hors table : ${longueur}`);
  const [symbole, base, extra] = ligne;
  bits.codeHuffman(symbole <= 279 ? symbole - 256 : 0xc0 + symbole - 280, symbole <= 279 ? 7 : 8);
  if (extra) bits.poidFaible(longueur - base, extra); // bits supplementaires, poids faible d abord
  bits.codeHuffman(0x00, 5); // distance 1 : symbole 0, code 0 sur 5 bits
}

// Un flux deflate qui produit AU MOINS `octetsCibles` : des matchs de 258
// octets a distance 1, thirteen bits chacun, donc 158 fois plus qu il ne pese.
// Aucun compresseur n atteint ce rapport sans qu on alloue d abord 1,5 Gio de
// zeros a compresser -- et c est precisement ce que ces tests veulent eviter
// d avoir a faire en memoire. Le flux s ecrit donc a la main, en Huffman fixe.
//
// ATTENTION : la production effective peut rester jusqu a 257 octets SOUS la
// cible (un match de 258 n encode pas 1). Une cible posee au plafond n aurait
// donc pas depasse le plafond, et le test ne prouverait rien : d ou les + 1024
// de `le plafond s applique EN COURS de route`.
//
// Deflate est un flux unique et stateful : ce blob est donc ecrit une fois et
// lu d un bloc, comme toute entree.
function deflateBomb(octetsCibles) {
  const matchs = Math.ceil((octetsCibles - 1) / 258);
  const bits = bitsDeflate();
  amorceDeflate(bits);
  for (let i = 0; i < matchs; i += 1) ecrireMatch(bits, 258);
  bits.codeHuffman(0x00, 7); // fin de bloc : symbole 256, sept bits a zero
  return { flux: bits.fin(), produits: 1 + 258 * matchs };
}

// Le meme flux, mais produisant EXACTEMENT `octets` — ce qui permet de viser la
// frontiere du plafond sans la depasser. Le dernier match est raccourci a la
// longueur qui manque : il faut donc que le reste soit exprimable, c est a dire
// nul ou dans [3, 258] (en dessous, deflate n a pas de symbole : le plus court
// match fait 3 octets). Les seuls cas impossibles sont donc n congru a 1, 2, 3
// ou 260, 261 modulo 258, et le helper leve plutot que d produire un flux faux.
function deflateFixe(octets) {
  const matchs = Math.floor((octets - 1) / 258);
  const reste = octets - 1 - 258 * matchs;
  if (reste !== 0 && (reste < 3 || reste > 258)) {
    throw new Error(`deflateFixe ne sait pas produire ${octets} : reste ${reste}, hors de [3, 258]`);
  }
  const bits = bitsDeflate();
  amorceDeflate(bits);
  for (let i = 0; i < matchs; i += 1) ecrireMatch(bits, 258);
  if (reste !== 0) ecrireMatch(bits, reste);
  bits.codeHuffman(0x00, 7); // fin de bloc
  return { flux: bits.fin(), produits: octets };
}

test('le repertoire central donne offset, tailles et nom de chaque entree', async () => {
  const file = fileFromBlob(zipSync({
    'Messages/c111111111111111111/channel.json': strToU8('{"id":111111111111111111,"type":0}'),
    'Messages/c111111111111111111/messages.json': strToU8('[{"ID":1009136231751360593,"Contents":"salut"}]'),
  }), 'package.zip');

  const { entries, reason } = await readZipIndex(file);
  assert.equal(reason, null);
  assert.equal(entries.length, 2);
  const messages = entries.find(entry => entry.name.endsWith('messages.json'));
  assert.equal(messages.method, 8);
  assert.ok(messages.uncompressedSize > 0);
  assert.ok(messages.compressedSize > 0);
  assert.ok(messages.localOffset > 0);
  // Exactement les cinq champs de ZipEntry : la tache 4 compare l'index a une
  // attente en deepEqual, donc un sixieme champ (l'en-tete local pre-lu) ferait
  // echouer cette comparaison pour une raison de forme et non de fond.
  assert.deepEqual(
    Object.keys(messages),
    ['name', 'method', 'compressedSize', 'uncompressedSize', 'localOffset'],
    'l entree ne porte que les cinq champs de ZipEntry',
  );
});

test('un fichier qui n est pas un zip donne une raison, pas une exception', async () => {
  const file = fileFromBlob(new TextEncoder().encode('ceci n est pas un zip'), 'faux.zip');
  const { entries, reason } = await readZipIndex(file);
  assert.equal(entries, null);
  assert.ok(reason, 'une raison est fournie pour que l appelant bascule sur le repli');
});

test('un central qui pointe sur l en-tete local d une AUTRE entree ouvre les MAUVAIS octets', async () => {
  // LE trou que la revue nomme I4, et le point M8 differe de la tache 1.
  //
  // `localHeaderOffset` verifie la SIGNATURE de l en-tete local, jamais son NOM.
  // Un repertoire central qui annonce `localOffset` = 0 pour une entree dont les
  // donnees sont ailleurs fait donc ouvrir les octets de l'ENTREE 0 — nommes d
  // apres le repertoire central, donc par les siens. Aucun octet ne parait errone :
  // c'est un `channel.json` valide, celui d'un AUTRE salon, qui se retrouve sous
  // le nom du salon annonce. Le contenu du paquet change, et rien ne le dit.
  //
  // Le chemin de reference, lui, LIT EN SEQUENCE : il ne peut pas etre trompe de
  // cette maniere, il ne fait qu'ouvrir ce que le fichier declare ensuite. C est
  // exactement l invariant que la tache 4 revendique (« les deux chemins n auraient
  // pas vu la meme archive ») qui etait porte par une porte ouverte.
  const octets = zipSync({
    'Messages/c111111111111111111/channel.json': strToU8('{\n  "id": 111111111111111111,\n  "type": 0,\n  "name": "salon reel"\n}'),
    'Messages/c222222222222222222/channel.json': strToU8('{\n  "id": 222222222222222222,\n  "type": 0,\n  "name": "salon annonce"\n}'),
  });
  const records = centralRecordsOf(octets);
  const cible = records.find(record => record.nom.includes('c222222222222222222'));
  const autre = records.find(record => record.nom.includes('c111111111111111111'));
  assert.ok(cible && autre, 'le temoin a bien deux entrees dans son central');
  assert.notEqual(cible.localOffset, autre.localOffset, `les deux entrees sont a des offsets locaux differents : ${cible.localOffset} et ${autre.localOffset}`);

  // Le central ment : l'entree annoncee pointe sur l en-tete local de l'autre.
  const vue = new DataView(octets.buffer, octets.byteOffset, octets.byteLength);
  vue.setUint32(cible.at + 42, autre.localOffset, true);
  assert.equal(vue.getUint32(cible.at + 42, true), autre.localOffset, 'le central annonce desormais l offset local de l AUTRE entree, DANS l archive');

  const fichier = fileFromBlob(octets, 'package.zip');
  const { entries, reason } = await readZipIndex(fichier);
  assert.equal(reason, null, `raison inattendue : ${reason}`);
  const entry = entries.find(candidat => candidat.name === cible.nom);
  assert.equal(entry.localOffset, autre.localOffset, `le lecteur d index rend bien l offset menteur : ${entry.localOffset}`);

  // Sans la verification du NOM, l ouverture passe : la signature locale est
  // bonne, les bornes sont bonnes, et l on ouvre les octets de l autre salon.
  assert.equal(
    await localHeaderOffset(fichier, entry, fichier.size),
    -1,
    'un en-tete local dont le NOM ne correspond pas a l entree du central doit etre refuse : ouvrir les octets d une autre entree, sous le nom d celle-ci, est le pire defaut possible ici',
  );
  await assert.rejects(
    () => inflateEntry(fichier, entry),
    /hors du fichier/,
    'et donc l ouverture elle-meme est refusee, plutot que de rendre le contenu d un autre salon sous ce nom',
  );

  // Le meme mensonge, en version plus vicieuse : le nom du central est un PREFIXE
  // du nom local. Les 27 premiers octets sont alors identiques, et une comparaison
  // octet par octet passe — il faut donc aussi comparer les LONGUEURS. Sans ce
  // second controle, une comparaison seule des octets ACCEPTERAIT cette entree, et
  // ouvrirait les donnees du nom long sous le nom court. Les deux controles sont
  // donc necessaires, et chacun se voit.
  // Les identifiants sont choisis HORS du corps, pour que `find` ne puisse pas
  // confondre l entree ajoutee et une entree du corps qui porterait le meme nom.
  const prefixe = 'Messages/c707070707070707070';
  const long = `${prefixe}/channel.json`;
  const avecPrefixe = zipAvecAjouts(archiveDeParite(), [
    { nom: long, method: 0, payload: strToU8('{\n  "id": 111111111111111111,\n  "name": "donnees du nom long"\n}') },
    { nom: prefixe, method: 0, payload: strToU8('{"id":1}') },
  ]);
  const centralAvecPrefixe = centralRecordsOf(avecPrefixe);
  const recordLong = centralAvecPrefixe.find(record => record.nom === long);
  const recordPrefixe = centralAvecPrefixe.find(record => record.nom === prefixe);
  assert.ok(recordLong && recordPrefixe, 'le central porte les deux noms, et ils sont de longueurs differentes');
  assert.ok(long.startsWith(prefixe) && long.length > prefixe.length, `${JSON.stringify(prefixe)} est un PREFIXE STRICT de ${JSON.stringify(long)} : ${long.length} contre ${prefixe.length} octets`);

  // Le central annonce pour le nom court l en-tete local du nom long.
  const reluPrefixe = new DataView(avecPrefixe.buffer, avecPrefixe.byteOffset, avecPrefixe.byteLength);
  reluPrefixe.setUint32(recordPrefixe.at + 42, recordLong.localOffset, true);
  assert.equal(reluPrefixe.getUint32(recordPrefixe.at + 42, true), recordLong.localOffset, 'l offset local du nom court pointe desormais sur l en-tete local du nom LONG, DANS l archive');

  const fichierPrefixe = fileFromBlob(avecPrefixe, 'package.zip');
  const { entries: entreesPrefixe } = await readZipIndex(fichierPrefixe);
  const entryPrefixe = entreesPrefixe.find(candidat => candidat.name === prefixe);
  assert.equal(entryPrefixe.localOffset, recordLong.localOffset, 'l entree au nom court pointe sur l en-tete local du nom LONG');
  assert.equal(
    await localHeaderOffset(fichierPrefixe, entryPrefixe, fichierPrefixe.size),
    -1,
    'un nom de central qui n est qu un prefixe du nom local doit etre refuse : la comparaison des octets passe, seule la comparaison des LONGUEURS le voit',
  );
});

test('une entree dont l offset deborde du fichier est signalee sans etre lue', async () => {
  // Entree fantome construite a la main : le pilote doit refuser l offset
  // AVANT toute lecture. On surveille slice() pour prouver que l offset hors
  // fichier est ecarte sans lire, et qu'aucune exception ne sort (une tranche
  // qui leve ici ferait echouer le test).
  const beyond = { name: 'x.json', method: 8, compressedSize: 10, uncompressedSize: 20, localOffset: 10 ** 12 };
  let slices = 0;
  const file = {
    name: 'package.zip',
    size: 4096,
    slice() { slices += 1; throw new Error('lecture interdite'); },
  };
  assert.equal(await localHeaderOffset(file, beyond, 4096), -1, 'offset hors fichier refuse');
  assert.equal(slices, 0, 'aucune lecture quand l offset est hors fichier');

  // Controle POSITIF, dans le meme test : les deux assertions ci-dessus
  // passeraient aussi bien pour un stub `async () => -1`. Sur une entree
  // valide, l offset rendu doit depasser l en-tete local, et une seule tranche
  // doit avoir ete demandee - celle de l en-tete local.
  const bytes = zipSync({
    'Messages/c111111111111111111/channel.json': strToU8('{"id":111111111111111111,"type":0}'),
    'Messages/c111111111111111111/messages.json': strToU8('[{"ID":1009136231751360593,"Contents":"salut"}]'),
  });
  const valide = countedFile(bytes, 'package.zip');
  const { entries, reason } = await readZipIndex(valide);
  assert.equal(reason, null, `raison inattendue : ${reason}`);
  const local = entries.find(entry => entry.name.endsWith('messages.json'));

  valide.slices.length = 0;
  const data = await localHeaderOffset(valide, local, bytes.length);
  assert.ok(data > local.localOffset, 'sur une entree valide, l offset depasse l en-tete local');
  assert.equal(valide.slices.length, 1, 'une seule tranche demandee : l en-tete local');
});

test('une archive plus grande que la fenetre de fin est lue au complet', async () => {
  // L'EOCD est cherche dans les 65 558 DERNIERS octets, donc la fenetre ne
  // commence a 0 que si le fichier est plus petit qu'elle. Sur le vrai export
  // de 394 Mo elle commence a ~393 Mo. Indexer la fenetre avec l'offset ABSOLU
  // de l'EOCD y lisait des octets hors tampon : total = 0, reason 'archive sans
  // entree', repli flux sur toute l'archive -- sans lever, donc invisible.
  // Un petit ZIP de test a tailStart = 0, ou relatif = absolu : il ne voit rien.
  const gros = {
    'Messages/c111111111111111111/channel.json': strToU8('{"id":111111111111111111,"type":0}'),
    'Messages/c111111111111111111/messages.json': strToU8('[{"ID":1009136231751360593,"Contents":"salut"}]'),
    'Events/events-1.json': incompressible(400000), // deflate seul repasserait sous la fenetre
  };
  const bytes = zipSync(gros);
  assert.ok(bytes.length > 65536, `l archive doit depasser la fenetre de fin : ${bytes.length} octets`);

  const file = fileFromBlob(bytes, 'gros.zip');
  const { entries, reason } = await readZipIndex(file);
  assert.equal(reason, null, `raison inattendue : ${reason}`);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map(entry => entry.name), Object.keys(gros), 'ordre du repertoire central respecte');

  // Et chaque entree reste adressable : l'en-tete local est lu a la demande.
  for (const entry of entries) {
    const data = await localHeaderOffset(file, entry, bytes.length);
    assert.ok(data > entry.localOffset, `${entry.name} : les donnees sont apres l en-tete local`);
    assert.ok(data + entry.compressedSize <= bytes.length, `${entry.name} : les donnees tiennent dans le fichier`);
  }
});

test('readZipIndex ne lit que deux tranches : la fin du fichier, puis le repertoire central', async () => {
  // Le chantier existe pour une raison : 12 s -> 2 s, en n'ouvrant que les entrees
  // utiles. Rien n'interdit une refonte future de relire les donnees de chaque
  // entree : readZipIndex ferait alors 2 + N lectures, le but disparaitrait, et
  // AUCUN test ne rougirait - le resultat, lui, resterait identique. Ce test
  // compte donc les lectures, et affiche la plage demandee a chaque fois.
  //
  // Le repertoire central est ici plus grand qu'une fenetre de fin (250 noms de
  // 250 caracteres), donc les deux tranches ne peuvent pas recouvrir les donnees
  // compressees des entrees : le controle " aucune lecture de contenu " a un
  // sens, sans quoi il serait vrai par construction.
  const source = {};
  for (let i = 0; i < 250; i += 1) source[`Messages/c${i}/${'c'.repeat(240)}/channel.json`] = strToU8(`{"id":${i}}`);
  const bytes = zipSync(source);
  const central = centralRangeOf(bytes);
  assert.ok(bytes.length - central.start >= TAIL_WINDOW, `le repertoire central doit remplir la fenetre de fin : ${bytes.length - central.start} octets`);

  const file = countedFile(bytes, 'large.zip');
  const { entries, reason } = await readZipIndex(file);
  assert.equal(reason, null, `raison inattendue : ${reason}`);
  assert.equal(entries.length, 250);
  assert.equal(file.slices.length, 2, `deux lectures attendues, pas ${file.slices.length} : ${JSON.stringify(file.slices.slice(0, 4))}`);
  assert.deepEqual(file.slices[0], [bytes.length - TAIL_WINDOW, bytes.length], 'la premiere lecture est la fenetre de fin');
  assert.deepEqual(file.slices[1], [central.start, central.end], 'la deuxieme lecture est le repertoire central');

  // Et, point par point, aucune des deux ne touche des donnees compressees :
  // l'intervalle [localOffset, localOffset + compressedSize) n'est jamais
  // demande, ni en entier ni en partie.
  for (const entry of entries) {
    const from = entry.localOffset;
    const to = entry.localOffset + entry.compressedSize;
    for (const [start, end] of file.slices) {
      assert.ok(end <= from || start >= to, `${entry.name} : la tranche [${start}, ${end}) touche les donnees compressees [${from}, ${to})`);
    }
  }
});

test('l offset rendu pointe sur les donnees compressees, octet pour octet', async () => {
  // Le module ne rend QUE des offsets, et aucun test ne prouve qu'un seul
  // octet. Une implementation qui lirait `extraLength` a l'octet 0 au lieu de
  // header[28] passerait tous les autres tests : `data` serait trop petit, donc
  // toujours > localOffset et toujours dans les bornes. Ici on lit les octets a
  // l'offset rendu, on les decompresse, et on compare a unzipSync.
  // Le remplissage incompressible maintient un offset errone dans les bornes du
  // fichier : l'erreur est donc visible sur les OCTETS, pas seulement sur un -1.
  const source = {
    'Messages/c111111111111111111/channel.json': strToU8('{"id":111111111111111111,"type":0}'),
    'Messages/c111111111111111111/messages.json': strToU8('[{"ID":1009136231751360593,"Contents":"salut"}]'),
    'Serveurs/1/guild.json': strToU8('{"id":"1","name":"x"}'),
    'Events/events-1.json': incompressible(40000),
  };
  const bytes = zipSync(source);
  const file = fileFromBlob(bytes, 'package.zip');
  const { entries, reason } = await readZipIndex(file);
  assert.equal(reason, null, `raison inattendue : ${reason}`);

  const attendu = unzipSync(bytes);
  for (const entry of entries) {
    const data = await localHeaderOffset(file, entry, bytes.length);
    assert.ok(data > 0, `${entry.name} : un offset rendu`);
    const bruts = bytes.subarray(data, data + entry.compressedSize);
    const lu = entry.method === 0 ? bruts : inflateSync(bruts);
    assert.equal(lu.length, attendu[entry.name].length, `${entry.name} : meme longueur`);
    assert.deepEqual(lu, attendu[entry.name], `${entry.name} : octets identiques a unzipSync`);
  }
});

test('une taille decompressee de 2 Go reste un entier positif', async () => {
  // C est la seule contrainte globale encore non testee, le `>>> 0` du lecteur
  // 32 bits : des que le bit 31 est pose, une taille signed ressort negative -
  // et une taille negative passerait le plafond de 128 Mo pour la bonne
  // raison, ce qui est le pire des deux mondes.
  const file = fileFromBlob(zipWithUncompressedSize(0x80000000), 'deux-go.zip');
  const { entries, reason } = await readZipIndex(file);
  assert.equal(reason, null, `raison inattendue : ${reason}`);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'a.json');
  assert.equal(entries[0].compressedSize, 8, 'la taille 32 bits classique reste exacte');
  assert.equal(entries[0].uncompressedSize, 2147483648, '2 Go, pas -2147483648');
});

test('un commentaire d archive de 65 535 octets, le plus grand admis, reste indexable', async () => {
  // L'EOCD (22 octets) precede son commentaire : avec le plus grand commentaire
  // que la norme admette, il se place 22 + 65 535 = 65 557 octets avant la fin
  // du fichier. Une fenetre de 65 536 octets s'arreterait 22 octets trop tot,
  // ne trouverait pas l'EOCD, et le pilote basculerait EN SILENCE sur le chemin
  // flux : aucune erreur, seulement la perte du gain de performance.
  const bytes = zipSync({ 'Messages/c111111111111111111/channel.json': strToU8('{"id":111111111111111111,"type":0}') });
  const commentaire = 65535;
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(bytes.length - 22 + 20, commentaire, true);
  // Remplissage 0x20 : aucune fausse signature 0x06054b50 dans le commentaire.
  const archive = joinBytes([bytes, new Uint8Array(commentaire).fill(0x20)]);
  assert.equal(archive.length - centralRangeOf(archive).end, commentaire + 22, 'le commentaire est bien place apres l EOCD');

  const file = countedFile(archive, 'commente.zip');
  const { entries, reason } = await readZipIndex(file);
  assert.equal(reason, null, `raison inattendue : ${reason}`);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'Messages/c111111111111111111/channel.json');
});

// --- Tache 2 : ecarter AVANT de decompresser -------------------------------
//
// Le repertoire central dit, pour chaque entree, sa taille decompressee et son
// offset, SANS l'ouvrir. Les 19 entrees ecartees du vrai export portent ~374 Mio
// compresses sur 394,05 — 95 % du fichier, deux gros fichiers de telemetrie (mesure,
// revue finale) : les ouvrir, meme pour les jeter, causerait les 12 s qu'on
// cherche a supprimer. Toute la discipline tient donc en une regle : rien ne
// s'ouvre avant d'avoir ete classe.
//
// selectEntries est donc une fonction SYNCHRONE et PURE sur le tableau deja lu :
// elle ne prend pas le fichier, elle ne demande aucune tranche. Les tests
// ci-dessous le prouvent en comptant les lectures, comme le contrat de la tache 1.

test('les entrees de bruit et les trop grosses sont ecartees sans etre ouvertes', () => {
  const entries = [
    { name: 'Messages/c1/channel.json', method: 8, compressedSize: 10, uncompressedSize: 20, localOffset: 0 },
    { name: 'Activité/events-1.json', method: 8, compressedSize: 900, uncompressedSize: 1148 * 1024 * 1024, localOffset: 100 },
    { name: 'Activité/events-2.json', method: 8, compressedSize: 3000, uncompressedSize: 4096 * 1024 * 1024, localOffset: 200 },
    { name: 'Serveurs/1/guild.json', method: 8, compressedSize: 5, uncompressedSize: 9, localOffset: 300 },
  ];
  const { kept, discarded } = selectEntries(entries);
  assert.deepEqual(kept.map(e => e.name), ['Messages/c1/channel.json', 'Serveurs/1/guild.json']);
  assert.equal(discarded.length, 2);
  assert.equal(discarded[0].uncompressedSize, 1148 * 1024 * 1024);
});

test('le bruit est reconna sans accents comme avec accents', () => {
  assert.equal(isNoisePath('Activités/events.json'), true);
  assert.equal(isNoisePath('Publicités/x.json'), true);
  assert.equal(isNoisePath('Messages/c1/channel.json'), false);
});

test('le plafond de 128 Mo tranche exactement a la frontiere', () => {
  // Une copie divergente qui ecarterait a `>=` (ou qui compterait en Mo et non
  // en Mio) laisserait passer, ou jetterait, exactement l'entree de 128 Mio :
  // c'est le seul cas ou les deux regles se touchent, donc le seul qui compte.
  assert.equal(MAX_ENTRY_BYTES, 128 * 1024 * 1024, 'le plafond exporte vaut bien 128 Mio');
  const plafond = MAX_ENTRY_BYTES;
  const { kept, discarded } = selectEntries([
    { name: 'Messages/c1/messages.json', method: 8, compressedSize: 10, uncompressedSize: plafond, localOffset: 0 },
    { name: 'Messages/c2/messages.json', method: 8, compressedSize: 10, uncompressedSize: plafond + 1, localOffset: 10 },
    { name: 'Messages/c3/messages.json', method: 8, compressedSize: 10, uncompressedSize: plafond - 1, localOffset: 20 },
  ]);
  assert.deepEqual(kept.map(e => e.name), ['Messages/c1/messages.json', 'Messages/c3/messages.json']);
  assert.deepEqual(discarded.map(e => e.name), ['Messages/c2/messages.json']);
});

test('classer l index ne demande aucune lecture : les ecartees ne sont jamais ouvertes', async () => {
  // Le but du chantier tient dans cette assertion. Une implementation qui
  // ouvrirait une entree pour mieux la classer — lire son en-tete local,
  // decompresser ses premiers octets, peu importe pour verifier le nom — ne
  // changerait RIEN aux trois tests precedents : memes noms, memes tailles,
  // meme ordre. Seul le COMPTE DES LECTURES distingue les deux ecritures.
  //
  // On compte donc : le fichier est lu deux fois pour l'index (fenetre de fin,
  // repertoire central), le compteur est remis a zero, puis on classe. Zero
  // tranche demandee apres ca. Et comme preuve complementaire, aucune des
  // tranches lues ne peut recouvrir les donnees compressees d'une entree
  // ecartee : une ecartee n'a pas ete effleuree, pas meme par erreur.
  const source = {
    'Compte/user.json': strToU8('{"id":"1","username":"x"}'),
    'Messages/c1/channel.json': strToU8('{"id":1,"type":0}'),
    'Messages/c1/messages.json': strToU8('[{"ID":1009136231751360593,"Contents":"salut"}]'),
    'Activité/reporting/events-1.json': incompressible(40000), // 4 Go sur le vrai export
    'Activités/events-2.json': strToU8('{"id":2}'),
    '__MACOSX/Messages/._channel.json': strToU8('x'),
    'Messages/.DS_Store': strToU8('x'),
  };
  const bytes = zipSync(source);
  const file = countedFile(bytes, 'package.zip');
  const { entries, reason } = await readZipIndex(file);
  assert.equal(reason, null, `raison inattendue : ${reason}`);
  assert.equal(entries.length, 7, 'les sept entrees sont indexees, bruit compris');
  assert.ok(file.slices.length > 0, 'l index a bien lu quelque chose avant le classement');

  // Le classement ne recoit QUE le tableau : pas de fichier, donc pas de tranche.
  assert.equal(selectEntries.length, 1, 'selectEntries ne prend que le tableau des entrees, jamais le fichier');
  file.slices.length = 0;
  const resultat = selectEntries(entries);
  assert.equal(typeof resultat.then, 'undefined', 'la fonction est synchrone : elle n attend rien, donc elle ne lit rien');
  assert.equal(file.slices.length, 0, `aucune lecture attendue au classement, pas ${file.slices.length} : ${JSON.stringify(file.slices.slice(0, 4))}`);

  assert.deepEqual(
    resultat.kept.map(e => e.name),
    ['Compte/user.json', 'Messages/c1/channel.json', 'Messages/c1/messages.json'],
  );
  assert.deepEqual(
    resultat.discarded.map(e => e.name),
    ['Activité/reporting/events-1.json', 'Activités/events-2.json', '__MACOSX/Messages/._channel.json', 'Messages/.DS_Store'],
  );

  // Les entrees rendues sont celles du repertoire central, pas des recopies :
  // le pilote n'alloue rien, il ne fait que les reclasser.
  for (const entry of resultat.kept) assert.ok(entries.includes(entry), `${entry.name} : l entree d origine est reutilisee`);

  // Et l'ecartement n'a rien touche : meme si une lecture avait eu lieu, elle
  // n'aurait pas pu viser les octets compresses d'une entree ecartee.
  for (const entry of resultat.discarded) {
    const from = entry.localOffset;
    const to = entry.localOffset + entry.compressedSize;
    for (const [start, end] of file.slices) {
      assert.ok(end <= from || start >= to, `${entry.name} : la tranche [${start}, ${end}) touche ses donnees [${from}, ${to})`);
    }
  }
});

test('les deux copies de la regle de bruit repondent pareil sur les cas du terrain', async () => {
  // `src/services/packageImporter.service.js` est un module ESM charge par le
  // renderer : il ne peut ni `require` un .cjs, ni importer quoi que ce soit de
  // `electron/`. La regle est donc DUPLIQUEE — une copie CJS pour le main
  // process, la copie existante pour le renderer — et c'est ce test qui empeche
  // les deux de diverger en silence. Il compare les deux implementations sur
  // un jeu de cas choisi pour couvrir les pieges reels d'un export traduit, pas
  // trois cas de facade.
  //
  // Import dynamique : le service du renderer tire fflate, et le charger au
  // sommet du fichier le ferait echouer avant meme que ces tests ne soient
  // annonces.
  const renderer = await import('../src/services/packageImporter.service.js');
  assert.equal(typeof renderer.isNoisePath, 'function', 'le renderer exporte isNoisePath, sans quoi les deux chemins ne peuvent pas etre compares');

// Ancrages absolus, identiques sur les deux copies : ce que ces chemins DOIVENT
  // valoir, independamment de l'accord entre les deux.
  const ANCRAGES = [
    ['Activité/reporting/events-1.json', true],
    ['Activités/events.json', true],
    ['Publicités/x.json', true],
    ['Activities/events.json', true],
    ['__MACOSX/Messages/c1/channel.json', true],
    ['Messages/._channel.json', true],
    ['Messages/.DS_Store', true],
    // Un dossier de demandes d'assistance est du bruit des deux cotes, et pas
    // seulement des deux cotes a la fois : chacun de ces six ancrages est
    // attendu BRUIT, donc il tient debout meme si les deux copies repondent
    // egalement « bruit » pour une mauvaise raison. « Demandes de soutien » etait
    // jusqu ici un cas de parite dont le verdict etait « conserve » des deux
    // cotes : l'egalite y etait triviale et le cas ne prouvait rien.
    ['Demandes de soutien/x.json', true],
    ['Demande Support/x.json', true],
    ['Advertisements/x.json', true],
    ['Tickets/x.json', true],
    ['Support Tickets/x.json', true],
    ['Support Requests/x.json', true],
    ['Messages/c1/channel.json', false],
    ['Messages/c1/messages.json', false],
    ['Serveurs/1/guild.json', false],
    ['Compte/user.json', false],
  ];
  for (const [chemin, attendu] of ANCRAGES) {
    assert.equal(isNoisePath(chemin), attendu, `copie principale : ${chemin}`);
    assert.equal(renderer.isNoisePath(chemin), attendu, `renderer : ${chemin}`);
  }

  // Comparaison croisee, entree par entree. Ces cas-la n'ont pas de verdict
  // absolu — « Messages/reactivites.json » ou « Messages/activation.json » sont
  // des frontieres dont personne n'a statue. Ce qui doit etre vrai, c'est que
  // les DEUX COPIES repondent pareil : c'est la divergence silencieuse, et elle
  // seule, qui casse l'import en passant par le chemin de l'un ou l'autre.
  const CAS = [
    // Accents reels de l'archive traduite, et leurs versions sans accents.
    'Activité/x.json',
    'Activités/x.json',
    'Publicités/x.json',
    'Activite/x.json',
    'Activities/x.json',
    'ACTIVITE/x.json',
    'activités/x.json',
    // Ponctuation et separateurs : le segment normalise ne garde que [a-z0-9].
    'activities_e/x.json',
    'Activité - 2024/x.json',
    'Activité.2024/x.json',
    'Demandes_de_support/x.json',
    'Publicités (copie)/x.json',
    // Variantes de casse et de ponctuation des dossiers de demandes
    // d'assistance et de tickets : sans elles, un ancrage ci-dessus ne prouve
    // que le nom colle. Ces formes ne tiennent qu'a la normalisation.
    'DEMANDES DE SOUTIEN/x.json',
    'Demandes-de-soutien (2024)/x.json',
    'Demande_Support (2024)/x.json',
    'ADVERTISEMENTS (2024)/x.json',
    'TICKETS/2024/x.json',
    'support-tickets/x.json',
    'SUPPORT-REQUESTS (2024)/x.json',
    'Programs/(2024)/x.json',
    'Ads/ads.json',
    // MacOS : dossier __MACOSX, fichiers ._ et .DS_Store, a tout niveau.
    '__MACOSX/Messages/c1/channel.json',
    '__macosx/x.json',
    '__MACOSX/__MACOSX/x.json',
    'Messages/._channel.json',
    'Messages/c1/._messages.json',
    'Messages/.DS_Store',
    'Messages/c1/.DS_Store',
    '.DS_Store',
    '._x',
    '.ds_store',
    // Segments vides : doubles barres, barre de tete, barre de fin.
    'Messages//c1/channel.json',
    '/Messages/c1/channel.json',
    'Messages/c1/',
    'Messages/c1',
    '///',
    'Activités//events.json',
    // Chemins sans aucune barre.
    'Activité',
    'Activites',
    'Publicités',
    // Frontieres prefixe/sous-chaine : une copie qui matcherait en sous-chaine
    // au lieu du prefixe du segment les traiterait comme du bruit.
    'Comptes/activation.json',
    'Messages/reactivites.json',
    'Messages/activities.json',
    // Utiles, avec et sans accents dans les noms de salon.
    'Messages/c111111111111111111/channel.json',
    'Messages/c1/messages.csv',
    'Activité/c1/channel.json', // segment bruite en tete : ecarte quand meme
    'Événements/x.json', // accent initial, hors liste : conserve
    'index.json',
  ];
  for (const chemin of CAS) {
    assert.equal(
      renderer.isNoisePath(chemin),
      isNoisePath(chemin),
      `les deux copies divergent sur « ${chemin} » : renderer=${renderer.isNoisePath(chemin)}, principale=${isNoisePath(chemin)}`,
    );
  }

  // Un prefixe qu'aucune des deux listes ne contient ne vaut rien, des deux
  // cotes : c'est le controle negatif de l'egalite croisee. Si une liste gagne
  // un prefixe cote main sans que l'autre suive — le piege le plus probable, la
  // mise a jour oubliee d'un seul cote — c'est ce genre de nom qui se met a
  // repondre " bruit" d'un seul bord.
  assert.equal(isNoisePath('BruitAjoute/x.json'), false, 'une regle absente des deux copies ne declare rien au bruit');
  assert.equal(renderer.isNoisePath('BruitAjoute/x.json'), false);
});

// --- Passe 2 de revue : le filet lui-meme ----------------------------------
//
// Le test ci-dessus compare les deux copies sur leurs VERDICTS. C'est necessaire
// et insuffisant, pour trois raisons measurables :
//
//   1. le plafond MAX_ENTRY_BYTES n'etait compare par personne — relever celui
//      du renderer seul ne faisait rougir aucun test ;
//   2. l'egalite des verdicts n'interdit pas une derive COSMETIQUE (ordre des
//      prefixes, nom de variable, regexp reecrite) : elle ouvre une fenetre
//      avant que la derive ne devienne fonctionnelle ;
//   3. cinq prefixes sur dix n'etaient portes par aucun cas : les retirer d'un
//      seul cote ne rougissait rien.
//
// Les trois tests ci-dessous ferment ces trois fenetres. Ils lisent les
// FICHIERS et non les modules importes : une regle ne peut pas se comparer
// elle-meme.

// Les quatre blocs qui portent la regle, dans les deux fichiers. Ce sont les
// seules lignes qui doivent etre copiees a l'identique.
const BLOCS_REGLE = ['MAX_ENTRY_BYTES', 'NOISE_PREFIXES', 'normalizeSegment', 'isNoisePath'];

const SONT_FONCTIONS = new Set(['normalizeSegment', 'isNoisePath']);

// Bloc de declaration TEL QU'ECRIT dans le fichier, du `const`/`function`
// jusqu'au `;` qui le termine ou l'accolade fermante de colonne 0. Ni le
// commentaire qui le precede, ni le `module.exports` qui le suit : ce sont des
// choix de mise en page, pas la regle. Les fins de ligne sont normalisees pour
// que le test porte sur le TEXTE et pas sur LF ou CRLF.
function blocRegle(source, nom) {
  const motif = SONT_FONCTIONS.has(nom)
    ? new RegExp(`(?:export )?function ${nom}\\(`)
    : new RegExp(`const ${nom} =`);
  const debut = source.search(motif);
  if (debut < 0) return null;
  const fin = SONT_FONCTIONS.has(nom)
    ? source.indexOf('\n}', debut)
    : source.indexOf(';', debut);
  if (fin < 0) return null;
  const bloc = source.slice(debut, SONT_FONCTIONS.has(nom) ? fin + 2 : fin + 1);
  return bloc.replace(/\r\n/g, '\n').replace(/^export /, '');
}

// Premiere ligne qui differe, avec les deux moities : sans elle, un echec
// d'egalite n'affiche que deux blocs de vingt lignes et ne se lit pas.
function premiereDivergence(nom, a, b) {
  const la = a.split('\n');
  const lb = b.split('\n');
  for (let i = 0; i < Math.max(la.length, lb.length); i += 1) {
    if (la[i] !== lb[i]) {
      return `bloc ${nom}, ligne ${i + 1}\n  principale : ${JSON.stringify(la[i])}\n  renderer  : ${JSON.stringify(lb[i])}`;
    }
  }
  return '';
}

test('le plafond est la MEME constante dans les deux copies de la regle', async () => {
  // Si les deux plafonds divergent, aucun des tests de verdicts ne rougit : ils
  // ne regardent que isNoisePath. Le chemin par index garde alors une entree
  // entre 128 et 256 Mio que le chemin flux jette — de la donnee perdue en
  // silence, et le choix du chemin ne se voit qu'a l'absence de messages.
  const renderer = await import('../src/services/packageImporter.service.js');
  assert.equal(typeof renderer.MAX_ENTRY_BYTES, 'number',
    'le renderer doit exporter MAX_ENTRY_BYTES : sans lui, relever son plafond seul ne rougirait aucun test');
  assert.equal(MAX_ENTRY_BYTES, 128 * 1024 * 1024, 'la copie principale garde 128 Mio');
  assert.equal(renderer.MAX_ENTRY_BYTES, MAX_ENTRY_BYTES,
    `les deux plafonds divergent : renderer=${renderer.MAX_ENTRY_BYTES}, principale=${MAX_ENTRY_BYTES}`);
});

test('les quatre blocs de la regle sont identiques au caractere pres dans les deux copies', () => {
  // Egalite des VERDICTS n'egale pas « copie a l'identique » : inverser deux
  // prefixes, renommer une variable ou reecrire une regexp change le texte sans
  // changer un seul verdict sur le corpus. Ce test lit les deux fichiers et
  // compare les quatre blocs apres retrait du seul mot-cle `export` — la seule
  // difference de forme autorisee entre un module ESM et un module CommonJS.
  const principale = readFileSync(new URL('../electron/packageImporter.rules.cjs', import.meta.url), 'utf8');
  const renderer = readFileSync(new URL('../src/services/packageImporter.service.js', import.meta.url), 'utf8');

  for (const nom of BLOCS_REGLE) {
    const a = blocRegle(principale, nom);
    const b = blocRegle(renderer, nom);
    // Un bloc introuvable doit faire ROUGE, jamais passer par egalite de deux
    // `null` : un renommage ferait sinon disparaitre la couverture en silence.
    assert.ok(a !== null, `bloc ${nom} introuvable dans electron/packageImporter.rules.cjs`);
    assert.ok(b !== null, `bloc ${nom} introuvable dans src/services/packageImporter.service.js`);
    assert.ok(a.length < 2000 && b.length < 2000, `bloc ${nom} : extraction anormalement longue, la borne est mauvaise`);
    assert.ok(!/^export /m.test(a) && !/^export /m.test(b), `bloc ${nom} : le mot-cle export n'a pas ete retire`);
    assert.equal(b, a, `les deux copies du bloc ${nom} divergent :\n${premiereDivergence(nom, a, b)}`);
  }
});

// Un dossier d'archive par prefixe, ecrit avec les espaces, la ponctuation et la
// casse qu'un dossier traduit peut avoir — sinon le temoin ne prouverait que le
// nom colle — et le prefixe SEUL qui doit le declarer bruit.
//
// Deux formes ne sont attustees par aucun export reel : « Demande Support » (le
// prefixe `demandesupport` existait deja, sans temoin) et « Support Requests »
// (prefixe ajoute cette passe, sur le fondement du sens, pas d'une capture).
// Pour ces deux-la, le temoin documente CE QUE FAIT LA REGLE, pas ce que
// Discord produit.
//
// Ce tableau est la piece qui manquait : sans lui, un prefixe sans temoin peut
// disparaitre d'un seul cote sans qu'aucun verdict ne change, et un prefixe mal
// orthographie peut s'introduire sans jamais rien attraper. La double boucle
// ci-dessous ferme les deux trous.
const TEMOINS = [
  ['Activité', 'activit'],
  ['Publicités', 'publicit'],
  ['Demandes de support', 'demandesdesupport'],
  ['Demandes de soutien', 'demandesdesoutien'],
  ['Demande Support', 'demandesupport'],
  ['Programs', 'program'],
  ['Advertisements', 'advertisement'],
  ['Ads', 'ads'],
  ['Tickets', 'ticket'],
  ['Support Tickets', 'supportticket'],
  ['Support Requests', 'supportrequests'],
];

test('chaque prefixe a un dossier temoin, et ce dossier ne tient qu a lui', async () => {
  const renderer = await import('../src/services/packageImporter.service.js');

  for (const prefixe of NOISE_PREFIXES) {
    const temoin = TEMOINS.find(([, attendu]) => attendu === prefixe);
    assert.ok(temoin, `le prefixe « ${prefixe } » n'a aucun temoin : personne ne prouve qu il sert a quelque chose`);

    const [dossier] = temoin;
    const norm = normalizeSegment(dossier);
    // Le prefixe doit correspondre a une orthographe POSSIBLE. « Demandes de
    // soutien » normalise en « demandesdesoutien » : c'est exactement ce controle
    // qui avait laisse passer un prefixe d'une lettre trop court.
    assert.ok(norm.startsWith(prefixe),
      `« ${dossier} » normalise en « ${norm} », qui ne commence pas par « ${prefixe } » : le prefixe ne correspond a aucune variante orthographique du dossier`);
    // Et il doit etre SEUL : si un autre prefixe couvre le meme dossier, le
    // retirer ne changerait aucun verdict, donc ce prefixe resterait sans
    // temoin — c'est precisement le cas de cinq prefixes avant cette passe.
    const autres = NOISE_PREFIXES.filter(p => p !== prefixe && norm.startsWith(p));
    assert.deepEqual(autres, [], `« ${dossier} » est aussi couvert par ${autres.join(', ')} : ce dossier ne prouve donc rien sur « ${prefixe } »`);

    assert.equal(isNoisePath(`${dossier}/x.json`), true, `copie principale : « ${dossier}/x.json » n'est pas classe bruit`);
    assert.equal(renderer.isNoisePath(`${dossier}/x.json`), true, `renderer : « ${dossier}/x.json » n'est pas classe bruit`);
  }

  // L'autre sens : un temoin qui ne designe aucun prefixe documente une orthographe
  // que la regle ne couvre pas. Retirer « supportrequests » des deux listes fait
  // rougir cette assertion : le doute resterait alors ecrit, et non perdu.
  for (const [dossier, prefixe] of TEMOINS) {
    assert.ok(NOISE_PREFIXES.includes(prefixe), `« ${prefixe} » (temoin « ${dossier} ») n est dans aucune des deux listes`);
  }
});

// --- Tache 3 : decompresser UNE entree, a son offset exact --------------------
//
// deflate est un flux unique et stateful : une entree s'ouvre d'un bloc, a son
// offset exact, une fois. La decouper couterait une lecture par entree, et le
// gain du chantier est precisement de n en demander qu une.
//
// Deux garde-fous precede l ouverture, et ni l un ni l autre n est dans
// selectEntries :
//
//   1. LE PLAFOND, PENDANT la decompression. Le chemin flux abandonne des que les
//      octets PRODUITS depassent le plafond (src/services/packageImporter.service.js,
//      ligne 316). selectEntries n a que l en-tete — et un en-tete peut mentir.
//      Sans filet ici, le chemin par index serait moins sur que celui qu il
//      remplace : exactement le genre de regression qui ne se voit qu au moment
//      ou l import diverge en silence.
//   2. LA SENTINELLE ZIP64. Le repertoire central est lu en u32 : une taille ou
//      un offset >= 4 Gio y vaut 0xFFFFFFFF et la vraie valeur vit dans le champ
//      extra ZIP64, que le module ne lit pas. Une sentinelle n est jamais une
//      valeur.
//      !! Sur l export REEL, ce garde-fou ne s est jamais declenche : l entree de
//      4096 Mio porte la sentinelle sur DEUX champs seulement (mesure, revue
//      finale), son localOffset vaut 163 485 153 — une vraie position — et elle est
//      ecartee par son NOM (Activite/...), ce que prouve `oversized: 0`. Ce qui
//      protege un export reel, c est donc la REGLE DE BRUIT, qui refuse par le nom
//      avant que la taille ne soit lue. Le garde-fou reste pour une entree GARDEE
//      qui porterait la sentinelle, et il est teste comme telle.

// Le contrat rend un Uint8Array. zlib rend un Buffer, qui en EST un : le test
// compare donc sur des octets purs plutot que d exiger une copie que
// l implementation n a pas lieu de faire.
const enOctets = (rendu) => Uint8Array.from(rendu);

// Les noms de test restent sans accents, comme tous ceux de ce fichier.
test('une entree lue a son offset se decompresse en octets identiques', async () => {
  const payload = strToU8('[{"ID":1009136231751360593,"Contents":"salut"}]');
  const bytes = zipSync({
    'Messages/c111111111111111111/messages.json': payload,
    'Serveurs/1/guild.json': strToU8('{"id":1,"name":"x"}'),
  });
  const file = fileFromBlob(bytes, 'package.zip');
  const { entries, reason } = await readZipIndex(file);
  assert.equal(reason, null, `raison inattendue : ${reason}`);

  const target = entries.find(entry => entry.name.endsWith('messages.json'));
  // AFFIRME avant d etre controle : sans cette assertion, le test passerait aussi
  // bien si inflateEntry rendait une entree STOCEE telle quelle — c est a dire
  // s il n decompressait rien du tout.
  assert.equal(target.method, 8, 'l entree du test est bien deflate');

  const out = await inflateEntry(file, target);
  assert.ok(out instanceof Uint8Array, `le contrat rend un Uint8Array, pas ${out && out.constructor && out.constructor.name}`);
  assert.equal(out.length, payload.length, 'la longueur decompressee');
  assert.deepEqual(enOctets(out), payload, 'octets identiques au contenu d origine, pas seulement de la meme longueur');

  // Et l autre entree de la meme archive, ouverte elle aussi : c est la preuve
  // que l offset rendu par le lecteur pointe bien sur CHAQUE entree.
  const guild = entries.find(entry => entry.name.endsWith('guild.json'));
  assert.equal(new TextDecoder().decode(await inflateEntry(file, guild)), '{"id":1,"name":"x"}');
});

test('une entree stockee sans compression est rendue telle quelle', async () => {
  const payload = strToU8('{"id":1}');

  // Cas ecrit a la main : methode 0, aucune decompression possible.
  const bytes = handMadeZip({ name: 'a.json', method: 0, payload });
  const { entries, reason } = await readZipIndex(fileFromBlob(bytes, 'p.zip'));
  assert.equal(reason, null, `raison inattendue : ${reason}`);
  assert.equal(entries[0].method, 0, 'l entree du test est bien stockee');
  assert.deepEqual(enOctets(await inflateEntry(fileFromBlob(bytes, 'p.zip'), entries[0])), payload);

  // Et le cas d un vrai archiveur : fflate ecrit du STOCE pour le niveau 0. Sans
  // cette seconde variante, le test ne prouverait que le format ecrit a la main.
  const reel = zipSync({ 'a.json': payload }, { level: 0 });
  const archive = fileFromBlob(reel, 'p.zip');
  const { entries: entrees, reason: raison } = await readZipIndex(archive);
  assert.equal(raison, null, `raison inattendue : ${raison}`);
  assert.equal(entrees[0].method, 0, 'le niveau 0 donne bien une entree stockee');
  assert.deepEqual(enOctets(await inflateEntry(archive, entrees[0])), payload);
});

test('ouvrir une entree demande deux tranches : l en-tete local, puis ses donnees', async () => {
  // Le contrat de lecture vaut aussi pour l ouverture : une tranche pour l
  // en-tete local (que localHeaderOffset lit a la demande, cf. tache 1), une pour
  // les octets compresses. Une implementation qui relirait le fichier, ou qui
  // decouperait l entree pour « superviser » la decompression, ne changerait RIEN
  // aux autres tests : seul le COMPTE et la PLAGE des lectures la distinguent.
  const payload = strToU8('[{"ID":1009136231751360593,"Contents":"salut"}]');
  const bytes = zipSync({
    'Messages/c111111111111111111/channel.json': strToU8('{"id":111111111111111111,"type":0}'),
    'Messages/c111111111111111111/messages.json': payload,
  });
  const file = countedFile(bytes, 'package.zip');
  const { entries, reason } = await readZipIndex(file);
  assert.equal(reason, null, `raison inattendue : ${reason}`);
  const target = entries.find(entry => entry.name.endsWith('messages.json'));

  // L offset attendu, relu par le module de la tache 1 : une tranche de plus,
  // comptee a part pour que les deux attendus ne se contaminent pas.
  const data = await localHeaderOffset(file, target, bytes.length);
  assert.ok(data > target.localOffset, 'les donnees suivent l en-tete local');

  file.slices.length = 0;
  const out = await inflateEntry(file, target);
  assert.deepEqual(enOctets(out), payload, 'octets identiques');
  // La premiere tranche fait 30 octets PLUS LA LONGUEUR DU NOM, et c est voulu :
  // c est ce qui permet de verifier que l en-tete local porte bien le NOM de
  // l entree annoncee, sans lire une troisieme tranche. La longueur du nom est
  // connue — c est celle de l entree, qu on a sous la main — donc le controle ne
  // coute aucune lecture de plus. Sur l archive reelle : 2 159 entrees ouvertes,
  // environ 110 Kio de plus lus, et le nombre de tranches reste 2 + 2 x 2 159.
  const nomEnOctets = Buffer.byteLength(target.name, 'utf8');
  assert.deepEqual(
    file.slices,
    [
      [target.localOffset, target.localOffset + 30 + nomEnOctets],
      [data, data + target.compressedSize],
    ],
    `deux tranches attendues — l en-tete local avec son nom, puis exactement compressedSize octets — pas ${JSON.stringify(file.slices)}`,
  );
});

test('une entree hors fichier echoue proprement, sans lire une seule tranche', async () => {
  const bytes = zipSync({ 'a.json': strToU8('{}') });
  const file = countedFile(bytes, 'p.zip');

  // 10 ** 12 n est PAS la sentinelle 0xFFFFFFFF : c est une borne de fichier, et
  // c est donc le test du garde-fou de l offset, pas celui de ZIP64 (lequel
  // verrait un egale, jamais un superieur).
  const beyond = { name: 'a.json', method: 8, compressedSize: 10, uncompressedSize: 20, localOffset: 10 ** 12 };
  await assert.rejects(() => inflateEntry(file, beyond), /hors du fichier|offset/i);
  assert.deepEqual(file.slices, [], 'une entree hors fichier est refusee sans lecture');

  // Controle POSITIF : le meme point d appel, sur une entree qui existe. Les
  // assertions ci-dessus passeraient aussi bien pour une fonction qui refuse
  // tout — et surtout, un refus qui eleve une exception synchrone au lieu de
  // renvoyer une promesse ne serait pas attrape par assert.rejects.
  const { entries, reason } = await readZipIndex(file);
  assert.equal(reason, null, `raison inattendue : ${reason}`);
  assert.equal(new TextDecoder().decode(await inflateEntry(file, entries[0])), '{}');
});

test('le plafond s applique EN COURS de route : une taille annoncee fausse ne passe pas', async () => {
  // Le piege que ce test ferme : selectEntries ne peut appliquer le plafond
  // qu a l en-tete. Une entree dont l en-tete annonce 800 Kio et qui en produit
  // 128 Mio serait donc GARDEE par le tri, puis decompressee sans borne par le
  // chemin par index — que le chemin flux, lui, aurait jetee a mi-parcours.
  //
  // La cible vaut MAX + 1024 et non MAX + 1 : le flux produit au plus 257 octets
  // de MOINS que la cible demandee, si bien que MAX + 1 donnerait un flux qui
  // tient encore sous le plafond et ne prouverait rien.
  const { flux, produits } = deflateBomb(MAX_ENTRY_BYTES + 1024);
  // AFFIRME avant d etre controle : sans cette assertion, un flux qui ne
  // depasserait pas le plafond passerait le test pour la mauvaise raison.
  assert.ok(produits > MAX_ENTRY_BYTES, `le flux doit vraiment depasser le plafond : ${produits} octets`);
  assert.ok(flux.length < produits / 100, `le flux compresse doit rester minuscule : ${flux.length} octets pour ${produits} produits`);

  const bytes = handMadeZip({ name: 'Messages/c1/messages.json', method: 8, payload: flux });
  const file = countedFile(bytes, 'bomb.zip');
  const { entries, reason } = await readZipIndex(file);
  assert.equal(reason, null, `raison inattendue : ${reason}`);

  const target = entries[0];
  // Le central porte la verite des octets COMPRESSES et un uncompressedSize
  // minuscule : c est le mensonge du cas « archive corrompue ou hostile ».
  assert.equal(target.compressedSize, flux.length, 'la taille compressee annoncee est exacte');
  assert.equal(target.uncompressedSize, flux.length, 'la taille decompressee annoncee est fausse, et minuscule');
  // Controle DECISIF : le tri, qui n a que l en-tete, ne peut rien voir de ce
  // mensonge. Si l entree est GARDEE, seul un plafond applique pendant la
  // decompression peut la refuser ensuite.
  assert.deepEqual(
    selectEntries(entries).kept.map(entry => entry.name),
    ['Messages/c1/messages.json'],
    'le classement garde l entree : il ne voit que l en-tete, il ne peut rien voir du mensonge',
  );

  file.slices.length = 0;
  await assert.rejects(() => inflateEntry(file, target), /plafond/i);
  assert.equal(file.slices.length, 2, `l entree a ete lue une fois, pas ${file.slices.length} : ${JSON.stringify(file.slices)}`);
});

test('une entree qui produit UN OCTET de plus que le plafond est refusee', async () => {
  // La frontiere exacte, que rien d autre ne sait prouver. Le chemin flux
  // abandonne des que la taille PRODUITE depasse MAX_ENTRY_BYTES ; une
  // implementation qui bornerait la sortie a MAX + 1 laisserait passer une entree
  // d un octet de trop, et l ecart ne se verrait qu au premier import reel ou les
  // deux chemins doivent tomber d accord. D ou ce flux, qui produit exactement
  // MAX + 1.
  const { flux, produits } = deflateFixe(MAX_ENTRY_BYTES + 1);
  assert.equal(produits, MAX_ENTRY_BYTES + 1, 'le flux produit exactement un octet de trop');
  assert.ok(flux.length * 100 < produits, `le flux compresse doit rester minuscule : ${flux.length} octets`);

  const bytes = handMadeZip({ name: 'Messages/c1/messages.json', method: 8, payload: flux });
  const file = countedFile(bytes, 'frontiere.zip');
  const { entries, reason } = await readZipIndex(file);
  assert.equal(reason, null, `raison inattendue : ${reason}`);
  const target = entries[0];
  assert.deepEqual(selectEntries(entries).kept, [target], 'le tri garde l entree : il ne voit que l en-tete');
  assert.ok(target.uncompressedSize <= MAX_ENTRY_BYTES, `l en-tete, lui, ne voit rien de trop : ${target.uncompressedSize}`);

  await assert.rejects(() => inflateEntry(file, target), /plafond/i);

  // Et le meme raisonnement sur l entree stockee, dont la production vaut
  // exactement compressedSize : la borne y est connue avant la lecture, et un
  // octet de trop doit y etre refuse de meme.
  const stockee = { ...target, method: 0, compressedSize: MAX_ENTRY_BYTES + 1 };
  await assert.rejects(() => inflateEntry(file, stockee), /plafond/i);
});

test('la borne de zlib est « au-dela », pas « au plafond » : une entree d un octet de trop est refusee', () => {
  // Le plafond passe en maxOutputLength de inflateRawSync, donc la SEMANTIQUE de
  // cette borne est une piece du contrat : si Node refusait des que la sortie
  // ATTEINT la borne, il faudrait passer MAX + 1, et une entree d un octet au
  // dessus du plafond passerait — un ecart d un octet entre le chemin par index
  // et le chemin flux, invisible jusqu au premier import reel.
  // Ce test verrouille donc le mecanisme dont depend l implementation.
  const charge = deflateSync(new Uint8Array(1000)); // 1000 octets exacts
  for (const [borne, doitPasser] of [[999, false], [1000, true], [1001, true]]) {
    let erreur = null;
    let rendu = null;
    try {
      rendu = inflateRawSync(charge, { maxOutputLength: borne });
    } catch (error) {
      erreur = error;
    }
    if (doitPasser) {
      assert.equal(erreur, null, `borne ${borne} : une sortie de 1000 octets doit passer`);
      assert.equal(rendu.length, 1000);
    } else {
      assert.ok(erreur, `borne ${borne} : une sortie de 1000 octets doit etre refusee`);
      assert.equal(erreur.code, 'ERR_BUFFER_TOO_LARGE');
    }
  }
});

test('une sentinelle ZIP64 est refusee explicitement, sur les trois champs', async () => {
  // Les trois champs sont concernes, et pas pour la meme raison : une taille
  // sentinelle se lit comme une taille enorme (elle echappe au plafond), un
  // offset sentinelle se lit comme une position qu on ouvrirait sans rien voir.
  const { flux } = deflateBomb(2048);
  const cas = [
    { champ: 'compressedSize', garde: true }, // kept par le tri : ouvrirait 4 Gio
    { champ: 'localOffset', garde: true }, // kept par le tri : ouvrirait ailleurs
    { champ: 'uncompressedSize', garde: false }, // ecarte par le tri, PAR CHANCE
  ];

  for (const { champ, garde } of cas) {
    const bytes = handMadeZip({ name: 'Messages/c1/messages.json', method: 8, payload: flux, [champ]: 0xffffffff });
    const file = countedFile(bytes, 'zip64.zip');
    const { entries, reason } = await readZipIndex(file);
    assert.equal(reason, null, `${champ} : l index se lit normalement, la sentinelle ne concerne que l ouverture`);
    assert.equal(entries[0][champ], 0xffffffff, `${champ} : la sentinelle est bien lue comme telle`);

    // Ce que le tri fait aujourd hui de cette entree, et pourquoi c est
    // aujourd hui une chance et non une garantie.
    const classes = selectEntries(entries);
    assert.deepEqual(
      classes.kept.map(entry => entry.name),
      garde ? ['Messages/c1/messages.json'] : [],
      `${champ} : ${garde ? 'GARDEE par le tri, donc jamais ouverte par lui' : 'ecartee par le tri, mais seulement parce que la sentinelle depasse le plafond'}`,
    );

    file.slices.length = 0;
    await assert.rejects(
      () => inflateEntry(file, entries[0]),
      /ZIP64/i,
      `${champ} : 0xFFFFFFFF doit etre refuse explicitement, pas calcule`,
    );
    assert.deepEqual(file.slices, [], `${champ} : refuse avant toute lecture`);
  }
});

test('sur une archive de plus de 4 Go, une sentinelle est une position legitime : rien ne la rattraperait', async () => {
  // Le cas reel que le test precedent ne peut pas reproduire : son archive fait
  // 1 Mio, ou 0xFFFFFFFF est hors du fichier et le bornage le rattrape donc par
  // hasard. Ici le fichier DECLARE 8 Gio et rend un en-tete local VALIDE pour
  // n'importe quelle position : 0xFFFFFFFF est alors une position ordinaire, et
  // une implementation sans garde-fou ouvrirait l entree au mauvais endroit,
  // silencieusement, sans lever — les octets rendus seraient ceux de la position
  // voisine. D ou les DEUX attentes : le refus nomme la sentinelle, et surtout
  // AUCUNE tranche n est demandee, ce qui est la seule trace de cet arret-la.
  const { flux } = deflateBomb(2048);
  const petit = fileFromBlob(handMadeZip({ name: 'Messages/c1/messages.json', method: 8, payload: flux }), 'zip64.zip');
  const { entries, reason } = await readZipIndex(petit);
  assert.equal(reason, null, `raison inattendue : ${reason}`);

  for (const champ of ['compressedSize', 'localOffset']) {
    const cible = { ...entries[0], [champ]: 0xffffffff };
    assert.equal(cible[champ], 0xffffffff, `${champ} : la sentinelle est bien presente`);

    const tranches = [];
    const geant = {
      name: 'geant.zip',
      size: 8 * 1024 ** 3,
      slice(start, end) {
        tranches.push([start, end]);
        // Un en-tete local valide a n'importe quel offset : c'est ce qui rend la
        // sentinelle piegeuse au lieu de simplement absurde.
        return petit.slice(0, Math.min(end - start, petit.size));
      },
    };
    assert.equal(
      selectEntries([cible]).kept.length,
      1,
      `${champ} : le tri garde cette entree, elle doit donc etre refusee a l ouverture`,
    );

    await assert.rejects(() => inflateEntry(geant, cible), /ZIP64/i, `${champ} : refus explicite`);
    assert.deepEqual(tranches, [], `${champ} : aucune lecture dans un fichier de 8 Gio ou le borne de fichier ne rattrape rien`);
  }
});

test('une entree stockee plus grande que le plafond est refusee SANS lire ses donnees', async () => {
  // Meme garde-fou, chemin stocke : une entree sans compression produit
  // exactement compressedSize octets. La borne est donc connue AVANT la lecture,
  // et se verifier apres n aurait servi a rien — on aurait lu 200 Mio pour les
  // jeter.
  const bytes = handMadeZip({ name: 'a.json', method: 0, payload: strToU8('{}') });
  const { entries, reason } = await readZipIndex(fileFromBlob(bytes, 'p.zip'));
  assert.equal(reason, null, `raison inattendue : ${reason}`);

  // 8 Gio de taille annoncee : sans ce gigantisme, le refus viendrait de la
  // borne de fichier (data + compressedSize hors du fichier) et non du plafond.
  // C est donc bien le plafond qui est teste, et lui seul.
  const geant = {
    name: 'geant.zip',
    size: 8 * 1024 ** 3,
    slice() { throw new Error('lecture interdite : le plafond doit etre tranche avant la lecture'); },
  };
  const cible = { ...entries[0], compressedSize: MAX_ENTRY_BYTES + 1, uncompressedSize: 10 };
  assert.deepEqual(selectEntries([cible]).kept, [cible], 'le tri garde cette entree : seule l ouverture peut la refuser');
  await assert.rejects(() => inflateEntry(geant, cible), /plafond/i);
});

test('une donnee compressee illisible est refusee avec le message de zlib', async () => {
  // Le plan exige que l appelant decide du repli : il lui faut la raison de
  // l echec, pas un « echec » sans cause. Oracle independant de l implementation
  // — le message que zlib rend sur ces octets-la.
  const payload = strToU8('ceci n est pas un flux deflate');
  const bytes = handMadeZip({ name: 'a.json', method: 8, payload });
  const file = fileFromBlob(bytes, 'p.zip');
  const { entries, reason } = await readZipIndex(file);
  assert.equal(reason, null, `raison inattendue : ${reason}`);

  let attendu = '';
  try {
    inflateRawSync(payload);
  } catch (error) {
    attendu = error.message;
  }
  assert.ok(attendu, `zlib refuse ces octets, et le test ne peut pas le supposer : ${attendu}`);

  await assert.rejects(() => inflateEntry(file, entries[0]), (error) => {
    assert.ok(error instanceof Error, `un refus doit etre une Error, pas ${error}`);
    assert.match(error.message, /illisible/i, `le refus doit nommer la cause : ${error.message}`);
    assert.ok(
      error.message.includes(attendu),
      `le message de zlib (« ${attendu} ») doit se retrouver dans le refus : « ${error.message} »`,
    );
    return true;
  });

  // Et une methode inconnue n est pas « stockee » : elle est refusee, pas rendue
  // telle quelle. Le chemin flux la refuse aussi (fflate ne la decompresse pas),
  // donc les deux chemins concordent.
  const inconnue = { ...entries[0], method: 99 };
  await assert.rejects(() => inflateEntry(file, inconnue), (error) => {
    assert.ok(error instanceof Error && error.message.length > 0, 'une methode inconnue donne un refus motive');
    return true;
  });
});

test('une tranche qui rend moins que demande donne un refus de troncature', async () => {
  // Le contrat de lecture du chantier est `{ name, size, slice }` : un wrapper
  // est donc admis, et un wrapper peut rendre une tranche plus courte que
  // demandee — une lecture partielle, un fichier synchronise a moitie, un cache
  // qui s arrete sur une frontiere. La borne de fichier ne voit rien de cela :
  // elle ne compare que des nombres. Sans ce controle, les octets raccourcis
  // partiraient quand meme chez zlib, qui repondrait « fin de fichier inattendue »,
  // un message qui accuse la compression d un defaut qu elle n a pas.
  const payload = strToU8('[{"ID":1009136231751360593,"Contents":"salut"}]');
  const bytes = zipSync({ 'Messages/c1/messages.json': payload });
  const reel = fileFromBlob(bytes, 'p.zip');
  const { entries, reason } = await readZipIndex(reel);
  assert.equal(reason, null, `raison inattendue : ${reason}`);
  const target = entries[0];

  let demandes = 0;
  const data = await localHeaderOffset(reel, target, bytes.length);
  // Le wrapper ne detient qu'un prefixe de l'archive : l'en-tete local, qui
  // demande 30 octets, passe intact ; la tranche de donnees, bien plus longue,
  // arrive amputee. C'est bien la DONNEE qui est tronquee, pas l'en-tete — sans
  // cette distinction, le refus viendrait de la borne d'en-tete de
  // localHeaderOffset, et le test ne prouverait rien sur le controle vise.
  const prefixe = data + Math.floor(target.compressedSize / 2);
  const partiel = {
    name: 'partiel.zip',
    size: bytes.length, // taille honnete : la borne de fichier est satisfaite
    slice(start, end) { demandes += 1; return reel.slice(start, Math.min(end, prefixe)); },
  };
  await assert.rejects(() => inflateEntry(partiel, target), /tronque/i);
  assert.equal(demandes, 2, `l en-tete local puis la donnee : ${demandes} tranches demandees`);

  // Controle POSITIF, sur le meme objet et a la seule difference de la tranche :
  // une lecture complete rend les octets. Sans ce controle, `troncature` serait
  // vrai par construction.
  const complet = { name: 'complet.zip', size: bytes.length, slice: (start, end) => reel.slice(start, end) };
  assert.deepEqual(enOctets(await inflateEntry(complet, target)), payload, 'une lecture complete n est pas une troncature');
});

// --- Seconde passe de revue : ce que zlib recoit, et ce que l en-tete annonce --
//
// Deux trous restaient, tous deux invisibles a la suite.
//
// 1. LA BORNE DE LA DECOMPRESSION n etait verifiee par AUCUN test. Pas « difficile
//    a verifier » : impossible a voir. Retirer `maxOutputLength`, le mettre a
//    MAX + 1, ou le mettre a Infinity ne changeait aucun resultat — la sortie
//    d un octet de trop echouait quand meme, sur un controle ulterieur. La suite
//    ne pouvait donc pas distinguer un bornage REEL d un bornage DECLARE, et c est
//    le bornage reel qui protege le chemin par index d une decompression sans
//    borne. Il se verifie en interceptant l appel : on lit les options que zlib
//    recoit, pas ce qu il en fait. Ni mesure de temps, ni mesure de memoire, donc
//    rien d instable, et aucune refactorisation n est interdite.
// 2. LA TAILLE COMPRESSEE n etait bornee par rien. Un repertoire central qui
//    annonce 3 Gio et 10 octets decompressees fait allouer 3 Gio d un seul coup
//    dans le main process. La ou le chemin flux, lui, n exceeded jamais un bloc de
//    64 Kio. C est le seul endroit ou le chemin par index etait reellement moins
//    sur que celui qu il remplace.

// Chemin du service tel que `require` le resout, pour pouvoir le purger de son
// cache et le recharger avec un zlib intercepte.
const SERVICE = require.resolve('../electron/packageImporter.service.cjs');

test('la borne de zlib est passee a l appel : les options recues portent maxOutputLength', async () => {
  // INTERCEPTION, en processus, deterministe : on remplace `inflateRawSync` sur
  // l instance CommonJS de node:zlib, on purge le service de require.cache pour
  // qu il relise le module (il detruit `inflateRawSync` au chargement), et on
  // enregistre ce que zlib recoit. Le correctif delegue au vrai zlib : rien n est
  // simule, et la sortie reste comparee octet a octet.
  const zlib = require('node:zlib');
  const reel = zlib.inflateRawSync;
  const recus = [];
  zlib.inflateRawSync = function (...args) {
    recus.push({ data: args[0], options: args[1] });
    return reel.apply(this, args);
  };
  try {
    delete require.cache[SERVICE];
    const { inflateEntry: surveille } = require(SERVICE);

    // --- Cas 1 : une entree honnete, qui passe -------------------------------
    const payload = strToU8('[{"ID":1009136231751360593,"Contents":"salut"}]');
    const bytes = zipSync({ 'Messages/c1/messages.json': payload });
    const file = fileFromBlob(bytes, 'package.zip');
    const { entries, reason } = await readZipIndex(file);
    assert.equal(reason, null, `raison inattendue : ${reason}`);
    const cible = entries[0];
    assert.equal(cible.method, 8, 'l entree du test est bien en deflate');

    const out = await surveille(file, cible);

    assert.equal(recus.length, 1, `zlib doit etre appele une fois, pas ${recus.length} : ${JSON.stringify(recus.map(r => r.options))}`);
    // LE controle. Egalite stricte : une option en trop, une borne a MAX + 1,
    // une borne absente, un `maxOutputLength: undefined` — tout rougit ici, et
    // rien d autre dans la suite ne le voit.
    assert.deepEqual(
      recus[0].options,
      { maxOutputLength: MAX_ENTRY_BYTES },
      `zlib doit recevoir la borne TELLE QUELLE : ${JSON.stringify(recus[0].options)}`,
    );
    // La borne etait en vigueur sur l appel REEL, pas sur une copie : les octets
    // qui entrent sont bien ceux de l entree, et ceux qui sortent sont les bons.
    assert.deepEqual(enOctets(out), payload, 'octets decompresses identiques, l interception n a rien change au resultat');
    assert.equal(recus[0].data.length, cible.compressedSize, 'zlib recoit les octets COMPRESSES, dans leur ordre');

    // --- Cas 2 : une entree au-dela du plafond, qui echoue -------------------
    // Meme interception, sur l appel qui refuse : la borne doit etre en vigueur
    // precisement quand zlib leve, sans quoi le refus viendrait d ailleurs.
    const { flux, produits } = deflateBomb(MAX_ENTRY_BYTES + 1024);
    const bombe = fileFromBlob(handMadeZip({ name: 'Messages/c1/messages.json', method: 8, payload: flux }), 'bomb.zip');
    const { entries: cibleBombe, reason: raisonBombe } = await readZipIndex(bombe);
    assert.equal(raisonBombe, null, `raison inattendue : ${raisonBombe}`);
    await assert.rejects(() => surveille(bombe, cibleBombe[0]), /plafond/i);

    assert.equal(recus.length, 2, `zlib doit avoir ete appele deux fois, pas ${recus.length}`);
    assert.deepEqual(recus[1].options, { maxOutputLength: MAX_ENTRY_BYTES }, 'la borne est en vigueur aussi sur l appel qui echoue');
    assert.ok(recus[1].data.length < produits / 100, `le flux compresse reste minuscule : ${recus[1].data.length} octets pour ${produits} produits`);
  } finally {
    zlib.inflateRawSync = reel;
    // Le service est purge puis recharge, pour que le cache ne conserve aucune
    // copie liee au zlib intercepte. Le `inflateEntry` du sommet du fichier garde
    // sa reference d origine, capture intacte : les autres tests n en sont pas
    // affectes.
    delete require.cache[SERVICE];
    require(SERVICE);
  }
});

test('une taille compressee annoncee trop grande est refusee AVANT toute lecture', async () => {
  // Le trou que ce test ferme, et le SEUL endroit ou le chemin par index etait
  // moins sur que le chemin flux qu il remplace. Sur deflate, `compressedSize`
  // n etait borne par rien : une entree qui annonce 3 Gio de donnees compressees
  // et 10 octets decompressees passe le tri, puis fait allouer 3 Gio d un seul
  // coup — `file.slice(data, data + compressedSize).arrayBuffer()` — dans le
  // main process. Le chemin flux, lui, n exceeded jamais un bloc de 64 Kio.
  //
  // 3 Gio, et non 0xFFFFFFFF : c est une VRAIE valeur, que `localHeaderOffset`
  // accepte des que le fichier est assez grand. Sans ce gigantisme du fichier,
  // le refus viendrait de la borne de fichier (`data + compressedSize > size`) et
  // non du plafond — le test ne prouverait rien sur le garde-fou vise.
  const { flux } = deflateBomb(2048);
  const bytes = handMadeZip({
    name: 'Messages/c1/messages.json',
    method: 8,
    payload: flux,
    compressedSize: 3 * 1024 ** 3,
    uncompressedSize: 10,
  });
  const petit = fileFromBlob(bytes, 'p.zip');
  const { entries, reason } = await readZipIndex(petit);
  assert.equal(reason, null, `raison inattendue : ${reason}`);
  const cible = entries[0];
  assert.equal(cible.method, 8, 'l entree est bien en deflate : c est ce chemin qui n etait pas borne');
  assert.equal(cible.compressedSize, 3 * 1024 ** 3, 'la taille compressee annoncee est bien de 3 Gio');
  assert.notEqual(cible.compressedSize, 0xffffffff, 'ce n est PAS la sentinelle ZIP64 : seul un plafond peut refuser cette valeur');
  // Le tri n a que l en-tete, et 3 Gio de donnes compressees n est pas un bruit :
  // l entree passe. Seul `inflateEntry` peut encore la refuser.
  assert.deepEqual(selectEntries([cible]).kept, [cible], 'le tri garde l entree : seule l ouverture peut la refuser');

  const tranches = [];
  const geant = {
    name: 'geant.zip',
    size: 8 * 1024 ** 3,
    slice(start, end) { tranches.push([start, end]); throw new Error('lecture interdite : le plafond doit etre tranche avant la lecture'); },
  };
  await assert.rejects(() => inflateEntry(geant, cible), /taille compressee/i);
  assert.deepEqual(tranches, [], `refuse avant toute lecture, pas ${tranches.length} tranches demandees`);

  // La frontiere exacte de la nouvelle borne, et sa semantique « au-dela ». Les
  // deux cas ci-dessous ne different que d UN octet, et leurs refus ne peuvent
  // pas etre confondus : le premier est tronque — c est-a-dire qu il a franchi
  // le plafond et demande la lecture — le second est refuse par le plafond.
  // Aucun des deux n alloue quoi que ce soit : la tranche rendue est courte.
  const MAX_MARGE = MAX_ENTRY_BYTES + 1024 * 1024;
  for (const [annonce, refuse] of [[MAX_MARGE, false], [MAX_MARGE + 1, true]]) {
    const lu = [];
    const fichier = {
      name: 'p.zip',
      size: 8 * 1024 ** 3,
      slice(start, end) { lu.push([start, end]); return petit.slice(start, Math.min(end, petit.size)); },
    };
    const cas = { ...cible, compressedSize: annonce };
    let message = '';
    try {
      await inflateEntry(fichier, cas);
    } catch (error) {
      message = error.message;
    }
    if (refuse) {
      assert.match(message, /taille compressee/i, `compressedSize = ${annonce} doit etre refuse par le plafond, pas autrement : « ${message} »`);
      assert.deepEqual(lu, [], `compressedSize = ${annonce} : aucune lecture, pas ${JSON.stringify(lu)}`);
    } else {
      // Passe le plafond, echoue sur la troncature : donc la BORNE n est pas la
      // cause, et l anneau de la lecture demandee vaut bien la taille annoncee.
      assert.match(message, /tronque/i, `compressedSize = ${annonce} doit franchir le plafond, pas etre refuse par lui : « ${message} »`);
      assert.equal(lu.length, 2, `l en-tete local puis la donnee : ${JSON.stringify(lu)}`);
      assert.equal(lu[1][1] - lu[1][0], annonce, 'la tranche demandee vaut la taille compressee annoncee');
    }
  }

  // Et le chemin stocke reste borne par le plafond EXACT, sans marge : une entree
  // sans compression produit exactement compressedSize octets, donc il n y a rien a
  // tolerate.
  const stockee = { ...cible, method: 0, compressedSize: MAX_ENTRY_BYTES + 1 };
  await assert.rejects(() => inflateEntry(geant, stockee), /taille compressee/i);
});

// Ce que zlib donne pour borne d un deflate : deflateBound(s) = s + (s>>12) +
// (s>>14) + (s>>25) + 13. C est la seule base honnete pour choisir une marge, et
// elle est VERIFIEE sur place par le test ci-dessous, sur des donnees que deflate
// ne peut pas reduire.
function borneDeflate(taille) {
  return taille + (taille >>> 12) + (taille >>> 14) + (taille >>> 25) + 13;
}

test('deflate n engendre que 0,03 % : la marge de 1 Mio ne peut pas refuser une archive honnete', async () => {
  // La marge du plafond sur compressedSize doit couvrir TOUT ce que deflate peut
  // fabriquer autour de son entree, sans quoi une archive honnete serait refusee.
  // Mesure : 40 965 octets de plus que 128 Mio, soit 0,0305 %, et la borne de
  // zlib en autorise 40 977. Une marge de 1 Mio les couvre 25 fois.
  const incompr = incompressible(1024 * 1024);
  const comprime = deflateRawSync(incompr);
  const engendres = comprime.length - incompr.length;
  assert.ok(engendres > 0, `deflate engendre ${engendres} octets de plus que son entree : le plafond porte sur ce qui SORT, une borne sur ce qui ENTRE ne peut donc pas etre exacte`);
  assert.ok(
    engendres <= borneDeflate(incompr.length) - incompr.length,
    `deflate engendre ${engendres} octets, sa propre borne n en autorise que ${borneDeflate(incompr.length) - incompr.length}`,
  );

  const marge = 1024 * 1024;
  const besoin = borneDeflate(MAX_ENTRY_BYTES) - MAX_ENTRY_BYTES;
  assert.ok(
    marge > besoin,
    `une marge de ${marge} octets ne couvre pas les ${besoin} octets que deflate peut engendrer sous le plafond`,
  );

  // Et surtout, une entree honnete de cette espece s'ouvre : incompressible
  // n est pas une excuse pour refuser.
  const bytes = handMadeZip({ name: 'Messages/c1/messages.json', method: 8, payload: comprime });
  const file = fileFromBlob(bytes, 'p.zip');
  const { entries, reason } = await readZipIndex(file);
  assert.equal(reason, null, `raison inattendue : ${reason}`);
  const cible = entries[0];
  assert.equal(cible.method, 8, 'l entree est bien en deflate');
  assert.equal(cible.uncompressedSize, comprime.length, 'l en-tete annonce la taille COMPRESSEE : c est le mensonge habituel de handMadeZip');
  assert.ok(cible.compressedSize <= MAX_ENTRY_BYTES + 1024 * 1024, `une entree honnete tient sous le plafond des donnees compressees : ${cible.compressedSize}`);
  assert.deepEqual(enOctets(await inflateEntry(file, cible)), incompr, 'une entrie honnete et incompressible s ouvre, octet pour octet');
});

// --- LE MEME DEFAUT, UNE SECONDE FOIS : LE REPERTOIRE CENTRAL LUI-MEME ----------
//
// La tache 3 a borne `compressedSize`, pour une raison ecrite dans ce fichier : une
// entree qui annonce 3 Gio compresses et 10 octets decompressees ferait allouer 3 Gio
// d un seul coup dans le main process. `centralSize` est EXACTEMENT la meme valeur,
// lue au meme endroit et lue dans la meme tranche unique — et n etait borne par RIEN.
// Un EOCD qui annonce un repertoire central couvrant tout le fichier suffit :
// `readBytes(file, centralOffset, eocdEnd)` demande alors la taille ENTIERE du
// fichier, d un bloc. Mesure par la revue finale : 2 098 Mio de RSS sur une archive de
// 1 Gio, alors que le code accepte explicitement 8 Gio de fichier — donc la mort du
// processus par commit, sans fenetre de recuperation.
//
// C est ce qui rend le defaut inacceptable : le motif de la correction existe deja dans
// ce meme fichier, a quelques lignes d ici. Le meme bug, laisse deux fois.

// Un fichier dont l EOCD MENT sur la taille de son repertoire central, sans qu un seul
// des octets annonces n existe.
//
// La borne de fichier du module (`centralOffset + centralSize > fileSize`) ne peut pas
// attraper ce mensonge : il suffirait de declarer un `file.size` immense. Ce fichier le
// fait — il ANNONCE `taille` octets et ne materialise que la fenetre de fin, celle que le
// pilote lit en premier. Le reste n est jamais rendu : une tranche trop large rend une
// plage VIDE, sans aucune allocation, si bien que le test peut exiger qu une demande de
// 1 Gio n ait pas eu lieu sans jamais allouer un octet de cette taille.
function fichierAuCentralmenteur({ taille, centralSize, entrees = 1, nom = 'mentant.zip' }) {
  const eocd = new Uint8Array(TAIL_WINDOW); // remplissage nul : aucune signature fortuite
  const vue = new DataView(eocd.buffer);
  const at = TAIL_WINDOW - 22; // l EOCD est le dernier enregistrement, suivi de son commentaire vide
  vue.setUint32(at, 0x06054b50, true); // signature EOCD
  vue.setUint16(at + 8, 1, true); // nombre de disques
  vue.setUint16(at + 10, entrees, true); // nombre d entrees
  vue.setUint32(at + 12, centralSize, true); // taille du repertoire central : LE MENSONGE
  vue.setUint32(at + 16, 0, true); // offset du central : il couvre le fichier depuis son debut

  const debutFenetre = taille - TAIL_WINDOW;
  const tranches = [];
  return {
    name: nom,
    size: taille,
    tranches,
    slice(debut, fin) {
      const from = Math.max(0, Number(debut) || 0);
      const to = Number(fin);
      tranches.push([from, to]);
      const d = Math.max(from, debutFenetre);
      const f = Math.min(to, taille);
      const out = f > d ? eocd.slice(d - debutFenetre, f - debutFenetre) : new Uint8Array(0);
      return { length: out.length, arrayBuffer: () => out.buffer };
    },
  };
}

test('un central qui annonce plus que le plafond est refuse SANS qu une tranche de cette taille soit demandee', async () => {
  // AFFIRMATIONS AVANT CONTROLE. Sans elles, le test pourrait passer pour la mauvaise
  // raison : un plafond assez haut pour passer sur 1 Gio, ou un mensonge que la seule
  // borne de fichier rattraperait, donneraient le meme refus que le plafond.
  const TAILLE = 1024 ** 3; // 1 Gio : la mesure de la revue, et une valeur qui reste dans le u32
  assert.ok(TAILLE - 22 > MAX_CENTRAL_BYTES, `le mensonge doit depasser le plafond : ${TAILLE - 22} contre ${MAX_CENTRAL_BYTES}`);
  assert.ok(TAILLE - 22 < 0xffffffff, 'et rester une VRAIE valeur u32 : seule une borne peut refuser ce cas, pas la sentinelle ZIP64');

  const fichier = fichierAuCentralmenteur({ taille: TAILLE, centralSize: TAILLE - 22 });
  const { entries, reason } = await readZipIndex(fichier);

  assert.equal(entries, null, `aucune entree rendue : « ${reason} »`);
  // LA RAISON EST EXPLICITE : elle nomme le champ ET le plafond, pour qu un journal
  // dise pourquoi le chemin flux a pris le relais.
  assert.match(reason, /central/i, `la raison nomme le repertoire central : « ${reason} »`);
  assert.ok(reason.includes(String(MAX_CENTRAL_BYTES)), `la raison nomme le plafond de ${MAX_CENTRAL_BYTES} : « ${reason} »`);

  // LE CONTROLE DECISIF, et le seul qui compte : la TAILLE DEMANDEE. Une
  // implementation qui rendrait sa raison en ayant demande 1 Gio d abord passerait
  // toutes les assertions ci-dessus et tuerait le main process — c est exactement le
  // motif de la correction appliquee a `compressedSize` quelques lignes plus haut.
  assert.deepEqual(
    fichier.tranches,
    [[TAILLE - TAIL_WINDOW, TAILLE]],
    `la SEULE lecture doit etre la fenetre de fin : ${JSON.stringify(fichier.tranches)}`,
  );

  // La frontiere exacte, et sa semantique « au-dela ». Sans ce second cas, un plafond
  // pose a `>=` — ou a MAX + 1 — passerait le test du dessus et refuserait une archive
  // honnete dont le repertoire central fait exactement la taille du plafond. Les deux cas
  // ne different que d UN octet, et leurs motifs ne peuvent pas etre confondus : le
  // premier est tronque, c est-a-dire qu il a franchi le plafond et demande la lecture.
  for (const [annonce, refuse] of [[MAX_CENTRAL_BYTES, false], [MAX_CENTRAL_BYTES + 1, true]]) {
    const cas = fichierAuCentralmenteur({ taille: TAILLE, centralSize: annonce });
    const { entries: entrees, reason: motif } = await readZipIndex(cas);

    for (const [d, f] of cas.tranches) {
      assert.ok(f - d <= MAX_CENTRAL_BYTES, `centralSize = ${annonce} : tranche de ${f - d} octets demandee, au-dela du plafond de ${MAX_CENTRAL_BYTES}`);
    }

    if (refuse) {
      assert.equal(entrees, null, `centralSize = ${annonce} : aucune entree rendue`);
      assert.ok(motif.includes(String(MAX_CENTRAL_BYTES)), `centralSize = ${annonce} : refuse par le plafond, nomme comme tel : « ${motif} »`);
      assert.deepEqual(cas.tranches, [[TAILLE - TAIL_WINDOW, TAILLE]], `centralSize = ${annonce} : aucune lecture du central, pas ${JSON.stringify(cas.tranches)}`);
    } else {
      assert.match(motif, /tronque/i, `centralSize = ${annonce} : le plafond ne doit pas etre la cause du refus : « ${motif} »`);
      assert.deepEqual(cas.tranches[1], [0, annonce], `centralSize = ${annonce} : la tranche demandee vaut exactement la taille annoncee`);
    }
  }
});

test('un central trop grand fait basculer sur le flux : le repli prend bien le relais', async () => {
  // Le plafond seul ne servirait a rien si le chemin index s y arretait : l import
  // doit aboutir. Ce test le prouve sur le MEME fichier mensonger, avec un chemin flux
  // TENDU — donc sans relire 1 Gio — et il exige que ce chemin flux soit APPELÉ, pas
  // seulement atteint : un repli qui n appellerait personne ne laisserait qu un echec
  // affiche, et le mode announce serait un mensonge.
  const TAILLE = 1024 ** 3;
  const fichier = fichierAuCentralmenteur({ taille: TAILLE, centralSize: TAILLE - 22 });
  const paquet = { user: {}, guilds: [], channels: [], messages: new Map(), totalMessages: 0, packageSizeBytes: TAILLE, discarded: { noise: 0, oversized: 0 } };

  let appele = 0;
  const resultat = await importPackageWithFallback(fichier, {
    loadStreamImporter: async () => (fichierArg, options) => { appele += 1; return paquet; },
  });

  assert.equal(appele, 1, `le chemin flux doit etre tente : ${appele} appel(s)`);
  assert.equal(resultat.mode, 'stream', 'le pilote index echoue et le chemin flux prend le relais');
  assert.ok(resultat.reason.includes(String(MAX_CENTRAL_BYTES)), `la raison du repli est celle du plafond : « ${resultat.reason} »`);
  assert.equal(resultat.package, paquet, 'le paquet rendu est celui du chemin flux');
  assert.equal(resultat.error, null, 'et aucun echec du repli');
  for (const [d, f] of fichier.tranches) {
    assert.ok(f - d <= MAX_CENTRAL_BYTES, `le repli n a rien demande au-dela du plafond : tranche de ${f - d} octets`);
  }
});

// --- Tache 4 : le chemin par index doit produire LE MEME resultat --------------
//
// Le chantier ne vaut que s'il est invisible. Le chemin de reference est
// `importDiscordPackage`, qui lit l'archive par blocs de 4 Mio et gonfle TOUTES
// les entrees, y compris les ~374 Mio de bruit qu'il jette ensuite — soit 95 % de
// l'archive reelle, deux gros fichiers de telemetrie (mesure, revue finale) ; le chemin par index
// lit le repertoire central et n'ouvre que les entrees gardees. Les deux doivent
// rendre le meme etat final, sinon l'IHM affiche autre chose selon le chemin
// qu'un import a pris par hasard — et rien ne le dirait.
//
// Ce test est donc le plus exigeant du fichier : il ne compare ni un compte
// d'elements, ni une longueur. Il compare les deux objets CHAMP PAR CHAMP, dans
// l'ordre ou les deux chemins les produisent, et il compare aussi la TRACE des
// rappels (onEntry) et la phase « extraction » de la progression, parce que ce
// sont les seules traces observables de ce que chaque chemin a reellement fait.
// Un compte d'elements passerait sur une implementation qui trie les salons dans
// le desordre, qui perd `guildId`, qui laisse un nom de remplacement s'echapper ou
// qui jette deux fois le meme salon.

const USER_ID = '123456789012345678';

// L OBJET de la fixture, separe de son empaquetage : c est ce qui permet de
// reconstruire la MEME archive dans une taille differente (voir
// archiveAuDessusDuBloc) sans dupliquer trente entrees.
//
// Une seule de ces entrees suffit a rendre les deux chemins divergents si l'un
// d'eux evolue : le resultat n'est pas « le nombre de salons », c'est l'objet.
function objetDeParite() {
  return {
    // --- Le compte, avec un avatar qui doit devenir une URL CDN --------------
    'Compte/user.json': strToU8(`{
  "id": ${USER_ID},
  "username": "testeur",
  "global_name": "Testeur",
  "avatar_hash": "a95b780ee6a221f82fca3dea0de7ad6b"
}`),
    // Une entree dont le nom n'interesse personne, et un BINAIRE illisible en
    // UTF-8 : la copie par index doit les ignorer exactement comme le flux, et ne
    // pas lever sur des octets qui ne sont pas du texte.
    'README.txt': strToU8('export de test'),
    'Compte/avatar.png': new Uint8Array([0xff, 0xfe, 0x00, 0x80, 0xc3]),
    // Une entree-REPERTOIRE : le vrai export en contient 700, de zero octet. Elle
    // est donc GARDEE par le tri, ouverte, et ne produit rien.
    'Messages/': strToU8(''),

    // --- Les deux index.json de l'archive reelle ----------------------------
    //
    // La cle 121212121212121212 est presente dans LES DEUX index.json, avec deux
    // valeurs differentes. L'archive reelle contient un Serveurs/index.json puis
    // un Messages/index.json, et c'est le PREMIER qui doit gagner : sans ce
    // doublon, un index fusionne « le dernier gagne » au lieu du premier ne
    // changerait RIEN sur cette archive, et la fusion passerait pour correcte.
    'Serveurs/index.json': strToU8('{\n  "999999999999999999": "Les Pangolins",\n  "121212121212121212": "Nom du premier index"\n}'),
    'Messages/index.json': strToU8(`{
  "111111111111111111": "general",
  "222222222222222222": "Message privé avec maliksync",
  "333333333333333333": "Conversation privée avec heropete",
  "555555555555555555": "Message privé avec Participant(e) inconnu(e)",
  "666666666666666666": "Orphanelin",
  "777777777777777777": "Direct Message with 爵士",
  "888888888888888888": "Salon inconnu, Les Pangolins",
  "121212121212121212": "Nom du second index"
}`),

    // --- Deux serveurs, dont un sans icone ----------------------------------
    'Serveurs/999999999999999999/guild.json': strToU8('{\n  "id": 999999999999999999,\n  "name": "Les Pangolins",\n  "icon": "abc123"\n}'),
    'Serveurs/888888888888888888/guild.json': strToU8('{\n  "id": 888888888888888888,\n  "name": "Sans icone"\n}'),

    // --- Salon de serveur RATTACHE, messages.json brut ----------------------
    'Messages/c111111111111111111/channel.json': strToU8(`{
  "id": 111111111111111111,
  "name": "general",
  "type": "GUILD_TEXT",
  "guild": { "id": 999999999999999999, "name": "Les Pangolins" }
}`),
    'Messages/c111111111111111111/messages.json': strToU8(`[
  {
    "ID": 1009136231751360593,
    "ChannelID": 111111111111111111,
    "Timestamp": "2026-04-24 11:13:52",
    "Contents": "appel manque",
    "Attachments": "https://cdn.discordapp.com/attachments/1/2/piece%20jointe.png?ex=1&amp;is=2&amp;hm=3"
  },
  {
    "ID": 790275834681622598,
    "ChannelID": 111111111111111111,
    "Timestamp": "2020-12-20 17:54:01",
    "Contents": "",
    "Attachments": ""
  }
]`),

    // --- MP : type en CHAINNE, recipients en IDS EN TEXTE --------------------
    'Messages/c222222222222222222/channel.json': strToU8(`{
  "id": 222222222222222222,
  "type": "DM",
  "recipients": ["333333333333333333", ${USER_ID}]
}`),
    'Messages/c222222222222222222/messages.csv': strToU8('ID,Timestamp,Contents,Attachments\n3001,2024-03-01T00:00:00.000Z,en direct,\n'),

    // --- Groupe : recipients en OBJETS, avec avatar -------------------------
    'Messages/c333333333333333333/channel.json': strToU8(`{
  "id": 333333333333333333,
  "type": "GROUP_DM",
  "recipients": [
    { "id": 444444444444444444, "username": "heropete", "avatar": "def456" },
    { "id": ${USER_ID}, "global_name": "Testeur" }
  ]
}`),

    // --- Fil de discussion (type 11) ----------------------------------------
    'Messages/c444444444444444444/channel.json': strToU8(`{
  "id": 444444444444444444,
  "name": "Fil des trades",
  "type": 11,
  "guild": { "id": 999999999999999999, "name": "Les Pangolins" }
}`),
    'Messages/c444444444444444444/messages.json': strToU8('[\n  {\n    "ID": 1009136231751360594,\n    "ChannelID": 444444444444444444,\n    "Timestamp": "2026-04-24 12:00:00",\n    "Contents": "dans un fil"\n  }\n]'),

    // --- MP dont le nom est un LIBELLE de Discord : le nom affiche doit etre
    //     nul, pas « Participant(e) inconnu(e) » ------------------------------
    'Messages/c555555555555555555/channel.json': strToU8(`{
  "id": 555555555555555555,
  "name": "Salon inconnu",
  "type": "DM",
  "recipients": ["666666666666666666", ${USER_ID}]
}`),
    'Messages/c555555555555555555/messages.json': strToU8('[]'),

    // --- messages.json SANS channel.json : donnees partielles. Le salon
    //     rattache est cree par l'assemblage, avec `guildId: null` la ou le
    //     chemin nominal met `guildId: undefined`. C'est exactement le genre de
    //     cle presente/absente qu'un simple compte d'elements ne voit pas. -----
    'Messages/c666666666666666666/messages.json': strToU8('[\n  {\n    "ID": 1009136231751360595,\n    "ChannelID": 666666666666666666,\n    "Timestamp": "2026-04-24 13:00:00",\n    "Contents": "orphelin de channel.json"\n  }\n]'),

    // --- MP dont le destinataire a disparu, mais dont index.json garde le nom --
    'Messages/c777777777777777777/channel.json': strToU8(`{
  "id": 777777777777777777,
  "type": "DM",
  "recipients": ["Utilisateur supprimé", ${USER_ID}]
}`),
    'Messages/c777777777777777777/messages.json': strToU8('[]'),

    // --- Salon de serveur dont le nom vient de l index fusionne : il ne peut venir
    //     que du PREMIER des deux index.json -----------------------------------
    'Messages/c121212121212121212/channel.json': strToU8('{\n  "id": 121212121212121212,\n  "name": "Salon inconnu",\n  "type": 0\n}'),
    'Messages/c121212121212121212/messages.json': strToU8('[]'),

    // --- Salon de serveur RATTACHE A AUCUN GUILDE : `isLeft` ----------------
    'Messages/c888888888888888888/channel.json': strToU8('{\n  "id": 888888888888888888,\n  "name": "Salon inconnu",\n  "type": 0\n}'),
    'Messages/c888888888888888888/messages.json': strToU8('[]'),

    // --- Le bruit, et lui seul, doit etre jete -------------------------------
    'Activité/reporting/events-2026-00000-of-00001.json': incompressible(2000),
    'Activité/': strToU8(''),
    'Activités/Activités_1/poker/poker.json': strToU8('{"id":2}'),
    'Publicités/ads.json': strToU8('{"id":3}'),
    'programs/ignored.json': strToU8('{"noise":true}'),
    '__MACOSX/Messages/._channel.json': strToU8('bruit'),
    'Messages/.DS_Store': strToU8('bruit'),
  };
}

// L'archive de parite elle-meme. Les identifiants sont ecrits EN TEXTE BRUT dans
// l'objet ci-dessus : un litteral numerique de 18 chiffres serait deja arrondi par
// le moteur avant meme d'arriver dans l'archive, et le test ne prouverait plus
// rien sur la conservation des snowflakes.
function archiveDeParite() {
  return zipSync(objetDeParite());
}

// Une archive qui tient dans UN SEUL bloc de 4 Mio — donc, a une constante pres,
// TOUTE archive de test — et une qui n'y tient pas. La distinction n'est pas
// cosmétique : c'est la frontière sur laquelle repose le comportement a une
// annulation (src/services/packageImporter.service.js:23 et :359).
const BLOC_DE_LECTURE = 4 * 1024 * 1024;
// Le Mio, separe du bloc de lecture : les deux grandeurs ont le meme nombre dans
// cette suite, et le test de cadence a besoin de les poser independamment.
const MIO = 1024 * 1024;

// Au-dessus du bloc de lecture, avec une entree de BRUIT qui fait deborder
// l'archive. Elle est du bruit, donc jamais ouverte par le chemin par index, et
// STOCEE (`level: 0`), donc le chemin de reference la parcourt sans la
// decompresser. Elle est placee en DERNIER dans l objet : tout ce qui interesse
// l affichage est donc dans le premier bloc.
function archiveAuDessusDuBloc() {
  const objet = objetDeParite();
  return zipSync({
    ...objet,
    'Activité/remplissage.json': incompressible(BLOC_DE_LECTURE),
  }, { level: 0 });
}

// L'archive de parite, completee des entrees qu'aucune archive de `zipSync` ne
// peut produire.
//
// On ne se contente pas de CONCATENER deux archives : le repertoire central d'un
// ZIP est un bloc CONTIGU, et l'EOCD annonce ou il commence et combien d'entrees
// il contient. Concatener deux archives mettrait deux repertoires centraux
// separes par l'entree ajoutee, et le lecteur de l'index — qui fidelement
// parcourt `total` enregistrements a la suite — s'arreterait sur l'EOCD du corps
// avec « signature centrale absente ». Le flux, lui, ne lit pas le repertoire
// central et ne verrait rien : les deux chemins n'auraient pas le meme nombre
// d'entrees, et la comparaison porterait sur deux archives differentes.
//
// On reconstruit donc un ZIP CONFORME : [en-tetes locaux du corps]
// [en-tetes locaux des ajouts] [repertoire central du corps]
// [repertoires centraux des ajouts] [EOCD]. C'est l'ordre qu'exige la norme, et
// c'est le seul ou les deux chemins voient la meme archive.
function zipAvecAjouts(corps, ajouts) {
  const central = centralRangeOf(corps); // { start, end } : le debut et la fin du central du corps
  const vue = new DataView(corps.buffer, corps.byteOffset, corps.byteLength);
  const entreesCorps = vue.getUint16(central.end + 10, true);
  assert.ok(entreesCorps >= 15, `le central du corps doit declarer ses entrees : ${entreesCorps}`);
  const centraleCorps = corps.subarray(central.start, central.end);

  // L'offset local annonce doit valoir la position reelle de l'en-tete local dans
  // l'archive finale, qui est celle ou finit le corps. `handMadeZip` ecrit 0, ce
  // qui ouvrirait le DEBUT du fichier, c'est-a-dire le premier salon : une erreur
  // invisible, qui produit des octets plausibles.
  //
  // Le patch se fait AVANT la copie : `joinBytes` recopie, donc corriger apres
  // ne toucherait que le tampon de depart. Et le controle, plus bas, relit
  // l'ARCHIVE — un controle sur le tampon passerait pour un succes alors que
  // l'archive est fausse.
  let curseurLocal = central.start;
  const morceaux = [];
  for (const ajout of ajouts) {
    const nom = Buffer.from(ajout.nom, 'utf8');
    const tailleLocale = 30 + nom.length + ajout.payload.length;
    const tailleCentrale = 46 + nom.length;
    const zip = handMadeZip({ ...ajout, name: ajout.nom });
    const local = zip.subarray(0, tailleLocale);
    const centralAjout = zip.subarray(tailleLocale, tailleLocale + tailleCentrale);
    new DataView(centralAjout.buffer, centralAjout.byteOffset, centralAjout.byteLength).setUint32(42, curseurLocal, true);
    morceaux.push({ nom: ajout.nom, local, central: centralAjout, tailleLocale, tailleCentrale });
    curseurLocal += tailleLocale;
  }
  const tailleLocales = curseurLocal - central.start;

  // L'EOCD final, reconstruit : un seul disque, TOUTES les entrees, et un central
  // qui commence la ou commence reellement le bloc central — donc APRES les
  // en-tetes locaux des entrees ajoutees, qui se sont glisse entre les donnees et
  // le central.
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 1, true);
  ev.setUint16(10, entreesCorps + ajouts.length, true);
  ev.setUint32(12, centraleCorps.length + morceaux.reduce((total, m) => total + m.tailleCentrale, 0), true);
  ev.setUint32(16, central.start + tailleLocales, true);

  const archive = joinBytes([
    corps.subarray(0, central.start),
    ...morceaux.map(m => m.local),
    centraleCorps,
    ...morceaux.map(m => m.central),
    eocd,
  ]);

  // AFFIRMATIONS AVANT CONTROLE, et DANS L'ARCHIVE : sans elles, un offset faux
  // pourrait donner un resultat egal, pour la mauvaise raison.
  const relu = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  let a = central.start + tailleLocales + centraleCorps.length;
  let b = central.start;
  for (const m of morceaux) {
    assert.equal(relu.getUint32(a + 42, true), b, `${m.nom} : l offset local annonce vaut la position reelle de son en-tete local, DANS l archive`);
    assert.equal(relu.getUint32(a, true), 0x02014b50, `${m.nom} : le central annonce commence sur une signature centrale`);
    a += m.tailleCentrale;
    b += m.tailleLocale;
  }
  return archive;
}

// Les DEUX entrees qui rendent la REGLE DE REPARTITION des jetes observable.
//
// 1. Une entree trop grosse HORS des dossiers de bruit, honnete — les deux
//    en-tetes disent la meme chose, donc comparable entre les deux chemins. Sur le
//    vrai export les deux fichiers de 1,1 et 4 Gio sont sous « Activité », donc
//    ils sont comptes comme BRUIT par les deux chemins ; sans une entree trop
//    grosse et non bruyante, le second compteur (`oversized`) resterait a zero des
//    deux cotes, et sa comparaison ne porterait que sur la repartition du bruit.
//
// 2. Une entree a la fois BRUYANTE et trop grosse, et c'est celle-la qui verrouille
//    la REGLE. Les deux chemins attribuent une entree qui est bruit ET trop grosse
//    au BRUIT d'abord (`if (!isNoisePath(path)) oversized else noise`,
//    src/services/packageImporter.service.js:319). Une archive ou aucune entree
//    n a les deux qualites ne peut pas distinguer cette regle d une regle
//    « taille d'abord » : les deux produiraient le meme compte. C est exactement
//    le piege que le vrai export ne revele pas non plus, puisque ses deux
//    grandes entrees sont du bruit.
//
// Une production REELLEMENT au-dela du plafond, a partir d'un flux qui pese
// moins de 900 Kio : `zipSync` ne peut pas faire cela sans allouer les 134 Mio,
// et c'est precisement ce qu un test ne doit pas faire.
function entreesRepartition() {
  const horsBruit = deflateBomb(MAX_ENTRY_BYTES + 1024);
  assert.ok(horsBruit.produits > MAX_ENTRY_BYTES, `la production doit vraiment depasser le plafond : ${horsBruit.produits}`);
  assert.ok(horsBruit.flux.length * 100 < horsBruit.produits, `le flux compresse doit rester minuscule : ${horsBruit.flux.length} octets`);

  const bruyante = deflateBomb(134 * 1024 * 1024 + 1024);
  assert.ok(bruyante.produits > MAX_ENTRY_BYTES, `la production de l entree bruyante doit depasser le plafond : ${bruyante.produits}`);

  return [
    {
      nom: 'Compte/user_data_exports/export-complet.json',
      method: 8,
      payload: horsBruit.flux,
      uncompressedSize: horsBruit.produits,
      localUncompressedSize: horsBruit.produits,
    },
    {
      nom: 'Activité/gros.json',
      method: 8,
      payload: bruyante.flux,
      uncompressedSize: bruyante.produits,
      localUncompressedSize: bruyante.produits,
    },
  ];
}

function archiveComplete() {
  // `corps` est rendu avec l'archive : c'est le corps seul qui tient dans UN bloc
  // de 4 Mio, donc celui sur lequel le chemin de reference echoue franchement a une
  // annulation (voir le test d annulation).
  const corps = archiveDeParite();
  return { corps, archive: zipAvecAjouts(corps, entreesRepartition()) };
}

// Les deux chemins sur la MEME archive. Le chemin de reference passe par un vrai
// Blob (c'est ce que lui donne le renderer), le chemin par index par un objet
// { name, size, slice } — le contrat de lecture du chantier.
async function lesDeuxChemins(bytes, options = {}) {
  const traceIndex = [];
  const traceFlux = [];
  const etapesIndex = [];
  const etapesFlux = [];

  const parIndex = await importViaIndex(fileFromBlob(bytes, 'package.zip'), {
    ...options,
    onEntry: (...args) => traceIndex.push(args),
    onProgress: info => etapesIndex.push({ ...info }),
  });

  const parFlux = await cheminFlux(new Blob([bytes], { type: 'application/zip' }), {
    ...options,
    onEntry: (...args) => traceFlux.push(args),
    onProgress: info => etapesFlux.push({ ...info }),
  });

  return { parIndex, parFlux, traceIndex, traceFlux, etapesIndex, etapesFlux };
}

// Les deux chemins demandent des rappels optionnels : sans leur valeur par
// defaut, un chemin qui les oublie quand meme echouerait pour la mauvaise raison.
// Le service du renderer est charge ICI et pas au sommet du fichier : il tire
// fflate, et le charger avant que ces tests ne soient annonces les ferait echouer.
const cheminFlux = async (file, options) => (await import('../src/services/packageImporter.service.js')).importDiscordPackage(file, options);

// La comparaison la plus forte que node:assert permette sur une MAP : ordre des
// cles puis contenu, cle par cle. `deepEqual` sur deux Map ignore l'ordre, donc
// il laisserait passer une table des messages parcourue dans le desordre.
function comparerMessages( attendu, obtenu, ou) {
  const clesAttendues = [...attendu.keys()];
  const clesObtenues = [...obtenu.keys()];
  assert.deepEqual(clesObtenues, clesAttendues, `${ou} : MEME ordre de cles, et MEME cles — la table des messages est ce que l'IHM parcourt`);
  for (const cle of clesAttendues) {
    const a = attendu.get(cle);
    const b = obtenu.get(cle);
    assert.ok(Array.isArray(b), `${ou} : le salon « ${cle} » a une liste de messages dans les deux chemins`);
    assert.equal(b.length, a.length, `${ou} : salon « ${cle} », MEME nombre de messages`);
    assert.deepEqual(b, a, `${ou} : salon « ${cle} », messages identiques champ par champ (id, channelId, timestamp, content, pieces jointes)`);
  }
}

test('l import par index donne le MEME resultat que l import par flux', async () => {
  // LE test de parite. Il ne rougit pas seulement si le chemin par index est faux :
  // il rougit aussi si le chemin de REFERENCE est casse, parce qu'il compare les
  // deux etats entre eux, sans ecrire une seule des valeurs attendues.
  const { corps, archive } = archiveComplete();
  const { parIndex, parFlux, traceIndex, traceFlux, etapesIndex, etapesFlux } = await lesDeuxChemins(archive);

  // 0. La comparaison ne doit pas porter sur deux etats vides : sans cela, une
  //    implementation qui ne rendrait RIEN passerait une partie des assertions.
  assert.ok(parFlux.channels.length >= 8, `le temoin doit etre riche, pas vide : ${parFlux.channels.length} salons`);
  assert.equal(parFlux.totalMessages, 5, 'le temoin compte bien des messages');
  // La REPARTITION des jetes, comptee a l unites. Le detail de pourquoi la
  // fixture contient une entree a la fois bruyante ET trop grosse est dans
  // entreesRepartition() ; ici on fige les DEUX compteurs, sans quoi une regle
  // « taille d'abord » donnerait { noise: 7, oversized: 2 } des deux cotes — donc
  // un test VERT, et un compteur affiche faux.
  assert.deepEqual(parFlux.discarded, { noise: 8, oversized: 1 }, `les compteurs de jetes doivent etre 8 bruit et 1 trop grosse : ${JSON.stringify(parFlux.discarded)}`);
  assert.deepEqual(parIndex.discarded, { noise: 8, oversized: 1 }, 'et le chemin par index les COMPTE pareil : une entree bruyante ET trop grosse va au bruit');
  // L'entree qui rend la regle observable est bien la, et bien dans les deux traces.
  for (const [nom, trace] of [['index', traceIndex], ['flux', traceFlux]]) {
    const trouvee = trace.find(([nomTrace]) => nomTrace === 'Activité/gros.json');
    assert.ok(trouvee, `chemin ${nom} : l entree bruyante ET trop grosse est dans la trace des entrees ecartees`);
    assert.equal(trouvee[2], true, `chemin ${nom} : et elle est bien marquee comme jetee`);
  }

  // 1. Les MEMES cles, dans le MEME ordre. Une cle de plus ou de moins, ou
  //   seulement un ordre different, change ce que PackageManager persiste et
  //   relit.
  assert.deepEqual(Object.keys(parIndex), Object.keys(parFlux), 'MEMES cles, MEME ordre : la forme du package est un contrat');

  // 2. Le compte : identifiants conserves en texte, avatar en URL CDN.
  assert.deepEqual(parIndex.user, parFlux.user, 'le compte est identique');
  assert.equal(parIndex.user.id, USER_ID, 'le snowflake du compte reste exact');
  assert.match(parIndex.user.avatar, /a95b780ee6a221f82fca3dea0de7ad6b\.png/, 'le hash d avatar devient une URL');

  // 3. Les serveurs, DANS L'ORDRE (le tri final des salons est stable : deux
  //    serveurs a nombre de messages egal gardent l'ordre du repertoire).
  assert.ok(parFlux.guilds.length >= 2, 'le temoin a des serveurs');
  assert.deepEqual(parIndex.guilds, parFlux.guilds, 'les serveurs sont identiques, dans le meme ordre');

  // 4. Les salons, DANS L'ORDRE — le chemin de reference trie par volume de
  //    messages decroissant, et ce tri doit etre refait a l identique.
  assert.ok(parFlux.channels.length >= 8, 'le temoin a des salons');
  assert.equal(parIndex.channels.length, parFlux.channels.length, 'MEME nombre de salons');
  assert.deepEqual(
    parIndex.channels.map(channel => channel.id),
    parFlux.channels.map(channel => channel.id),
    'MEME ordre de salons, et MEME identifiants',
  );
  for (let i = 0; i < parFlux.channels.length; i += 1) {
    const attendu = parFlux.channels[i];
    const obtenu = parIndex.channels[i];
    assert.deepEqual(
      Object.keys(obtenu),
      Object.keys(attendu),
      `salon « ${attendu.id} » : MEMES cles, MEME ordre — une cle presente dans un chemin et absente de l autre suffit a differer`,
    );
    assert.deepEqual(obtenu, attendu, `salon « ${attendu.id} » : objet identique (nom, type, recipient, guildName, guildId, isLeft, messagesCount)`);
  }

  // Les formes qui se perdent en silence, verifiees une par une plutot que
  // laissees a la comparaison globale — pour qu'un echec dise CE QUI a diverge.
  const parType = type => parIndex.channels.find(channel => channel.type === type);
  assert.equal(parType('THREAD')?.name, 'Fil des trades', 'un fil reste un fil');
  assert.equal(parType('GROUP')?.name, 'heropete', 'le pseudo d un membre prime sur le prefixe de l index');
  assert.equal(parType('GROUP')?.recipient.avatar, 'https://cdn.discordapp.com/avatars/444444444444444444/def456.png?size=64', 'un recipient objet donne une URL d avatar');
  const mp = parIndex.channels.find(channel => channel.name === 'maliksync');
  assert.ok(mp, 'le prefixe francais du nom d un MP est retire');
  assert.equal(mp.recipient.id, '333333333333333333', 'un recipient lu en TEXTE identifie quand meme le partenaire');
  const pseudoUnicode = parIndex.channels.find(channel => channel.name === '爵士');
  assert.ok(pseudoUnicode, 'le prefixe anglais est retire, et un pseudo hors ASCII passe de travers : un nom de MP peut etre n importe quoi');
  assert.equal(pseudoUnicode.recipient.username, 'Utilisateur supprimé', 'le destinataire supprime reste identifiable');
  assert.equal(parIndex.channels.filter(channel => channel.type === 'DM').length, 3, 'trois MP');
  const sansNom = parIndex.channels.filter(channel => channel.name === null);
  assert.equal(sansNom.length, 2, 'deux noms tombent a null : un libelle de Discord, un participant inconnu');
  const orphelin = parIndex.channels.find(channel => channel.id === '666666666666666666');
  assert.ok(orphelin, 'les messages sans channel.json donnent quand meme un salon');
  assert.equal(orphelin.guildId, null, 'ce salon a guildId: null, la ou un salon nominal a guildId: undefined');
  assert.equal(parIndex.channels.find(channel => channel.id === '888888888888888888').isLeft, true, 'un salon sans guilde reste marque isLeft');
  const fusion = parIndex.channels.find(channel => channel.id === '121212121212121212');
  assert.ok(fusion, 'le salon dont le nom ne peut venir que de l index est present');
  assert.equal(fusion.name, 'Nom du premier index', 'des deux index.json fusionnes, c est le PREMIER qui gagne — donc les deux chemins fusionnent pareil');
  assert.equal(parFlux.channels.find(channel => channel.id === '121212121212121212').name, fusion.name, 'et le temoin est d accord');

  // 5. Les messages, salon par salon, contenu par contenu.
  comparerMessages(parFlux.messages, parIndex.messages, 'table des messages');
  const gros = parIndex.messages.get('111111111111111111');
  assert.equal(gros[0].id, '1009136231751360593', 'un snowflake ecrit sans guillemets reste exact');
  assert.equal(gros[0].channelId, '111111111111111111', 'les messages sont rattaches a leur salon');
  assert.equal(gros[1].id, '790275834681622598', 'et le dernier chiffre du premier message aussi');
  assert.deepEqual(gros[0].attachments, [{ url: 'https://cdn.discordapp.com/attachments/1/2/piece%20jointe.png?ex=1&is=2&hm=3', fileName: 'piece jointe.png' }], 'les pieces jointes sont desechappees, URL et nom compris');
  assert.equal(parIndex.messages.get('222222222222222222')[0].content, 'en direct', 'le chemin messages.csv est suivi lui aussi');
  assert.equal(parFlux.messages.get('222222222222222222').length, 1, 'et le temoin voit la meme chose');

  // 6. Les compteurs, dont la repartition bruit / trop grosse.
  assert.equal(parIndex.totalMessages, parFlux.totalMessages, 'MEME total de messages');
  assert.equal(parIndex.totalMessages, parIndex.channels.reduce((sum, c) => sum + c.messagesCount, 0), 'le total est la somme des messages compte par salon');
  assert.deepEqual(parIndex.discarded, parFlux.discarded, 'MEME compte de jetes, et MEME repartition bruit / trop grosse');
  assert.deepEqual(Object.keys(parIndex.discarded), Object.keys(parFlux.discarded), 'les compteurs portent les MEMES cles, dans le MEME ordre');
  assert.equal(parIndex.packageSizeBytes, parFlux.packageSizeBytes, 'MEME taille d archive');
  assert.equal(parIndex.packageSizeBytes, archive.length, 'et c est la taille reelle');

  // Les MEMES CLES la ou l objet a des sous-objets. La comparaison globale les
  // verrait passer si les deux copies avaient les memes valeurs ; c est une cle
  // presente d un cote et absente de l autre — ou deplacee — qu elle ne voit pas.
  // La racine et les salons sont compares plus haut ; le COMPTE et les SERVEURS
  // aussi, parce que ce sont des objets comme les autres.
  assert.deepEqual(Object.keys(parIndex.user), Object.keys(parFlux.user), 'le compte porte les MEMES cles, dans le MEME ordre');
  assert.ok(parFlux.guilds.length >= 2, 'le temoin a des serveurs');
  for (let i = 0; i < parFlux.guilds.length; i += 1) {
    assert.deepEqual(
      Object.keys(parIndex.guilds[i]),
      Object.keys(parFlux.guilds[i]),
      `serveur « ${parFlux.guilds[i].name} » : MEMES cles, MEME ordre (id, name, icon)`,
    );
  }

  // 7. LA TRACE onEntry : memes entrees, meme ordre, memes tailles, meme
  //    marqueur de jete. C'est la seule trace observable de ce que chaque chemin
  //    a OUVERT, et elle est plus fine que le resultat final.
  //
  //    INVARIANT DE FIXTURE, PAS DU FORMAT. La comparaison suppose que les deux
  //    chemins parcourent les entrees dans le MEME ORDRE, et les deux parcourent le
  //    repertoire central. Or cet ordre est une propriete de CETTE fixture : V8
  //    conserve l'ordre d'insertion des cles d'un objet, et `zipSync` ecrit les
  //    entrees dans cet ordre-la. Le format ZIP, lui, ne garantit AUCUN ordre de
  //    parcours — il n'a pas d'ordre, il a un repertoire. Deux ecritures qui
  //    changeraient l'ordre de la fixture feraient donc rougir ce test sans qu'aucun
  //    des deux chemins n'ait change de comportement : c'est le prix de la
  //    comparaison de traces, et il est paye volontairement.
  assert.deepEqual(
    traceIndex.map(([nom, taille, jete]) => [nom, taille, jete]),
    traceFlux.map(([nom, taille, jete]) => [nom, taille, jete]),
    'MEME trace des entrees traitees, dans le MEME ordre : aucune entree ouverte d un cote et pas de l autre',
  );
  assert.ok(traceIndex.length >= 20, `la trace doit etre longue, sinon elle ne prouve rien : ${traceIndex.length}`);
  assert.ok(traceIndex.some(([, taille, jete]) => jete === true), 'la trace contient des entrees jetees');
  assert.ok(traceIndex.some(([, taille, jete]) => jete === false && taille > 0), 'et des entrees ouvertes, avec leur taille');

  // 8. LA PROGRESSION. Les deux chemins n'ont pas la meme phase de lecture (le
  //    flux compte des octets, l index des entrees), donc l'egalite porte sur la
  //    phase « extraction » — celle qui remplit les 70 % derniers de la barre, et
  //    la seule dont l'IHM tire un salon.
  const phaseExtraction = etapes => etapes.filter(info => info.channelId !== undefined);
  assert.ok(phaseExtraction(etapesFlux).length >= 8, 'le temoin annonce une phase extraction par salon');
  assert.deepEqual(phaseExtraction(etapesIndex), phaseExtraction(etapesFlux), 'la phase extraction est identique, salon par salon');

  const { kept } = selectEntries((await readZipIndex(fileFromBlob(corps, 'c.zip'))).entries);
  const etapesEntrees = etapesIndex.filter(info => info.channelId === undefined);
  assert.equal(etapesEntrees.length, kept.length, `une etape d avancement par entree gardee, pas ${etapesEntrees.length} pour ${kept.length}`);
  // `current` PROGRESSE. Sans cette assertion, une implementation qui figerait
  // `current` a 0 — ou qui emettrait toujours la meme valeur — passerait tous les
  // autres controles : le nombre d etapes serait bon, `total` serait bon, et la
  // barre resterait immobile sans que rien ne le signale.
  assert.deepEqual(
    etapesEntrees.map(info => info.current),
    etapesEntrees.map((_, rang) => rang),
    '`current` progresse de 0 a kept.length - 1, une valeur par etape : une barre qui n avance pas ne se voit pas autrement',
  );
  for (const info of etapesEntrees) {
    assert.equal(info.total, kept.length, 'le total de la phase entree est le nombre d entrees GARDEES');
    assert.ok(Object.hasOwn(info, 'bytes'), '`bytes: false` est pose EXPLICITEMENT, sinon applyImportProgress peut basculer sur la phase octets');
    assert.equal(info.bytes, false, 'et il vaut false : l index ne compte pas des octets');
    assert.ok(info.stage, `chaque etape nomme sa phase : ${JSON.stringify(info)}`);
  }
});

test('une entree gardee malformee fait REJETER les deux chemins, avec le MEME message', async () => {
  // `parseEntry` n est pas protege dans `importViaIndex` : un `channel.json` mal
  // forme remonte une `SyntaxError` NUE. Le chemin de reference, lui, l attrape
  // dans `collectEntries` puis l enveloppe dans
  // `Unable to read ZIP archive: <cause>` (src/services/packageImporter.service.js:350 puis :370).
  //
  // Les deux REJETTENT — la parite d etat est donc correcte, et c est deja
  // quelque chose. Mais les MESSAGES, donc le `reason` que la tache 5 doit
  // conserver tel quel, diffèrent : « Unexpected token… » d un cote,
  // « Unable to read ZIP archive: Unexpected token… » de l autre. Un wrapper qui
  // affiche le `reason` afficherait donc, pour la meme archive, un texte different
  // selon le chemin par hasard que l import a pris.
  const bytes = zipSync({
    'Compte/user.json': strToU8(`{\n  "id": ${USER_ID},\n  "username": "testeur"\n}`),
    'Messages/c111111111111111111/channel.json': strToU8('ceci n est pas du json'),
  });

  const motifIndex = await importViaIndex(fileFromBlob(bytes, 'package.zip'), {}).then(() => null, error => error.message);
  const motifFlux = await cheminFlux(new Blob([bytes], { type: 'application/zip' }), {}).then(() => null, error => error.message);

  assert.ok(motifIndex, `une entree gardee malformee doit faire ECHOUER le chemin par index : ${JSON.stringify(motifIndex)}`);
  assert.ok(motifFlux, 'et le chemin de reference aussi : rien n est perdu sans bruit');
  // Affirmation avant controle : sans elle, deux messages vides passeraient.
  assert.match(motifFlux, /JSON/i, `le temoin doit nommer la cause du refus : « ${motifFlux} »`);
  assert.equal(motifIndex, motifFlux,
    `les deux chemins REJETTENT mais pas avec le meme message, donc le reason de la tache 5 differe selon le chemin :\n  index : ${motifIndex}\n  flux  : ${motifFlux}`);
});

test('une annulation sur une archive de plus de 4 Mio donne DEUX etats finaux, et deux succes', async () => {
  // LE point que le rapport de la premiere passe decrit de travers, et qui est le
  // plus dangereux de toute la tache pour la tache 5.
  //
  // « Les deux echouent au meme endroit, c est le comportement a preserver » n est
  // vrai QUE sur une archive qui tient dans un seul bloc de 4 Mio — donc, a une
  // constante pres, sur AUCUNE archive reelle. Au-dela, les deux chemins
  // REUSSISSENT, et ils ne reussissent pas pareil :
  //
  //   - le chemin par index s arrete ENTRE DEUX ENTREES et rend un paquet
  //     PARTIEL — un prefixe de l import complet ;
  //   - le chemin de reference, lui, ne consulte `shouldStop()` qu AU DEBUT de
  //     chaque bloc : apres avoir pousse le premier, il rend TOUT ce qu il a lu,
  //     qui peut donc etre l import ENTIER.
  //
  // Ce n est pas une divergence de granularite : deux etats finaux differents, dont
  // deux « succes » au sens de « une valeur a ete retournee ». Un wrapper qui
  // presenterait le retour comme un succes afficherait donc un paquet partiel ou un
  // paquet complet selon le chemin qu un import a pris, sans que rien ne le dise.
  const bytes = archiveAuDessusDuBloc();
  // AFFIRMATION AVANT CONTROLE : sans elle, le test pourrait « prouver » la
  // divergence sur une archive qui tient encore dans un bloc, c est-a-dire sur le
  // cas ou les deux echouent reellement.
  assert.ok(bytes.length > BLOC_DE_LECTURE, `l archive doit depasser le bloc de ${BLOC_DE_LECTURE} octets : ${bytes.length}`);
  assert.ok(archiveDeParite().length < BLOC_DE_LECTURE, `et l archive de parite doit tenir dedans : ${archiveDeParite().length}`);

  // L index s arrete tot — apres quelques entrees.
  let appelsIndex = 0;
  const index = await importViaIndex(fileFromBlob(bytes, 'package.zip'), {
    shouldStop: () => { appelsIndex += 1; return appelsIndex > 4; },
  });
  // Le flux s arrete au BLOC SUIVANT — donc apres avoir pushed tout le premier.
  let appelsFlux = 0;
  const flux = await cheminFlux(new Blob([bytes], { type: 'application/zip' }), {
    shouldStop: () => { appelsFlux += 1; return appelsFlux > 1; },
  });

  // Les deux ont RENDU UN PAQUET : aucun des deux n'a leve.
  assert.ok(appelsFlux > 1, `le chemin de reference a bien consulte shouldStop : ${appelsFlux} fois`);
  assert.ok(appelsIndex > 4, `le chemin par index a bien consulte shouldStop : ${appelsIndex} fois`);

  // Et les deux etats sont DIFFERENTS. C'est le point : deux succes, deux etats.
  assert.ok(
    index.channels.length < flux.channels.length,
    `une annulation donne deux paquets differents : index ${index.channels.length} salons, flux ${flux.channels.length}. Si ces nombres etaient egaux, l annulation ne pourrait pas etre presentee comme un succes indistinct.`,
  );
  assert.notDeepEqual(
    index.channels.map(channel => channel.id),
    flux.channels.map(channel => channel.id),
    'les deux listes de salons different : deux etats finaux pour une seule action',
  );
  // Ce que le chemin flux rend sur une annulation reste un PREFIXE de l import
  // complet — il s arrete, il ne melange pas — mais un prefixe beaucoup plus long.
  const complet = await cheminFlux(new Blob([bytes], { type: 'application/zip' }));
  assert.deepEqual(
    flux.channels.map(channel => channel.id),
    complet.channels.map(channel => channel.id).slice(0, flux.channels.length),
    'le paquet du flux annule est un prefixe de l import complet',
  );
  assert.equal(flux.totalMessages, complet.totalMessages, 'et ici il l est completement : le flux s arrete trop tard pour avoir perdu quoi que ce soit');
});

test('une annulation donne le MEME comportement des deux chemins', async () => {
  // Le chemin de reference s arrete au bloc de lecture, donc AVANT d avoir lu la
  // moindre entree d une archive de cette taille ; et il echoue alors
  // franchement (`seen === 0` -> « invalid zip data »). Le chemin par index doit
  // se comporter de meme : une annulation ne doit laisser ni package a moitie
  // construit, ni objet vide presente comme un import reussi.
  //
  // ATTENTION A LA PORTEE DE CE TEST : il vaut pour une archive qui tient dans UN
  // SEUL bloc de 4 Mio, donc pour AUCUNE archive reelle. Sur une archive plus
  // grande, les deux chemins REUSSISSENT tous deux, avec deux etats finaux
  // differents : c est le test suivant qui le mesure, et c est la regle que la
  // tache 5 doit appliquer.
  //
  // Les deux MOTIFS different, et c est le seul ecart constate ici : le flux
  // confond « archive vide » et « annule » dans un meme message, l index constate
  // qu il n a pas de user.json. Ce sont deux echecs et non deux imports, et c est
  // precisement ce que la tache 5 doit rendre observable.
  const { corps, archive } = archiveComplete();
  const motifIndex = await importViaIndex(fileFromBlob(corps, 'package.zip'), { shouldStop: () => true }).then(
    () => null,
    error => error.message,
  );
  const motifFlux = await cheminFlux(new Blob([corps], { type: 'application/zip' }), { shouldStop: () => true }).then(
    () => null,
    error => error.message,
  );
  assert.ok(motifIndex, `une annulation avant toute entree doit faire ECHOUER le chemin par index : ${JSON.stringify(motifIndex)}`);
  assert.ok(motifFlux, 'et le chemin de reference echoue aussi : rien de lu n est pas un import reussi');
  assert.match(motifIndex, /user\.json is missing/, `le chemin par index doit nommer ce qui lui manque : « ${motifIndex} »`);
  assert.match(motifFlux, /invalid zip data/, `le chemin de reference doit dire qu il n a rien lu : « ${motifFlux} »`);
  assert.notEqual(motifIndex, motifFlux, 'les deux messages nomment deux causes, et le test le dit plutot que de le tolerer en silence');

// Et le cas ou l annulation survient APRES quelques entrees : c est la que les
  // deux chemins kilometrent vraiment. Le flux lit toute l archive d un bloc de
  // 4 Mio et ne peut donc PAS s arreter au milieu sur une archive de cette taille
  // : il echoue, comme ci-dessus. On mesure donc l index seul, et on le compare a
  // l import COMPLET — ce qu il rend doit en etre un prefixe, jamais un melange.
  let arrets = 0;
  const arrete = await importViaIndex(fileFromBlob(archive, 'package.zip'), {
    shouldStop: () => { arrets += 1; return arrets > 4; },
  });
  const complet = await cheminFlux(new Blob([archive], { type: 'application/zip' }));
  assert.ok(arrets > 4, `l annulation a ete consultee ${arrets} fois`);
  assert.equal(arrete.user.id, USER_ID, 'l index garde le compte : il s est arrete apres l avoir lu');
  assert.ok(
    arrete.channels.length < complet.channels.length,
    `l index s arrete tot : il doit produire moins de salons que l import complet (${arrete.channels.length} contre ${complet.channels.length})`,
  );
  assert.deepEqual(
    arrete.channels.map(channel => channel.id),
    complet.channels.map(channel => channel.id).slice(0, arrete.channels.length),
    'et ce qu il a produit est un PREFIXE de l import complet : il s arrete, il ne melange pas',
  );
  // La table des messages ne se compare pas globale : un import interrompu n'a lu
  // qu'une partie des channel.json, donc sa table n'a que les cles qu'il a
  // vues. Ce qui ne doit PAS arriver, c'est une cle en trop, ou une liste
  // differente pour une cle presente des deux cotes.
  const clesArrete = [...arrete.messages.keys()];
  const clesPartielles = new Set(clesArrete);
  assert.deepEqual(
    clesArrete,
    clesArrete.filter(cle => clesPartielles.has(cle)),
    'les cles de la table partielle sont sans doublon',
  );
  assert.ok(clesArrete.length <= complet.messages.size, `la table partielle ne peut pas avoir plus de cles que la complete : ${clesArrete.length} contre ${complet.messages.size}`);
  for (const cle of clesArrete) {
    assert.deepEqual(arrete.messages.get(cle), complet.messages.get(cle), `salon « ${cle} » : la liste de messages est celle de l import complet`);
  }
});

test('une entree dont les en-tetes mentent est abandonnee EN COURS de route, et l import se termine', async () => {
  // Le plafond « en cours de route » du chemin de REFERENCE est une branche
  // d ETAT FINAL, pas une branche de memoire — ce que le rapport de la premiere
  // passe affirmait, et ce qui est FAUX dans le cas general. Le test est
  // autonome, et ne compare pas les deux chemins : quand l'entree porte un nom
  // RECONNU et ment dans ses DEUX en-tetes, les deux chemins divergent par
  // construction (l'un echoue, l'autre reussit), donc la parite ne peut pas
  // l'exercer.
  //
  // Ce que le chemin de reference lit, c'est l en-tete LOCAL (fflate) :
  // `declared = entry.originalSize`, qui vaut ici 4. L entree est donc GARDEE, puis
  // abandonnee a 128 Mi de PRODUITS (src/services/packageImporter.service.js:333).
  // L'import se TERMINE, avec les salons qu il a lus, et l'entree comptee en trop
  // grosse.
  const bomb = deflateBomb(MAX_ENTRY_BYTES + 1024);
  assert.ok(bomb.produits > MAX_ENTRY_BYTES, `la production doit vraiment depasser le plafond : ${bomb.produits}`);
  const nom = 'Messages/c999999999999999999/messages.json';
  const archive = zipAvecAjouts(archiveDeParite(), [{
    nom,
    method: 8,
    payload: bomb.flux,
    // LES DEUX en-tetes mentent de la meme facon : 4 octets annonces, 134 Mio
    // produits. C est ce qui rend les deux chemins divergents, donc ce que la
    // parite ne peut pas couvrir.
    uncompressedSize: 4,
    localUncompressedSize: 4,
  }]);

  const fichier = fileFromBlob(archive, 'package.zip');
  const { entries } = await readZipIndex(fichier);
  const entry = entries.find(candidat => candidat.name === nom);
  assert.ok(entry, 'l entree menteuse est bien dans le repertoire central');
  assert.equal(entry.uncompressedSize, 4, `et le central annonce bien 4 octets : ${entry.uncompressedSize}`);

  const paquet = await cheminFlux(new Blob([archive], { type: 'application/zip' }));
  assert.ok(paquet.user, 'l import se TERMINE malgre l entree menteuse : rien n est fige, rien ne plante');
  assert.ok(paquet.channels.length >= 8, `et il a bien produit des salons : ${paquet.channels.length}`);
  assert.equal(
    paquet.channels.find(channel => channel.id === '999999999999999999'),
    undefined,
    'le salon de l entree menteuse est ABSENT : ses messages ont ete abandonnes en cours de route, et c est ce qui distingue cette branche d une simple liberation de memoire',
  );
  assert.equal(paquet.messages.has('999999999999999999'), false, 'et sa table de messages ne contient aucune cle fantome');
  assert.equal(paquet.discarded.oversized, 1, `et l entree est comptee en trop grosse : ${JSON.stringify(paquet.discarded)}`);

  // L AUTRE MOITIE de l ecart, mesuree : le chemin par index garde la meme entree
  // (il lit la MEME taille annoncee) puis s arrete sur `maxOutputLength`, donc il
  // ECHOUE. C est le repli de la tache 5 qui doit traiter ce cas, et il ne peut
  // le faire qu'en voyant l echec.
  await assert.rejects(
    () => importViaIndex(fichier, {}),
    /depasse le plafond/,
    'le chemin par index refuse la meme entree, mais en ECHANT : deux etats finaux differents pour une seule archive',
  );
});

test('une entree ecartee n est jamais ouverte : le gain du chantier est la', async () => {
  // Le but entier du chantier, verifie sur les LECTURES et pas sur le resultat :
  // un chemin qui jetterait une entree apres l'avoir ouverte donnerait le meme
  // package, en 12 secondes comme avant. Seule la trace des tranches le voit.
  //
  // Le fichier est donc de ceux qui COMPTENT : chaque [debut, fin) demandee est
  // notee, puis rapportee a l'entree dont elle porte l'en-tete local. Une entree
  // ecartee ne doit apparaitre dans AUCUNE tranche — pas meme par son en-tete
  // local de 30 octets, qui n'est lu qu'a l'ouverture.
  const { corps, archive } = archiveComplete();
  const fichier = countedFile(archive, 'package.zip');
  const { entries, reason } = await readZipIndex(fichier);
  assert.equal(reason, null, `raison inattendue : ${reason}`);
  const { kept, discarded } = selectEntries(entries);

  // Ouvertures attendues, calculees par le module de la tache 1 : c'est lui qui
  // sait ou sont les donnees compressees d'une entree. On lit ces offsets AVANT
  // de lancer l'import, pour que ces lectures-la ne polluent pas le compte.
  const intervalles = new Map();
  for (const entry of entries) {
    const data = await localHeaderOffset(fichier, entry, fichier.size);
    assert.ok(data >= 0, `${entry.name} : l offset local doit etre lisible, meme pour une entree ecartee`);
    intervalles.set(entry, { from: data, to: data + entry.compressedSize, gardee: kept.includes(entry) });
  }

  // Les DEUX lectures que fait l'index sont exclues du compte, et c'est une
  // NECESSITE, pas une commodite. Le commentaire qui le justifiait affirmait
  // l'inverse — « la fenetre de fin est forcement au-dessus des dernieres donnees
  // compressees » — et c'est FAUX, sur CETTE fixture, de 63 KiB.
  //
  // Mesure : le fichier fait 2 404 308 octets, la fenetre de fin 65 558. Elle
  // occupe donc [2 338 750, 2 404 308). Or `Activité/gros.json`, entree ECARTEE,
  // porte son en-tete local a 1 176 251 et ses donnees compressees jusqu a
  // 2 401 684. La lecture n° 1 est donc a l INTERIEUR de l'entree ecartee, sur
  // [2 338 750, 2 401 684) — et seule la fin de la fenetre, 2 624 octets, touche
  // le repertoire central. Lire la fin d'un fichier pour y trouver l'EOCD n'est
  // pas ouvrir une entree, mais la tranche qui porte la lecture EST, elle, dans
  // l'entree : sans cette exclusion, l'assertion d'en dessous fires sur une
  // tranche que le pilote ne peut pas eviter.
  //
  // L'exclusion est donc une NECESSITE et son motif sera reutilise. On la
  // PROUVE plutot que de l'ecrire, sinon le commentaire peut mentir en silence
  // comme il a menti une fois.
  const fenetre = fichier.slices[0];
  const ecarteeQuiEnglobeLaFenetre = discarded.find(entry => {
    const intervalle = intervalles.get(entry);
    return fenetre[0] < intervalle.to && fenetre[1] > entry.localOffset;
  });
  assert.ok(
    ecarteeQuiEnglobeLaFenetre,
    `la lecture n° 1 [${fenetre[0]}, ${fenetre[1]}) devrait toucher une entree ecartee : c est ce qui rend l exclusion une necessite, et cette assertion le prouve`,
  );
  assert.ok(fenetre[1] > ecarteeQuiEnglobeLaFenetre.localOffset, `et elle commence meme AVANT la fin de ses donnees, [${ecarteeQuiEnglobeLaFenetre.localOffset}, ${intervalles.get(ecarteeQuiEnglobeLaFenetre).to})`);

  fichier.slices.length = 0;
  await importViaIndex(fichier, {});
  const lectures = fichier.slices.slice(2);
  assert.equal(fichier.slices.length - lectures.length, 2, 'l index se relit en deux tranches, ni une de plus');

  assert.ok(discarded.length >= 6, `le temoin doit ecarter de quoi : ${discarded.length}`);
  let ouvertes = 0;
  for (const [start, end] of lectures) {
    const porteur = entries.find(entry => {
      const intervalle = intervalles.get(entry);
      // Les DEUX lectures d une ouverture tiennent dans
      // [localOffset, fin des donnees compressees) : 30 octets d en-tete local,
      // puis exactement compressedSize octets. C est cet intervalle la qu une
      // entree ecartee ne doit jamais apparaitre — et il englobe l en-tete local,
      // qui n est lu qu a l ouverture.
      return start >= entry.localOffset && end <= intervalle.to;
    });
    if (!porteur) continue;
    assert.ok(
      intervalles.get(porteur).gardee,
      `${porteur.name} : ENTIERE ECARTEE, et pourtant ouverte — c'est exactement le travail de 5 244 Mo que le chantier supprime`,
    );
    ouvertes += 1;
  }
  assert.ok(ouvertes >= 2 * kept.length, `chaque entree gardee est ouverte, en-tete local puis donnees : ${ouvertes} tranches pour ${kept.length} entrees`);

  for (const entry of discarded) {
    for (const [start, end] of lectures) {
      assert.ok(
        end <= entry.localOffset || start >= intervalles.get(entry).to,
        `${entry.name} : la tranche [${start}, ${end}) touche cette entree ecartee — ni ses donnees, ni son en-tete local`,
      );
    }
  }
});

// --- Le filet du filet : les deux COPIES des parseurs, cas par cas -----------
//
// Le test de parite compare deux Archives. Il voit donc tout ce que l'archive de
// fixture exerce — et rien de plus. Un parseur qui diverge sur une branche que
// cette archive ne touche pas (un CSV avec des guillemets, un `Attachments`
// multiple, un nom de champ snowflake que Discord ecrit et que la fixture non)
// passerait VERT.
//
// Ce test ferme ce trou la ou il est possible : il compare les deux copies
// DIRECTEMENT, sur un corpus de cas choisis pour les pieges, sans monter d'archive.
// C'est le meme principe que le test d'egalite croisee des regles de bruit, et la
// meme limite : il ne prouve que les CAS qu'il contient. Il ne les ecrit pas tous.
//
// Il verifie aussi que l'export du renderer existe, sinon les deux listes
// compareraient `undefined` a `undefined` et le test passerait sur du vide.
test('les deux copies des parseurs repondent pareil sur les cas choisis', async () => {
  const renderer = await import('../src/services/packageImporter.service.js');
  for (const nom of ['parseEntry', 'parseCsv', 'parseMessagesJson', 'parseSnowflakeJson', 'parseAttachments', 'normalizeChannelType', 'normalizeRecipients', 'cleanDmName', 'isPlaceholderName', 'cdnAvatar', 'cdnGuildIcon', 'channelKey']) {
    assert.equal(typeof renderer[nom], 'function', `le renderer doit exporter ${nom}, sinon ce test compare deux definitions de vide`);
    assert.equal(typeof parseurs[nom], 'function', `la copie doit definir ${nom}`);
  }

  // Comparaison sur une fonction qui peut lever : on compare le résultat OU le
  // message, jamais « l'un des deux a lève ». Un parseur qui refuse une entrée que
  // l'autre accepte fait un import raté, pas un import différent.
  const comparer = (nom, ...args) => {
    let a;
    let b;
    try { a = { ok: renderer[nom](...args) }; } catch (error) { a = { erreur: error.message }; }
    try { b = { ok: parseurs[nom](...args) }; } catch (error) { b = { erreur: error.message }; }
    assert.deepEqual(b, a, `${nom}(${args.map(v => JSON.stringify(v)).join(', ')}) : les deux copies divergent\n  renderer : ${JSON.stringify(a)}\n  copie    : ${JSON.stringify(b)}`);
    return a.ok;
  };

  // --- parseSnowflakeJson : chaque variante de champ que Discord ecrit -------
  const CHAMPS = ['id', 'ID', 'channel_id', 'ChannelID', 'guild_id', 'GuildID', 'user_id', 'message_id', 'owner_id', 'recipient_id'];
  for (const champ of CHAMPS) {
    for (const forme of [`{"${champ}": 1009136231751360593}`, `{"${champ}":1009136231751360593}`, `[{"${champ}": 790275834681622598}]`, `{"a":1,"${champ}": 1009136231751360593,"b":2}`]) {
      comparer('parseSnowflakeJson', forme);
    }
  }
  // Les formes qui ne doivent PAS etre touchees : un nombre trop court, un nom de
  // champ qui n est pas un snowflake, une chaine qui contient un nombre.
  for (const forme of ['{"id": 42}', '{"video_id": 1009136231751360593}', '{"id": "1009136231751360593"}', '{"id": 1009136231751360593.5}', 'pas du json', '[]', '{}']) {
    comparer('parseSnowflakeJson', forme);
  }
  // Affirmation avant contrôle : sans elle, le cas pourrait « passer » parce que
  // les deux copies massacrent les deux.
  const arrondi = renderer.parseSnowflakeJson('{"id": 1009136231751360593}');
  assert.equal(arrondi.id, '1009136231751360593', 'le temoin doit vraiment conserver le snowflake en texte');

  // --- parseCsv : les pieges du vrai CSV --------------------------------------
  const CSV = [
    '',
    '\n',
    'ID,Timestamp\n',
    'ID,Timestamp,Contents,Attachments\n1,2024-01-01T00:00:00.000Z,texte,\n',
    'ID,Timestamp,Contents\n1,2024-01-01,avec, virgule\n',                    // colonne surnumeraire
    'ID, Timestamp , Contents\n1, 2024-01-01 , espaces dans les en-tetes\n',   // en-tetes a rogner
    // Les CR doivent disparaitre, et le test le voit : ici `Contents` est la
    // DERNIERE colonne, donc c'est elle qui porte le CR. Le mettre au milieu
    // laisserait le CR dans `Attachments`, que le parseur de liens jette de toute
    // façon — et la mutation passerait pour un succes.
    'ID,Timestamp,Contents\r\n1,2024-01-01,texte avec CR\r\n',
    'ID,Timestamp,Contents,Attachments\r\n1,2024-01-01,CRLF,"a,b"\r\n',       // CRLF et champ quote
    'ID,Timestamp,Contents\n1,2024-01-01,"guillemet "" double"\n',            // echappement guillemet
    'ID,Timestamp,Contents\n1,2024-01-01,"ligne\ncoupee"\n',                  // saut de ligne DANS un champ
    'ID,Timestamp,Contents\n,2024-01-01,sans id\n',                           // pas d ID : la ligne saute
    'ID,Timestamp,Contents\n1,,sans timestamp\n',                             // pas de Timestamp : la ligne saute
    'ID,Timestamp,Contents,Attachments\n1,2024-01-01,deux pieces,https://a/1.png https://b/2.png\n',
    'ID,Timestamp,Contents,Attachments\n1,2024-01-01,pieces echappees,https://a/1.png?x=1&amp;y=2\n',
    'ID,Timestamp,Contents,Attachments\n1,2024-01-01,pieces,https://a/1.png,https://b/2.png\n',
    'ID,Timestamp,Contents,Attachments\n1,2024-01-01,passe pas une URL,pas-une-url\n',
    'ID,Timestamp,Contents,Attachments\n1,2024-01-01,accent,&lt;tag&gt; et &quot;citation&quot; et &#39;apostrophe&#39;\n',
    // `&#039;` (avec zéro) : la regle est `/&#0*39;/`, donc un zéro en trop doit
    // etre tolere. C'est la forme que produit un encodeur HTML, et une copie qui
    // ecrit `&#39;` seul ne couvre plus le meme corpus. Le tout est dans
    // `Contents`, donc il SURVIT au resultat : place dans `Attachments`, le
    // parseur de liens l aurait jete et la mutation passerait pour un succes.
    'ID,Timestamp,Contents\n1,2024-01-01,&lt;b&gt;&#039;&#039;&#x27;&quot;&lt;/b&gt;\n',
  ];
  for (const texte of CSV) comparer('parseCsv', texte);
  // Affirmation : le CSV de reference doit vraiment produire un message.
  assert.equal(renderer.parseCsv(CSV[4]).length, 1, 'le CSV temoin doit produire un message');
  // Affirmation avant contrôle, sur le CR : sans elle, la ligne CRLF pourrait ne
  // pas distinguer les deux copies parce qu'aucune ne retire le CR.
  assert.equal(renderer.parseCsv(CSV[6])[0].content, 'texte avec CR', 'le CR de fin de ligne ne doit pas rester dans le contenu');

  // --- parseMessagesJson ------------------------------------------------------
  const JSON_ENTREES = [
    '',
    'pas du json',
    '{}',
    '[]',
    '[null, {"ID": null, "Timestamp": null}, {"ID": "1", "Timestamp": "2024-01-01"}]',
    '[{"ID": 1009136231751360593, "ChannelID": 1327342698700738652, "Timestamp": "2020-12-20 17:54:01", "Contents": "salut", "Attachments": ""}]',
    '[{"ID": "1", "Timestamp": "2024-01-01", "Contents": 42}]',                  // Contents non texte
    '[{"ID": "1", "Timestamp": "2024-01-01", "Attachments": "https://cdn.discordapp.com/attachments/1/2/piece%20jointe.png?ex=1&amp;is=2&amp;hm=3"}]',
    '[{"ID": "1", "Timestamp": "2024-01-01", "Attachments": "https://a/1.png,https://b/2.png"}]',
  ];
  for (const texte of JSON_ENTREES) comparer('parseMessagesJson', texte);

  // --- parseAttachments -------------------------------------------------------
  const PIECES = [
    '', null, undefined, 'pas une URL', 'https://cdn.discordapp.com/attachments/1/2/x.png?ex=1&amp;is=2',
    'https://a/1.png https://a/2.png', 'https://a/1.png,https://a/2.png',
    'https://a/%C3%A9t%C3%A9.png', 'https://a/1.png#ancre', 'ftp://a/1.png', '/chemin/relatif.png',
    // Les ENTITES dans une URL : c est le seul endroit ou `decodeEntities` est
    // appele, donc le seul corpus qui verifie ses cinq remplacements. `&#039;` a
    // un zero de trop, que `/&#0*39;/` doit tolerer ; et `&amp;` se deshappe en
    // dernier, donc `&amp;#039;` ne doit PAS finir deshappe comme une apostrophe.
    'https://a/1.png?quote=&#039;&amp;x=1',
    'https://a/1.png?entite=&#39;&lt;&gt;&quot;&amp;',
    'https://a/1.png?hexa=&#x27;&amp;#039;',
  ];
  for (const valeur of PIECES) comparer('parseAttachments', valeur);
  // Affirmation avant controle : sans elle, les trois lignes ci-dessus pourraient
  // etre rejetees par les deux copies, et la comparaison ne porterait sur rien.
  const deshappe = renderer.parseAttachments('https://a/1.png?quote=&#039;&amp;x=1');
  assert.equal(deshappe.length, 1, 'l entite doit etre toleree dans une URL');
  assert.equal(deshappe[0].url, "https://a/1.png?quote='&x=1", `les entites sont deshappees avant d etre rangees : ${ deshappe[0].url }`);

  // --- parseEntry : la reconnaissance des noms, et la casse -------------------
  const NOMS = [
    'Compte/user.json', 'Messages/index.json', 'Serveurs/index.json',
    'Messages/c1/channel.json', 'Messages/c1/Channel.JSON', 'MESSAGES/C1/CHANNEL.JSON',
    'Messages/c1/messages.json', 'Messages/c1/Messages.Json', 'Messages/c1/messages.csv', 'Messages/c1/Messages.CSV',
    'Serveurs/1/guild.json', 'Serveurs/1/GUILD.JSON', 'README.txt', 'Compte/avatar.png',
    'Messages/', 'Messages', '', 'messages.json', 'x.json/y/channel.json', 'Messages/c1/channel.json.bak',
  ];
  for (const nom of NOMS) {
    const octets = strToU8('{"id":"1","ID":"2","Timestamp":"2024-01-01"}');
    comparer('parseEntry', nom, octets);
    // Et un contenu qui n est pas du texte : les deux copies doivent le deco der
    // pareil, c est-a-dire ne pas lever (700 avatars du vrai export passent par la).
    comparer('parseEntry', nom, new Uint8Array([0xff, 0xfe, 0x00, 0x80]));
  }

  // --- normalizeChannelType : formes chaines et numeriques --------------------
  const TYPES = [
    'DM', 'dm', ' DM ', 'GROUP_DM', 'group', 'GROUP', 'GUILD_TEXT', 'GUILD_PUBLIC_THREAD', 'GUILD_PRIVATE_THREAD',
    'GUILD_NEWS_THREAD', 'SERVER_TEXT', '', 'inconnu', 0, 1, 2, 3, 10, 11, 12, 13, null, undefined, '1', '3',
    'GUILD_', 'THREAD', true, {}, [],
  ];
  for (const type of TYPES) comparer('normalizeChannelType', type);

  // --- normalizeRecipients ----------------------------------------------------
  const DESTINATAIRES = [
    [], null, undefined, 'pas un tableau',
    ['222222222222222222'], ['222222222222222222', ' 333333333333333333 '], ['Utilisateur supprimé'], [''], ['   '],
    ['12345', 'pas un nombre'], [{ id: 44444444444444444, username: 'bob' }], [{ id: 44444444444444444, avatar: 'abc' }],
    [{ id: 44444444444444444, avatar: 'a_animated', username: 'gif' }], [{ id: 44444444444444444, global_name: 'Global' }],
    [{ username: 'sans id' }], [{}], [null], [42], [{ id: '' }], [{ id: 44444444444444444, username: '' }],
  ];
  for (const raw of DESTINATAIRES) comparer('normalizeRecipients', raw);

  // --- cleanDmName / isPlaceholderName : les libelles de Discord ---------------
  const NOMS_SALON = [
    '', null, undefined, '   ', 'maliksync', 'Message privé avec maliksync', 'Message prive avec maliksync',
    'Message direct avec X', 'Conversation privée avec X', 'Private conversation with X', 'Private message with X',
    'Private dm with X', 'Dm with X', 'Direct message with X', 'Direct Message with 爵士',
    'Participant(e) inconnu(e)', 'Participant inconnu', 'Unknown participant', 'Unknown participant (e)',
    'utilisateur supprimé', 'Utilisateur supprimé', 'deleted user', 'Salon inconnu', 'salon inconnu, Les Pangolins',
    'Serveur inconnu', 'unknown channel', 'unknown', 'salon', 'channel', 'message privé avec',
  ];
  for (const nom of NOMS_SALON) {
    comparer('cleanDmName', nom);
    comparer('isPlaceholderName', nom);
  }

  // --- cdnAvatar / cdnGuildIcon / channelKey ---------------------------------
  for (const [id, hash, taille] of [['1', 'abc', undefined], ['1', 'a_animated', undefined], ['1', 'a_animated', 64], ['1', null, 64], ['', 'abc', 64], [null, null, 64], ['1', '', 64]]) {
    comparer('cdnAvatar', id, hash, taille);
    comparer('cdnGuildIcon', id, hash, taille);
  }
  for (const id of ['123', 'c123', 'C123', 'c', 'cabc', 123, null, undefined, '']) comparer('channelKey', id);

  // --- Les trois motifs, sur des chemins que la fixture n exercise pas ---------
  const CHEMINS = [
    'Messages/c111111111111111111/channel.json', 'Messages/111111111111111111/channel.json',
    'export-2024/Messages/c1/channel.json', 'Messages/c1/messages.json', 'Messages/1/messages.csv',
    'Messages/c1/messages.txt', 'Messages/c1x/channel.json', 'Messages/c/channel.json',
    'Serveurs/999999999999999999/guild.json', 'Serveurs/c999999999999999999/guild.json',
    'Serveurs/abc/guild.json', 'Messages/c1/channel.JSON', 'c1/channel.json', '/c1/channel.json',
  ];
  for (const chemin of CHEMINS) {
    for (const [nom, motif] of [['CHANNEL_ENTRY', 'CHANNEL_ENTRY'], ['MESSAGES_ENTRY', 'MESSAGES_ENTRY'], ['GUILD_ENTRY', 'GUILD_ENTRY']]) {
      const a = renderer[motif].exec(chemin);
      const b = parseurs[motif].exec(chemin);
      assert.deepEqual(b === null ? null : [...b], a === null ? null : [...a], `${nom} sur « ${chemin} » : les deux copies divergent`);
    }
  }
  // Affirmation : le motif doit reconnaitre SON cas, sinon la comparaison
  // porterait sur deux `null`.
  assert.ok(renderer.CHANNEL_ENTRY.exec('Messages/c1/channel.json'), 'le motif CHANNEL_ENTRY reconnait son propre cas');

  // Les motifs sont stateless (`/i` sans `/g`), donc `.exec` ne garde pas de
  // position : c'est ce qui permet de les reutiliser en boucle. Une copie qui
  // ajouterait `/g` ferait diverger les deux au DEUXIEME appel, et le test le voit.
  assert.deepEqual(
    [...renderer.MESSAGES_ENTRY.exec('Messages/c1/messages.json')],
    [...parseurs.MESSAGES_ENTRY.exec('Messages/c1/messages.json')],
    'deux appels successifs : un motif /g divergerait des la deuxieme fois',
  );

  // `SNOWFLAKE_FIELDS` construit la regexp qui protege les 18-19 chiffres. Il etait
  // EXPORTE par la copie et compare par personne : le test figeait donc sa propre
  // liste de champs, et un champ retire de la regexp des deux copies ne rougissait
  // rien. Il est desormais exporte des DEUX cote et compare ici.
  assert.equal(typeof renderer.SNOWFLAKE_FIELDS, 'string', 'le renderer doit exporter SNOWFLAKE_FIELDS, sinon ce test compare une regexp a sa propre liste');
  assert.equal(parseurs.SNOWFLAKE_FIELDS, renderer.SNOWFLAKE_FIELDS,
    `SNOWFLAKE_FIELDS diverge : renderer=${renderer.SNOWFLAKE_FIELDS}, copie=${parseurs.SNOWFLAKE_FIELDS} — un champ retire d un seul cote cesse d etre protege`);
  // Affirmation avant controle : sans elle, les deux chaines pourraient etre vides.
  assert.ok(renderer.SNOWFLAKE_FIELDS.includes('recipient_?id'), 'la regexp protege bien le champ recipient_id');
});

// --- Le filet du filet, second niveau : les deux copies, AU CARACTERE PRES ----
//
// Les deux tests precedents couvrent ce que l archive de fixture exerce (parite)
// et les CAS choisis (corpus). Aucun des deux ne couvre `assemble`, qui pese
// 122 des 415 lignes dupliquees — 29 % — et qui produit l etat AFFICHE : la
// fusion des deux `index.json`, le choix du partenaire d un MP, la difference
// entre `guildId: undefined` et `guildId: null`, `isLeft`, le rattachement des
// orphelins, le tri final, la table des messages et `totalMessages`.
//
// Ce trou n est pas refermable par une fixture. Il n existe AUCUN pendant
// fonctionnel de `assemble` a comparer : le renderer l ecrit en ligne dans
// `importDiscordPackage`, et le chemin par index n a personne pour le controler.
// Une archive de plus ne le couvrirait que sur les formes qu elle choisit ; or les
// formes qui divergent sont precisement celles qu on n avait pas vues. Discord emet
// un MP dont `recipients` ne contient que le compte exporte, un `channel.json`
// dont `id` ne vaut pas la cle de son dossier, deux `channel.json` sur la meme
// cle : aucun des trois n existe dans la fixture, et aucun ne se devine.
//
// On applique donc ici le meme principe que le test d identite des blocs de la
// regle (tache 2) : LIRE LES FICHIERS, pas les modules — une regle ne peut pas se
// comparer elle-meme. C est le seul filet possible sur `assemble`, et son cout de
// maintenance est celui que le depot a deja accepte.
// Les quatre noms de fichiers que le fichier lui-meme marque « COPIER À L'IDENTIQUE »
// des le premier `const`. Ils n etaient pas compares : la revue a muté
// `CHANNEL_NAME` dans la copie seule, quatre tests ont rougi — et le diagnostic disait
// « des salons manquent », pas « les deux copies divergent ». Le filet attrapait, sans
// mener a la cause : or un nom de fichier recognise change ce que le parseur fait de
// l entree, donc c est le genre de divergence qui doit se voir au niveau du TEXTE.
const BLOCS_PARSEURS = [
  'USER_NAME', 'INDEX_NAME', 'GUILD_NAME', 'CHANNEL_NAME',
  'SNOWFLAKE_FIELDS', 'SNOWFLAKE_JSON_RE',
  'CHANNEL_ENTRY', 'MESSAGES_ENTRY', 'GUILD_ENTRY',
  'PLACEHOLDER_NAMES', 'DM_NAME_PREFIX', 'UNKNOWN_PARTICIPANT', 'PLACEHOLDER_PREFIXES',
  'channelKey', 'normalizeChannelType', 'normalizeRecipients', 'cleanDmName',
  'isPlaceholderName', 'cdnAvatar', 'cdnGuildIcon', 'decodeEntities',
  'parseSnowflakeJson', 'parseAttachments', 'parseCsv', 'parseMessagesJson', 'parseEntry',
];

// Les blocs declares en `function` : ils se terminent par l accolade de colonne 0,
// la ou un `const` se termine par son `;`. La liste est explicite plutot que
// deduite, pour qu un bloc ajoute soit LOCALISE comme tel — une deduction erronee
// ferait chercher une accolade fermante la ou il y a un point-virgule, et
// remonterait alors un bloc trop long au lieu de lever.
const FONCTIONS_PARSEURS = new Set([
  'channelKey', 'normalizeChannelType', 'normalizeRecipients', 'cleanDmName',
  'isPlaceholderName', 'cdnAvatar', 'cdnGuildIcon', 'decodeEntities',
  'parseSnowflakeJson', 'parseAttachments', 'parseCsv', 'parseMessagesJson', 'parseEntry',
]);

// Ancre du corps de `assemble`. Dans la copie c est la premiere ligne de la
// fonction ; dans le renderer c est la meme ligne, indentee de deux espaces, au
// meme endroit du corps de `importDiscordPackage`.
const ANCRE_ASSEMBLE = '// Sections par motif';

// Les adaptations de FORME tolerees, au nombre de DEUX (le retrait de `export `
// en est une troisieme, traitee dans blocCopie). Chacune est analysee a la main,
// avec son motif, et NON deduite : une adaptation non declaree ferait rougir ce
// test a chaque evolution legitime — il deviendrait lehindrier qu il est cense
// eviter — et une adaptation declaree trop large masquerait une vraie derive.
const ADAPTATIONS_ASSEMBLE = [
  // 1. La classe d erreur. `PackageImportError` vit dans le module ESM du
  //    renderer, que le main process ne peut pas charger (meme raison que les
  //    parseurs). La copie leve donc une `Error` ordinaire, et l appelant ne doit
  //    discriminer que sur le fait qu il y a eu ECHEC, jamais sur la classe. Le
  //    MESSAGE, lui, doit rester identique : c est lui que la tache 5 conserve
  //    dans `reason`.
  [/throw new PackageImportError\(/g, 'throw new Error('],
  // 2. La taille d archive. Le renderer la lit sur le `file` qu il a recu ;
  //    `assemble` de la copie n a pas de `file` et la recoit en parametre.
  //    `importViaIndex` y passe `Number(file.size) || 0`, la MEME valeur pour un
  //    `size` numerique — c est ce que le test de parite controle.
  [/packageSizeBytes: file\.size \|\| 0,/g, 'packageSizeBytes,'],
];

// Applique les adaptations, et REND COMPTE de celles qui n'ont rien trouve : une
// adaptation devenue inutile doit se voir, sinon elle reste dans le test et
// continue de masquer ce qu elle masquerait.
function normaliser(source) {
  let out = source;
  const inertes = [];
  for (const [motif, remplacement] of ADAPTATIONS_ASSEMBLE) {
    const trouve = out.match(motif);
    if (!trouve) inertes.push(String(motif));
    out = out.replace(motif, remplacement);
  }
  return { out, inertes };
}

// Bloc TEL QU ECIT, du `const`/`function` jusqu au `;` ou a l accolade fermante
// de colonne 0. Ni le commentaire qui le precede, ni le `module.exports` qui le
// suit : ce sont des choix de mise en page, pas la regle. Fins de ligne
// normalisees, `export ` retire — les deux seules differences de FORME entre un
// module ESM et un module CommonJS.
function blocCopie(source, nom) {
  const estFonction = FONCTIONS_PARSEURS.has(nom);
  const debut = source.search(estFonction
    ? new RegExp(`(?:export )?function ${nom}\\(`)
    : new RegExp(`const ${nom} =`));
  if (debut < 0) return null;
  const fin = source.indexOf(estFonction ? '\n}' : ';', debut);
  if (fin < 0) return null;
  const bloc = source.slice(debut, estFonction ? fin + 2 : fin + 1);
  return bloc.replace(/\r\n/g, '\n').replace(/^export /, '');
}

// Corps de `assemble` : de l ancre jusqu a l accolade fermante de colonne 0 qui
// termine la fonction. cote copie c est `assemble` elle-meme, cote renderer c est
// le corps de `importDiscordPackage`, de deux espaces plus indente.
function corpsAssemble(source) {
  const debut = source.indexOf(ANCRE_ASSEMBLE);
  if (debut < 0) return null;
  const fin = source.indexOf('\n}', debut);
  if (fin < 0) return null;
  return source
    .slice(debut, fin + 2)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(ligne => (ligne.startsWith('  ') ? ligne.slice(2) : ligne))
    .join('\n');
}

test('sans TextDecoder, la copie des parseurs LEVE au lieu de rendre du vide', () => {
  // Le pire mode de defaussance possible pour ce fichier, et le plus discret.
  //
  // La copie remplace `strFromU8` de fflate par le `TextDecoder` que fflate utilise
  // lui-meme (COPIE n° 2). Le repli que l auteur avait ecrit rendait `''` quand le
  // decodeur n existe pas. Or un nom reconnu passe dans `parseEntry` AVANT tout
  // JSON.parse : `messages.json` avec `''` donne `parseMessagesJson('')` → `[]`, et
  // `index.json` avec `''` donne une `SyntaxError`. Un message sur deux disparait,
  // silencieusement, sans lever, sans journal, sans compteur.
  //
  // Le test charge le FICHIER dans un contexte ou `TextDecoder` n existe pas — un
  // contexte V8 neuf n a que les built-ins, donc exactement ce cas — et exige un
  // LEVEMENT. Impossible a tester autrement : le module construit son decodeur au
  // chargement, donc il faudrait recharger le processus pour le priver du sien.
  const source = readFileSync(new URL('../electron/packageImporter.parse.cjs', import.meta.url), 'utf8');
  const charger = (avecDecodeur) => {
    const module = { exports: {} };
    vm.runInNewContext(source, avecDecodeur ? { module, exports: module.exports, TextDecoder } : { module, exports: module.exports });
    return module.exports;
  };

  const octets = strToU8('[{"ID":1009136231751360593,"Timestamp":"2024-01-01","Contents":"salut"}]');

  // Avec le decodeur, la copie se comporte comme le reste de la suite.
  const avec = charger(true);
  assert.equal(avec.parseEntry('Messages/c1/messages.json', octets).value.length, 1, 'avec TextDecoder, un messages.json donne bien un message');

  // Sans lui : LEVE. C'est un environnement degrade, pas un environnement normal —
  // on veut un echec bruyant, pas des donnees fausses.
  const sans = charger(false);
  assert.throws(
    () => sans.parseEntry('Messages/c1/messages.json', octets),
    /TextDecoder/,
    'sans TextDecoder, la copie doit LEVER : rendre une chaine vide ferait disparaitre tous les messages de l archive SANS AUCUN SIGNAL',
  );
  assert.throws(
    () => sans.parseEntry('README.txt', octets),
    /TextDecoder/,
    'et leverait aussi sur un nom que personne ne analyse : mieux vaut une archive entiere refusee qu un import demi Builds',
  );
});

test('les deux copies des parseurs sont identiques au caractere pres, et assemble avec', () => {
  const principale = readFileSync(new URL('../electron/packageImporter.parse.cjs', import.meta.url), 'utf8');
  const renderer = readFileSync(new URL('../src/services/packageImporter.service.js', import.meta.url), 'utf8');

  for (const nom of BLOCS_PARSEURS) {
    const a = blocCopie(principale, nom);
    const b = blocCopie(renderer, nom);
    // Un bloc introuvable doit faire ROUGE, jamais passer par egalite de deux
    // `null` : un renommage ferait sinon disparaitre la couverture en silence.
    assert.ok(a !== null, `bloc ${nom} introuvable dans electron/packageImporter.parse.cjs`);
    assert.ok(b !== null, `bloc ${nom} introuvable dans src/services/packageImporter.service.js`);
    assert.ok(a.length < 4000 && b.length < 4000, `bloc ${nom} : extraction anormalement longue, la borne est mauvaise`);
    assert.ok(!/^export /m.test(a) && !/^export /m.test(b), `bloc ${nom} : le mot-cle export n'a pas ete retire`);
    assert.equal(b, a, `les deux copies du bloc ${nom} divergent :\n${premiereDivergence(nom, a, b)}`);
  }

  // `assemble` : 122 lignes, la production de l etat affiche. Compare au
  // caractere pres, apres dedent des deux espaces du renderer et application des
  // deux adaptations de forme declarees ci-dessus.
  const extraitA = corpsAssemble(principale);
  const extraitB = corpsAssemble(renderer);
  assert.ok(extraitA !== null, `le corps de assemble est introuvable dans electron/packageImporter.parse.cjs (ancre « ${ANCRE_ASSEMBLE} »)`);
  assert.ok(extraitB !== null, `le corps de assemble est introuvable dans src/services/packageImporter.service.js (ancre « ${ANCRE_ASSEMBLE} »)`);
  const { out: a, inertes } = normaliser(extraitB);
  const b = extraitA;
  assert.deepEqual(inertes, [], `ces adaptations ne trouvent plus rien dans le renderer, donc elles ne normalisent plus rien : ${inertes.join(' , ')}`);
  assert.ok(a.split('\n').length >= 100, `l extraction de assemble est anormalement courte : ${a.split('\n').length} lignes`);
  assert.ok(!/^export /m.test(a) && !/^export /m.test(b), 'le mot-cle export n a pas ete retire');
  assert.equal(a, b, `les deux copies du corps de assemble divergent :\n${premiereDivergence('assemble', a, b)}`);

  // Affirmations AVANT controle. Sans elles, le test pourrait passer pour la
  // mauvaise raison : deux extractions vides, une ancre qui attrape le premier
  // commentaire du fichier au lieu du bon, ou une adaptation devenue inerte.
  assert.ok(extraitB.includes('throw new PackageImportError('), 'le renderer leve bien PackageImportError : l adaptation 1 porte sur du texte reel');
  assert.ok(extraitB.includes('packageSizeBytes: file.size || 0,'), 'le renderer lit bien la taille sur le file : l adaptation 2 porte sur du texte reel');
  assert.ok(a.includes('const partner = recipients.find(item => item.id && item.id !== selfId)'), 'l extraction porte bien le choix du partenaire');
  assert.ok(a.includes('guildId: channel.guild?.id ? String(channel.guild.id) : undefined'), 'et le `guildId: undefined` du parcours nominal');
  assert.ok(a.includes('guildId: null, isLeft: false'), 'et le `guildId: null` du salon RAJOUTE pour donnees partielles');
  assert.ok(a.includes('channels.sort((a, b) => b.messagesCount - a.messagesCount)'), 'et le tri final');
  assert.ok(!a.includes('schemaVersion'), 'et pas de cle que le retour reel n expose pas');
});

// --- Tache 5 : le repli, et ce qui traverse REELLEMENT l IPC ----------------
//
// Le chemin par index existe, il reste a le rendre accessible a l'utilisateur, et
// trois choses changent de nature en passant par la fenetre IPC. Chacune a un
// piege qu'un test qui compte des elements ne voit pas.
//
// 1. LE REPLI. Les deux chemins n'echouent pas sur les memes motifs : un
//    repertoire central illisible n'arrete que le chemin par index, une entree
//    de 4 Gio les arrete tous les deux. Le repli doit donc etre SILENCIEUX
//    quand il reussit, et CONNU — avec sa raison exacte — quand il a lieu.
// 2. LA SERIALISATION. `ParsedPackage.messages` est une `Map`, et l'IPC Electron
//    transporte ses arguments par CLONAGE STRUCTURE, qui preserve `Map` et `Set` :
//    une `Map` y arrive INTACTE, et non vide. L'aplatissement reste donc
//    deliberé — une forme inspectable et comparable — mais il ne faut pas lui
//    inventer une justification technique fausse : c'est ce qu'un mainteneur
//    lirait, et il en tirerait que le transport est en JSON.
// 3. LE FICHIER. 394 Mo ne passent pas dans un message d'IPC, et les recopier
//    coutent plus cher que l'import qu'ils doivent permettre d accelerer.

// Le reste du fichier charge le service du renderer paresseusement (voir
// cheminFlux) parce qu'il tire fflate. Les tests ci-dessous chargent le
// composant PackageManager, qui tire le meme module : meme raison, meme parade.

// Une zone de contenu qui suffit a `render()`. PackageManager ecrit dans
// `innerHTML` et interroge le DOM sans jamais le modifier : c'est ce que
// packageRender.test.js utilise aussi, et les deux fichiers doivent pouvoir
// importer le composant hors navigateur.
function zoneMinimale() {
  return { innerHTML: '', className: '', addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] };
}

function fichierDeTest(bytes, nom = 'package.zip') {
  return new File([bytes], nom, { type: 'application/zip', lastModified: 1700000000000 });
}

// Total des octets demandes par un fichier de `countedFile`. Les tests
// d'annulation comparent le wrapper a ce que le chemin par index LUI SEUL lit :
// c'est la seule reference qui ne depend pas de la taille de la fixture.
function octetsLus(fichier) {
  return fichier.slices.reduce((total, [debut, fin]) => total + (fin - debut), 0);
}

// Un dossier de travail jetable pour le lecteur sur disque. Il est retire dans
// un `finally` : un fichier d archive ecrit dans %TEMP% et laisse derriere ne
// serait pas un detail de test, ce serait 6 Mo sur le disque de l'utilisateur.
function dossierJetable() {
  return mkdtempSync(join(tmpdir(), 'index-import-'));
}

// Le composant, charge a la demande : il tire le service d import du renderer,
// donc il est soumis a la meme parade que `cheminFlux` ci-dessus.
const chargerRenderer = async () => import('../src/components/PackageManager.js');

// Silence les journaux pendant un test, et les REND. `console.warn` sert de
// temoin : `savePackageArchive` echoue en Node (pas d'IndexedDB) et le signale
// par un warn, donc un warn absent prouve qu'aucune archive n'a ete enregistree.
function capturerJournaux(objet = console) {
  const captured = { log: [], warn: [], info: [], error: [] };
  const vrais = {};
  for (const nom of Object.keys(captured)) {
    vrais[nom] = objet[nom];
    objet[nom] = (...args) => captured[nom].push(args.map(value => String(value?.message ?? value)).join(' '));
  }
  return {
    captured,
    restaurer() { for (const nom of Object.keys(captured)) objet[nom] = vrais[nom]; },
  };
}

test('une archive sans repertoire central bascule sur le flux et le dit', async () => {
  const file = fileFromBlob(new TextEncoder().encode('pas un zip'), 'faux.zip');
  const resultat = await importPackageWithFallback(file, {});

  assert.equal(resultat.mode, 'stream', 'le pilote index echoue et le chemin flux prend le relais');
  assert.ok(resultat.reason, 'la raison du repli est conservee');
  assert.match(resultat.reason, /Unable to read ZIP archive/, `la raison nomme l echec de l index : « ${resultat.reason} »`);
  // LES DEUX MESSAGES, ET ILS DIFFERENT. Une annulation, ou une entree refusee,
  // donne un `reason` qui n'est PAS « Unable to read ZIP archive: … » (voir
  // interfaces.md) : wrapper qui remplace l un par l autre afficherait un motif
  // qui ne decrit pas ce qui s est passe.
  assert.ok(resultat.error, 'et l echec du chemin flux est conserve a part');
  assert.notEqual(resultat.error, resultat.reason, `les deux messages nomment deux etapes distinctes :\n  reason : ${resultat.reason}\n  error  : ${resultat.error}`);
  assert.equal(resultat.cancelled, false, 'rien n a ete annule');
});

test('le repli ne laisse aucun resultat partiel : rien n est presente comme un import reussi', async () => {
  // Le plan annoncait ici « `result.package` existe, avec zero salon ». Ce
  // serait faux : sur une archive qui n en est pas une, le chemin flux LEVE
  // (`seen === 0` -> « invalid zip data », src/services/packageImporter.service.js:371).
  // Ce qui compte n'est donc pas le contenu d'un paquet rendu, c'est qu'aucun
  // paquet ne soit rendu : un paquet vide presente comme un import reussi est
  // exactement le piege que l annulation expose (test suivant).
  const file = fileFromBlob(new TextEncoder().encode('pas un zip'), 'faux.zip');
  const resultat = await importPackageWithFallback(file, {});

  assert.equal(resultat.package, null, 'aucun paquet : ni vide, ni partiel — le repli n invente rien');
  assert.equal(resultat.error, 'Unable to read ZIP archive: invalid zip data', `le motif du chemin flux est celui du chemin de reference : « ${resultat.error} »`);
  assert.equal(resultat.cancelled, false);
});

test('un repertoire central incoherentent fait basculer, et le repli rend le MEME paquet que le chemin de reference', async () => {
  // Le sabotage porte sur le repertoire central SEUL : la premiere signature
  // centrale est abimee. Le chemin par index, qui cherche cette signature, echoue ;
  // le chemin flux lit EN SEQUENCE et ne la regarde jamais, donc il reussit. C
  // est la divergence d 'etat final que le repli existe pour couvrir — et le
  // resultat du repli doit etre le paquet du chemin de REFERENCE, au caractere
  // pres : sinon l'utilisateur verrait un autre import selon que le central est
  // lisible ou non.
  const bytes = archiveDeParite();
  const central = centralRangeOf(bytes);
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(central.start, 0x02014b51, true);

  const attendu = await cheminFlux(new Blob([bytes], { type: 'application/zip' }), {});
  assert.ok(attendu.channels.length >= 8, `le temoin doit etre riche : ${attendu.channels.length} salons`);

  const resultat = await importPackageWithFallback(fileFromBlob(bytes, 'p.zip'), {});
  assert.equal(resultat.mode, 'stream', 'le pilote index echoue et le repli prend le relais');
  assert.match(resultat.reason, /signature centrale absente/, `la raison est celle de l index, au caractere pres : « ${resultat.reason} »`);
  assert.equal(resultat.error, null);

  const obtenu = resultat.package;
  assert.ok(obtenu, 'le repli rend un paquet');
  assert.deepEqual(Object.keys(obtenu), Object.keys(attendu), 'MEMES cles, MEME ordre');
  assert.deepEqual(obtenu.user, attendu.user, 'le compte est identique');
  assert.deepEqual(obtenu.guilds, attendu.guilds, 'les serveurs sont identiques');
  assert.deepEqual(obtenu.channels, attendu.channels, 'les salons sont identiques, dans le MEME ordre');
  assert.equal(obtenu.totalMessages, attendu.totalMessages, 'le total de messages est identique');
  assert.deepEqual(obtenu.discarded, attendu.discarded, 'les compteurs de jetes sont identiques');
  comparerMessages(attendu.messages, obtenu.messages, 'table des messages du repli');
});

test('une annulation n est JAMAIS presentee comme un succes, et ne relance JAMAIS le chemin flux', async () => {
  // LE piege de toute cette tache, mesure a la tache 4 : sur une archive qui
  // depasse le bloc de lecture du chemin flux — donc sur TOUTE archive reelle —
  // une annulation laisse les deux chemins RENDRE un paquet. Celui du chemin par
  // index a deja lu `Compte/user.json` : il a un compte, des salons, un total de
  // messages. C'est un succes SILENCIEUX, et le wrapper doit le refuse malgre
  // tout, parce que sa forme ne dit rien de ce qui s'est passe.
  const bytes = archiveAuDessusDuBloc();
  assert.ok(bytes.length > BLOC_DE_LECTURE, `l archive doit depasser le bloc de ${BLOC_DE_LECTURE} octets : ${bytes.length}`);

// D'abord, ce que le chemin par index LUI SEUL rendrait : c'est l'etat que le
  // wrapper doit refuser de presenter. Sans cette etape, le test pourrait
  // « prouver » la regle sur un paquet qui n aurait rien de reussi. Le point
  // d arret est apres une MENZAINE D ENTREE : le compte, les deux index, les deux
  // serveurs et le premier `channel.json`, donc de quoi afficher une conversation.
  // Ce meme passage se fait sur un fichier qui COMPTE ses lectures : c'est la
  // reference de comparaison plus bas.
  let arretsIsoles = 0;
  const pourRef = countedFile(bytes, 'p.zip');
  const isole = await importViaIndex(pourRef, {
    shouldStop: () => { arretsIsoles += 1; return arretsIsoles > 12; },
  });
  const lusReference = octetsLus(pourRef);
  assert.equal(isole.user.id, USER_ID, 'le chemin par index seul a bien lu le compte avant l arret');
  assert.ok(isole.channels.length > 0, `et il a bien produit des salons : ${isole.channels.length} — c'est ce qui ressemble a un succes`);

  // Puis le wrapper, sur la MEME archive.
  const fichier = countedFile(bytes, 'p.zip');
  let arrets = 0;
  const resultat = await importPackageWithFallback(fichier, {
    shouldStop: () => { arrets += 1; return arrets > 12; },
  });

  assert.ok(arrets >= 13, `shouldStop a bien ete consulte : ${arrets} fois`);
  assert.equal(resultat.cancelled, true, 'l annulation est DITE, pas devinee');
  assert.equal(resultat.package, null, 'jamais un paquet, meme partiel, meme complet : la forme du paquet ne dit rien');
  assert.equal(resultat.error, null, 'et pas d erreur non plus : une annulation n est pas un echec d archive');
  // Ici le chemin index n a rien refuse : il a rendu son paquet, et c est
  // l annulation qui l invalide. Il n'y a donc AUCUN motif — la distinction
  // importe : un motif vide ne doit pas se lire comme un echec d archive.
  assert.equal(resultat.reason, null, 'aucun echec n a eu lieu : le motif est nul, et `cancelled` porte seul le verdict');
  assert.equal(resultat.mode, 'index', 'et le mode dit par quel chemin l arret a eu lieu');

  // LE CHEMIN FLUX N A PAS ETE RELANCE. Compter les OCTETS lus est la seule preuve
  // independante de l etat final — un wrapper qui relancerait le flux et rendrait
  // son paquet partiel passerait tous les autres controles de ce test. La
  // reference est ce que le chemin par index lit SEUL : la comparaison ne depend
  // donc pas de la taille de la fixture, qui n'a rien a voir ici.
  const lus = octetsLus(fichier);
  assert.equal(lus, lusReference, `le chemin flux n a pas ete relance : ${lus} octets lus, contre ${lusReference} pour le seul chemin index. Au-dela, c est un second parcours de 394 Mo pour rien.`);
  assert.ok(lus < 256 * 1024, `et la lecture reste petite en valeur absolue : ${lus} octets pour une archive de ${bytes.length}`);
});

test('une annulation donne le meme verdict sur une archive qui tient dans UN bloc', async () => {
  // L'autre moitie du piege, sur le cas ou les deux chemins ECHOUENT. Les motifs
  // different (interfaces.md : « Unrecognized Discord package: user.json is
  // missing. » pour l index, « invalid zip data » pour le flux) — donc le verdict
  // ne peut pas se lire dans le message, il doit etre porte par `cancelled`.
const { corps } = archiveComplete();
  // Reference : ce que le chemin par index lit SEUL sur cette archive, avant
  // d echouer. C'est elle, et non une constante en octets, qui dit ce qu'un
  // second parcours de l archive coûterait.
  const pourRef = countedFile(corps, 'p.zip');
  await importViaIndex(pourRef, { shouldStop: () => true }).catch(() => null);
  const lusReference = octetsLus(pourRef);

  const fichier = countedFile(corps, 'p.zip');
  const resultat = await importPackageWithFallback(fichier, { shouldStop: () => true });

  assert.equal(resultat.cancelled, true, 'une annulation vaut une annulation, meme quand les deux chemins echouent');
  assert.equal(resultat.package, null, 'et aucun paquet n est rendu');
  assert.equal(resultat.error, null, `l annulation n est pas un echec d archive : « ${resultat.error} »`);
  assert.match(resultat.reason, /user\.json is missing/, `le motif de l index est conserve tel quel : « ${resultat.reason} »`);

  // Et ICI le chemin flux ne doit pas etre relance non plus. C'est la meme regle
  // que le test precedent, sur l'autre moitie du cas : la-bas l'index aboutissait
  // (donc le repli n'etait meme pas arme), ici l'index ECHOIE — et un wrapper qui
  // ne verifierait l'annulation qu'apres un succes laisserait passer ce second
  // parcours, qui relit l'archive entiere pour rien.
  const lus = octetsLus(fichier);
  assert.equal(lus, lusReference, `le chemin flux n a pas ete relance apres l echec de l index : ${lus} octets lus, contre ${lusReference} pour le seul chemin index`);
});

test('si le chemin flux n est pas chargeable ici, l import revient au renderer', async () => {
  // Le chemin de reference est un module ESM de BROWSER, que le main process
  // charge par `import()` dynamique. Si ce chargement echoue — asar, build
  // packager, module absent — le repli n'a personne vers qui replier, et un
  // echec de chargement ne doit pas etre presente comme un echec d'archive :
  // c'est au renderer de refaire l'import, comme avant cette tache.
  const file = fileFromBlob(new TextEncoder().encode('pas un zip'), 'faux.zip');
  const resultat = await importPackageWithFallback(file, {
    loadStreamImporter: async () => { throw new Error('ERR_MODULE_NOT_FOUND'); },
  });

  assert.equal(resultat.fallbackToRenderer, true, 'le renderer est prevenu qu il doit refaire l import');
  assert.equal(resultat.package, null, 'sans quoi deux imports se superposeraient');
  assert.match(resultat.error, /ERR_MODULE_NOT_FOUND/, `le motif du chargement est conserve : « ${resultat.error} »`);
  assert.equal(resultat.cancelled, false);
});

test('le paquet survit au passage par IPC : la Map des messages est reconstruite a l identique', async () => {
  const { archive } = archiveComplete();
  const original = await importViaIndex(fileFromBlob(archive, 'p.zip'), {});
  assert.ok(original.messages instanceof Map, 'le chemin par index rend bien une Map, en MEMOIRE');
  assert.ok(original.messages.size >= 8, `et elle est pleine : ${original.messages.size} salons`);

  // PREUVE DU CHOIX, avant de s'y fier. L'aplatissement est un CHOIX de forme,
  // pas une contrainte du transport, et on le teste donc contre le cas le plus
  // severe possible : du JSON. Mesure : le transport REEL d'Electron est le
  // clonage structure, qui PRESERVE les `Map` — l'affirmation de droite est donc
  // vraie, et celle de gauche aussi. Le passage JSON prouve que ce test est plus
  // SEVERE que le transport reel, ce qui est la bonne pratique, et NON que le
  // transport reel est du JSON.
  const mapSurLeFil = structuredClone(new Map([['111', [{ id: '1' }]]]));
  assert.equal(mapSurLeFil instanceof Map, true, 'le transport reel PRESERVE une Map : l aplatissement est un choix, pas une contrainte');
  const mapEnJson = JSON.parse(JSON.stringify(new Map([['111', [{ id: '1' }]]])));
  assert.deepEqual(mapEnJson, {}, 'et JSON, lui, la vide : c est le cas severe que ce test se pose');

  const charge = aplatitPackagePourIpc(original);
  assert.equal(charge.messages instanceof Map, false, 'ce qui part dans l IPC est un objet plat, pas une Map');
  assert.equal(Object.getPrototypeOf(charge.messages), Object.prototype, 'un objet ordinaire, donc serialisable');

  const { hydrateImportedPackage } = await chargerRenderer();

  // --- Passe 1 : le cas JSON, le plus severe. Ce que le renderer recoit ne peut
  // pas porter un `undefined` — et le paquet de reference en a, sur les salons
  // sans guilde. La comparaison se fait donc contre ce que le fil PEUT porter,
  // et la difference est ensuite nommee au lieu d etre toleree en silence.
  const recu = JSON.parse(JSON.stringify(charge));
  const reconstruit = hydrateImportedPackage(recu);
  const transportable = JSON.parse(JSON.stringify(original));
  assert.deepEqual(Object.keys(reconstruit), Object.keys(original), 'MEMES cles, MEME ordre : la forme du package est un contrat');
  assert.deepEqual(reconstruit.user, transportable.user, 'le compte est identique');
  assert.deepEqual(reconstruit.guilds, transportable.guilds, 'les serveurs sont identiques');
  assert.deepEqual(reconstruit.channels, transportable.channels, 'les salons sont identiques, dans le MEME ordre');
  assert.equal(reconstruit.totalMessages, original.totalMessages, 'le total de messages est identique');
  assert.equal(reconstruit.packageSizeBytes, original.packageSizeBytes, 'la taille d archive est identique');
  assert.deepEqual(reconstruit.discarded, original.discarded, 'les compteurs de jetes sont identiques');
  assert.ok(reconstruit.messages instanceof Map, 'et surtout : la table des messages est bien une Map');
  comparerMessages(original.messages, reconstruit.messages, 'table reconstruite apres IPC');

  // La SEULE difference avec le paquet d origine est un ensemble de cles dont la
  // valeur est `undefined` — donc rien n est perdu, mais il faut que ce soit
  // VRAI, et non qu'on l'espere : on recompte les cles pour lesquelles le
  // transport change quelque chose.
  const sansValeur = canaux => canaux.filter(canal => Object.keys(canal).some(cle => canal[cle] === undefined));
  const parOriginal = sansValeur(original.channels).length;
  assert.ok(parOriginal > 0, `le temoin doit avoir des cles sans valeur, sinon la comparaison ne prouve rien : ${parOriginal}`);
  const parReconstruit = sansValeur(reconstruit.channels).length;
  assert.equal(parReconstruit, 0, `et la reconstruction n en laisse aucune : ${parReconstruit} — ce sont des cles ABSENTES, pas des valeurs fausses`);

  // --- Passe 2 : le transport reel. La serialisation structuree porte les
  // `undefined`, et elle est plus fidele que JSON ; le paquet reconstruit doit
  // alors etre identique a l original, cles absentes comprises.
  const viaStructure = hydrateImportedPackage(structuredClone(charge));
  assert.deepEqual(viaStructure.channels, original.channels, 'sur un transport qui porte les `undefined`, les salons sont identiques cles comprises');
  comparerMessages(original.messages, viaStructure.messages, 'table reconstruite par le transport structure');
});

test('le paquet reconstruit reste un package de base : il est enregistre et relu comme avant', async () => {
  // `schemaVersion` est une cle du COTE IHM : c'est `isCurrentPackageArchive`
  // qui la lit, au rechargement, pour ecarter une archive d'une version
  // perimee. Le retour du main process ne la porte donc pas — la parite de la
  // tache 4 l'exclut explicitement — et c'est le renderer qui la pose. Sinon une
  // archive importee par le nouveau chemin serait ecartee a sa relecture.
  const { archive } = archiveComplete();
  const original = await importViaIndex(fileFromBlob(archive, 'p.zip'), {});
  const { hydrateImportedPackage } = await chargerRenderer();
  const stockage = await import('../src/services/packageStorage.service.js');

  const charge = aplatitPackagePourIpc(original);
  assert.equal(Object.hasOwn(charge, 'schemaVersion'), false, 'ce qui part du main process ne porte pas de version de schema : elle n existe que dans la base');

  const reconstruit = hydrateImportedPackage(JSON.parse(JSON.stringify(charge)));
  reconstruit.schemaVersion = stockage.PACKAGE_SCHEMA_VERSION; // la ligne de PackageManager
  assert.equal(stockage.isCurrentPackageArchive({ packageData: reconstruit }), true, 'une fois posee par le renderer, l archive est consideree comme courante');
  assert.equal(stockage.isCurrentPackageArchive({ packageData: hydrateImportedPackage(JSON.parse(JSON.stringify(charge))) }), false, 'et sans elle, elle serait ECARTEE a la relecture : le paquet enregistre ne serait pas conserve');
});

test('le fichier ne traverse pas l IPC : le main process ne lit que les tranches demandees', async () => {
  // L'archive de test pese 6,6 Mo, dont 4 Mio d'ENTREE DE BRUIT STOREE : le
  // chemin par index ne l'ouvre jamais (c'est le principe du chantier), donc il
  // ne doit en lire qu'une fraction. Un lecteur qui chargerait le fichier —
  // `readFile`, ou un envoi des 394 Mo par l'IPC — la lirait en entier, et
  // l'economie du chantier serait payee par une copie de 394 Mo.
  //
  // LA MESURE EST AU NIVEAU DE `fs.readSync`, pas du `slice` du lecteur : compter
  // les tranches DEMANDEES prouverait que l'appelant en demande peu, pas que le
  // lecteur en LIT peu — et c'est la lecture qui coute. Le `readSync` est donc
  // intercepte, puis le service recharge depuis un cache purge, pour qu'il
  // capture la fonction interceptee (meme procede que le test de la borne zlib).
  const fs = require('node:fs');
  const SERVICE_TACHE_5 = require.resolve('../electron/packageImporter.service.cjs');
  const vraiReadSync = fs.readSync;
  const surDisque = { octets: 0, appels: 0 };
  fs.readSync = (...args) => {
    const lus = vraiReadSync(...args);
    surDisque.octets += lus;
    surDisque.appels += 1;
    return lus;
  };
  delete require.cache[SERVICE_TACHE_5];
  const service = require('../electron/packageImporter.service.cjs');

  const dossier = dossierJetable();
  try {
    const archive = zipAvecAjouts(archiveDeParite(), [
      { nom: 'Activité/remplissage.json', method: 0, payload: incompressible(BLOC_DE_LECTURE) },
    ]);
    assert.ok(archive.length > BLOC_DE_LECTURE, `l archive doit depasser le bloc : ${archive.length}`);
    const chemin = join(dossier, 'package.zip');
    writeFileSync(chemin, archive);

    surDisque.octets = 0;
    surDisque.appels = 0;
    const lecteur = await service.openArchiveReader(chemin, 'package.zip');
    assert.equal(lecteur.size, archive.length, 'la taille annoncee est celle du fichier, pas celle d un tampon');

    // Le contrat de lecture, tranche par tranche, compare aux octets reels.
    const tete = new Uint8Array(await lecteur.slice(0, 4).arrayBuffer());
    assert.deepEqual([...tete], [...archive.subarray(0, 4)], 'une tranche rend exactement les octets demandes');
    const queue = new Uint8Array(await lecteur.slice(archive.length - 22, archive.length).arrayBuffer());
    assert.equal(queue.length, 22, 'la derniere tranche est complete');
    assert.equal(new DataView(queue.buffer).getUint32(0, true), 0x06054b50, 'et c est bien l EOCD de l archive');
    const bornee = new Uint8Array(await lecteur.slice(archive.length - 10, archive.length + 4096).arrayBuffer());
    assert.equal(bornee.length, 10, 'une tranche qui deborde la fin rend ce qui existe, sans decaler la lecture');
    const vide = new Uint8Array(await lecteur.slice(archive.length, archive.length + 10).arrayBuffer());
    assert.equal(vide.length, 0, 'et une tranche entierement hors fichier rend zero octet');
    const lu = surDisque.octets;
    assert.equal(lu, 4 + 22 + 10, `une tranche ne lit QUE ce qu on lui demande : ${lu} octets pour 36 demandes`);

    // Et l'import complet, sur la MEME mesure. Un lecteur qui materialise le
    // fichier — pour l'envoyer par l IPC, ou par simplicite — lirait 6,6 Mo.
    surDisque.octets = 0;
    surDisque.appels = 0;
    const resultat = await service.importPackageWithFallback(lecteur, {});
    assert.ok(resultat.package, `l import doit aboutir : ${resultat.error}`);
    assert.equal(resultat.mode, 'index');
    assert.ok(
      surDisque.octets < 256 * 1024,
      `${surDisque.octets} octets lus sur une archive de ${archive.length}, en ${surDisque.appels} lectures : l entree de bruit de 4 Mio n a pas ete ouverte, et le fichier n a pas ete recopie`,
    );

    await assert.rejects(() => service.openArchiveReader(join(dossier, 'absent.zip'), 'absent.zip'), /ENOENT/, 'un fichier absent se signale, il ne rend pas un lecteur muet');
  } finally {
    fs.readSync = vraiReadSync;
    delete require.cache[SERVICE_TACHE_5];
    rmSync(dossier, { recursive: true, force: true });
  }
});

test('le descripteur du fichier est ferme, meme quand l import echoue ou s annule', async () => {
  // Sur Windows, un descripteur ouvert EMPECHE la suppression du fichier, et le
  // lecteur n existe que le temps d'un import. Le wrapper ferme donc toujours,
  // sur les trois sorties possibles — sans quoi un import annule, ou en echec,
  // laisserait le fichier verrouille.
  const dossier = dossierJetable();
  try {
    const archive = archiveDeParite();
    const chemin = join(dossier, 'package.zip');
    writeFileSync(chemin, archive);
    writeFileSync(join(dossier, 'faux.zip'), 'pas un zip');

    const scenarios = [
      { nom: 'succes', fichier: chemin, options: {} },
      { nom: 'annulation', fichier: chemin, options: { shouldStop: () => true } },
      { nom: 'echec', fichier: join(dossier, 'faux.zip'), options: {} },
    ];

    for (const scenario of scenarios) {
      const lecteur = await openArchiveReader(scenario.fichier, 'p.zip');
      let fermetures = 0;
      const vraiClose = lecteur.close.bind(lecteur);
      await importPackageWithFallback({
        name: lecteur.name,
        size: lecteur.size,
        slice: (debut, fin) => lecteur.slice(debut, fin),
        close: async () => { fermetures += 1; await vraiClose(); },
      }, scenario.options);
      assert.equal(fermetures, 1, `${scenario.nom} : le descripteur doit etre ferme UNE fois`);
      // Prouve que le descripteur est REELLEMENT ferme, et pas qu'un drapeau a
      // ete pose : une lecture apres fermeture echoue sur le descripteur. La
      // lecture etant synchrone, l echec est un LEVEE, pas un rejet.
      assert.throws(() => lecteur.slice(0, 4), /EBADF|bad file descriptor/i, `${scenario.nom} : le descripteur doit etre invalide apres fermeture`);
    }
  } finally {
    rmSync(dossier, { recursive: true, force: true });
  }
});

test('le preload envoie le CHEMIN du fichier, jamais ses octets', async () => {
  // Le bridge est la seule chose que la suite ne peut pas atteindre en
  // executant le vrai Electron : on le charge donc dans un `vm`, avec un faux
  // `electron`. Ce qui est verifie ici est du SILENCE — le message ne porte ni
  // octets, ni tampon, ni `File` — et une absence ne se voit pas sans mesure.
  const octets = zipSync({ 'Compte/user.json': strToU8('{"id":1}') });
  const cheminAttendu = 'C:\\Users\\testeur\\Downloads\\package (1).zip';
  const { api, appels, logs } = chargerPreload({ chemin: cheminAttendu });

  // La reponse simulee porte le PAQUET ENTIER : c'est ce que renvoie le main
  // process sur un export reel (667 salons, leurs messages). Le journal du
  // preload ne doit pas le contenir : un `wrap` automatique le journaliserait, et
  // le journal du main process se remplirait alors de l'archive entiere.
  const paquet = { user: { id: '1' }, guilds: [], channels: [{ id: '1' }], messages: { 1: [{ id: '1', content: 'bonjour' }] }, totalMessages: 1, packageSizeBytes: 1, discarded: { noise: 0, oversized: 0 } };
  const { api: apiFaux, appels: appelsFaux, logs: logsFaux } = chargerPreload({ chemin: cheminAttendu, reponse: { success: true, package: paquet, mode: 'index', reason: null } });
  const recue = await apiFaux.importPackage(new File([octets], 'package (1).zip'));
  assert.equal(recue.package, paquet, 'la reponse est rendue telle quelle');
  const journalise = JSON.stringify(logsFaux.log);
  assert.ok(journalise.length < 400, `le journal ne doit pas contenir le paquet : ${journalise.length} caracteres journalises`);
  assert.equal(journalise.includes('bonjour'), false, 'le contenu des messages ne doit jamais passer par le journal');
  const resume = logsFaux.log.map(args => args.find(argue => argue && typeof argue === 'object' && 'salons' in argue)).find(Boolean);
  assert.ok(resume, `le journal doit porter un resume de l import : ${journalise}`);
  assert.equal(resume.salons, 1, 'avec le nombre de salons');
  assert.equal(resume.messages, 1, 'et le nombre de messages');
  assert.equal(resume.mode, 'index', 'et le mode retenu');
  assert.equal(appelsFaux.length, 1, 'et un seul message d IPC a ete envoye');

  const reponse = await api.importPackage(new File([octets], 'package (1).zip'));
  assert.equal(appels.length, 1, `un seul message d IPC : ${appels.length}`);
  assert.equal(appels[0].canal, 'discord:importPackage');
  assert.deepEqual(Object.keys(appels[0].charge).sort(), ['chemin', 'nom', 'taille'], `la charge utile ne porte que des metadonnees : ${JSON.stringify(Object.keys(appels[0].charge))}`);
  assert.equal(appels[0].charge.chemin, cheminAttendu, 'le chemin du fichier');
  assert.equal(appels[0].charge.nom, 'package (1).zip', 'et son nom');
  assert.equal(appels[0].charge.taille, octets.length, 'et sa taille');
  assert.equal(JSON.stringify(appels[0].charge).length < 200, true, 'rien qui ressemble a des octets');
  assert.equal(reponse.ok, true, 'et la reponse est rendue telle quelle');

  // Un fichier qui n'existe pas sur le disque — un `File` construit en JS, une
  // archive en memoire — n'a pas de chemin. Le repli se fait ALORS, sans message
  // d IPC : le renderer refait l'import lui-meme, comme avant cette tache.
  const sansChemin = chargerPreload({ chemin: '' });
  const local = await sansChemin.api.importPackage(new File([octets], 'package.zip'));
  assert.equal(sansChemin.appels.length, 0, 'aucun message d IPC : il n y a rien a transmettre');
  assert.equal(local.success, false);
  assert.equal(local.fallbackToRenderer, true, 'et le renderer est prevenu qu il doit importer lui-meme');
  assert.ok(local.error, 'avec un motif affichable');

  // Un objet qui n'est pas un File fait LEVER `getPathForFile` : le caller ne
  // doit pas exploser pour cela.
  const quiLeve = chargerPreload({ chemin: '', leve: true });
  const surBlob = await quiLeve.api.importPackage(new Blob([octets]));
  assert.equal(surBlob.fallbackToRenderer, true, 'un Blob n est pas un File, et tombe donc sur le chemin local');
  assert.equal(quiLeve.appels.length, 0);
});

test('main, preload et renderer parlent des MEMES canaux et de la MEME forme', async () => {
  // Le handler de main.cjs ne peut pas etre execute ici — le fichier cree des
  // dossiers et demande le verrou d instance unique des son chargement. Ce qui
  // reste verifiable, et qui se casse Independentement, c'est la CONVENTION :
  // un nom de canal ecrit d un cote et pas de l autre ne leve rien, il fait
  // echouer l'import en silence, et le renderer retomberait sur le chemin local
  // sans dire pourquoi. Le reste de la forme est tenu par les types de
  // src/types/global.d.ts, et la charge utile par le test du preload.
  const main = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  const preload = readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');

  assert.match(main, /ipcMain\.handle\('discord:importPackage'/, 'main doit enregistrer le canal de l import');
  assert.match(main, /event\.sender\.send\('discord:importPackage:progress'/, 'main doit publier la progression sur son canal');
  assert.match(preload, /ipcRenderer\.invoke\('discord:importPackage'/, 'le preload doit invoquer ce meme canal');
  assert.match(preload, /ipcRenderer\.on\('discord:importPackage:progress'/, 'et ecouter celui de la progression');
  // La forme du fil — le paquet IMBRIQUE sous `package` — appartient au service,
  // ou un test de comportement la verifie : a plat, il se confond avec les cles
  // de l enveloppe, et le renderer ne le voit pas.
  assert.match(main, /importArchiveDepuisChemin\(/, 'main delegue l import entier, et ne reassemble donc pas l enveloppe lui-meme');
});

test('le preload relaie la progression du main process, et se desabonne', async () => {
  const { api, emettre } = chargerPreload({ chemin: 'C:\\p.zip' });
  const recues = [];
  const stop = api.onImportPackageProgress(info => recues.push(info));

  emettre('discord:importPackage:progress', { fichier: 'p.zip', current: 3, total: 9, stage: 'Lecture des entrees utiles', bytes: false });
  assert.deepEqual(recues, [{ fichier: 'p.zip', current: 3, total: 9, stage: 'Lecture des entrees utiles', bytes: false }], 'la progression arrive telle quelle, `bytes: false` compris');

  stop();
  emettre('discord:importPackage:progress', { fichier: 'p.zip', current: 4, total: 9, stage: 'Lecture des entrees utiles', bytes: false });
  assert.equal(recues.length, 1, 'l desabonnement arrete de RECEVOIR la progression, pas seulement de conserver la fonction');
});

// Un `vm` qui charge electron/preload.cjs avec un faux `electron`. Le bridge y
// enregistre les handlers : on observe ce que le renderer enverrait, sans
// Electron et sans fenetre.
function chargerPreload({ chemin = '', leve = false, reponse = { ok: true } } = {}) {
  const source = readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
  const namespaces = {};
  const appels = [];
  const abonnes = new Map();
  const fauxElectron = {
    contextBridge: { exposeInMainWorld: (nom, api) => { namespaces[nom] = api; } },
    ipcRenderer: {
      invoke: async (canal, charge) => { appels.push({ canal, charge }); return reponse; },
      on: (canal, cb) => { if (!abonnes.has(canal)) abonnes.set(canal, new Set()); abonnes.get(canal).add(cb); },
      removeListener: (canal, cb) => { abonnes.get(canal)?.delete(cb); },
    },
    webUtils: { getPathForFile: () => { if (leve) throw new Error('not a File object'); return chemin; } },
  };
  const logs = { log: [], warn: [], error: [] };
  // Les arguments sont conserves TELS QUELS, pas joints en chaine : c'est la
  // seule facon de verifier qu'un journal ne contient pas le paquet, puisque
  // `String({})` vaut « [object Object] » et prouverait n'importe quoi.
  const fauxConsole = Object.fromEntries(Object.entries(logs).map(([nom, liste]) => [nom, (...args) => liste.push(args)]));
  const moduleFaux = { exports: {} };
  const sandbox = {
    require: id => (id === 'electron' ? fauxElectron : require(id)),
    module: moduleFaux,
    exports: moduleFaux.exports,
    console: fauxConsole,
    setTimeout, clearTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'electron/preload.cjs' });

  assert.ok(namespaces.electronAPI, 'le preload doit exposer electronAPI');
  assert.ok(namespaces.persistAPI, 'et persistAPI : le fichier expose deux espaces de noms');
  return {
    api: namespaces.electronAPI,
    appels,
    logs,
    emettre: (canal, donnees) => { for (const cb of abonnes.get(canal) || []) cb({}, donnees); },
  };
}

test('sans electronAPI, ou sans chemin, l import retombe sur le chemin local', async () => {
  // Le filet de securite de toute la tache : si le main process ne peut pas
  // faire l'import, le renderer le fait lui-meme, exactement comme avant. Sans ce
  // test, une regression de bridge se verrait comme une application cassee.
  const bytes = archiveDeParite();
  const scenarios = [
    { nom: 'aucun electronAPI', api: undefined },
    { nom: 'pas de chemin', api: { importPackage: async () => ({ success: false, fallbackToRenderer: true, error: 'sans chemin' }) } },
  ];

  for (const scenario of scenarios) {
    const { PackageManager } = await chargerRenderer();
    const windowAvant = globalThis.window;
    globalThis.window = scenario.api === undefined ? {} : { electronAPI: scenario.api };
    const journaux = capturerJournaux();
    try {
      const manager = new PackageManager(zoneMinimale());
      const item = { file: fichierDeTest(bytes), status: 'queued', percent: 0, startedAt: 0 };
      manager.queue.push(item);
      await manager.importQueueItem(item);

      assert.equal(item.status, 'success', `${scenario.nom} : l import doit aboutir`);
      assert.ok(manager.package, `${scenario.nom} : le paquet est charge`);
      assert.ok(manager.package.channels.length >= 8, `${scenario.nom} : avec tous ses salons (${manager.package?.channels?.length})`);
      assert.ok(manager.package.messages instanceof Map, `${scenario.nom} : et sa table de messages`);
      assert.equal(journaux.captured.info.length, 1, `${scenario.nom} : le mode retenu est journalise UNE fois, pas a chaque etape : ${JSON.stringify(journaux.captured.info)}`);
      assert.match(journaux.captured.info[0], /local/, `${scenario.nom} : et le journal nomme le chemin local : « ${journaux.captured.info[0]} »`);
    } finally {
      journaux.restaurer();
      globalThis.window = windowAvant;
    }
  }
});

test('par IPC, le renderer reconstruit la Map, journalise le mode, et persiste le paquet', async () => {
  const { archive } = archiveComplete();
  const original = await importViaIndex(fileFromBlob(archive, 'p.zip'), {});
  const charge = aplatitPackagePourIpc(original);
  const { PackageManager } = await chargerRenderer();
  const { isCurrentPackageArchive, PACKAGE_SCHEMA_VERSION } = await import('../src/services/packageStorage.service.js');

  const progres = [];
  const windowAvant = globalThis.window;
  globalThis.window = {
    electronAPI: {
      importPackage: async () => ({ success: true, package: JSON.parse(JSON.stringify(charge)), mode: 'index', reason: null }),
      onImportPackageProgress: cb => { progres.push(cb); return () => { progres.length = 0; }; },
    },
  };
  const journaux = capturerJournaux();
  try {
    const manager = new PackageManager(zoneMinimale());
    const item = { file: fichierDeTest(archive), status: 'queued', percent: 0, startedAt: 0 };
    manager.queue.push(item);

    const fin = manager.importQueueItem(item);
    // La progression du main process alimente la MÊME barre que le chemin local :
    // c'est ce qui evite que la jauge reste figee pendant tout l'import.
    progres[0]({ fichier: item.file.name, current: 5, total: 20, stage: 'Lecture des entrees utiles', bytes: false });
    progres[0]({ fichier: item.file.name, current: 2, total: 9, channelId: '111111111111111111', stage: 'Extraction des messages' });
    await fin;

    assert.equal(item.status, 'success', 'l import aboutit');
    assert.equal(item.percent, 100);
    assert.equal(progres.length, 0, 'la progression est desabonnee a la fin de l import');
    assert.ok(manager.package.messages instanceof Map, 'la table des messages est reconstruite');
    comparerMessages(original.messages, manager.package.messages, 'table reconstruite par PackageManager');
    assert.equal(journaux.captured.info.length, 1, 'le mode est journalise une fois');
    assert.match(journaux.captured.info[0], /index/, `et c est le mode index : « ${journaux.captured.info[0]} »`);

    // La version du schema est posee COTE IHM, et c'est elle que le
    // rechargement lit : sans elle, l archive importee par le nouveau chemin
    // serait ecartee a la relecture.
    assert.equal(manager.package.schemaVersion, PACKAGE_SCHEMA_VERSION, 'la version du schema est posee par le renderer');
    assert.equal(isCurrentPackageArchive({ packageData: manager.package }), true, 'et l archive est donc consideree comme courante');
    assert.equal(
      journaux.captured.warn.some(ligne => ligne.includes('Unable to persist package archive')),
      true,
      'la persistence a bien ete tentee : en Node il n y a pas d IndexedDB, et l absence de ce warn prouverait au contraire qu aucune archive n a ete enregistree',
    );
  } finally {
    journaux.restaurer();
    globalThis.window = windowAvant;
  }
});

test('le mode d import est VISIBLE dans la file, pendant l import comme apres', async () => {
  // Le risque le plus couturier de ce chantier est un GAIN QUI DISPARAIT EN SILENCE :
  // un `npm i` vers Electron 44 casse l import ESM du renderer dans l archive asar —
  // l application continue de fonctionner, l import repasse a 12 s, rien ne leve, la
  // suite de tests est verte, et le filet de repli refait le travail par le renderer.
  // Personne ne voit donc rien. Le remede tient en un mot affiche : « ca est redevenu
  // lent » se rapporte avec le mode dans la capture d ecran.
  //
  // La preuve la plus utile est la premiere : le mode doit etre affiche PENDANT l
  // import, car la reponse du main process ne rend qu a la fin — un mode affiche au
  // succes seulement n apparaitrait que sur un import deja fini, donc trop tard pour un
  // import lent.
  const { archive } = archiveComplete();
  const charge = JSON.parse(JSON.stringify(aplatitPackagePourIpc(await importViaIndex(fileFromBlob(archive, 'p.zip'), {}))));
  const { PackageManager } = await chargerRenderer();

  // Les trois formes reelles : index, repli sur le flux DANS le main process, et
  // repli sur le renderer lui-meme (pas d `electronAPI`). Les deux dernieres
  // DOIVENT se dire « flux » : c est la degradation qu on veut voir. Le troisieme cas
  // n a pas de progression injectable — elle vient de l import local lui-meme — donc il
  // verifie le mode final, ce qui est deja le moment ou il compte le plus (capture
  // d ecran d un import fini).
  const scenarios = [
    { nom: 'index', progression: [{ current: 5, total: 20, stage: 'Lecture des entrees utiles', bytes: false }], reponse: { mode: 'index', reason: null }, attendu: 'index' },
    { nom: 'repli flux', progression: [{ current: 0, total: 400, stage: 'Lecture du ZIP', bytes: true }, { current: 667, total: 667, stage: 'Extraction des messages' }], reponse: { mode: 'stream', reason: 'repertoire central illisible' }, attendu: 'flux' },
    { nom: 'repli renderer', progression: [], local: true, attendu: 'flux' },
  ];

  for (const scenario of scenarios) {
    const progres = [];
    const windowAvant = globalThis.window;
    globalThis.window = scenario.local ? {} : {
      electronAPI: {
        importPackage: async () => ({ success: true, package: charge, ...scenario.reponse }),
        onImportPackageProgress: cb => { progres.push(cb); return () => { progres.length = 0; }; },
      },
    };
    const journaux = capturerJournaux();
    try {
      const manager = new PackageManager(zoneMinimale());
      const item = { file: fichierDeTest(archive), status: 'queued', percent: 0, startedAt: 0 };
      manager.queue.push(item);

      const fin = manager.importQueueItem(item);
      for (const info of scenario.progression) {
        progres[0]?.({ fichier: item.file.name, ...info });
        assert.match(
          item.statusText || '',
          new RegExp(`mode ${scenario.attendu}`),
          `${scenario.nom} : l utilisateur voit le mode PENDANT l import : « ${item.statusText} »`,
        );
      }
      await fin;

      assert.equal(item.status, 'success', `${scenario.nom} : l import aboutit`);
      assert.match(item.statusText, new RegExp(`mode ${scenario.attendu}`), `${scenario.nom} : et le mode reste affiche apres l import : « ${item.statusText} »`);
    } finally {
      journaux.restaurer();
      globalThis.window = windowAvant;
    }
  }
});

test('le repli REPREND la jauge a zero, et un echec ne laisse pas une barre pleine', async () => {
  // Mesure par la revue finale : quand l index echoue et que le flux prend le relais, la
  // barre RECULE — l utilisateur la voit arriver a 100 %, retomber, puis grimper pendant 12 s.
  // Les deux chemins ecrivent pourtant la MEME PROMESSE de progression, et c est ce qui rend le
  // retour illisible : seul le chemin flux annonce des OCTETS (`bytes: true`), et il le fait
  // APRES avoir annonce des entrees. Cet ordre-la est donc la signature du repli, et c est la
  // seule que le renderer voie : la reponse du main process ne rend qu a la fin.
  //
  // Et en cas d echec final, une barre a 100 % avec le statut « error » se lit comme un
  // succes. Un import qui n a rien produit ne doit pas afficher de progression.
  const { archive } = archiveComplete();
  const charge = JSON.parse(JSON.stringify(aplatitPackagePourIpc(await importViaIndex(fileFromBlob(archive, 'p.zip'), {}))));
  const { PackageManager } = await chargerRenderer();

  // --- LE REPLI ---------------------------------------------------------------
  // La reponse est un interrupteur : le repli se produit DANS le main process, et le
  // renderer n en apprend l existence que par l ordre des evenements de progression.
  let reponse = { success: true, package: charge, mode: 'stream', reason: 'repertoire central illisible' };
  const progres = [];
  const windowAvant = globalThis.window;
  globalThis.window = {
    electronAPI: {
      importPackage: async () => reponse,
      onImportPackageProgress: cb => { progres.push(cb); return () => { progres.length = 0; }; },
    },
  };
  try {
    const manager = new PackageManager(zoneMinimale());
    const item = { file: fichierDeTest(archive), status: 'queued', percent: 0, startedAt: 0 };
    manager.queue.push(item);

    const fin = manager.importQueueItem(item);
    // Soixante secondes de travail perdu : sans remise a zero de l horodatage, l ETA du
    // second passage les compterait et annoncerait des minutes pour un passage qui en
    // dure un quart de seconde. C est le meme defaut, dans une autre figure.
    item.startedAt = Date.now() - 60_000;
    // Le passage par index, monte dans les 70 % de l extraction.
    progres[0]({ fichier: item.file.name, current: 20, total: 20, stage: 'Lecture des entrees utiles', bytes: false });
    assert.ok(item.percent >= 90, `le passage par index doit aller au bout de sa phase : ${item.percent} %`);

    // LE SECOND PASSAGE. Sans remise a zero, la jauge reculerait d ici a ~0 %.
    progres[0]({ fichier: item.file.name, current: 1, total: 394105000, stage: 'Lecture du ZIP', bytes: true });
    assert.ok(item.percent <= 1, `la jauge doit REPARTIR, pas reculer : ${item.percent} %`);
    progres[0]({ fichier: item.file.name, current: 197052500, total: 394105000, stage: 'Lecture du ZIP', bytes: true });
    assert.ok(item.percent > 1 && item.percent <= 30, `le second passage occupe son tiers : ${item.percent} %`);
    assert.doesNotMatch(item.statusText, /min \d+ s restantes/, `l ETA ne doit pas compter le passage mort : « ${item.statusText} »`);

    await fin;
    assert.equal(item.status, 'success', 'l import aboutit');
    assert.equal(item.percent, 100, 'et la barre est pleine a la fin');

    // --- L ECHEC FINAL --------------------------------------------------------
    // Meme item, meme jauge a 100 %, puis un echec : ce que l utilisateur voit.
    reponse = { success: false, error: 'Fichier illisible' };
    const item2 = { file: fichierDeTest(archive), status: 'queued', percent: 0, startedAt: 0 };
    manager.queue.push(item2);
    const fin2 = manager.importQueueItem(item2);
    progres[0]({ fichier: item2.file.name, current: 20, total: 20, stage: 'Lecture des entrees utiles', bytes: false });
    assert.ok(item2.percent >= 90, 'la jauge est pleine juste avant l echec');
    await fin2;

    assert.equal(item2.status, 'error', `l import echoue : « ${item2.statusText} »`);
    assert.equal(item2.percent, 0, `une barre pleine a cote d « error » se lit comme un succes : ${item2.percent} %`);
    assert.match(item2.statusText, /illisible/i, `et le motif reste affiche : « ${item2.statusText} »`);
  } finally {
    globalThis.window = windowAvant;
  }
});

test('un ecart de taille est un ECHEC FRANC cote renderer : statut d erreur, et rien d enregistre', async () => {
  // Le bout qui manque au test du service. `importArchiveDepuisChemin` renvoie
  // bien un echec sans `fallbackToRenderer` — et c'est `PackageManager.readPackage`
  // qui decide de ce que cela devient. Sans ce test, une evolution de la
  // reponse du service (un `fallbackToRenderer` ajoute, un `success` passe a
  // true) resterait verte ici : le seul test qui regardait le repli affirmait
  // qu'il DEVAIT y avoir repli, donc il verrouillait le bug.
  //
  // Ce qui est mesure : le statut de l'item, le texte affiche a l'utilisateur, et
  // l'absence de toute ecriture. Le warn de `savePackageArchive` sert de temoin —
  // en Node, sans IndexedDB, il echoue et le signale ; son absence prouve
  // qu'aucune archive n'a ete enregistree.
  const dossier = dossierJetable();
  try {
    const archive = archiveDeParite();
    const chemin = join(dossier, 'package.zip');
    writeFileSync(chemin, archive);

    // Le main process refuse, SANS repli. On capture sa reponse REELLE plutot
    // que de la recopier : le test lie alors les deux moities du contrat.
    const refus = await importArchiveDepuisChemin({ chemin, nom: 'package.zip', taille: archive.length - 1 }, {});
    assert.equal(refus.fallbackToRenderer, undefined, 'premiere preuve : le service ne renvoie pas de repli');

    const { PackageManager } = await chargerRenderer();
    const windowAvant = globalThis.window;
    globalThis.window = {
      electronAPI: {
        importPackage: async () => refus,
        onImportPackageProgress: () => () => {},
      },
    };
    const journaux = capturerJournaux();
    try {
      const manager = new PackageManager(zoneMinimale());
      const item = { file: fichierDeTest(archive), status: 'queued', percent: 0, startedAt: 0 };
      manager.queue.push(item);
      await manager.importQueueItem(item);

      assert.equal(item.status, 'error', `un fichier remplace ne doit pas finir « succes » : « ${item.statusText} »`);
      assert.match(item.statusText, /taille/i, `et l utilisateur voit POURQUOI : « ${item.statusText} »`);
      assert.equal(/annul/i.test(item.statusText), false, `ce n'est pas une annulation : « ${item.statusText} »`);
      assert.equal(manager.package, null, 'aucun paquet n est charge');
      assert.equal(
        journaux.captured.warn.some(ligne => ligne.includes('Unable to persist package archive')),
        false,
        `rien ne doit etre enregistre : le fichier REMPLACE deviendrait un import valide au redemarrage. Journaux : ${JSON.stringify(journaux.captured.warn)}`,
      );
    } finally {
      journaux.restaurer();
      globalThis.window = windowAvant;
    }
  } finally {
    rmSync(dossier, { recursive: true, force: true });
  }
});

test('une annulation venue du main process ne devient ni un succes, ni une archive enregistree', async () => {
  const { PackageManager } = await chargerRenderer();
  const windowAvant = globalThis.window;
  globalThis.window = {
    electronAPI: {
      importPackage: async () => ({
        success: false,
        cancelled: true,
        mode: 'index',
        reason: 'Unrecognized Discord package: user.json is missing.',
      }),
    },
  };
  const journaux = capturerJournaux();
  try {
    const manager = new PackageManager(zoneMinimale());
    const item = { file: fichierDeTest(archiveDeParite()), status: 'queued', percent: 0, startedAt: 0 };
    manager.queue.push(item);
    await manager.importQueueItem(item);

    assert.equal(item.status, 'error', `une annulation n est pas un succes : « ${item.statusText} »`);
    assert.match(item.statusText, /annul/i, `et le texte la distingue d un echec d archive : « ${item.statusText} »`);
    assert.equal(manager.package, null, 'aucun paquet n est charge');
    assert.equal(
      journaux.captured.warn.some(ligne => ligne.includes('Unable to persist package archive')),
      false,
      `rien ne doit etre enregistre : un paquet partiel ecrit en base serait relu comme un import complet. Journaux : ${JSON.stringify(journaux.captured.warn)}`,
    );
  } finally {
    journaux.restaurer();
    globalThis.window = windowAvant;
  }
});

test('un echec du main process affiche le motif du chemin qui a echoue', async () => {
  // Les DEUX motifs ne se ressemblent pas : « Unable to read ZIP archive: … »
  // quand l'archive est illisible, « Unrecognized Discord package: user.json
  // is missing. » quand il manque une entree. C'est le `error` — le motif de la
  // DERNIERE tentative — qui s'affiche, et le `reason` (echec de l'index) qui
  // reste dans le journal. Les confondre afficherait un motif qui ne decrit pas
  // ce qui s'est passe.
  const { PackageManager } = await chargerRenderer();
  const windowAvant = globalThis.window;
  globalThis.window = {
    electronAPI: {
      importPackage: async () => ({
        success: false,
        mode: 'stream',
        reason: 'entree Compte/user.json : hors du fichier a son offset local',
        error: 'Unrecognized Discord package: user.json is missing.',
      }),
    },
  };
  const journaux = capturerJournaux();
  try {
    const manager = new PackageManager(zoneMinimale());
    const item = { file: fichierDeTest(archiveDeParite()), status: 'queued', percent: 0, startedAt: 0 };
    manager.queue.push(item);
    await manager.importQueueItem(item);

    assert.equal(item.status, 'error');
    assert.equal(item.statusText, 'Unrecognized Discord package: user.json is missing.', 'c est le motif du chemin qui a echoue qui s affiche, pas celui de l index');
  } finally {
    journaux.restaurer();
    globalThis.window = windowAvant;
  }
});

// --- Seconde passe de revue : ce que l UTILISATEUR RECOIT ----------------------
//
// Tout ce qui précède testait des COMPOSANTS : le classement, l'ouverture, la
// parité des deux chemins. La seule ligne qui décide de ce que l'utilisateur
// reçoit — « y a-t-il un paquet, ou pas ? » — n'était dans aucun test : elle
// vivait dans le corps d'un handler de `main.cjs`, que la suite ne peut pas
// exécuter. Le test de convention du fichier ne voyait que six REGEX sur le
// texte source : une dérive de noms, pas un comportement.
//
// Trois trous, trois tests, et chacun se prouve par la mutation qu'il interdit.
//
// 1. LE PAQUET SANS CONTENU. La forme qui rendrait `{ messages: {} }` n'est pas
//    le paquet NUL : l'aplatissement REFUSE le nul (il leve), donc
//    `buildImportResponse({ package: {} })` est la forme reellement dangereuse —
//    elle passe la garde de presence, et donne exactement une Map VIDE que le
//    renderer hydrate, que `importQueueItem` enregistre avec sa version de schema,
//    et qui sera relue comme un import valide au redemarrage. Le test tranche
//    l'invariant (presence, pas contenu) et dit POURQUOI il est tenable.
// 2. LE MAIN PROCESS FIGE. Le chemin flux rend la main a chaque bloc de 4 Mio
//    (`src/services/packageImporter.service.js:367`) ; le chemin par défaut,
//    lui, n'avait AUCUN point de rendement.
// 3. LA TAILLE ANNONCEE. Le renderer envoyait `taille`, le main process ne la
//    lisait pas, et ouvrait le fichier du chemin sans rien comparer.

test('un paquet nul n est JAMAIS presente comme un succes, et ne produit aucun paquet a persister', () => {
  // Les DEUX etats sans paquet, un par un. `cancelled` distingue l'annulation de
  // l'echec d'archive, et les deux doivent aboutir au meme refus : c'est ce qui
  // empeche `PackageManager.importQueueItem` de poser `schemaVersion` et
  // d'ENREGISTRER le resultat.
  const annule = buildImportResponse({ package: null, mode: 'index', reason: 'Unrecognized Discord package: user.json is missing.', cancelled: true, error: null });
  assert.equal(annule.success, false, 'une annulation n est pas un succes');
  assert.equal(annule.cancelled, true, 'et le verdict reste lisible : `cancelled` porte la decision');
  assert.equal(annule.package, null, 'aucun paquet, meme partiel, meme complet, meme vide');
  assert.equal(annule.fallbackToRenderer, undefined, 'et pas de repli : le chemin local ramenerait le meme etat');
  assert.equal(annule.mode, 'index');
  assert.equal(annule.reason, 'Unrecognized Discord package: user.json is missing.', 'la raison de l annulation est conservee');

  const echec = buildImportResponse({ package: null, mode: 'stream', reason: 'entree Compte/user.json : hors du fichier a son offset local', cancelled: false, error: 'Unrecognized Discord package: user.json is missing.' });
  assert.equal(echec.success, false, 'un echec du dernier chemin n est pas un succes');
  assert.equal(echec.cancelled, false);
  assert.equal(echec.package, null, 'et il ne porte pas de paquet non plus');
  assert.equal(echec.error, 'Unrecognized Discord package: user.json is missing.', 'le motif affiche est celui de la DERNIERE tentative');

  // La MUTATION que ce test interdit (« `success: true` inconditionnel »), et ce
  // qu'elle produirait reellement — MESURE, et non suppose. Sur un paquet NUL,
  // l'aplatissement REFUSE aujourd'hui : sans garde, l'appel leve, le handler
  // renvoie `fallbackToRenderer`, et l'utilisateur ne voit rien de faux. C'est un
  // accident de forme (`paquet.messages` sur `null`), pas une regle : il disparait
  // des la premiere edition tolerante de l'aplatissement, et il n'est la que par
  // la raison ci-dessous.
  let aplati = 0;
  const annuleSansGarde = buildImportResponse({ package: null, mode: 'index', reason: 'x', cancelled: true, error: null }, paquet => { aplati += 1; return { messages: {} }; });
  assert.equal(aplati, 0, `sans paquet, l'aplatissement n'est meme pas tente : ${aplati} appel(s)`);
  assert.equal(annuleSansGarde.success, false, 'et le resultat reste un echec');
  assert.throws(() => aplatitPackagePourIpc(null), /paquet nul/, 'un paquet nul est REFUSE explicitement, pas transforme en objet vide');
  assert.throws(() => aplatitPackagePourIpc(undefined), /paquet nul/);

  // La forme reellement Dangereuse est celle d'un paquet VRAI mais SANS CONTENU :
  // il passe la garde, et donne exactement `{ messages: {} }` — une Map vide cote
  // renderer, que `importQueueItem` enregistre avec sa version de schema, et qui
  // sera relu comme un import valide au redemarrage.
  assert.deepEqual(aplatitPackagePourIpc({}), { messages: {} }, 'la forme que prend un paquet sans messages : une Map vide cote renderer');

  // L'INVARIANT TRANCHE : la garde porte sur la PRESENCE, pas sur le contenu, et
  // `{ package: {} }` est donc un SUCCES. Ce n'est pas un oubli — c'est la seule
  // definition tenable, et ce test la dit au lieu d'asserter `{ messages: {} }`
  // comme un contrat. Les deux raisons, qui sont mesurables :
  //
  //   (a) le paquet sans `user` est INATTEIGNABLE par les deux chemins de
  //       production, qui leveraient avant de rendre quoi que ce soit. C'est le
  //       test suivant qui le prouve, sur une archive reelle, pas une affirmation.
  //   (b) refuser un paquet « vide » casserait le cas LEGITIME « un compte, zero
  //       message », que le test d apres construit et exige comme succes.
  const sansContenu = buildImportResponse({ package: {}, mode: 'index', reason: null, cancelled: false, error: null });
  assert.equal(sansContenu.success, true, 'la garde est une garde de PRESENCE : un objet vide la traverse');
  assert.deepEqual(sansContenu.package, { messages: {} }, 'et ce qu il produit est dit ICI, comme un fait constate — pas comme un contrat desirable');
});

test('un paquet sans `user` est INATTEIGNABLE : les deux chemins lèvent sur son absence', async () => {
  // Ce qui rend la garde de PRESENCE tenable (raison (a) ci-dessus). Les deux
  // chemins de production construisent leur paquet par `assemble`, qui leve sur
  // l'absence de `Compte/user.json`. On le MESURE sur une archive reelle, sans
  // `user.json`, par les DEUX chemins — pas en citant leurs sources.
  const objet = objetDeParite();
  const sansCompte = zipSync(Object.fromEntries(Object.entries(objet).filter(([nom]) => nom !== 'Compte/user.json')));

  // Le chemin par index : le refus vient de `assemble`, donc l'index a bien lu
  // le repertoire central — c'est un refus de CONTENU, pas un echec d'archive.
  await assert.rejects(
    () => importViaIndex(fileFromBlob(sansCompte, 'sans-compte.zip'), {}),
    /user\.json is missing/,
    'le chemin par index refuse une archive sans compte',
  );

  // Le chemin de reference, le meme refus, pour la meme raison.
  await assert.rejects(
    () => cheminFlux(new Blob([sansCompte], { type: 'application/zip' }), {}),
    /user\.json is missing/,
    'et le chemin de reference aussi : les deux partagent `assemble`',
  );

  // Le repli, lui, ne rend RIEN non plus — c'est ce qui fait que l'enveloppe ne
  // peut pas rendre de paquet sans `user` par un autre chemin.
  const repli = await importPackageWithFallback(fileFromBlob(sansCompte, 'sans-compte.zip'), {});
  assert.equal(repli.package, null, `le repli ne fabrique pas de paquet sans compte : ${JSON.stringify(repli)}`);
  assert.match(repli.error, /user\.json is missing/);
});

test('« un compte, zero message » est un import VALIDE : il est rendu, aplati et persiste', () => {
  // La raison (b) : le cas que refuser un paquet « vide » casserait. Il est
  // LEGITIME — un compte exporte qui n'a encore rien ecrit — donc il doit passer
  // la garde, et il doit s'aplatir en un objet dont `messages` est `{}` : une Map
  // VIDE cote renderer est la bonne representation de « zero message », pas un
  // import fantome. Ce qui distingue ce paquet d'un paquet sans `user`, c'est
  // `user` — et c'est `assemble` qui garantit sa presence (raison (a)).
  const paquet = { user: { id: '123', username: 'zero' }, guilds: [], channels: [], messages: new Map(), totalMessages: 0, packageSizeBytes: 42, discarded: { noise: 0, oversized: 0 } };
  const reponse = buildImportResponse({ package: paquet, mode: 'index', reason: null, cancelled: false, error: null });

  assert.equal(reponse.success, true, `un compte sans aucun message est un import reussi : « ${reponse.error} »`);
  assert.equal(reponse.package.user.id, '123', 'le compte traverse');
  assert.deepEqual(reponse.package.messages, {}, 'et zero message est bien une table vide, pas un paquet perdu');
  assert.equal(reponse.package.totalMessages, 0);
});

test('l enveloppe place le paquet sous `package`, et ne rend aucun paquet sur un repli', () => {
  const { archive } = archiveComplete();
  const paquet = { user: { id: '1' }, guilds: [], channels: [], messages: new Map([['1', [{ id: '1' }]]]), totalMessages: 1, packageSizeBytes: archive.length, discarded: { noise: 0, oversized: 0 } };
  const ok = buildImportResponse({ package: paquet, mode: 'index', reason: null, cancelled: false, error: null });
  assert.equal(ok.success, true);
  assert.equal(ok.mode, 'index');
  assert.equal(ok.reason, null);
  assert.equal(ok.package.messages instanceof Map, false, 'ce qui part dans l IPC est un objet plat, pas une Map');
  assert.deepEqual(ok.package.messages, { 1: [{ id: '1' }] });

  // Le repli : le main process ne peut pas importer du tout. L'enveloppe doit le
  // dire SANS transporter de paquet, sinon le renderer aurait deux sources de
  // verite et perdrait son cadre — un paquet vide est un succes.
  const repli = buildImportResponse({ package: null, mode: 'index', reason: 'archive sans entree', cancelled: false, error: 'ERR_MODULE_NOT_FOUND', fallbackToRenderer: true });
  assert.equal(repli.success, false);
  assert.equal(repli.fallbackToRenderer, true, 'le renderer est prevenu qu il doit refaire l import');
  assert.equal(repli.package, null, 'et ne recoit aucun paquet a la place');
  assert.equal(repli.error, 'ERR_MODULE_NOT_FOUND', 'le motif du chargement est conserve tel quel');
});

test('une serialisation qui leve ne rend pas un paquet a moitie construit', () => {
  // Le paquet est deja en memoire, l'import a reussi : une exception de
  // serialisation est un BUG, pas une archive illisible. La reponse doit donc
  // etre un echec — jamais un `success: true` avec une `Map` vide a l arrivee.
  const quiLeve = () => { throw new Error('paquet sans user'); };
  const resultat = buildImportResponse({ package: { messages: new Map() }, mode: 'index', reason: null, cancelled: false, error: null }, quiLeve);
  assert.equal(resultat.success, false, `un echec de serialisation ne se presente pas comme un succes : « ${JSON.stringify(resultat)} »`);
  assert.equal(resultat.package, null);
  assert.equal(resultat.fallbackToRenderer, true, 'et le renderer refait l import : il a la VRAIE archive, lui');
  assert.match(resultat.error, /paquet sans user/);
});

test('le main process rend la main, et le travail avance entre deux points de rendement', async () => {
  // Le chemin flux rend la main a chaque bloc de 4 Mio, delibirement. Sans
  // equivalent ici, les menus natifs, `dialog`, les autres `ipcMain.handle` et
  // les timers axios restent FIGES pendant tout l'import — alors que le renderer,
  // lui, continue de peindre et d'afficher la barre. Le chemin par defaut etait
  // donc moins cooperatif que son propre repli.
  //
  // On mesure deux choses, pas une : (a) qu un point de rendement EST pris, et
  // (b) que du travail se fait ENTRE deux points de rendement. (a) seul
  // prouverait qu on rend la main une fois, a la fin.
  // Deux fois le budget de rendement par entree, donc un point de rendu APRES
  // chacune des trois : c'est ce qui permet d'exiger du travail ENTRE deux points
  // de rendement. Chacune pese 32 Kio sur le disque — c'est ce que la
  // decompression PRODUIT qui compte, et le chemin index ne compte que cela. Le
  // nom importe (`Gros/…` n'est pas un dossier de bruit) et `parseEntry` ne sait
  // rien faire d'un `.txt` : l'entree est donc gardee, ouverte, decompressee,
  // comptee — et jamais parsee, donc le test ne paie pas de JSON de 8 Mio.
  // Les TROIS grosses entrées, puis HUIT petites. La cadence est donc mesurée sur
  // un budget qui n'est PAS un multiple de la taille d'entrée : c'est ce qui
  // distingue « le compteur porte le budget » de « le compteur est remis à zéro ».
  // Une remise à zéro perd le reste de chaque grosse entrée et rend la main deux
  // fois moins souvent ; un budget doublé perd les petits apports. Les deux
  // mutations font tomber le compte SOUS le seuil exigé plus bas, qui est donc
  // choisi avec une marge des deux côtés plutôt qu'égal au minimum de la fixture.
  const bomb = octets => deflateBomb(octets);
  const petites = Array.from({ length: 8 }, (_, i) => ({ nom: `Petit/p${i}.txt`, method: 8, payload: bomb(1.5 * MIO).flux }));
  const archive = zipAvecAjouts(archiveDeParite(), [
    { nom: 'Gros/un.txt', method: 8, payload: bomb(2 * BLOC_DE_LECTURE).flux },
    { nom: 'Gros/deux.txt', method: 8, payload: bomb(2 * BLOC_DE_LECTURE).flux },
    { nom: 'Gros/trois.txt', method: 8, payload: bomb(2 * BLOC_DE_LECTURE).flux },
    ...petites,
  ]);

  const vrai = globalThis.setTimeout;
  const trace = [];
  let rendements = 0;
  globalThis.setTimeout = (fn, delai, ...reste) => { rendements += 1; trace.push('rendement'); return vrai(fn, delai, ...reste); };

  let obtenu;
  try {
    obtenu = await importViaIndex(fileFromBlob(archive, 'p.zip'), { onEntry: nom => trace.push(`entree:${nom}`) });
  } finally {
    globalThis.setTimeout = vrai;
  }

  assert.ok(obtenu?.package || obtenu?.user, `l import doit aboutir : « ${obtenu?.error} »`);
  // Le seuil est au-dessus du minimum de la fixture, et VOLONTAIREMENT : exiger
  // exactement 3 laissait passer une constante portee a 8 Mio (3 gros + 8 petits
  // = 36 Mio produits ne donneraient alors que 4 rendements). Ici la cadence est
  // mesuree sur des apports qui ne tombent pas sur la frontière — un budget double
  // fait tomber le compte, une remise a zero aussi. La borne reste « au plus une
  // fois par entree » : jamais de point de rendement au milieu d'une entree.
  assert.ok(rendements >= 8, `le main process doit rendre la main a chaque budget PRODUIT atteint, cumulativement : ${rendements} points de rendement sur 36 Mio produits`);
  const premier = trace.indexOf('rendement');
  assert.ok(trace.slice(premier).some(evenement => evenement.startsWith('entree:')), `du travail doit se faire APRES un point de rendement, pas seulement avant le premier : ${JSON.stringify(trace)}`);
  assert.ok(trace.slice(0, premier).some(evenement => evenement.startsWith('entree:')), `et avant aussi : ${JSON.stringify(trace)}`);

  // Le point de rendement ne doit rien changer au resultat : la comparaison est
  // faite sur un paquet sans point de rendement et un avec.
  const reference = await importViaIndex(fileFromBlob(archive, 'p.zip'), {});
  comparerMessages(reference.messages, obtenu.messages, 'table des messages apres des points de rendement');
  assert.equal(obtenu.totalMessages, reference.totalMessages, 'et le total de messages est inchange');
  assert.deepEqual(obtenu.discarded, reference.discarded, 'la repartition des jetes est inchangee');
});

test('une petite archive ne paie aucun point de rendement', async () => {
  // La frequence est choisie pour etre gratuite sur une archive modeste : le
  // budget est exprime en octets PRODUITS, pas en entrees. Ce test verrouille ce
  // choix, sinon un « point de rendement par entree » passerait aussi le test
  // precedent et ferait payer un `setTimeout` a chaque entree pour rien.
  const { archive } = archiveComplete();
  const vrai = globalThis.setTimeout;
  let rendements = 0;
  globalThis.setTimeout = (...args) => { rendements += 1; return vrai(...args); };
  try {
    const obtenu = await importViaIndex(fileFromBlob(archive, 'p.zip'), {});
    assert.ok(obtenu.messages instanceof Map, 'l import aboutit');
  } finally {
    globalThis.setTimeout = vrai;
  }
  assert.equal(rendements, 0, `une archive de ${archive.length} octets ne doit rien payer : ${rendements} points de rendement`);
});

test('un module qui ne expose pas la fonction attendue est un echec de CHARGEMENT', async () => {
  // `importDiscordPackage` absent d'un module charge sans erreur : aujourd hui le
  // repli tente de l'appeler, leve `importer is not a function`, et le renderer
  // recoit un echec SANS repli — donc pas de chemin local, et une erreur
  // technique a l'ecran. Un module charge sans la fonction attendue est un
  // echec de chargement, exactement comme un module absent.
  const file = fileFromBlob(new TextEncoder().encode('pas un zip'), 'faux.zip');
  const resultat = await importPackageWithFallback(file, { loadStreamImporter: async () => ({}) });

  assert.equal(resultat.fallbackToRenderer, true, `le renderer doit pouvoir refaire l import : « ${JSON.stringify(resultat)} »`);
  assert.equal(resultat.package, null);
  assert.match(resultat.error, /importDiscordPackage/, `le motif nomme la fonction manquante : « ${resultat.error} »`);
  assert.equal(resultat.cancelled, false);
});

test('un `close` qui leve ne remplace pas le resultat de l import', async () => {
  // Le `finally` du wrapper appelle `close()`. Si ce `close` leve, l exception
  // REMPLACE le resultat : le handler la rattrape, renvoie `fallbackToRenderer`,
  // et le renderer refait l'import — donc le meme import fait DEUX fois. Un
  // descripteur qu on ne parvient pas a fermer est un incident de nettoyage, pas
  // un echec d'import.
  const { archive } = archiveComplete();
  const fichier = fileFromBlob(archive, 'p.zip');
  fichier.close = () => { throw new Error('EBUSY'); };
  const resultat = await importPackageWithFallback(fichier, {});

  assert.ok(resultat.package, `l import doit aboutir malgre le close : « ${JSON.stringify(resultat) }»`);
  assert.equal(resultat.mode, 'index');
  assert.equal(resultat.error, null, `et sans erreur : « ${resultat.error} »`);
  assert.equal(resultat.cancelled, false);
});

test('la taille annoncee par le renderer est comparee a la taille reellement ouverte', async () => {
  // Le renderer envoie `taille`, et le main process ne la lisait pas : il
  // ouvrait le fichier du chemin annonce sans rien comparer. Un fichier remplace
  // entre la selection et l'ouverture etait donc importe sans que rien ne le
  // signale, alors que la file avait enregistre le nom et la taille de celui que
  // l'utilisateur avait choisi. `taille` etait un parametre mort qui avait
  // l'air protege.
  const dossier = dossierJetable();
  try {
    const archive = archiveDeParite();
    const chemin = join(dossier, 'package.zip');
    writeFileSync(chemin, archive);

    // La valeur annoncee ET la valeur reelle : c'est la seule comparaison qui
    // distingue « le fichier que vous avez choisi » de « le fichier qui est la ».
    const bon = await importArchiveDepuisChemin({ chemin, nom: 'package.zip', taille: archive.length }, {});
    assert.equal(bon.success, true, `l archive choisie doit s importer : « ${bon.error} »`);
    assert.ok(bon.package, 'et rendre un paquet');
    assert.equal(bon.package.messages instanceof Map, false, 'aplati pour le fil');

    // Le fichier a change entre la selection et l'ouverture, et le refus est FRANC.
    // `fallbackToRenderer` est ce qui rendrait l'import « reussi » : le renderer
    // relirait `item.file`, dont le CHEMIN est celui qu'on vient de refuser, et
    // enregistrerait le fichier remplace avec sa version de schema. Sans lui,
    // `readPackage` leve, l'IHM affiche le motif, et rien n'est persiste.
    const change = await importArchiveDepuisChemin({ chemin, nom: 'package.zip', taille: archive.length - 1 }, {});
    assert.equal(change.success, false, 'un fichier d une autre taille ne s importe pas comme si de rien n etait');
    assert.equal(change.package, null, 'sans aucun paquet');
    assert.equal(change.cancelled, false, `et ce n'est pas une annulation : « ${JSON.stringify(change)} »`);
    assert.equal(change.fallbackToRenderer, undefined, 'SANS repli : le renderer relirait le meme chemin, donc le fichier REMPLACE, et le marquerait reussi');
    assert.match(change.error, /taille/i, `en disant pourquoi : « ${change.error} »`);
    // Le message ne se repete pas : « annonce » y etait deux fois (« taille
    // annoncee 6294555 octets annonces, 6294556 trouvees »).
    assert.equal(change.error, `Fichier modifie depuis sa selection : taille ${archive.length - 1} annonces, ${archive.length} trouvees.`, `un motif sans redondance, au caractere pres : « ${change.error} »`);
    assert.equal((change.error.match(/annonc/gi) || []).length, 1, `« annonce » n apparait qu UNE fois dans le motif : « ${change.error} »`);

    // Aucun chemin : rien a ouvrir, donc rien a comparer. Le repli se fait sans
    // message d'IPC cote main.
    const sansChemin = await importArchiveDepuisChemin({ nom: 'package.zip', taille: archive.length }, {});
    assert.equal(sansChemin.success, false);
    assert.equal(sansChemin.fallbackToRenderer, true, 'un fichier sans chemin retombe sur le chemin local');

    // Un fichier absent : ce n'est pas l'archive qui est illisible, donc le
    // renderer garde la main, comme avant.
    const absent = await importArchiveDepuisChemin({ chemin: join(dossier, 'absent.zip'), nom: 'absent.zip', taille: 10 }, {});
    assert.equal(absent.success, false);
    assert.equal(absent.fallbackToRenderer, true, 'un fichier absent ne se presente pas comme une archive illisible');
    assert.match(absent.error, /illisible/i);

    // La comparaison, seule, sur les cas qui la interessent : une valeur absente
    // ou non finie n'est pas une declaration, donc elle ne peut pas faire refus.
    assert.equal(ecartTailleAnnonce(archive.length, archive.length), null, 'la valeur exacte ne refuse rien');
    assert.equal(ecartTailleAnnonce(undefined, archive.length), null, 'rien d annonce n est un controle impossible, pas un echec');
    assert.equal(ecartTailleAnnonce(0, archive.length), null, 'et 0 n est pas une taille annoncee');
    assert.ok(ecartTailleAnnonce(archive.length - 1, archive.length), 'un ecart est nomme');
  } finally {
    rmSync(dossier, { recursive: true, force: true });
  }
});

test('la progression est ROUTEE sur le nom du fichier demande, et la cle de routage passe en dernier', async () => {
  // `{ fichier: nom, ...info }` : le spread vient APRÈS, donc un `info.fichier`
  // — que le renderer n'a pas inventé, mais qu'un jour une phase pourrait
  // porter — ecraserait la cle de routage, et la jauge d'une archive se
  // remplirait avec la progression d'une autre. La cle de routage se pose donc
  // en DERNIER, et le test le prouve en injectant un `info.fichier` concurrent.
  const dossier = dossierJetable();
  try {
    const archive = archiveDeParite();
    const chemin = join(dossier, 'package.zip');
    writeFileSync(chemin, archive);

    const recues = [];
    const resultat = await importArchiveDepuisChemin({ chemin, nom: 'archive-de-teste.zip', taille: archive.length }, {
      onProgress: info => recues.push(info),
    });

    assert.equal(resultat.success, true, `l import aboutit : « ${resultat.error} »`);
    assert.ok(recues.length > 0, 'le main process publie bien une progression');
    assert.ok(recues.every(info => info.fichier === 'archive-de-teste.zip'), `chaque evenement porte le nom du fichier demande : ${JSON.stringify(recues.slice(0, 2))}`);

    // L'injection promise plus haut : un `info.fichier` concurrent ne doit pas
    // s'imposer. C'est l'ordre des deux ecritures que le test verifie — donc la
    // mutation `{ fichier, ...info }` le rougit.
    const route = routeProgression('archive-de-teste.zip', { fichier: 'autre.zip', current: 1, total: 2, stage: 'x' });
    assert.equal(route.fichier, 'archive-de-teste.zip', 'la cle de routage du nom demande passe EN DERNIER');
    assert.deepEqual(Object.keys(route), ['fichier', 'current', 'total', 'stage'], `et les informations de phase sont conservees : ${JSON.stringify(Object.keys(route))}`);
  } finally {
    rmSync(dossier, { recursive: true, force: true });
  }
});

test('main.cjs ne fait que deleguer : la garde sur le paquet vit dans le service, teste', () => {
  // Le handler de main.cjs ne peut pas etre execute ici — le fichier cree des
  // dossiers et demande le verrou d instance unique des son chargement. Ce qui
  // reste verifiable, et qui se casse independentement, c'est la CONVENTION :
  // un handler qui decide seul de `success: true` reintroduirait exactement la
  // mutation que le test de comportement interdit.
  const main = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');

  assert.match(main, /ipcMain\.handle\('discord:importPackage'/, 'main doit enregistrer le canal de l import');
  assert.match(main, /event\.sender\.send\('discord:importPackage:progress'/, 'main doit publier la progression sur son canal');
  assert.match(main, /importArchiveDepuisChemin\(/, 'main doit deleguer l import entier au service, ou la taille est comparee et le paquet garde');
  // Le BLOC du handler, et non le fichier entier : `main.cjs` a d'autres
  // handlers qui rendent `success: true` legitimement. Ce qui ne doit plus
  // exister ICI, c'est une decision de succes — elle appartient a
  // `buildImportResponse`, qui a un test de comportement.
  const bloc = main.slice(main.indexOf("ipcMain.handle('discord:importPackage'"), main.indexOf('\n});', main.indexOf("ipcMain.handle('discord:importPackage'")) + 4);
  assert.equal(/success:/.test(bloc), false, `le handler ne doit decider de NULLE PART qu un import a reussi : ${bloc.slice(0, 400)}`);
  assert.equal(/aplatitPackagePourIpc\(|serialisePackage\(/.test(bloc), false, 'ni aplatir le paquet lui-meme : la forme du fil appartient au service');
});
