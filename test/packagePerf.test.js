import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// Oracle et fabrique, comme dans test/packageIndex.test.js : ce fichier doit
// pouvoir produire une archive HONNETE, avec des en-tetes qui disent la verite, et
// un contenu de reference independant du code qu'il mesure. Le CRC est calcule
// pour de vrai : une fixture qui ment sur le CRC pourrait passer pour une preuve.
import { crc32 } from 'node:zlib';
import { deflateSync } from '../node_modules/fflate/esm/browser.js';

// Tache 6 : MESURER, et surtout dire ce qu'un test automatique doit verrouiller.
//
// Un export Discord de 394,1 Mo, 667 salons, 27 325 messages, 15 serveurs,
// 347 MP, passait 12 s. Tout le chantier tient dans une seule promesse : ne pas
// decompresser ce que l'outil jette ensuite. Cette tache la mesure.
//
//
// LE PROBLEME QUE LE PLAN NE VOIT PAS
// ====================================
//
// Le plan demande « un test qui echoue si la regression revient, avec un seuil en
// millisecondes ». Ce seuil sera instable, et il cassera chez l'utilisateur pour
// une raison qui n'a rien a voir avec le code : un CI charge, un portable lent, un
// antivirus qui se reveille. Une duree, c'est `travail / vitesse de la machine`, et
// la vitesse n'a pas de borne. Un test qui rouge parce que la machine est lente
// apprend a tout le monde a l'ignorer, et le jour ou il rouge pour une vraie
// raison, plus personne ne regarde.
//
// CE QUI DISTINGUE VRAIMENT UNE REGRESSION D'UNE MACHINE LENTE, c'est le GENRE de
// grandeur qu'on compare, pas sa valeur :
//
//   - un COMPTE d'octets, un NOMBRE de tranches, un NOMBRE d'entrees : la vitesse
//     de la machine n'y entre pas. Si le chemin par index relit 394 Mo au lieu de
//     20, c'est rouge partout, sur n'importe quelle machine, et pour toujours.
//     C'est LA promesse du chantier, et elle est un compte.
//   - un COMPTE de tours de boucle : la vivacite du main process se mesure en
//     tours EFFECTUES, pas en millisecondes (test « le main process n est pas
//     affame »). Zero tour, c'est un main process gele ; un tour, c'est un main
//     process vivant — et les deux se voient sur n'importe quelle machine.
//   - une EGALITE de resultats entre les deux chemins : 667, 27 325, 15, 347, et
//     l'empreinte de chaque salon, de chaque serveur et de chaque message.
//
//   - une DUREE, elle, ne se compare qu'a elle-meme. D'ou le decoupage de ce
//     fichier en deux parties explicites :
//
//     PARTIE 1 — ce que `npm test` rejoue a chaque execution : des grandeurs de
//                COMPTE. Rouge ou vert selon ce que fait le code, jamais selon
//                l'etat de la machine. Secondes, pas minutes.
//     PARTIE 2 — ce que `npm test` ne rejoue PAS : les durees et les pics de
//                memoire, qui ne sont que des RELEVES. Un import de 12 s dans la
//                suite de tous les jours la rendrait inutilisable, et un seuil en
//                millisecondes y remplacerait une garantie par un coup de chance.
//                Ces releves se rejouent sur demande : PERF_MESURE=1, PERF_PIRE=1.
//
// Le plan annonce 470 ms contre 11 363 ms. Ces chiffres venaient d'un rapport, pas
// d'un depot, et aucun script ne les rejouait. Ce fichier EST ce script : il
// produit des chiffres a lui, et il dit ce qu'ils prouvent et ce qu'ils ne
// prouvent pas.

const require = createRequire(import.meta.url);
const { readZipIndex } = require('../electron/zipIndex.cjs');
const { selectEntries, inflateEntry, importViaIndex, importPackageWithFallback, openArchiveReader } = require('../electron/packageImporter.service.cjs');
const { isNoisePath, MAX_ENTRY_BYTES } = require('../electron/packageImporter.rules.cjs');

const MIO = 1024 * 1024;
const CE_PROPRE = fileURLToPath(import.meta.url);

// L'archive reelle. Trois sources, dans cet ordre : la variable d'environnement — qui
// fait AUTORITE, pour qu'un chemin errone se voie dans le SKIP plutot que d'etre
// remplace en silence — puis un emplacement RELATIF AU DEPOT, `data/perf/package.zip`.
// `data/` est deja ignore par le .gitignore du depot (verifie : `git check-ignore -v`),
// donc y deposer une archive de 394 Mio ne peut pas la faire committer, et c est deja la
// ou l application portable ecrit ses donnees. En dernier recours, le chemin du disque de
// l auteur des mesures — d ou la seule valeur en dur qu il restait, et que ce test ne
// peut pas remplacer sans devoir ajouter une regle au .gitignore.
// Son absence fait SKIP les tests de donnees reelles — jamais echouer : une suite qui
// exige le fichier de downloads de l'utilisateur n'est pas une suite, c'est un
// bonus fragile.
const CHEMIN_DEPOSIT = fileURLToPath(new URL('../data/perf/package.zip', import.meta.url));
const CHEMIN_ARCHIVE = process.env.PERF_ARCHIVE
  || (existsSync(CHEMIN_DEPOSIT) ? CHEMIN_DEPOSIT : 'C:\\Users\\Tariq\\Downloads\\package (1).zip');
const ARCHIVE_PRESENTE = existsSync(CHEMIN_ARCHIVE);

// Les releves CLOIS. `npm test` ne les rejoue pas ; voir le bandeau ci-dessus.
const MESURE = process.env.PERF_MESURE === '1';
const PIRE = process.env.PERF_PIRE === '1';
const TAILLE_PIRE = Number(process.env.PERF_PIRE_MIO || MAX_ENTRY_BYTES / MIO) * MIO;

// --- Enfant : un processus isole par releve de PEAK --------------------------
//
// maxRSS ne se mesure pas dans le processus qui vient d'importer : la machine
// virtuelle a deja grandi, le GC a deja rendu la memoire, et le pic est passe.
// Chaque releve tourne donc dans son PROPRE processus, sur UNE seule tache, et
// rend son `process.resourceUsage().maxRSS` — sous Windows, le PIC de la working
// set du processus (verifie : 100, 200, 300, 400, 500 Mio alloues et touches
// rendent 152, 256, 358, 460, 563 Mio). Le REPOS est mesure aussi, pour que le
// chiffre annonce soit une difference et non un total.
const ENFANT = process.env.PERF_ENFANT;
if (ENFANT) {
  await jouerEnfant(JSON.parse(ENFANT));
  process.exit(0);
}

// =============================================================================
// PARTIE 1 — CE QUE LA SUITE VERROUILLE. Des grandeurs de COMPTE.
// =============================================================================

// --- Fabriques ---------------------------------------------------------------

// Un fichier qui COMPTE ses lectures. La plage demandee, pas seulement le
// resultat : c'est la seule chose qui distingue « 20 Mio lus sur 394 » de « 394 Mo
// lus puis jetes ». Un Blob sert de source : ses tranches sont asynchrones, comme
// celles d'un File du renderer.
function fichierCompteur(octets, nom = 'package.zip') {
  const blob = new Blob([octets]);
  const taille = blob.size;
  const tranches = [];
  return {
    name: nom,
    size: taille,
    tranches,
    slice(debut, fin) {
      tranches.push([Number(debut) || 0, fin === undefined || fin === null ? taille : Number(fin)]);
      return blob.slice(debut, fin);
    },
    octetsLus() { return tranches.reduce((total, [d, f]) => total + Math.max(0, Math.min(f, taille) - Math.max(0, d)), 0); },
  };
}

// Le MEME compteur sur le LECTEUR DE PRODUCTION (ouvrirLecteur, dont les lectures
// sont SYNCHRONES). La distinction n'est pas cosmetique et elle decide de la
// validite d'un test : avec un Blob, chaque lecture est une vraie promesse et fait
// donc tourner la boucle a elle seule, si bien qu'un test de vivacite passerait
// meme sans point de rendement. Mesure : sur une archive de 18 Mio produits, un
// compteur de `setImmediate` tourne 177 fois AVEC le point de rendement et ZERO
// fois sans.
function compteurSurLecteur(lecteur) {
  const tranches = [];
  // La fermeture est IDEMPOTENTE, et ce n'est pas un detail : le chemin de
  // production `importPackageWithFallback` ferme le descripteur dans son `finally`
  // (il en est proprietaire), donc un double `close()` leve EBADF. Mesure, pas
  // deduit : c'est ce que fait le test de releve sur l'archive reelle.
  let fermee = false;
  return {
    name: lecteur.name,
    size: lecteur.size,
    tranches,
    close() { if (fermee) return; fermee = true; lecteur.close(); },
    slice(debut, fin) {
      tranches.push([Number(debut) || 0, fin === undefined || fin === null ? lecteur.size : Number(fin)]);
      return lecteur.slice(debut, fin);
    },
    octetsLus() { return tranches.reduce((total, [d, f]) => total + Math.max(0, Math.min(f, lecteur.size) - Math.max(0, d)), 0); },
  };
}

