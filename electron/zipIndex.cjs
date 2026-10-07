// Lecture du repertoire central d'un ZIP (CJS, main process) — SANS decompression.
//
// Un export Discord de 394 Mo passait 12 s a l'import, dont 90 % pour
// decompresser des fichiers que l'outil jette ensuite. Le repertoire central,
// lui, tient en fin de fichier : il dit, pour chaque entree, ou elle commence
// et combien elle pese, SANS l'ouvrir. On peut donc ecarter le bruit et les
// entrees trop grosses AVANT toute lecture.
//
// Role unique : dire quelles entrees existent, ou, et leur taille. Rien d'autre.
//
// Contrat de lecture : { name, size, slice(start, end) }, la tranche renvoyant
// un objet porteur de arrayBuffer(). Un vrai File/Blob du renderer convient
// tel quel ; s'en tenir a slice() garantit qu'aucune allocation globale n'est
// reintroduite (cf. readBlocks dans src/services/packageImporter.service.js).
//
// Regle absolue : NE JAMAIS lever. Une archive illisible rend une `reason`,
// ce qui permet a l'appelant de basculer sur le chemin flux, inchange.

const EOCD_SIGNATURE = 0x06054b50; // fin du repertoire central ("End Of Central Directory")
const CENTRAL_SIGNATURE = 0x02014b50; // en-tete d'une entree du repertoire central
const LOCAL_SIGNATURE = 0x04034b50; // en-tete local, devant les donnees compressees

const EOCD_BYTES = 22; // taille minimale d'un EOCD (le commentaire peut le prolonger)
const CENTRAL_BYTES = 46; // taille fixe d'un en-tete central, nom et champs variables exclus
const LOCAL_BYTES = 30; // taille fixe d'un en-tete local
// Fenetre de recherche de l'EOCD : 65 536 + 22, et non 65 536. La norme autorise
// un commentaire d'archive de 65 535 OCTETS, et l'EOCD (22 octets) precede ce
// commentaire : il peut donc se placer 22 + 65 535 = 65 557 octets avant la fin
// du fichier. Une fenetre de 65 536 octets l'arreterait 22 octets trop tot, ne
// trouverait rien, et le pilote basculerait en silence sur le chemin flux.
const TAIL_BYTES = 65536 + 22;
const INVALID = -1;

// Plafond du REPERTOIRE CENTRAL, c est-a-dire de la seule tranche que ce fichier
// demande pour indexer (cf. readCentralDirectory). `centralSize` est une valeur
// ANNONCEE par l archive, comme `compressedSize` d une entree, et elle est lue dans la
// meme tranche unique : sans plafond, un EOCD qui annonce un repertoire central
// couvrant tout le fichier ferait allouer la TAILLE DU FICHIER d un seul coup dans le
// main process (mesure par la revue finale : 2 098 Mio de RSS sur une archive de 1 Gio,
// la ou le code accepte explicitement 8 Gio de fichier — donc la mort du processus par
// commit, sans fenetre de recuperation).
//
// 16 Mio, et la justification est une mesure : le central du vrai export fait 200 a
// 300 Kio pour 2 178 entrees, soit 1 a 2 % de ce plafond. Meme a 46 octets d entree nue —
// nom, extra et commentaire vides — il faudrait plus de 360 000 entrees pour le remplir.
// Un export Discord reel n en a jamais approche. Et comme le repli flux prend le relais,
// un plafond bas ne coute que de la VITESSE sur une archive vraiment grande, jamais
// l import lui-meme.
const MAX_CENTRAL_BYTES = 16 * 1024 * 1024;

// Tout le ZIP est en little-endian. `>>> 0` reapplique l'unsigned : sans lui,
// une taille >= 2 Go ressortirait negative.
const u16 = (view, at) => view[at] | (view[at + 1] << 8);
const u32 = (view, at) => (view[at] | (view[at + 1] << 8) | (view[at + 2] << 16) | (view[at + 3] << 24)) >>> 0;

// Encodeur unique, pour re-metre en octets le nom que `readZipIndex` a decode.
// Sans etat entre deux appels, comme le `TextDecoder` de l autre sens.
const encoder = new TextEncoder();

const fail = (reason) => ({ entries: null, reason });