const dossierJetable = () => mkdtempSync(join(tmpdir(), 'perf-import-'));

const ecrireArchive = (dossier, octets, nom = 'package.zip') => {
  const chemin = join(dossier, nom);
  writeFileSync(chemin, octets);
  return chemin;
};

// Un lecteur de production, compte, ouvert et FERME. Un `openArchiveReader` laisse
// un descripteur ouvert sur Windows tant qu'il n'est pas ferme, et le fichier reste
// verrouille : c'est ce que la tache 5 a documente, donc ce fichier s'en charge.
async function avecLecteurCompte(chemin, nom, fn) {
  const lecteur = compteurSurLecteur(await openArchiveReader(chemin, nom));
  try { return await fn(lecteur); } finally { lecteur.close(); }
}

// Bruit blanc reproductible : incompressible, donc un deflate de niveau 0 en
// ressort a la meme taille — ce qui est precisement le pire cas MEMOIRE du chemin
// par index, qui tient les octets compresses pendant qu'il produit sa sortie.
function incompressible(taille) {
  const out = new Uint8Array(taille);
  let graine = 2463534242;
  for (let i = 0; i < taille; i += 1) {
    graine ^= graine << 13; graine ^= graine >>> 17; graine ^= graine << 5;
    out[i] = graine & 0xff;
  }
  return out;
}

// Un contenu de `taille` octets qui se COMPRESSE : la fixture pese peu en disque
// tout en PRODUISANT la taille voulue, et c'est le budget de rendement qui compte
// les octets produits. C'est une tuile de bruit de 4 Kio repetee, pas des zeros :
// la tuile doit tenir dans la FENETRE de deflate (32 Kio), sinon aucune repetition
// n'est visible et rien ne se compresse — mesure : une tuile de 64 Kio sur 5 Mio
// ressort a 5,24 Mio, soit 0 % de gain. Avec 4 Kio, 5 Mio ressortent a 35 Kio,
// et la fabrication reste rapide (54 ms).
function compressible(taille) {
  const tuile = incompressible(4 * 1024);
  const out = new Uint8Array(taille);
  for (let at = 0; at < taille; at += tuile.length) out.set(tuile.subarray(0, Math.min(tuile.length, taille - at)), at);
  return out;
}

const encodeur = new TextEncoder();
const decodeur = new TextDecoder();

// Une entree d'archive. `methode` 0 pour du STOCE, 8 pour du DEFLATE. Le contenu
// est compresse ICI, une fois, au niveau demande — et le niveau 0 donne un flux
// deflate HONNETE dont la taille compressee vaut la production (des blocs STORED),
// ce qui est le pire cas du chemin par index : il tient les octets compresses
// pendant qu'il produit sa sortie.
function entreeDeflate(nom, contenu, niveau = 6) {
  return { nom, methode: 8, contenu, charge: deflateSync(contenu, { level: niveau }) };
}

function entreeStockee(nom, contenu) {
  return { nom, methode: 0, contenu, charge: contenu };
}

// L'archive honnete, ecrite OCTET PAR OCTET.
//
// Pas `zipSync` : mesure, il overflow la pile au-dela de quelques centaines
// d'entrees (RangeError dans `fltn`), et la fixture de forme reelle en compte
// 1 400. Pas non plus parce qu'il ecrit toujours en deflate et qu'il faut un cas
// STOCE. Les en-tetes locaux ET centraux disent la verite, CRC compris : une
// fixture qui ment sur le CRC, ou dont l'offset local ne vaut pas la position
// reelle de son en-tete, pourrait passer pour une preuve alors qu'on mesure autre
// chose. Le drapeau UTF-8 (bit 11) est pose sur les deux en-tetes des noms non
// ASCII, comme le fait un vrai archiveur et comme le porte l'export reel (mesure :
// le drapeau est pose sur les 18 noms non ASCII de l'archive reelle).
function archiveHonente(entrees) {
  const morceaux = [];
  const centraux = [];
  let at = 0;
  for (const entree of entrees) {
    const octetsNom = encodeur.encode(entree.nom);
    const crc = crc32(entree.contenu) >>> 0;
    const drapeau = octetsNom.some(octet => octet >= 0x80) ? 0x0800 : 0;

    const local = new Uint8Array(30 + octetsNom.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, drapeau, true);
    lv.setUint16(8, entree.methode, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, entree.charge.length, true);
    lv.setUint32(22, entree.contenu.length, true);
    lv.setUint16(26, octetsNom.length, true);
    local.set(octetsNom, 30);

    const central = new Uint8Array(46 + octetsNom.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, drapeau, true);
    cv.setUint16(10, entree.methode, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, entree.charge.length, true);
    cv.setUint32(24, entree.contenu.length, true);
    cv.setUint16(28, octetsNom.length, true);
    cv.setUint32(42, at, true);
    central.set(octetsNom, 46);

    centraux.push(central);
    morceaux.push(local, entree.charge);
    at += local.length + entree.charge.length;
  }

  const corpsCentral = concat(centraux);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 1, true);
  ev.setUint16(10, entrees.length, true);
  ev.setUint32(12, corpsCentral.length, true);
  ev.setUint32(16, at, true);
  const archive = concat([...morceaux, corpsCentral, eocd]);

  // AFFIRMATION APRES CONTROLE, DANS L'ARCHIVE : sans elle, une erreur d'offset
  // local passerait pour un succes, puisque les octets lus seraient ceux d'une
  // AUTRE entree — donc plausibles.
  const relu = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  let curseur = 0;
  for (const entree of entrees) {
    const tailleNom = encodeur.encode(entree.nom).length;
    assert.equal(relu.getUint32(curseur, true), 0x04034b50, `signature locale de ${entree.nom}`);
    assert.equal(relu.getUint32(curseur + 18, true), entree.charge.length, `taille compressee locale de ${entree.nom}`);
    assert.equal(relu.getUint32(curseur + 22, true), entree.contenu.length, `taille decompressee locale de ${entree.nom}`);
    curseur += 30 + tailleNom + entree.charge.length;
  }
  return archive;
}

function concat(morceaux) {
  const out = new Uint8Array(morceaux.reduce((total, m) => total + m.length, 0));
  let at = 0;
  for (const m of morceaux) { out.set(m, at); at += m.length; }
  return out;
}

// Le paquet sous une FORME canonique, puis une empreinte. Comparer deux chemins sur
// un compteur de messages ne prouve pas qu'ils ont vu le meme contenu : ici chaque
// salon, chaque serveur et chaque message entrent dans le hachage, donc le moindre
// ecart de nom, d'ordre ou d'identifiant le change.
function empreinteDuPaquet(paquet) {
  const md = createHash('sha256');
  const parId = (a, b) => String(a && a.id).localeCompare(String(b && b.id));
  md.update(JSON.stringify({
    user: paquet.user,
    totalMessages: paquet.totalMessages,
    packageSizeBytes: paquet.packageSizeBytes,
    discarded: paquet.discarded,
    guilds: [...paquet.guilds].sort(parId),
    channels: [...paquet.channels].sort(parId),
  }));
  for (const cle of [...paquet.messages.keys()].sort()) {
    md.update(`\n${cle}:`);
    md.update(JSON.stringify(paquet.messages.get(cle)));
  }
  return md.digest('hex');
}

// Le premier ecart entre deux paquets, NOMME. Sans lui, deux empreintes
// differentes ne disent pas OU — et la revue de la tache 5 a deja montre qu'un
// mecanisme d'ecart peut etre l'inverse de ce qu'on croit (`aplatitPackagePourIpc`
// LEVE sur un paquet nul, il ne rend pas { messages: {} }).
function premierEcart(attendu, obtenu, chemin = '') {
  if (attendu === obtenu) return null;
  if (attendu instanceof Map || obtenu instanceof Map) {
    const cles = [...new Set([...(attendu instanceof Map ? attendu.keys() : []), ...(obtenu instanceof Map ? obtenu.keys() : [])])].sort();
    if (cles.length !== (attendu instanceof Map ? attendu.size : obtenu.size)) return `${chemin || 'messages'} : ${attendu.size} tables contre ${obtenu.size}`;
    for (const cle of cles) {
      const ecart = premierEcart(attendu.get(cle), obtenu.get(cle), `${chemin || 'messages'}[${cle}]`);
      if (ecart) return ecart;
    }
    return null;
  }
  if (Array.isArray(attendu) || Array.isArray(obtenu)) {
    if (!Array.isArray(attendu) || !Array.isArray(obtenu)) return `${chemin || 'racine'} : ${Array.isArray(attendu) ? 'tableau' : typeof attendu} contre ${Array.isArray(obtenu) ? 'tableau' : typeof obtenu}`;
    if (attendu.length !== obtenu.length) return `${chemin} : ${attendu.length} elements contre ${obtenu.length}`;
    for (let i = 0; i < attendu.length; i += 1) {
      const ecart = premierEcart(attendu[i], obtenu[i], `${chemin}[${i}]`);
      if (ecart) return ecart;
    }
    return null;
  }
  if (attendu && obtenu && typeof attendu === 'object' && typeof obtenu === 'object') {
    for (const cle of [...new Set([...Object.keys(attendu), ...Object.keys(obtenu)])].sort()) {
      const ecart = premierEcart(attendu[cle], obtenu[cle], chemin ? `${chemin}.${cle}` : cle);
      if (ecart) return ecart;
    }
    return null;
  }
  return `${chemin || 'racine'} : ${JSON.stringify(attendu)} contre ${JSON.stringify(obtenu)}`;
}

// Les positions de chaque enregistrement du repertoire central, par nom. Le test
// doit pouvoir PATCHER le central, et le seul moyen de trouver un enregistrement
// est de le parcourir — independamment du module teste, donc avec la seule
// longueur des champs variables.
function enregistrementsCentraux(octets) {
  const vue = new DataView(octets.buffer, octets.byteOffset, octets.byteLength);
  let eocd = -1;
  for (let at = octets.length - 22; at >= 0; at -= 1) {
    if (vue.getUint32(at, true) === 0x06054b50) { eocd = at; break; }
  }
  assert.ok(eocd >= 0, 'l archive de test doit contenir un EOCD');
  const debut = vue.getUint32(eocd + 16, true);
  const taille = vue.getUint32(eocd + 12, true);
  const total = vue.getUint16(eocd + 10, true);
  const enregistrements = [];
  let at = debut;
  for (let i = 0; i < total && at + 46 <= eocd; i += 1) {
    assert.equal(vue.getUint32(at, true), 0x02014b50, `signature centrale a l enregistrement ${i}`);
    const nom = vue.getUint16(at + 28, true);
    const extra = vue.getUint16(at + 30, true);
    const commentaire = vue.getUint16(at + 32, true);
    enregistrements.push({
      nom: decodeur.decode(octets.subarray(at + 46, at + 46 + nom)),
      debut: vue.getUint32(at + 42, true),
      tailleNom: nom,
      tailleExtra: extra,
      compressedSize: vue.getUint32(at + 20, true),
      uncompressedSize: vue.getUint32(at + 24, true),
      method: vue.getUint16(at + 10, true),
      at,
    });
    at += 46 + nom + extra + commentaire;
  }
  return { debut, taille, eocd, enregistrements };
}

// La sentinelle ZIP64 : 0xFFFFFFFF sur compressedSize ET uncompressedSize, ce que
// porte l'entree de 4 096 Mio du vrai export (mesure : 0xFFFFFFFF sur ses deux
// champs). Elle est ecartee avant toute lecture, donc ce test ne prouve pas que le
// chemin par index la REFUSE — il prouve qu'il ne la LIT PAS, ce qui est la seule
// chose qui compte pour le memoire et pour le temps.
function patcherSentinelleZip64(octets, nom) {
  const { enregistrements } = enregistrementsCentraux(octets);
  const cible = enregistrements.find(e => e.nom === nom);
  assert.ok(cible, `l archive doit contenir ${nom} : ${enregistrements.map(e => e.nom).join(', ')}`);
  const vue = new DataView(octets.buffer, octets.byteOffset, octets.byteLength);
  vue.setUint32(cible.at + 20, 0xffffffff, true);
  vue.setUint32(cible.at + 24, 0xffffffff, true);
  return octets;
}

// La plage d'octets qu'une entree occupe dans le fichier : en-tete local et
// donnees. C'est ce dont on doit demontrer qu'il n'est JAMAIS lu. Un test qui ne
// verifierait que le NOM de l'entree passerait pour une preuve alors que le chemin
// testerait a cote.
//
// Les tailles sont lues dans l'EN-TETE LOCAL, pas dans le central, et c'est
// indispensable : l'entree qui porte la sentinelle y annonce 0xFFFFFFFF, donc sa
// « plage » d'apres le central couvrirait 4 Gio,avalerait le repertoire central
// lui-meme, et le controle ne prouverait plus rien. L'en-tete local, lui, dit la
// verite — c'est lui que `localHeaderOffset` ouvrirait si l'entree passait le tri.
function plageReelle(octets, entreeCentral) {
  const vue = new DataView(octets.buffer, octets.byteOffset, octets.byteLength);
  const debut = entreeCentral.debut;
  assert.equal(vue.getUint32(debut, true), 0x04034b50, `signature locale de ${entreeCentral.nom}`);
  const tailleNom = vue.getUint16(debut + 26, true);
  const tailleExtra = vue.getUint16(debut + 28, true);
  const compresse = vue.getUint32(debut + 18, true);
  return { nom: entreeCentral.nom, debut, fin: debut + 30 + tailleNom + tailleExtra + compresse };
}

// Ce que le chemin par index a le droit de lire, en tranches et en octets, calcule
// DEPUIS L'ARCHIVE et non depuis le module teste : la fenetre de fin (65 536 + 22,
// la taille exacte que zipIndex lit), le repertoire central, puis l'en-tete local et
// les donnees de chaque entree gardee. C'est l'oracle des comptes : un egalite, donc
// une regression de lecture le fait rougir.
const TAILLE_FENETRE_FIN = 65536 + 22;
function expectedReads(octets, tailleCentral, enregistrements, nomsGardes) {
  let octetsAttendus = Math.min(TAILLE_FENETRE_FIN, octets.length) + tailleCentral;
  let tranches = 2;
  for (const entree of enregistrements) {
    if (!nomsGardes.has(entree.nom)) continue;
    octetsAttendus += 30 + entree.tailleNom + entree.tailleExtra + entree.compressedSize;
    tranches += 2;
  }
  return { tranches, octets: octetsAttendus };
}

// Le nombre de points de rendement que le budget annonce pour une suite de tailles
// PRODUITES, dans l'ordre du repertoire central.
//
// Deux variantes, et les DEUX sont ecrites ici, pas reprises du module : un second
// ecompte doit pouvoir, LUI, dire faux, sinon il ne prouve rien. `report` est le
// comportement voulu — le credit se soustrait, donc une entree qui produit 5 Mio
// pour un budget de 4 Mio laisse 1 Mio de credit. `zero` est la faute classique :
// le compteur est remis a zero, chaque grosse entree perd donc son reliquat, et la
// cadence s'affaiblit sur une archive faite de grosses entrees entrecinees de
// petites. Verifie sur la fixture : 3 points attendus contre 2 — et le mutant
// corresponding produit bien 2.
function rendementsAttendus(taillesProduites, budget, variante = 'report') {
  let credit = 0;
  let compte = 0;
  for (const taille of taillesProduites) {
    credit += taille;
    if (credit >= budget) {
      credit = variante === 'zero' ? 0 : credit - budget;
      compte += 1;
    }
  }
  return compte;
}

// Un compteur de tours de boucle. `setImmediate` et non `setTimeout` : un
// setImmediate s'execute des la prochaine rotation, SANS qu'aucun temps n'ait eu a
// s'ecouler, donc ce qu'il compte est une rotation et non une duree. C'est ce qui
// rend la mesure de vivacite independante de la machine.
function compteurDeTours() {
  const etat = { tours: 0, actif: true };
  const battement = () => { if (!etat.actif) return; etat.tours += 1; setImmediate(battement); };
  setImmediate(battement);
  return { etat, arreter() { etat.actif = false; } };
}