async function readBytes(file, start, end) {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

// L'EOCD est le dernier enregistrement du fichier, suivi de son seul commentaire.
// On scanne la fenetre de fin en debut : la PREMIERE signature trouvee en
// remontant est la bonne. On demarre a 22 octets de la fin, soit la position la
// plus haute ou un EOCD valide peut commencer (EOCD de 22 octets, commentaire
// de longueur nulle).
function findEocd(tail) {
  for (let at = tail.length - EOCD_BYTES; at >= 0; at -= 1) {
    if (u32(tail, at) === EOCD_SIGNATURE) return at;
  }
  return INVALID;
}

// Parcours du repertoire central, deja charge en memoire : une seule tranche,
// puis on avance de 46 octets plus nom + extra + commentaire par entree.
//
// `record` : les 22 octets de l'EOCD, indexes DEPUIS LEUR DEBUT.
// `eocdEnd` : position ABSOLUE de l'EOCD dans le fichier, seule borne du
// repertoire central. Chaque tampon a donc un seul systeme de coordonnees.
async function readCentralDirectory(file, record, eocdEnd, fileSize) {
  const total = u16(record, 10); // nombre d'entrees, tous disques confondus
  const centralSize = u32(record, 12);
  const centralOffset = u32(record, 16);

  // Marqueur ZIP64 : les valeurs reelles vivent dans un enregistrement ZIP64
  // que l'on ne gere pas. On le dit plutot que de lire n'importe quoi — le
  // repli flux prend le relais.
  if (total === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    return fail('repertoire central ZIP64 non gere');
  }
  if (total === 0) return fail('archive sans entree');
  if (centralOffset + centralSize > fileSize || centralOffset >= eocdEnd) {
    return fail('repertoire central hors du fichier');
  }

  // LE PLAFOND, AVANT LA TRANCHE. `centralSize` est annonce par l archive comme
  // `compressedSize` d une entree, et la tranche ci-dessous le demande d un seul bloc :
  // le borner est donc exactement la correction que la tache 3 a applique a la taille
  // compressee d une entree, au meme endroit du raisonnement. Sans lui, un EOCD qui
  // annonce un central couvrant le fichier fait allouer le fichier entier dans le main
  // process ; avec lui, l import bascule sur le chemin flux, qui lit par blocs de 4 Mio.
  // La raison nomme le plafond : c est elle qui dit, dans un journal, pourquoi le
  // chemin index a ete ecarte.
  if (centralSize > MAX_CENTRAL_BYTES) {
    return fail(`repertoire central de ${centralSize} octets, au-dela du plafond de ${MAX_CENTRAL_BYTES}`);
  }

  const end = Math.min(centralOffset + centralSize, eocdEnd);
  const dir = await readBytes(file, centralOffset, end);
  const entries = [];
  const decoder = new TextDecoder();

  let at = 0;
  for (let index = 0; index < total; index += 1) {
    if (at + CENTRAL_BYTES > dir.length) return fail(`repertoire central tronque a l entree ${index}`);
    if (u32(dir, at) !== CENTRAL_SIGNATURE) return fail(`signature centrale absente a l entree ${index}`);

    const nameLength = u16(dir, at + 28);
    const extraLength = u16(dir, at + 30);
    const commentLength = u16(dir, at + 32);
    const variable = nameLength + extraLength + commentLength;
    if (at + CENTRAL_BYTES + nameLength > dir.length) return fail(`nom tronque a l entree ${index}`);

    const entry = {
      name: decoder.decode(dir.subarray(at + CENTRAL_BYTES, at + CENTRAL_BYTES + nameLength)),
      method: u16(dir, at + 10),
      compressedSize: u32(dir, at + 20),
      uncompressedSize: u32(dir, at + 24),
      localOffset: u32(dir, at + 42),
    };
    entries.push(entry);
    at += CENTRAL_BYTES + variable;
  }

  return { entries, reason: null };
}

async function readZipIndex(file) {
  try {
    if (!file || typeof file.slice !== 'function') return fail('fichier sans tranche lisible');
    const fileSize = Number(file.size) || 0;
    const tailLength = Math.min(TAIL_BYTES, fileSize);
    if (tailLength < EOCD_BYTES) return fail('fichier trop court pour contenir un ZIP');

    const tail = await readBytes(file, fileSize - tailLength, fileSize);
    const eocdAt = findEocd(tail);
    if (eocdAt === INVALID) return fail('fin du repertoire central introuvable');

    const record = tail.subarray(eocdAt, eocdAt + EOCD_BYTES);
    return await readCentralDirectory(file, record, fileSize - tailLength + eocdAt, fileSize);
  } catch (error) {
    return fail(`repertoire central illisible: ${error.message}`);
  }
}

// Offset des DONNEES compressees d'une entree : l'en-tete local (30 octets, plus
// le nom et le champ extra) precede les donnees, et sa longueur n'est connue
// qu'une fois cet en-tete lu — d'ou la lecture a la demande, ici, plutot qu'une
// lecture par entree dans readZipIndex : pre-les coutait 1 459 lectures de 30
// octets sur l'archive reelle, y compris pour les entrees qu'on ecarte sans
// jamais les ouvrir. Seul l'appelant qui ouvre reellement l'entree paie donc.
//
// ET LE NOM EST VERIFIE, PAS SEULEMENT LA SIGNATURE. C'etait le point M8 de la
// tache 1, differe, et il est tombe sur l'invariant que la tache 4 revendique :
// « les deux chemins n'auraient pas vu la meme archive ». Un repertoire central
// qui annonce `localOffset` sur l'en-tete local d'une AUTRE entree faisait
// ouvrir LES OCTETS DE CELLE-LA, nommes d'apres le repertoire central : rien ne
// parait errone, on obtenait un `channel.json` valide — celui d'un autre salon,
// sous le nom de celui annonce. Le chemin de reference, qui LIT EN SEQUENCE, ne
// peut pas etre trompe ainsi.
//
// La longueur du nom est celle de l'entree elle-meme : c'est une borne EXACTE des
// octets a comparer (le nom local doit etre identique octet pour octet), donc
// 30 + cette longueur suffit, et la tranche reste unique — pas de lecture
// supplementaire, pas de limite de nom introduite par ce controle.
// Un nom central qui n'est pas de l'UTF-8 valide ne peut donc pas etre retrouve
// a l'identique : l'entree est REFUSEE (-1), et l'appelant bascule sur le chemin
// flux. Refuser vaut mieux que d'ouvrir une entree sous un nom qui n'est pas le
// sien.
//
// Valide dans l'ordre exact du plan ; -1 des la premiere verification en echec,
// ce qui permet a l'appelant d'ignorer l'entree sans jamais la lire.
// NE JAMAIS lever : -1 y compris sur une entree absente ou un fichier sans
// tranche lisible, pour que le repli flux reste decisionnel et non une exception.
async function localHeaderOffset(file, entry, fileSize) {
  if (!entry || typeof entry !== 'object') return INVALID;
  const size = Number(fileSize);
  if (!Number.isFinite(size)) return INVALID;

  const localOffset = Number(entry.localOffset);
  const compressedSize = Number(entry.compressedSize);
  const nom = typeof entry.name === 'string' ? encoder.encode(entry.name) : null;
  // L'en-tete tient-il dans le fichier ? Verifie AVANT toute lecture. La lecture
  // elle-meme porte les 30 octets PLUS le nom, dont la longueur est deja connue.
  if (!Number.isFinite(localOffset) || localOffset < 0 || !nom || localOffset + LOCAL_BYTES + nom.length > size) return INVALID;
  if (!file || typeof file.slice !== 'function') return INVALID;

  try {
    const header = await readBytes(file, localOffset, localOffset + LOCAL_BYTES + nom.length);
    if (header.length < LOCAL_BYTES + nom.length || u32(header, 0) !== LOCAL_SIGNATURE) return INVALID;
    // Le nom de l'en-tete local doit etre CELUI de l'entree du central, en
    // longueur d'abord — un octet de plus ou de moins ne peut pas etre le meme
    // nom — puis en contenu.
    if (u16(header, 26) !== nom.length) return INVALID;
    for (let i = 0; i < nom.length; i += 1) {
      if (header[LOCAL_BYTES + i] !== nom[i]) return INVALID;
    }

    const data = localOffset + LOCAL_BYTES + nom.length + u16(header, 28);
    if (!Number.isFinite(compressedSize) || data + compressedSize > size) return INVALID;
    return data;
  } catch (error) {
    return INVALID;
  }
}

module.exports = { readZipIndex, localHeaderOffset, MAX_CENTRAL_BYTES };