// --- L'archive de la PARTIE 1 : la FORME de l'export reel, en petit ----------
//
// Meme arborescence, meme repartition des types de salon (347 DM, 101 GROUP_DM,
// 219 types serveur — mesure sur l'archive reelle), meme total de messages, et les
// quatre entrees que le vrai export contient et qui sont chacune un cas
// particulier : la banniere incompressible, seule entree gardee a depasser le
// budget de rendement, et les trois entrees ecartees, dont une de 4 096 Mio
// portant la sentinelle ZIP64.
//
// Une seule fois : la fabrication est deterministe et le tampon n'est plus modifie
// apres coup. Le recalculer pour chaque test coute plus d'une seconde de suite.
let FORME_REELLE = null;
function archiveDeFormeReelle() {
  if (FORME_REELLE) return FORME_REELLE;

  const CANAUX = 667;
  const MESSAGES = 27325;
  const SERVEURS = 15;
  const TYPES = [['DM', 347], ['GROUP_DM', 101], ['GUILD_TEXT', 181], ['GUILD_VOICE', 21], ['PUBLIC_THREAD', 15], ['GUILD_ANNOUNCEMENT', 1], ['PRIVATE_THREAD', 1]];

  const snowflake = (depart, pas, i) => String(depart + BigInt(i) * pas);
  const versOctets = valeur => (typeof valeur === 'string' ? encodeur.encode(valeur) : valeur);
  const types = [];
  for (const [nom, nombre] of TYPES) for (let i = 0; i < nombre; i += 1) types.push(nom);

  const fichiers = {};
  const nomsSalons = {};
  const base = Math.floor(MESSAGES / CANAUX);
  let rabat = MESSAGES - base * CANAUX;
  let ecrits = 0;

  for (let i = 0; i < CANAUX; i += 1) {
    const id = snowflake(700000000000000000n, 7919n, i);
    const dossier = `Messages/c${id}`;
    const type = types[i];    // Les snowflakes sont ecrits EN TEXTE BRUT, comme dans l'export reel : c'est ce
    // qui exerce parseSnowflakeJson, qui doit les re-mettre entre guillemets avant
    // de pouvoir lire le JSON.
    fichiers[`${dossier}/channel.json`] = `{"id": ${id}, "type": "${type}", "recipients": ["Utilisateur supprime", "${snowflake(400000000000000000n, 104729n, i)}"]}`;

    const nombre = base + (rabat-- > 0 ? 1 : 0);
    const lignes = [];
    for (let m = 0; m < nombre; m += 1) {
      const snow = snowflake(800000000000000000n, 104729n, ecrits + m);
      // Une piece jointe sur 37, avec les & ecrits comme &amp; : c'est ce que fait
      // l'export reel, et c'est le cas que decodeEntities doit rattraper.
      const piece = (ecrits + m) % 37 === 0 ? 'https://cdn.discordapp.com/attachments/1/2/fichier.png?ex=1&amp;is=2&amp;hm=3' : '';
      lignes.push(`{"ID": ${snow}, "Timestamp": "2024-0${1 + ((ecrits + m) % 9)}-1${(ecrits + m) % 9} 1${(ecrits + m) % 9}:2${(ecrits + m) % 6}:3${(ecrits + m) % 6}", "Contents": "message ${ecrits + m} du salon ${i}", "Attachments": "${piece}"}`);
    }
    ecrits += nombre;
    fichiers[`${dossier}/messages.json`] = `[\n${lignes.join(',\n')}\n]`;
    nomsSalons[id] = type === 'DM' ? null : `salon ${i}`;
  }

  for (let s = 0; s < SERVEURS; s += 1) {
    const id = snowflake(100000000000000000n, 104729n, s);
    fichiers[`Serveurs/${id}/guild.json`] = `{"id": ${id}, "name": "Serveur ${s}", "owner_id": "${snowflake(400000000000000000n, 104729n, s)}", "icon_hash": "abc${s}"}`;
    fichiers[`Serveurs/${id}/channels.json`] = JSON.stringify([...Array(4)].map((_, k) => ({ id: snowflake(900000000000000000n, 7919n, s * 4 + k), type: 0, name: `salon ${k}`, position: k })));
    fichiers[`Serveurs/${id}/audit-log.json`] = `{"guild_id": ${id}, "entries": []}`;
    nomsSalons[id] = `Serveur ${s}`;
  }

  // La banniere : la SEULE entree gardee du vrai export qui depasse le budget de
  // rendement de 4 Mio (9,77 Mio la, 5 Mio ici). La GRANULARITE du point de
  // rendement ne depend pas de cette taille : elle depend du fait qu'il est pris
  // ENTRE les entrees. C'est mesure sur le vrai fichier — son inflation y tient le
  // main process 118 ms d'affilee, contre 5 points de rendement sur tout l'import.
  fichiers['Serveurs/1183128243226804314/banner.gif'] = compressible(5 * MIO);
  // Puis des apports de 0,9 Mio, qui distinguent « le credit se reporte » de « le
  // compteur est remis a zero » : sans report, la banniere ne laisse aucun credit
  // et la cadence change. Le test verifie que la fixture les distingue.
  for (let a = 0; a < 5; a += 1) fichiers[`Compte/recent_avatars/${1408151497723744478n + BigInt(a)}.png`] = compressible(Math.round(0.9 * MIO));

  fichiers['Compte/user.json'] = `{"id": "747781155633496127", "username": "kata_v8.03", "avatar_hash": "a95b780ee6a221f82fca3dea0de7ad6b", "flags": ["MFA_SMS", "PREMIUM"]}`;
  fichiers['Messages/index.json'] = JSON.stringify(nomsSalons);
  fichiers['Serveurs/index.json'] = JSON.stringify(Object.fromEntries([...Array(SERVEURS)].map((_, s) => [snowflake(100000000000000000n, 104729n, s), `Serveur ${s}`])));
  fichiers['README.txt'] = 'Bienvenue dans ton paquet de donnees Discord !';

  // Les entrees ecartees du vrai export, en INCOMPRESSIBLE et au niveau 0 : leur
  // poids dans le fichier est donc reel, comme sur l'archive reelle (mesure : la
  // seule entrie d'activite lisible y pese 136 Mio compresses pour 1 148 Mio
  // annonces, et l'autre 4 096 Mio). C'est ce qui rend le contraste de lecture
  // structurel et non declaratif — un bruit compressible ne pese rien dans le
  // fichier, donc les deux chemins liraient presque autant l'un que l'autre.
  // `Activité/reporting/...` porte la sentinelle ZIP64 sur ses deux tailles : elle
  // n'est jetee que parce qu'elle est du BRUIT, jamais parce que sa taille a ete
  // lue — et c'est bien ce qu'on veut demontrer.
  const ecartees = {
    'Activité/tns/events-2026-00000-of-00001.json': incompressible(8 * MIO),
    'Activité/reporting/events-2026-00000-of-00001.json': incompressible(1024),
    'Publicités/traits.json': incompressible(2048),
    '__MACOSX/._Messages': incompressible(64),
  };

  // Les entrees utiles au niveau 6, le bruit au niveau 0.
  const archive = archiveHonente([
    ...Object.entries(fichiers).map(([nom, valeur]) => entreeDeflate(nom, versOctets(valeur), 6)),
    ...Object.entries(ecartees).map(([nom, octets]) => entreeDeflate(nom, octets, 0)),
  ]);
  FORME_REELLE = patcherSentinelleZip64(archive, 'Activité/reporting/events-2026-00000-of-00001.json');
  return FORME_REELLE;
}

// --- A. Le chemin par index ne lit que les entrees qu'il garde ---------------
//
// C'est LA promesse du chantier, et elle est un COMPTE : le fichier peut peser
// 40 KiB ou 394 Mo, la reponse ne change pas. C'est la seule garantie qu'un test
// automatique peut poser sur ce chantier sans dependre de la machine.
test('le chemin par index ne lit que les entrees qu il garde, et rien du reste', async () => {
  // Une archive dont la TAILLE EST FAUSSE : une entree de bruit INCOMPRESSIBLE de
  // 4 Mio, donc 4 Mio reellement presents dans le fichier, plus une entree de 4 096
  // Mio portant la sentinelle ZIP64. Le chemin flux doit lire et decompresser les
  // 4 Mio ; c'est exactement ce qu'on ne veut pas payer.
  const contenu = {
    'Compte/user.json': '{"id": "1", "username": "mesure"}',
    'Messages/c1/channel.json': '{"id": "1", "type": "DM"}',
    'Messages/c1/messages.json': '[{"ID": 10, "Timestamp": "2024-01-01 00:00:00", "Contents": "bonjour", "Attachments": ""}]',
  };
  const bruit = {
    'Activité/tns/events-2026-00000-of-00001.json': incompressible(4 * MIO),
    'Activité/reporting/events-2026-00000-of-00001.json': incompressible(1024),
    'Publicités/traits.json': incompressible(2048),
    '__MACOSX/._Messages': incompressible(64),
  };
  // Le bruit passe au niveau 0 : des flux deflate incompressibles, de la taille de
  // leur production. C'est ce qui rend la fixture lourde sur disque — donc ce qui
  // rend le contraste avec le chemin index net, et non une propriete du format.
  const archive = patcherSentinelleZip64(
    archiveHonente([
      ...Object.entries(contenu).map(([nom, texte]) => entreeDeflate(nom, encodeur.encode(texte))),
      ...Object.entries(bruit).map(([nom, octets]) => entreeDeflate(nom, octets, 0)),
    ]),
    'Activité/reporting/events-2026-00000-of-00001.json',
  );

  const fichier = fichierCompteur(archive);
  const paquet = await importViaIndex(fichier, {});

  // AFFIRMATION AVANT CONTROLE : sans elle, un chemin qui lirait les 4 Mio de bruit
  // passerait pour une preuve d'efficacite. Les 4 Mio sont la, dans le fichier.
  assert.ok(archive.length > 3 * MIO, `la fixture doit contenir reellement les octets de bruit : ${archive.length} octets`);

  // LE COMPTE EXACT, en tranches ET en octets — les deux calcules depuis
  // l'ARCHIVE, par un parcours independant du module teste.
  //
  // Une tranche par entree ecartee would etre le red flag ; deux tranches par entree
  // ouverte (l'en-tete local, puis les donnees), plus la fenetre de fin et le
  // repertoire central. Ce sont des EGALITES, pas des plafonds : une lecture de
  // plus par entree — la relecture du nom local, un cache mal place, une tranche
  // de controle — ferait rouge.
  const { entries, reason } = await readZipIndex(fichierCompteur(archive));
  assert.equal(reason, null, `le repertoire central doit etre lisible : ${reason}`);
  const { kept, discarded } = selectEntries(entries);
  assert.equal(kept.length, Object.keys(contenu).length, `les trois entrees utiles doivent etre les seules gardees : ${kept.map(e => e.name).join(', ')}`);
  assert.equal(discarded.length, Object.keys(bruit).length, `les quatre entrees de bruit doivent etre ecartees : ${discarded.map(e => e.name).join(', ')}`);

  const gardes = new Set(kept.map(e => e.name));
  const { taille: tailleCentral, enregistrements } = enregistrementsCentraux(archive);
  const attendus = expectedReads(archive, tailleCentral, enregistrements, gardes);
  assert.equal(fichier.tranches.length, attendus.tranches, `exactement ${attendus.tranches} tranches attendues (fin de fichier, central, puis en-tete local + donnees par entree) : ${fichier.tranches.length} mesurees`);
  assert.equal(fichier.octetsLus(), attendus.octets, `exactement ${attendus.octets} octets attendus : la fenetre de fin, le repertoire central, puis l en-tete local et les donnees de chaque entree gardee. ${fichier.octetsLus()} mesures. Les ${archive.length - attendus.octets} octets de bruit sont intacts.`);

  // Et le resultat, qui doit rester le paquet des trois entrees utiles.
  assert.equal(paquet.totalMessages, 1, `le message de la seule entree de messages doit etre la : ${paquet.totalMessages}`);
  assert.equal(paquet.channels.length, 1, `un seul salon : ${paquet.channels.length}`);
  assert.equal(paquet.guilds.length, 0, `aucun serveur : ${paquet.guilds.length}`);
  assert.deepEqual(paquet.discarded, { noise: discarded.length, oversized: 0 }, `les quatre ecartees sont du bruit, aucune n est trop grosse : ${JSON.stringify(paquet.discarded)}`);
});

// --- B. Une entree ecartee n'est jamais OUVERTE ------------------------------
//
// Le nom ne suffit pas : c'est la PLAGE D'OCTETS qui ne doit pas etre lue, sinon
// le chemin testerait a cote et le test passerait pour une preuve.
test('aucune plage d une entree ecartee n est lue, et la sentinelle ZIP64 non plus', async () => {
  const archive = archiveDeFormeReelle();
  const fichier = fichierCompteur(archive);
  const paquet = await importViaIndex(fichier, {});

  const { entries } = await readZipIndex(fichierCompteur(archive));
  const { kept, discarded } = selectEntries(entries);
  assert.ok(discarded.length >= 4, `la fixture doit contenir des entrees ecartees : ${discarded.length}`);
  assert.equal(paquet.totalMessages, 27325, `la fixture doit produire 27 325 messages : ${paquet.totalMessages}`);

  const nommes = new Set(kept.map(e => e.name));
  const jetees = new Set(discarded.map(e => e.name));
  const { enregistrements } = enregistrementsCentraux(archive);
  const lues = fichier.tranches;
  const chevauchements = [];
  for (const entree of enregistrements) {
    if (!jetees.has(entree.nom)) continue;
    const plage = plageReelle(archive, entree);
    for (const [debut, fin] of lues) {
      if (Math.min(fin, plage.fin) > Math.max(debut, plage.debut)) {
        chevauchements.push(`${plage.nom} : tranche [${debut}, ${fin}]`);
      }
    }
  }
  assert.deepEqual(chevauchements, [], `aucune plage d une entree ecartee ne doit etre lue : ${chevauchements.join(', ')}`);

  // La sentinelle ZIP64 a, elle, une plage de 4 096 Mio ANNONCEES : le controle
  // general ci-dessus la couvre deja, mais on verifie ici qu'aucune lecture ne
  // COMMENCE sur son en-tete local — parce que c'est la lecture que ferait
  // `localHeaderOffset` si l'entree passait le tri. Sur l'archive reelle, cette
  // entree est la seule a porter la sentinelle, et elle n'est jetee que parce
  // qu'elle est du bruit.
  const sentinelle = enregistrements.find(e => e.uncompressedSize === 0xffffffff);
  assert.ok(sentinelle, `la fixture doit porter une sentinelle ZIP64 : ${enregistrements.map(e => `${e.nom}=${e.uncompressedSize}`).join(', ')}`);
  assert.ok(!lues.some(([debut]) => debut === sentinelle.debut), `aucune lecture ne doit commencer sur l en-tete local de l entree a sentinelle : offset ${sentinelle.debut}, lectures ${JSON.stringify(lues.map(([d]) => d))}`);
  assert.equal(sentinelle.compressedSize, 0xffffffff, `la sentinelle doit porter 0xFFFFFFFF sur ses deux tailles : ${sentinelle.compressedSize}`);

  // Et la repartition, qui doit suivre la MEME regle que le chemin flux : une entree
  // de bruit et trop grosse compte une fois, comme bruit.
  assert.ok(discarded.every(e => isNoisePath(e.name)), `les ${discarded.length} ecartees doivent toutes etre du bruit : ${discarded.filter(e => !isNoisePath(e.name)).map(e => e.name).join(', ')}`);
  assert.deepEqual(paquet.discarded, { noise: discarded.length, oversized: 0 }, `toute entree ecartee ici est du bruit, aucune n est comptee comme trop grosse : ${JSON.stringify(paquet.discarded)}`);
  assert.ok(nommes.size === kept.length, 'le jeu des noms gardes ne doit pas se deddoublonner');
});

// --- C. La parite des deux chemins, a l'ECHELLE de l'export reel -------------
//
// 667 salons, 347 MP, 27 325 messages, 15 serveurs : les comptes du plan, verifies
// dans la suite de tous les jours, sans une seule milliseconde dans l'assertion.
test('les deux chemins rendent le meme paquet sur une archive a la forme de l export reel', async () => {
  const archive = archiveDeFormeReelle();
  const fichierIndex = fichierCompteur(archive, 'package.zip');
  const fichierFlux = fichierCompteur(archive, 'package.zip');

  const parIndex = await importViaIndex(fichierIndex, {});
  const parFlux = await cheminFluxDuService(fichierFlux, {});

  // LES COMPTES DU VRAI EXPORT.
  assert.equal(parIndex.channels.length, 667, `667 salons : ${parIndex.channels.length}`);
  assert.equal(parIndex.channels.filter(c => c.type === 'DM').length, 347, `347 MP : ${parIndex.channels.filter(c => c.type === 'DM').length}`);
  assert.equal(parIndex.guilds.length, 15, `15 serveurs : ${parIndex.guilds.length}`);
  assert.equal(parIndex.totalMessages, 27325, `27 325 messages : ${parIndex.totalMessages}`);
  assert.equal(parIndex.messages.size, 667, `une table de messages par salon : ${parIndex.messages.size}`);

  // ET LA PARITE PROPREMENT DITE, par empreinte : chaque salon, chaque serveur et
  // chaque message y entrent. Les quatre comptes ci-dessus prouveraient qu'un
  // message a disparu ET qu'un autre a ete duplique sans qu'on le voie.
  assert.equal(empreinteDuPaquet(parIndex), empreinteDuPaquet(parFlux), `les deux chemins doivent produire le meme paquet : ${premierEcart(parIndex, parFlux) || 'empreintes differentes sans ecart trouve'}`);

  // Le chemin flux a du, lui, LIRE tout le fichier, bruit compris. C'est le prix
  // qu'on ne paie plus, et il est la dans un COMPTE d'octets lus.
  //
  // Le contraste est plus faible ici (trois fois) que sur l'archive reelle
  // (19,6 fois : 20,1 Mio contre 394,1) parce que cette fixture est petite et que
  // les entrees utiles y sont une grosse part du fichier. Il reste structurel : il
  // ne depend d'aucune machine, et il tombe des que le chemin index rouvre du
  // bruit.
  assert.ok(fichierFlux.octetsLus() > fichierIndex.octetsLus() * 3, `le chemin flux doit lire bien plus que le chemin index : ${fichierFlux.octetsLus()} contre ${fichierIndex.octetsLus()} octets`);
  assert.equal(fichierFlux.octetsLus(), archive.length, `le chemin flux doit lire le fichier ENTIER : ${fichierFlux.octetsLus()} sur ${archive.length}`);
});

// --- D. Le point de rendement : une CADENCE, et une cadence bornee par l'entree
//        la plus grosse. Le budget est en octets PRODUITS et le credit se REPORTE.
//        Un test en COMPTE le nombre, ce qui est machine-independent ; l'ancien
//        test exigeait un PLANCHER, que satisfait aussi une cadence deux fois
//        moins fine.
test('le point de rendement a la cadence que son budget annonce, et jamais plus d une fois par entree', async () => {
  const archive = archiveDeFormeReelle();
  const fichier = fichierCompteur(archive);
  const produits = [];
  let rendements = 0;

  const vrai = globalThis.setTimeout;
  globalThis.setTimeout = (fn, delai, ...reste) => { rendements += 1; return vrai(fn, delai, ...reste); };
  let obtenu;
  try {
    obtenu = await importViaIndex(fichier, { onEntry: (nom, taille, jete) => { if (!jete) produits.push(taille); } });
  } finally {
    globalThis.setTimeout = vrai;
  }
  assert.equal(obtenu.totalMessages, 27325, `la fixture doit produire 27 325 messages : ${obtenu.totalMessages}`);

  const BUDGET = 4 * MIO;
  // AFFIRMATION AVANT CONTROLE : la fixture doit distinguer « le credit se
  // reporte » de « le compteur est remis a zero ». Si les deux donnaient le meme
  // compte, ce test ne prouverait rien de ce qu'il pretendra verifier.
  const avecReport = rendementsAttendus(produits, BUDGET, 'report');
  const sansReport = rendementsAttendus(produits, BUDGET, 'zero');
  assert.notEqual(avecReport, sansReport, `la fixture doit distinguer les deux cadences : ${avecReport} points avec report, ${sansReport} avec remise a zero`);

  assert.equal(rendements, avecReport, `le nombre de points de rendement doit etre celui que le budget annonce : ${rendements} mesures, ${avecReport} attendus (credit reporte), ${sansReport} attendus (compteur remis a zero)`);

  // Et la borne assumee, consequence directe de « entre les entrees » : jamais plus
  // d'un point de rendement par entree, donc la plus longue sequence sans rendre la
  // main vaut au plus la plus grosse entree. C'est la limite que la revue a
  // explicitement refuse de reparer — le reparer changerait le contrat de lecture
  // des deux chemins, donc leur parite. Elle est donc MESUREE et DECLAREE ici.
  assert.ok(rendements <= produits.length, `au plus un point de rendement par entree : ${rendements} points pour ${produits.length} entrees ouvertes`);
  assert.equal(Math.max(...produits), 5 * MIO, `la plus grosse entree gardee de la fixture doit etre la banniere de 5 Mio : ${Math.max(...produits)}`);
});

// --- E. Le main process n'est pas affame -------------------------------------
//
// C'est la SUFFISANCE du point de rendement, et elle se mesure en TOURS DE BOUCLE —
// pas en millisecondes.
//
// Un `setTimeout(0)` exigerait qu'une milliseconde se passe : le compte dependrait
// alors de la vitesse de la machine, et un plancher « au moins N tours » serait un
// seuil en temps deguise. Un `setImmediate` s'execute des la prochaine rotation,
// SANS qu'aucun temps n'ait eu a s'ecouler : ce qu'il compte est une rotation. Zero
// rotation pendant un import, c'est un main process gele ; une rotation, c'est un
// main process vivant. Les deux se voient sur n'importe quelle machine, et c'est ce
// qui rend cette assertion legitime — c'est-a-dire impossible a satisfaire par
// hasard, et impossible a faire echouer parce que la machine est lente.
test('le main process n est pas affame : la boucle tourne pendant un import', async () => {
  const dossier = dossierJetable();
  try {
    // Le LECTEUR DE PRODUCTION, dont les lectures sont synchrones : avec un Blob,
    // chaque lecture serait une vraie promesse et ferait tourner la boucle a elle
    // seule. C'est pour cela que ce test ecrit l'archive sur disque.
    const chemin = ecrireArchive(dossier, archiveDeFormeReelle());

    const mesurer = async (neutraliser) => {
      const fichier = compteurSurLecteur(await openArchiveReader(chemin, 'package.zip'));
      const vrai = globalThis.setTimeout;
      globalThis.setTimeout = (fn, delai, ...reste) => {
        // LE MUTANT : le rappel est appele tout de suite, donc aucune rotation de
        // boucle n'est plus possible. C'est ce que le test doit voir.
        if (neutraliser) { fn(); return 0; }
        return vrai(fn, delai, ...reste);
      };
      const tours = compteurDeTours();
      try {
        await importViaIndex(fichier, {});
      } finally {
        tours.arreter();
        globalThis.setTimeout = vrai;
        fichier.close();
      }
      return tours.etat.tours;
    };

    const avec = await mesurer(false);
    const sans = await mesurer(true);

    assert.equal(sans, 0, `le mutant doit supprimer TOUTE rotation de boucle : ${sans} tours. S'il en reste, le test ne prouve rien — le lecteur rendrait la main tout seul.`);
    assert.ok(avec > 0, `le main process doit rendre la main pendant un import : ${avec} tours de boucle sur l'archive de forme reelle`);
  } finally {
    rmSync(dossier, { recursive: true, force: true });
  }
});

// --- F. Les memes COMPTES, sur l'ARCHIVE REELLE ------------------------------
//
// Skipe si le fichier est absent : une suite qui exige le fichier de downloads de
// l'utilisateur n'est pas une suite. Tout ce qui est verifie ici est structurel —
// tranches, octets, comptes, cadence — donc VERDICT quel que soit l'etat de la
// machine. La duree, elle, est en PARTIE 2.
test('sur l archive reelle, le chemin par index lit 20 Mio sur 394 et rend 667/27 325/15/347', { skip: !ARCHIVE_PRESENTE && `archive absente : ${CHEMIN_ARCHIVE}` }, async () => {
  // L'index, relu dans l'archive, pour avoir la liste des entrees sans dependre du
  // compteur de lectures ci-dessous.
  const { entries, reason } = await avecLecteurCompte(CHEMIN_ARCHIVE, 'package (1).zip', async fichier => readZipIndex(fichier));
  assert.equal(reason, null, `le repertoire central de l'archive reelle doit etre lisible : ${reason}`);
  const { kept, discarded } = selectEntries(entries);
  assert.equal(entries.length, 2178, `2 178 entrees au central : ${entries.length}`);
  assert.equal(kept.length, 2159, `2 159 entrees gardees : ${kept.length}`);
  assert.equal(discarded.length, 19, `19 entrees ecartees : ${discarded.length}`);

  const produits = [];
  let rendements = 0;
  const vrai = globalThis.setTimeout;
  globalThis.setTimeout = (fn, delai, ...reste) => { rendements += 1; return vrai(fn, delai, ...reste); };
  const mesure = await avecLecteurCompte(CHEMIN_ARCHIVE, 'package (1).zip', async fichier => {
    const paquet = await importViaIndex(fichier, { onEntry: (nom, taille, jete) => { if (!jete) produits.push(taille); } });
    return { paquet, tranches: fichier.tranches.length, octets: fichier.octetsLus() };
  });
  globalThis.setTimeout = vrai;

  // LES COMPTES DU PLAN, sur le vrai fichier.
  assert.equal(mesure.paquet.channels.length, 667, `667 salons : ${mesure.paquet.channels.length}`);
  assert.equal(mesure.paquet.channels.filter(c => c.type === 'DM').length, 347, `347 MP : ${mesure.paquet.channels.filter(c => c.type === 'DM').length}`);
  assert.equal(mesure.paquet.guilds.length, 15, `15 serveurs : ${mesure.paquet.guilds.length}`);
  assert.equal(mesure.paquet.totalMessages, 27325, `27 325 messages : ${mesure.paquet.totalMessages}`);
  assert.equal(mesure.paquet.messages.size, 667, `une table de messages par salon : ${mesure.paquet.messages.size}`);
  assert.deepEqual(mesure.paquet.discarded, { noise: 19, oversized: 0 }, 'les 19 ecartees sont du bruit, aucune n est trop grosse');

  // LE COMPTE QUI PROUVE LE CHANTIER : 4 320 tranches, soit exactement deux par
  // entree ouverte, plus les deux lectures de structure. Sur une archive de 394,1
  // Mio dont 5 244,5 Mio sont annoncees dans le central. Ce nombre ne depend
  // d'aucune machine : il depend des octets DEMANDES.
  assert.equal(mesure.tranches, 4320, `4 320 tranches attendues (fin de fichier, central, puis en-tete local + donnees par entree) : ${mesure.tranches}`);
  assert.ok(mesure.octets < 25 * MIO, `le chemin par index doit rester sous 25 Mio lus sur 394 : ${(mesure.octets / MIO).toFixed(2)} Mio`);

  // LA CADENCE, en nombre exact : 5. Ce n'est pas un plancher — un budget double,
  // une remise a zero du compteur ou un point de rendement pris AVANT l'entree
  // le feraient rougir, ici comme en CI. Le compte est donc structurel.
  const BUDGET = 4 * MIO;
  assert.equal(rendements, rendementsAttendus(produits, BUDGET), `${rendements} points de rendement observes, ${rendementsAttendus(produits, BUDGET)} attendus pour ${produits.length} entrees`);
  assert.ok(rendements <= produits.length, `au plus un point de rendement par entree : ${rendements} pour ${produits.length}`);
  assert.equal(produits.length, kept.length, `chaque entree gardee est ouverte une fois : ${produits.length} pour ${kept.length}`);

  // LA GRANULARITE, mesuree et declaree : le point est pris ENTRE les entrees, donc
  // la cadence suit le budget cumule et la borne reste la plus grosse entree. Sur le
  // vrai fichier, cette borne vaut 9,77 Mio — soit 118 ms d'inflation d'affilee,
  // la moitie de tout l'import. C'est le point que la revue a refuse de reparer.
  // L'oracle est l'ENTETE de l'entree, donc l'egalite est exacte et non un arrondi.
  const banniere = entries.filter(e => e.name.endsWith('/banner.gif')).map(e => e.uncompressedSize).sort((a, b) => b - a)[0];
  assert.ok(banniere > 4 * MIO, `la banniere doit depasser le budget de rendement : ${(banniere / MIO).toFixed(2)} Mio`);
  assert.equal(Math.max(...produits), banniere, `la plus grosse entree produite doit etre la banniere : ${(Math.max(...produits) / MIO).toFixed(2)} Mio contre ${(banniere / MIO).toFixed(2)} Mio annoncees`);
  assert.ok(produits.length > 2000, `le vrai export ouvre plus de 2 000 entrees : ${produits.length}`);

  // LA VIVACITE, sur le VRAI fichier et avec le lecteur de production : c'est la
  // question posee par la revue (« un timer du main process s execute reellement
  // pendant un import de 394 Mo ? »), et elle se repond en tours de boucle, donc
  // sans seuil de temps.
  const tours = await avecLecteurCompte(CHEMIN_ARCHIVE, 'package (1).zip', async fichier => {
    const compteur = compteurDeTours();
    try { await importViaIndex(fichier, {}); } finally { compteur.arreter(); }
    return compteur.etat.tours;
  });
  assert.ok(tours > 0, `la boucle du main process doit tourner pendant l'import de l'archive reelle : ${tours} tours`);
});

// =============================================================================
// PARTIE 2 — DES RELEVES, PAS DES GARANTIES. Jamais rejoues par `npm test`.
//
// Un releve se conserve, il ne s'exige pas. Aucun de ces deux tests ne peut rougir
// sur une duree ni sur un pic de memoire : ils impriment, et leur travail est de
// comparer les deux chemins sur le meme fichier, ce qui est une question de
// structure — et la seule facon honnete de parler d'un pic de memoire.
// =============================================================================

// --- G. Les deux chemins sur l'archive reelle -------------------------------
test('RELEVE — les deux chemins sur l archive reelle : durees, memoire, et parite des resultats', { skip: !ARCHIVE_PRESENTE || !MESURE ? `releve clos : PERF_MESURE=1 (et l archive ${CHEMIN_ARCHIVE})` : false }, async () => {
  // Chaque chemin dans son PROPRE processus, pour trois raisons : le pic de memoire
  // n'est mesurable que dans un processus qui n'a rien fait d'autre ; les deux
  // chemins ne se contaminent donc ni l'un ni l'autre ; et la parite se verifie sur
  // des EMPREINTES rendues par chaque enfant, donc sans memoire partagee.
  const repos = await releveEnfant({ tache: 'repos' });
  const flux = await releveEnfant({ tache: 'import', voie: 'flux', chemin: CHEMIN_ARCHIVE });
  const index = await releveEnfant({ tache: 'import', voie: 'index', chemin: CHEMIN_ARCHIVE });

  const Mio = octets => (octets / MIO).toFixed(1);
  const MioPic = octets => Math.round(octets / 1024);
  console.log(`\n  [releve] archive reelle : ${Mio(statSync(CHEMIN_ARCHIVE).size)} Mio ; un processus au repos occupe ${MioPic(repos.pic)} Mio`);
  for (const [nom, releve] of [['flux ', flux], ['index', index]]) {
    console.log(`  [releve] chemin ${nom} : ${Math.round(releve.ms)} ms, ${Mio(releve.octets)} Mio lus, pic ${MioPic(releve.pic - repos.pic)} Mio, plus long bloc sans rendre la main ${Math.round(releve.blocMax)} ms, ${releve.comptes.salons} salons dont ${releve.comptes.mp} MP, ${releve.comptes.messages} messages, ${releve.comptes.serveurs} serveurs`);
  }
  console.log(`  [releve] rapport des durees ${(flux.ms / index.ms).toFixed(1)}x | rapport des lectures ${(flux.octets / index.octets).toFixed(1)}x | pic ${MioPic(index.pic - repos.pic)} contre ${MioPic(flux.pic - repos.pic)} Mio (${((index.pic - repos.pic) / (flux.pic - repos.pic)).toFixed(2)}x)`);
  console.log(`  [releve] cible de 2 s : ${index.ms < 2000 ? 'atteinte' : 'NON atteinte'} (${Math.round(index.ms)} ms) - releve, aucun test automatique ne depend de ce chiffre`);

  // CE QUI EST VRAIMENT VERIFIE ICI, malgre la porte temporelle : la parite des
  // resultats. Elle ne depend ni de la duree ni de la memoire, et c'est le seul
  // contenu assertable d'un releve.
  assert.equal(index.mode, 'index', `le chemin par index doit etre pris, sans repli : ${index.raison}`);
  assert.equal(flux.mode, 'stream', `le chemin flux est le chemin de reference : ${flux.mode}`);
  assert.equal(index.empreinte, flux.empreinte, 'les deux chemins doivent rendre le meme paquet sur l archive reelle : empreintes differentes');
  assert.deepEqual(index.comptes, flux.comptes, `les deux chemins doivent rendre les memes comptes : ${JSON.stringify(index.comptes)} contre ${JSON.stringify(flux.comptes)}`);
  assert.equal(index.comptes.salons, 667, `667 salons : ${index.comptes.salons}`);
  assert.equal(index.comptes.mp, 347, `347 MP : ${index.comptes.mp}`);
  assert.equal(index.comptes.messages, 27325, `27 325 messages : ${index.comptes.messages}`);
  assert.equal(index.comptes.serveurs, 15, `15 serveurs : ${index.comptes.serveurs}`);
  assert.equal(index.comptes.tables, 667, `une table de messages par salon : ${index.comptes.tables}`);
  assert.deepEqual(index.comptes.jetes, { noise: 19, oversized: 0 }, `19 ecartees, toutes du bruit : ${JSON.stringify(index.comptes.jetes)}`);
  assert.ok(index.octets * 15 < flux.octets, `le chemin index doit lire au moins quinze fois moins : ${index.octets} contre ${flux.octets} octets`);
});

// --- H. LE PIRE CAS HONNETE : une entree de 128 Mio, le plafond lui-meme -----
//
// progress.md annonce « ~256 Mio contre ~144 Mo » pour le pic. Ce chiffre vient
// d'un rapport et n'est pas etaye. On mesure donc, en processus isoles, sur des
// entrees HONNETES dont les deux en-tetes disent la verite :
//
//   - INCOMPRESSIBLE : deflate de niveau 0, donc taille compressee ~= production.
//     C'est le pire cas du chemin par index, qui tient les octets compresses
//     pendant qu'il produit sa sortie.
//   - COMPRESSIBLE : la production est la meme, la taille compressee pas. C'est le
//     cas inverse, et il faut le mesurer aussi — il pourrait inverser la conclusion.
//   - STOCEE (methode 0) : le seul cas ou le chemin par index rend le tampon SANS
//     copie, donc le seul ou il peut etre meilleur que le chemin flux.
//
// Les trois sont honnets : aucun en-tete ne ment. La grosse entree s'appelle
// `Gros/gros.txt` — ni channel.json, ni messages.json, ni guild.json — donc une
// entree GARDEE et non analysee, ce qui est le cas d'une piece jointe dans un
// export reel.
test('RELEVE — le pire cas honnete : une entree de 128 Mio, pic des deux chemins', { skip: !PIRE ? 'releve clos : PERF_PIRE=1' : false }, async () => {
  const dossier = dossierJetable();
  try {
    const utilisateur = encodeur.encode('{"id": "1", "username": "pire"}');
    const cas = {
      // deflate de niveau 0 : un flux deflate HONNETE dont la taille compressee vaut
      // la production. C'est ce qui se passe sur une image ou un PNG deja comprime.
      incompressible: entreeDeflate('Gros/gros.txt', incompressible(TAILLE_PIRE), 0),
      // La meme production, compressee : la taille compressee ne pese plus rien.
      compressible: entreeDeflate('Gros/gros.txt', compressible(TAILLE_PIRE), 6),
      // STOCE : ni compression ni copie.
      stocke: entreeStockee('Gros/gros.txt', compressible(TAILLE_PIRE)),
    };

    const chemins = {};
    const tailles = {};
    for (const [cle, description] of Object.entries(cas)) {
      const archive = archiveHonente([entreeDeflate('Compte/user.json', utilisateur, 6), description]);
      chemins[cle] = ecrireArchive(dossier, archive, `${cle}.zip`);
      const { entries } = await avecLecteurCompte(chemins[cle], `${cle}.zip`, fichier => readZipIndex(fichier));
      const grosse = entries.find(e => e.name === 'Gros/gros.txt');
      tailles[cle] = { produit: grosse.uncompressedSize, compresse: grosse.compressedSize, methode: grosse.method };
    }

    // Le REPOS d'un processus qui ne fait rien : sans lui, « 260 Mio » ne dit pas si
    // l'import a coute 40 Mio ou 210.
    const repos = await releveEnfant({ tache: 'repos' });
    const lignes = [];
    for (const [cle, chemin] of Object.entries(chemins)) {
      const releves = {};
      for (const voie of ['index', 'flux']) releves[voie] = await releveEnfant({ tache: 'import', voie, chemin });
      // La MEME entree, sans le parse : isole le tampon du chemin par index
      // (compresses + sortie) de ce que le parsing ajoute ensuite aux DEUX.
      const entree = await releveEnfant({ tache: 'entree', chemin });
      lignes.push({
        cas: cle,
        ...tailles[cle],
        picIndex: releves.index.pic - repos.pic,
        picFlux: releves.flux.pic - repos.pic,
        picEntreeSeule: entree.pic - repos.pic,
        msIndex: Math.round(releves.index.ms),
        msFlux: Math.round(releves.flux.ms),
        blocIndex: Math.round(releves.index.blocMax),
        blocFlux: Math.round(releves.flux.blocMax),
      });
    }

    console.log(`\n  [releve] pire cas : une entree de ${TAILLE_PIRE / MIO} Mio ; un processus au repos occupe ${Math.round(repos.pic / 1024)} Mio`);
    for (const ligne of lignes) {
      console.log(`  [releve] ${ligne.cas.padEnd(13)} methode ${ligne.methode}, produit ${(ligne.produit / MIO).toFixed(1)} Mio, compresse ${(ligne.compresse / MIO).toFixed(1)} Mio`);
      console.log(`  [releve]   pic index ${Math.round(ligne.picIndex / 1024)} Mio   pic flux ${Math.round(ligne.picFlux / 1024)} Mio   ecart ${Math.round((ligne.picIndex - ligne.picFlux) / 1024)} Mio (positif : l'index est plus gourmand)`);
      console.log(`  [releve]   dont la seule ouverture de l'entree, sans parse : ${Math.round(ligne.picEntreeSeule / 1024)} Mio`);
      console.log(`  [releve]   temps index ${ligne.msIndex} ms  flux ${ligne.msFlux} ms   |   plus long passage sans rendre la main : index ${ligne.blocIndex} ms, flux ${ligne.blocFlux} ms`);
    }

    // CE QUI EST ASSERTABLE ICI, et qui ne depend d'aucune machine : les TAILLES.
    // Un pic, lui, depend de l'allocateur, du GC et de l'OS — c'est un releve, et
    // c'est pourquoi il s'imprime au lieu de s'exiger.
    for (const ligne of lignes) {
      assert.equal(ligne.produit, TAILLE_PIRE, `le cas ${ligne.cas} doit produire ${TAILLE_PIRE} octets : ${ligne.produit}`);
      assert.equal(ligne.methode, cas[ligne.cas].methode, `le cas ${ligne.cas} doit porter la methode ${cas[ligne.cas].methode} : ${ligne.methode}`);
      assert.ok(ligne.compresse > 0, `le cas ${ligne.cas} doit avoir une taille compressee non nulle : ${ligne.compresse}`);
    }
    // Le pire cas du chemin par index : sa taille compressee depasse sa production,
    // donc il tient 128 Mio compresses pendant qu'il en produit 128 Mio.
    assert.ok(lignes[0].compresse > TAILLE_PIRE, `le cas incompressible doit peser au moins sa production : ${lignes[0].compresse} contre ${TAILLE_PIRE}`);
    assert.ok(lignes[1].compresse < TAILLE_PIRE / 100, `le cas compressible doit peser cent fois moins que sa production : ${lignes[1].compresse}`);
    assert.equal(lignes[2].compresse, TAILLE_PIRE, `le cas stocke doit peser exactement sa production : ${lignes[2].compresse}`);
  } finally {
    rmSync(dossier, { recursive: true, force: true });
  }
});

// --- Le relais vers les processus isoles --------------------------------------

async function releveEnfant(specification) {
  const dossier = mkdtempSync(join(tmpdir(), 'perf-enfant-'));
  const sortie = join(dossier, 'sortie.json');
  try {
    const resultat = spawnSync(process.execPath, [CE_PROPRE], {
      env: { ...process.env, PERF_ENFANT: JSON.stringify(specification), PERF_ENFANT_SORTIE: sortie },
      encoding: 'utf8',
      maxBuffer: 16 * MIO,
      timeout: 15 * 60 * 1000,
    });
    assert.equal(resultat.status, 0, `l enfant ${specification.tache}/${specification.voie || ''} doit aboutir : ${resultat.stderr}`);
    return JSON.parse(readFileSync(sortie, 'utf8'));
  } finally {
    rmSync(dirname(sortie), { recursive: true, force: true });
  }
}

// --- Le chemin flux, charge par un CHEMIN RELATIF ----------------------------
//
// Un `import()` d'un chemin ABSOLU WINDOWS est refuse par le chargeur ESM («
// Received protocol 'c: »). C'est un piege reel du depot, verifie en tache 5, et la
// forme relative est celle du code de production.
//
// DECLARATION DE FONCTION et non liaison `const` : le processus ENFANT entre dans
// ce module par le dispatch en tete de fichier, donc avant la fin de la lecture du
// module, donc avant l'initialisation d'une liaison `const` — ReferenceError.
// Mesure : c'est exactement ce que le premier essai du releve a donne.
async function cheminFluxDuService(fichier, options) {
  const module = await import('../src/services/packageImporter.service.js');
  return module.importDiscordPackage(fichier, options);
}

// --- L'enfant lui-meme --------------------------------------------------------
//
// UNE seule tache, dans un processus qui n'a rien fait d'autre, puis un seul jeu de
// chiffres : le pic de la working set, la duree, les octets lus, et le PLUS LONG
// passage sans retour a la boucle — ce dernier est la GRANULARITE reelle du point
// de rendement, en millisecondes, sur le chemin que l'utilisateur voit. Releve,
// jamais seuil : c'est une observation, pas une exigence.
//
// L'import passe par `importPackageWithFallback` pour la voie index, comme en
// production, donc on mesure le chemin reellement utilise — repli compris — et non
// `importViaIndex` appele a la main.
async function jouerEnfant({ tache, voie, chemin }) {
  const sortie = { tache, voie, pic: process.resourceUsage().maxRSS, ms: 0, blocMax: 0, octets: 0 };
  if (tache === 'repos') {
    await import('../src/services/packageImporter.service.js'); // le point de depart honnete
    sortie.pic = process.resourceUsage().maxRSS;
    writeFileSync(process.env.PERF_ENFANT_SORTIE, JSON.stringify(sortie));
    return;
  }

  const depart = performance.now();
  let dernier = depart;
  let blocMax = 0;
  const battement = setInterval(() => {
    const maintenant = performance.now();
    blocMax = Math.max(blocMax, maintenant - dernier);
    dernier = maintenant;
  }, 1);
  const fichier = compteurSurLecteur(await openArchiveReader(chemin, 'archive.zip'));
  try {
    if (tache === 'entree') {
      // L'ENTREE SEULE : ni parse, ni paquet. Isole le tampon du chemin par index
      // (octets compresses + sortie) de ce que le parsing ajoute ensuite aux DEUX.
      const { entries } = await readZipIndex(fichier);
      const grosse = [...entries].sort((a, b) => b.uncompressedSize - a.uncompressedSize)[0];
      await inflateEntry(fichier, grosse);
    } else {
      const resultat = voie === 'index'
        ? await importPackageWithFallback(fichier, {})
        : await cheminFluxDuService(fichier, {});
      const paquet = resultat.package || resultat;
      sortie.empreinte = empreinteDuPaquet(paquet);
      sortie.mode = resultat.mode || 'stream';
      sortie.raison = resultat.reason || null;
      sortie.comptes = {
        salons: paquet.channels.length,
        mp: paquet.channels.filter(c => c.type === 'DM').length,
        messages: paquet.totalMessages,
        serveurs: paquet.guilds.length,
        tables: paquet.messages.size,
        jetes: paquet.discarded,
      };
    }
    sortie.octets = fichier.octetsLus();
  } finally {
    fichier.close();
    clearInterval(battement);
  }
  sortie.ms = performance.now() - depart;
  sortie.blocMax = blocMax;
  sortie.pic = process.resourceUsage().maxRSS;
  writeFileSync(process.env.PERF_ENFANT_SORTIE, JSON.stringify(sortie));
}
