// Pilote d'import base sur le repertoire central — COPIE CommonJS, main process.
//
// Consomme les entrees de electron/zipIndex.cjs, qui lit le repertoire central
// SANS decompresser quoi que ce soit. Le role de ce fichier est de classer ces
// entrees avant d'ouvrir la moindre : sur le vrai export (394,05 Mo), 19 entrees
// sur 2 178 sont ecartees, et elles portent ~374 Mio compresses, soit 95 % de
// l'archive — deux gros fichiers de telemetrie sous `Activite/`, dont un de
// 136 Mio compresses produisant 1 148 Mio. Les decompresser pour les jeter
// coutait 10 des 12 s de l'import.
//
// Étape 2 du plan : le tri. `selectEntries` est une fonction SYNCHRONE et PURE
// sur le tableau deja lu — elle ne prend pas le fichier et ne demande aucune
// tranche. Le tri ne peut pas lire, donc rien n'est lu : c'est le principe du
// chantier, et le test « classer l index ne demande aucune lecture » le prouve
// en comptant les lectures.
//
// Étape 3 : l'ouverture. `inflateEntry` ouvre UNE entrée, à son offset exact, en
// un bloc. deflate est un flux unique et stateful : le découper coûterait une
// lecture par entrée, et le gain du chantier est précisément de n'en demander
// qu'une.
//
// `node:zlib` est autorisé ici, et NULLE PART ailleurs : ce fichier est du main
// process Node. `src/` est un module ESM de navigateur, il casserait au premier
// `import` sur un `node:*` — le test de parité des règles relit d'ailleurs les
// deux copies pour vérifier qu'aucune n'a glissé.
//
// --- CONTRAT DE inflateEntry, A LIRE AVANT LA TACHE 4 -----------------------
//
//.inflateEntry(file, entry) -> Promise<Uint8Array>`. Quatre proprietes, dont
// trois ont deja vole une heure a quelqu'un d'autre ; elles sont donc ici, dans un
// fichier SUIVI par git, et pas seulement dans un rapport de tache.
//
// 1. CE QUI EST RENDU EST LE `Buffer` DE ZLIB, SANS COPIE. C'est un Uint8Array,
//    donc `instanceof` passe, mais :
//      - `assert.deepEqual(rendu, attendu)` est ROUGE, meme a contenu identique,
//        parce qu'un Buffer et un Uint8Array n ont pas la meme forme interne.
//        Comparer par `Uint8Array.from(rendu)`.
//      - le rendu est une VUE dans un tampon plus grand que son contenu : en
//        dessous du pool de 64 Kio, une sortie de 1 000 octets arrive avec un
//        `byteOffset` non nul (16 488 sur la mesure faite — le pool etant partage,
//        la valeur depend de ce qui a ete alloue avant) dans un tampon de 65 536.
//        Une sortie de N octets ne retient donc PAS N octets : jusqu'a 64 Kio pour
//        1 000, soit 65 fois plus. Au-dela, zlib alloue un tampon dedie et le
//        rendu fait bien exactement N octets. La tache 5 ne doit pas complter par
//        `buffer.buffer`, qui lui donnerait le slab entier, ni croire retenir N
//        octets par entree.
// 2. PAS DE COPIE, DELIBEREMENT. Copier doublerait le pic sur une entree de
//    128 Mio : 128 Mio produits PLUS 128 Mio de copie, dans le main process, au
//    moment ou l import tient deja deux chemins en vie. La copie appartient a
//    l'appelant s il en a besoin, et lui seul sait s'il en a besoin.
// 3. LE REFUS REJETTE, IL NE RENVOIE JAMAIS `null`. Le choix du repli sur le
//    chemin flux appartient a l'appelant. Une `Error` nomme la cause en
//    francais, prefixee du nom de l'entree, et deux motifs de plafond se
//    distinguent par le champ qu'ils nomment (`uncompressedSize` contre
//    `compressedSize`) : a l'appelant de dire lequel a declenche.
// 4. LES DEUX GARDE-FOUS. `0xFFFFFFFF` sur l'un des trois champs du repertoire
//    central est une sentinelle ZIP64, jamais une valeur : refus avant toute
//    lecture. Et le plafond est applique AUX DEUX BORNES — ce que l en-tete
//    annonce (`uncompressedSize`, `compressedSize`) ET ce que l entree produit
//    (`maxOutputLength`) — parce qu un en-tete peut mentir. Les deux sont avant
//    ou pendant l'ouverture, jamais apres.

const { inflateRawSync } = require('node:zlib');
const { openSync, fstatSync, readSync, closeSync } = require('node:fs');
const { MAX_ENTRY_BYTES, isNoisePath } = require('./packageImporter.rules.cjs');
const { readZipIndex, localHeaderOffset } = require('./zipIndex.cjs');
const { parseEntry, assemble } = require('./packageImporter.parse.cjs');

const INVALID_OFFSET = -1;
// Le répertoire central est lu en u32. Une taille ou un offset >= 4 Gio y vaut
// 0xFFFFFFFF et la vraie valeur vit dans le champ extra ZIP64, que le module ne
// lit pas : cette valeur est une SENTINELLE, jamais une mesure.
//
// Sur le vrai export, l'unique entree qui porte la sentinelle
// (`Activite/reporting/events-…json`) la porte sur DEUX champs seulement : son
// `localOffset` vaut 163 485 153, une vraie valeur. Et elle est ecartee par son NOM,
// trois lignes plus tot, pas par la sentinelle ni par le plafond — la preuve est que
// `oversized` reste a 0. Le garde-fou ci-dessous est donc INATTEIGNABLE sur un export
// Discord : il protege les archives de plus de 4 Gio, que Discord ne produit pas.
const ZIP64_SENTINEL = 0xffffffff;

// Marge du plafond applique a la taille COMPRESSEE, et a elle seule.
//
// Elle existe parce que deflate n'est pas injective : sa sortie peut peser
// PLUS que son entree. La valeur vient de la mesure, pas d'un arrondi : sur des
// donnees incompressibles, deflate engendre 40 965 octets pour 128 Mio, soit
// 0,0305 %, et zlib donne lui-meme une borne de 40 977 octets supplementaires
// (deflateBound = s + (s>>12) + (s>>14) + (s>>25) + 13). 1 Mio couvre 25 fois ce
// que deflate peut engendrer, donc aucune archive honnete dont la production
// tient sous le plafond ne peut etre refusee pour sa taille compressee.
//
// Ce que la borne protege n'est pas la MEMOIRE de la sortie — cela, c'est
// maxOutputLength — mais l'ALLOCATION d'entree : c'est compressedSize qui
// dimensionne le `file.slice(...).arrayBuffer()` fait d'un seul coup, avant que
// quoi que ce soit puisse etre dit de la production.
const COMPRESSED_SLACK = 1024 * 1024;

// Classe l'index, sans ouvrir quoi que ce soit.
//
// Fonction SYNCHRONE et PURE : elle ne reçoit que le tableau d'entrees deja lu
// par readZipIndex, ne prend pas le fichier et ne demande aucune tranche. Le
// `||` court-circuite : un nom bruite n'a pas sa taille examinée, et surtout
// AUCUNE entrée écartée n'est lue — c'est le cœur du chantier. Sur le vrai
// export, les 19 entrees ecartees portent ~374 Mio compresses ; les ouvrir ici les
// ferait décompresser avant de pouvoir les jeter.
//
// L'ordre du répertoire central est conservé dans les deux tableaux : le pilote
// les parcourt ensuite dans cet ordre, et une progression qui sauterait d'une
// entrée à la suivante n'aurait plus de sens.
function selectEntries(entries) {
  const kept = [];
  const discarded = [];
  for (const entry of entries) {
    if (isNoisePath(entry.name) || Number(entry.uncompressedSize) > MAX_ENTRY_BYTES) {
      discarded.push(entry);
    } else {
      kept.push(entry);
    }
  }
  return { kept, discarded };
}

// Ouvre une entrée à son offset exact et rend ses octets décompressés.
//
// Le refus est EXPLICITE et porte son motif : c'est à l'appelant de décider du
// repli sur le chemin flux, pas à une exception muette qui se perd dans un
// `catch` générique. Trois motifs, dont deux sont des garde-fous et non des
// vérifications de bon fonctionnement.
//
// 1. `0xFFFFFFFF` sur compressedSize, uncompressedSize ou localOffset : la
//    sentinelle ZIP64 (voir la constante). Détectée AVANT toute lecture, donc
//    une entrée gardée par le tri n'ouvre jamais au mauvais endroit. Sans cela,
//    le chemin par index serait moins sûr que celui qu'il remplace : une archive
//    de plus de 4 Gio, ou un offset local au-delà de 0xFFFFFFFF, produirait des
//    octets pris au hasard, sans lever.
//
// 2. Le plafond. selectEntries n'a que l'en-tête, et un en-tête peut mentir :
//    le chemin flux, lui, abandonne dès que les octets PRODUITS dépassent
//    MAX_ENTRY_BYTES (src/services/packageImporter.service.js:333). Le contrôle
//    doit donc être à la fois en amont (ce que l'en-tête annonce) ET pendant
//    (ce que l'entrée produit), sinon un répertoire central mensonger ferait
//    décompresser sans borne une entrée que le flux aurait refusée.
//
// 3. Le message de zlib, rendu tel quel dans le refus (étape 3 du plan) : lui
//    seul permet à l'appelant de distinguer une archive corrompue d'une méthode
//    de compression inconnue.
function refuser(entry, motif) {
  const nom = entry && typeof entry === 'object' && entry.name ? entry.name : 'entree sans nom';
  return new Error(`entree ${nom} : ${motif}`);
}

async function inflateEntry(file, entry) {
  if (!entry || typeof entry !== 'object') throw refuser(entry, 'entree absente ou illisible');

  const method = Number(entry.method);
  const compressedSize = Number(entry.compressedSize);
  const uncompressedSize = Number(entry.uncompressedSize);
  const localOffset = Number(entry.localOffset);
  if (![method, compressedSize, uncompressedSize, localOffset].every(Number.isFinite)) {
    throw refuser(entry, 'taille ou offset illisible');
  }

  // Garde-fou 1 : la sentinelle ZIP64, avant toute lecture. Sur une archive de
  // plus de 4 Gio elle serait une position LÉGITIME, donc rien d'autre ne la
  // rattraperait — c'est le test « sur une archive de plus de 4 Go » qui le
  // montre, avec un fichier de 8 Gio annoncés et un en-tête local valide rendu
  // à n'importe quel offset.
  if ([compressedSize, uncompressedSize, localOffset].some(taille => taille === ZIP64_SENTINEL)) {
    throw refuser(entry, 'taille ou offset ZIP64 non gere (0xFFFFFFFF)');
  }

  // Garde-fou 2, partie visible : ce que l'en-tête annonce.
  //
  // Redondant PAR CONSTRUCTION sur le chemin complet : `selectEntries` a déjà
  // tranché sur ce critère, donc une entrée gardée ne peut pas le dépasser. La
  // ligne existe pour que `inflateEntry` reste sûr appelé seul, sur n'importe
  // quelle entrée. Aucun test ne la déclenche volontairement, et la retirer ne
  // fait rougir aucun test : c'est mesuré, et c'est le motif pour lequel elle est
  // conservée telle quelle, documentée ici plutôt que masquée par un test
  // décoratif qui ne prouverait qu'un inatteignable.
  if (uncompressedSize > MAX_ENTRY_BYTES) {
    throw refuser(entry, `taille decompressee annoncee (uncompressedSize) de ${uncompressedSize} octets, au-dela du plafond de ${MAX_ENTRY_BYTES} octets`);
  }
  // La taille COMPRESSEE est bornee elle aussi, AVANT la lecture, et pour toutes
  // les methodes. C'est elle qui dimensionne l'allocation d'entree — le
  // `file.slice(...).arrayBuffer()` plus bas est fait d'un seul coup — donc une
  // entree qui annonce 3 Gio de donnees compressees et 10 octets decompressees
  // ferait allouer 3 Gio dans le main process. La valeur annoncee est une VRAIE
  // valeur, pas une sentinelle : `localHeaderOffset` l'accepte des que le
  // fichier est assez grand. C'est le seul endroit ou le chemin par index etait
  // reellement moins sur que le chemin flux qu'il remplace, qui n'excede jamais un
  // bloc de 64 Kio.
  //
  // La marge est COMPRESSED_SLACK, mesuree : voir la constante. Une entree
  // STOCEE n'a rien a tolerer, elle produit exactement compressedSize octets, et
  // la borne est alors exacte comme pour uncompressedSize.
  const limiteCompressee = method === 0 ? MAX_ENTRY_BYTES : MAX_ENTRY_BYTES + COMPRESSED_SLACK;
  if (compressedSize > limiteCompressee) {
    throw refuser(entry, `taille compressee annoncee (compressedSize) de ${compressedSize} octets, au-dela du plafond de ${limiteCompressee} octets`);
  }

  const fileSize = Number(file && file.size) || 0;
  const data = await localHeaderOffset(file, entry, fileSize);
  if (data === INVALID_OFFSET) throw refuser(entry, 'hors du fichier a son offset local');

  const bytes = new Uint8Array(await file.slice(data, data + compressedSize).arrayBuffer());
  if (bytes.length !== compressedSize) throw refuser(entry, 'donnees compressees tronquees');
  if (method === 0) return bytes;

  try {
    // Garde-fou 2, partie réelle : la borne est DANS l'appel zlib, pas après.
    // inflateRawSync alloue et produit en un seul appel, donc un
    // `if (taille > plafond)` placé plus loin n'arriverait qu'après avoir alloué
    // la sortie — c'est-à-dire après le coup. `maxOutputLength` arrête
    // l'inflation en route (ERR_BUFFER_TOO_LARGE dès que la sortie DÉPASSE la
    // borne), et zlib abandonne alors son tampon : rien des 134 Mio n'est
    // conservé.
    //
    // La sémantique de Node est « au-delà », pas « atteint » : vérifié
    // empiriquement, et verrouillé par le test « la borne de zlib est au-dela,
    // pas au plafond ». Le plafond passe donc TEL QUEL — passer MAX + 1 laisserait
    // passer une entrée d'un octet au-dessus, que le chemin flux refuse.
    //
    // Et la borne est verifiee PAR ELLE-MEME, en interceptant cet appel : le test
    // « la borne de zlib est passee a l appel » lit les options que zlib recoit.
    // C'est la seule mutation que la suite ne voyait pas avant — la mettre a
    // MAX + 1, ou a 16 Mio, ne changeait aucun resultat.
    return inflateRawSync(bytes, { maxOutputLength: MAX_ENTRY_BYTES });
  } catch (error) {
    if (error && error.code === 'ERR_BUFFER_TOO_LARGE') {
      throw refuser(entry, `depasse le plafond de ${MAX_ENTRY_BYTES} octets en cours de route`);
    }
    throw refuser(entry, `donnees compressees illisibles : ${error.message}`);
  }
}

// --- Tache 4 : le MEME resultat que l import par flux, sans ouvrir le bruit ---
//
// C'est ici que se joue tout le chantier. Les trois etapes precedentes ont rendu
// les outils : lire le repertoire central, classer, ouvrir UNE entree a son offset.
// Ce qui manquait etait l'assemblage, et il ne peut pas etre approxime — le chemin
// de reference (src/services/packageImporter.service.js) definit un etat final
// precis, que l'IHM affiche tel quel. Un salon dans le desordre, une cle en trop,
// un nom de remplacement laisse, un snowflake arrondi : l'import « marche » et
// affiche autre chose, sans le moindre signal.
//
// Trois decisions, chacune un ecart de parite possible qu'on ferme explicitement :
//
// 1. LE PARCOURS. On parcourt TOUTES les entrees du repertoire central, dans son
//    ordre, et non seulement les entrees gardees. Le chemin flux appelle `onEntry`
//    pour chaque entree, jetee comprise, AVANT de l'ouvrir : un `onEntry` manque
//    ici, et les deux traces divergeaient. C'est aussi ce qui permet de rebatir
//    les compteurs exactement — `discarded` compte le BRUIT et le TROP GROS
//    separement, et le chemin flux attribue au bruit une entree qui est aussi trop
//    grosse (`if (!isNoisePath(path)) oversized else noise`). Rappeler
//    `isNoisePath` sur les entrees deja classees reproduit cette regle a
//    l'identique : c'est l'option que la revue de la tache 2 avait laisse ouverte
//    (« soit rappeler isNoisePath, soit elargir l'interface du plan »).
//
// 2. L'ERREUR. `collectEntries` empile les echecs d'entree puis fait echouer
//    l'import ENTIER (`throw failures[0]`), et `importDiscordPackage` l'enveloppe
//    dans `Unable to read ZIP archive: <cause>`. On fait pareil : un parseur qui
//    leve sur une entree gardee fait echouer l'import, comme sur le chemin flux.
//    Un en-tete qui MENT, lui, fait echouer le chemin par index la ou le chemin
//    flux reussit : c'est le repli de la tache 5 qui traite ce cas, et c'est le
//    bon comportement — refuser d'ouvrir une entree de 4 Gio vaut mieux que de la
//    decompresser.
//
// 3. `shouldStop()`. Le chemin flux s'arrete a une FRONTIERE DE BLOC et construit
//    son package avec ce qu'il a deja lu ; on fait pareil, sinon une annulation
//    laisserait un panneau vide d'un cote et rempli de l'autre. Consequence
//    MESUREE, et non theorique : sur une archive qui tient dans UN seul bloc de
//    4 Mio — donc toute archive de test — le flux n'a rien lu et echoue
//    franchement (« Unable to read ZIP archive: invalid zip data »), alors que
//    l'index s'arrete entre deux entrees et rend un etat partiel. LES DEUX
//    ECHOUENT DONC sur ce cas, pour deux motifs differents.
//
//    Sur une archive REELLE, c'est-a-dire au-dela de 4 Mio, les deux REUSSISSENT
//    et ne reussissent pas pareil : l'index rend un prefixe de l'import complet,
//    le flux rend tout ce qu'il a lu — qui peut etre l'import ENTIER, sa seule
//    frontiere de lecture etant le bloc. Ce n'est donc PAS une divergence de
//    granularite : ce sont DEUX ETATS FINAUX, dont deux succes au sens de « une
//    valeur a ete retournee ». Le test « une annulation sur une archive de plus de
//    4 Mio » le mesure, salon par salon.
//
//    !! REGLE VITALE POUR LA TACHE 5, ecrite ici parce que ce fichier est SUIVI
//    par git et que .superpowers/ ne l'est pas : `shouldStop()` vrai implique
//    (a) de NE JAMAIS considerer le resultat comme un succes, quelle que soit la
//    forme du paquet — paquet partiel, paquet complet, paquet vide — et
//    (b) de NE JAMAIS relancer le chemin flux sur un `shouldStop()` vrai, sous
//    peine de reparcourir 394 Mo pour rien.
//    Le `reason` sera alors `Unrecognized Discord package: user.json is missing.` —
//    jamais `Unable to read ZIP archive: ...` : c'est le message de l'assemblage,
//    pas celui d'une archive illisible, et il ne doit pas servir a conclure que le
//    chemin flux rattraperait quoi que ce soit.
const STAGE_ENTREE = 'Lecture des entrees utiles';

// Le POINT DE RENDEMENT du chemin par defaut, et l endroit ou il manquait.
//
// Le chemin flux rend la main a chaque bloc de 4 Mio —
// `src/services/packageImporter.service.js:367` — avec un commentaire qui dit
// pourquoi (« sans lui, l'UI reste figee pendant toute la lecture (~10 s sur un
// export de 394 Mo) »). Le soin apporte au renderer n avait PAS ete reporte sur
// le main process, et le chemin par defaut etait donc strictement moins
// cooperatif que son propre repli : les menus natifs, `dialog`, les autres
// `ipcMain.handle` et les timers axios restaient figes pendant tout l'import.
//
// Le renderer, lui, continuait de peindre — c'est un AUTRE processus, et il
// recoit les `send` — donc la barre avançait et l'ETA s'affichait pendant que le
// main etait bloque. L'absence de point de rendement ne se voyait donc pas.
// D'autant qu'`addFiles` lance les imports concurremment sans les attendre : deux
// archives de 394 Mo faisaient rester la jauge du second a zero pendant tout le
// premier.
//
// Le budget est exprime en octets PRODUITS, pas en entrees : une petite archive
// ne l'atteint jamais et ne paie donc RIEN. Un « point de rendement par entree »
// passerait le meme test et ferait payer un `setTimeout` a chaque entee —
// 2 178 entrees sur l'archive reelle, pour rien.
const OCTETS_PAR_RENDEMENT = 4 * 1024 * 1024;

// Le meme appel que le chemin flux, au meme endroit du cycle : un tour de boucle
// d'evenements, ce qui laisse la main aux menus, aux dialogues, aux timers et aux
// autres handlers en attente. Le renderer n'en a pas besoin pour peindre, le main
// process si.
function pointDeRendement() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

// Phase « extraction » de PackageManager.applyImportProgress. `bytes: false` est
// pose EXPLICITEMENT, et non laisse absent : c'est ce booleen qui fait prendre
// 70 % de la barre a cette phase plutot que 30 %, et un `undefined` se lit encore
// comme « phase octets ». Le chemin par index ne compte PAS d'octets — il ne lit
// que 20 Mio au lieu de 394 — donc annoncer des octets ici serait un mensonge.
//
// L'erreur est une `Error` ordinaire, et non le `PackageImportError` du renderer :
// cette classe vit dans un module ESM de navigateur, que le main process ne peut
// pas charger (meme raison que les parseurs). L'appelant ne doit donc PAS
// discriminer sur la classe, seulement sur le fait qu'il y a eu echec.
async function importViaIndex(file, { onProgress = () => {}, onEntry = () => {}, shouldStop = () => false } = {}) {
  if (!file || typeof file.slice !== 'function') throw new Error('Un fichier ZIP est requis.');

  const { entries, reason } = await readZipIndex(file);
  if (!entries) throw new Error(`Impossible de lire l’archive ZIP : ${reason}`);

  const { kept, discarded: ecartees } = selectEntries(entries);
  const gardes = new Set(kept);

  // MEME REPARTITION que le chemin flux, qui attribue au bruit une entree qui est
  // aussi trop grosse, et a `oversized` celle qui ne l'est que par sa taille.
  const discarded = { noise: 0, oversized: 0 };
  for (const entry of ecartees) {
    if (isNoisePath(entry.name)) discarded.noise += 1;
    else discarded.oversized += 1;
  }

  const total = kept.length;
  const collectees = [];
  const echecs = [];
  let current = 0;
  let produits = 0;

  for (const entry of entries) {
    // Point d'arret entre deux entrees, jamais au milieu de l'une : une entree
    // coupee en deux donnerait un salon a moitie ecrit, ce qu'aucun des deux
    // chemins ne sait produire.
    if (shouldStop()) break;

    if (!gardes.has(entry)) {
      // Le chemin flux signale une entree jetee AVANT de l'ouvrir, avec une taille
      // de 0 : c'est ce qui permet a l'IHM de ne pas la compter. Elle n'est pas
      // ouverte ici non plus — c'est le principe du chantier, et le test
      // « une entree ecartee n est jamais ouverte » le compte en tranches.
      onEntry(entry.name, 0, true);
      continue;
    }

    onProgress({ current, total: total || 1, stage: STAGE_ENTREE, bytes: false });
    current += 1;

    // `inflateEntry` REJETTE, jamais ne renvoie `null` : un refus est un refus,
    // et il remonte tel quel. C'est a l'appelant (tache 5) de decider du repli.
    const bytes = await inflateEntry(file, entry);
    // Un parseur qui leve sur une entree gardee fait echouer l'import ENTIER,
    // comme sur le chemin flux — qui empile les echecs et jette `failures[0]`
    // (src/services/packageImporter.service.js:350 puis :370). On pile donc de la meme
    // facon, SANS ENCORE ENVELOPPER : l'enveloppe `Unable to read ZIP archive:`
    // est posee plus bas, sur le seul motif, pour que le message soit celui du
    // chemin de reference, au caractere pres. Sans elle, un `channel.json`
    // malforme remontait une `SyntaxError` NUE — meme etat final (un echec), mais
    // un `reason` different, donc un texte different dans l'IHM selon le chemin
    // qu'un import a pris.
    try {
      const parsed = parseEntry(entry.name, bytes);
      if (parsed) collectees.push({ path: entry.name, ...parsed });
    } catch (error) {
      echecs.push(error);
    }
    onEntry(entry.name, bytes.length, false);

    // Point de rendement, APRES l'entree et jamais au milieu d'une : c'est
    // l'inflation qui bloque, et elle est finie. Le compteur porte les octets
    // PRODUITS, donc une entree ecartee — jamais ouverte — ne le fait pas
    // avancer, et une petite archive ne rend jamais la main.
    // Le compteur est DECALE, pas remis a zero : une entree qui produit 9 Mio pour
    // un budget de 4 Mio laisse 5 Mio de credit, et l'entree suivante rend la main
    // sans avoir produit 4 Mio de plus. Avec `produits = 0`, la cadence derive vers
    // le bas sur une grande entree — le budget devient un maximum observe, pas une
    // cadence. La borne reste la meme : le point de rendement est pris au plus une
    // fois par entree, donc jamais au milieu d'une (invariant borne et assume).
    produits += bytes.length;
    if (produits >= OCTETS_PAR_RENDEMENT) {
      produits -= OCTETS_PAR_RENDEMENT;
      await pointDeRendement();
    }
  }

  // Meme ordre que le chemin flux : les echecs d'entree d'abord, puis le reste.
  if (echecs.length) throw new Error(`Impossible de lire l’archive ZIP : ${echecs[0].message}`);

  return assemble(collectees, {
    packageSizeBytes: Number(file.size) || 0,
    discarded,
    onProgress,
  });
}

// --- Tâche 5 : le repli, et ce qui traverse RÉELLEMENT l'IPC ----------------
//
// Trois décisions, chacune tranchée par une mesure plutôt que par une façon de
// faire.
//
// 1. LE CHEMIN FLUX EST CHARGÉ, PAS DUPLIQUÉ. Le chemin de référence vit dans
//    `src/services/packageImporter.service.js`, un module ESM de BROWSER que le
//    main process ne peut pas `require` — même raison que les parseurs de la
//    tâche 4, mais ici la duplication serait ÉVITABLE : un `import()` dynamique
//    charge l'ESM sans le recopier. On préfère donc charger, pour deux raisons
//    qui ne sont pas des préférences :
//      - une copie du chemin flux ne serait gardée par AUCUN filet. Les parseurs
//        dupliqués le sont (test d'identité au caractère près) ; le corps de
//        `collectEntries` ne l'est pas, et 200 lignes d'`Unzip` sans filet sont
//        exactement la duplication que ce chantier a refusée partout ailleurs.
//      - celle-ci EST le chemin de référence : elle est couverte par toute la
//        suite existante, donc un vrai bug du chemin flux se verrait ici.
//    Si ce chargement échoue — asar, build packagé, module absent — le repli
//    n'a personne vers qui replier : le wrapper le DIT (`fallbackToRenderer`) et
//    le renderer refait l'import, comme avant cette tâche. Un échec de
//    chargement n'est jamais présenté comme un échec d'archive.
//
// 2. LE FICHIER NE TRAVERSE PAS L'IPC. Un `File` n'est pas sérialisable, et
//    l'archive réelle fait 394 Mo : l'envoyer coûterait 394 Mo de tampon de
//    sérialisation côté renderer, plus 394 Mo dans le main process, par-dessus
//    les 394 Mo que le renderer détient déjà — pour un fichier dont le plafond
//    accepté par `PackageManager` est de 8 Gio. Le preload transmet donc le
//    CHEMIN du fichier (`webUtils.getPathForFile`, qui remplace `File.path`,
//    retiré en Electron 32) et le main process ouvre un descripteur de lecture :
//    il ne lit que les plages demandées. Mesuré sur l'export réel : 20,1 Mio lus
//    par le chemin par index, au lieu de 394 Mo.
//
// 3. LE PAQUET EST UN OBJET PLAT. `ParsedPackage.messages` est une `Map`, et
//    l'IPC Electron serialize ses arguments par l'ALGORITHME DE CLONAGE
//    STRUCTURE — qui PRESERVE `Map` et `Set`. Une affirmation inverse a circule
//    dans ce depot six fichiers durant une passe entiere : elle est fausse, et
//    mesurable (`structuredClone(new Map(a)) instanceof Map === true`).
//    Aplatir puis rehydrater reste donc CORRECT — et plus robuste : la
//    transformation est explicite, donc elle ne depend pas du transport, et
//    elle est verifiee par un test dans les deux sens. Ce qui part dans l IPC
//    est un objet indexe par identifiant de salon (`aplatitPackagePourIpc`),
//    que le renderer retransforme en `Map` (`hydrateImportedPackage`,
//    src/components/PackageManager.js).
//
// !! L'ANNULATION, ET SA RÈGLE. `shouldStop()` vrai implique :
//   (a) de NE JAMAIS rendre de paquet — ni complet, ni partiel, ni vide ;
//   (b) de NE JAMAIS relancer le chemin flux, qui reparcourrait 394 Mo pour rien.
// MESURÉ, et non déduit : sur une archive de plus de 4 Mio — donc sur TOUTE
// archive réelle — les deux chemins RENDENT un paquet à l'annulation, pour deux
// raisons opposées : l'index s'arrête entre deux entrées et rend un préfixe de
// l'import complet, le flux s'arrête au BLOC SUIVANT et rend souvent l'import
// ENTIER. Ce sont deux états finaux distincts, dont deux « succès » au sens
// « une valeur a été retournée ». La forme du paquet ne dit donc RIEN de ce qui
// s'est passé : seul `cancelled` le dit, et il porte sur le résultat entier.

// Le chemin de référence, chargé UNE fois. La promesse est remise à zéro si le
// chargement échoue : la conserver en état rejeté condamnerait tous les imports
// suivants, alors qu'un second essai peut réussir.
let cheminFlux = null;
async function chargerCheminFlux() {
  if (!cheminFlux) {
    cheminFlux = import('../src/services/packageImporter.service.js')
      .then(module => module.importDiscordPackage)
      .catch(error => { cheminFlux = null; throw error; });
  }
  return cheminFlux;
}

// Le REPLI, et la seule frontière où les deux chemins se rencontrent.
//
// `package` n'est non nul que si l'import a abouti : un résultat annulé ne
// porte aucun paquet, quelle qu'en soit la forme. Les DEUX motifs sont
// conservés, et ils ne se ressemblent pas — `reason` est l'échec de l'INDEX
// (pourquoi on a replié), `error` celui de la DERNIÈRE tentative (ce qu'on
// affiche). Les confondre afficherait, pour la même archive, un motif qui ne
// décrit pas ce qui s'est passé : sur une annulation `reason` vaut
// `Unrecognized Discord package: user.json is missing.` et jamais
// `Unable to read ZIP archive: …` (mesuré en revue de la tâche 4).
//
// Le repli est journalisé sur UNE ligne : un import qui passe par le chemin
// index doit être muet, sinon le journal du main process se remplirait de lignes
// disant « tout va bien » deux fois.
//
// `loadStreamImporter` est une couture de TEST : elle remplace le chargement du
// module ESM, seul cas où le repli n'a personne vers qui replier. Elle n'existe
// pas pour la production et n'est pas utilisée par elle.
async function importPackageWithFallback(file, options = {}) {
  const { onProgress = () => {}, onEntry = () => {}, shouldStop = () => false, loadStreamImporter } = options;
  try {
    let indexError = null;
    try {
      const paquet = await importViaIndex(file, { onProgress, onEntry, shouldStop });
      if (shouldStop()) return annule('index', null);
      return { package: paquet, mode: 'index', reason: null, cancelled: false, error: null };
    } catch (error) {
      // Un arrêt demandé PENDANT l'index n'est pas un échec d'archive : c'est une
      // annulation, et relancer le chemin flux reparcourrait les 394 Mo pour rien.
      if (shouldStop()) return annule('index', error.message);
      indexError = error;
    }

    console.warn(`Import : repertoire central inutilisable (${indexError.message}) — repli sur la lecture sequentielle.`);

    let importer;
    try {
      importer = await (loadStreamImporter || chargerCheminFlux)();
      // Un module qui se CHARGE sans exposer la fonction attendue est un echec de
      // CHARGEMENT, exactement comme un module absent — pas une archive
      // illisible. Sans cette verification, le repli tente d'appeler un objet,
      // leve « importer is not a function », et le renderer recoit un echec SANS
      // repli : donc pas de chemin local, et une erreur technique a l'ecran.
      if (typeof importer !== 'function') throw new Error('le chemin flux est charge mais n expose pas importDiscordPackage');
    } catch (error) {
      return { package: null, mode: 'index', reason: indexError.message, cancelled: false, error: error.message, fallbackToRenderer: true };
    }
    try {
      const paquet = await importer(file, { onProgress, onEntry, shouldStop });
      if (shouldStop()) return annule('stream', indexError.message);
      return { package: paquet, mode: 'stream', reason: indexError.message, cancelled: false, error: null };
    } catch (error) {
      if (shouldStop()) return annule('stream', indexError.message);
      return { package: null, mode: 'stream', reason: indexError.message, cancelled: false, error: error.message };
    }
  } finally {
    // Le descripteur est ferme sur TOUTES les sorties, y compris une annulation.
    // Un `File` de Windows reste verrouille tant qu'il est ouvert : un import
    // interrompu ne doit pas empeacher de renommer ou supprimer l'archive.
    //
    // Laisse ATTRAPPE : une exception levee par `close` dans un `finally`
    // REMPLACE le resultat, donc le handler la rattraperait, renverrait
    // `fallbackToRenderer`, et le renderer referait l'import — le meme import,
    // deux fois, pour une fermeture ratée.
    await fermerLecteur(file);
  }
}

function annule(mode, reason) {
  return { package: null, mode, reason: reason || null, cancelled: true, error: null };
}

// Un LECTEUR PAR TRANCHES SUR DISQUE, et le seul contrat dont les deux chemins
// d'import ont besoin : { name, size, slice(debut, fin) }, la tranche renvoyant
// un objet porteur de `arrayBuffer()` — la forme d'un `File`, donc.
//
// `readFile` mettrait 394 Mo en mémoire avant même la première tranche ; ici une
// lecture positionnelle ne demande QUE la plage demandée, dans un tampon de la
// TAILLE EXACTE de cette plage — donc `.buffer` vaut les octets lus, sans copie
// et sans le slab de 64 Kio dans lequel Node écrirait une sortie de 1 000 octets
// (cf. le contrat de `inflateEntry`, en tête de ce fichier).
//
// LA LECTURE EST SYNCHRONE, et c'est ce que permet le contrat : les deux
// chemins appellent `file.slice(...).arrayBuffer()` SANS await sur le `slice`, donc
// un `slice` qui retournerait une promesse casserait les deux. Le prix est un
// main process bloqué le temps de la lecture — ce qu'il est DÉJÀ, puisque
// `inflateRawSync` décompresse en bloquant, et ce que la tâche 4 a mesuré sans
// réserve (4 320 tranches, 20,1 Mio, 462 ms). Une lecture asynchrone ici
// changerait le contrat de lecture des deux chemins, donc leur parité.
//
// Une lecture peut revenir COURTE (fin de fichier, fichier synchronisé à
// moitié) : on boucle plutôt que de rendre un tampon à moitié vide, sinon la
// faute de lecture retomberait sur le parseur.
function ouvrirLecteur(chemin, nom) {
  const fd = openSync(chemin, 'r');
  try {
    const size = fstatSync(fd).size;
    return {
      name: nom,
      size,
slice(debut, fin) {
      const from = Math.max(0, Number(debut) || 0);
      const borne = fin === undefined || fin === null ? size : Number(fin);
      const to = Math.min(size, Number.isFinite(borne) ? borne : size);
      const attendu = Math.max(0, to - from);
      const octets = new Uint8Array(attendu);
      let lus = 0;
      while (lus < attendu) {
        const bytesRead = readSync(fd, octets, lus, attendu - lus, from + lus);
        if (!bytesRead) break;
        lus += bytesRead;
      }
      return { length: lus, arrayBuffer: () => (lus === attendu ? octets.buffer : octets.slice(0, lus).buffer) };
    },
    close() { closeSync(fd); },
    };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

// Async pour que l'appelant ait UN SEUL traitement d'erreur : un fichier absent
// ou inaccessible doit arriver en REJET, comme le faisait la version `open()`.
async function openArchiveReader(chemin, nom = 'package.zip') {
  return ouvrirLecteur(chemin, nom);
}

// --- LES TROIS FORMES DE `messages`, ET LEUR NOM ------------------------------
//
// `messages` est l'unique champ du paquet qui change de forme trois fois. Les
// trois transformations sont dans le depot, dont DEUX portaient le meme nom
// (`serialisePackage`) pour deux formats differents : le prochain qui les
// touchera doit pouvoir les nommer sans les ouvrir toutes.
//
//   1. EN MEMOIRE — une `Map` (identifiant de salon -> messages). C'est ce que
//      rendent `importViaIndex` et `importDiscordPackage`, et ce que consomme
//      `PackageManager`. AUCUNE transformation : les deux chemins d'import
//      s'arrêtent la, et c'est la forme de reference.
//   2. SUR LE FIL — un OBJET indexe par identifiant de salon
//      (`Record<string, PackageMessage[]>`). C'est ce que produit
//      `aplatitPackagePourIpc` ci-dessous, et ce que `buildImportResponse`
//      place sous `package` ; `hydrateImportedPackage`
//      (src/components/PackageManager.js) en fait une `Map` a l'arrivee.
//   3. EN BASE — un TABLEAU DE PAIRES (`[string, PackageMessage[]][]`), parce
//      qu'IndexedDB sait stocker un `ArrayBuffer` mais pas une cle d'objet.
//      Ce sont les deux fonctions de `src/services/packageStorage.service.js`,
//      `serialisePackage` et `hydratePackage`, qui vivent dans un autre module
//      et pour un autre STORE : d'ou leur nom d'origine, identique au nôtre.
//      Elles n'ont pas ete renommees ici — ce module ne les possede pas — mais
//      les trois formes sont desormais nommees la ou chacune est ecrite.
//
// L'aplatissement est donc VOLONTAIRE et non une contrainte du transport : l'IPC
// d'Electron preserverait une `Map` (clonage structure), mais un objet se
// inspecte dans un journal, se compare dans un test, et ne casse pas si le
// transport change un jour. Ce qui compte ici : la transformation est
// EXPLICITE, donc verifiee dans les deux sens plutot que laissee au transport.
// Le refus d'un paquet NUL est EXPLICITE, et c'est mesure : sans cette ligne,
// `paquet.messages` sur `null` leve un `TypeError` — donc l'aplatissement « se
// defend » par accident de forme, pas par regle. Il suffirait alors qu'une
// edition ulterieure etablie `paquet?.messages` pour qu'un paquet NUL devienne
// `{ messages: {} }` : une Map vide cote renderer, que `importQueueItem`
// enregistrerait avec sa version de schema. Le REFUS est donc pose ici, et il
// est double : `buildImportResponse` n'appelle de toute facon jamais
// l'aplatissement sans paquet.
function aplatitPackagePourIpc(paquet) {
  if (!paquet || typeof paquet !== 'object') throw new Error('paquet nul ou illisible : rien a aplatir');
  const sortie = { ...paquet };
  sortie.messages = Object.fromEntries(paquet.messages || new Map());
  return sortie;
}

// L'ENVELOPPE de la reponse IPC — et la seule ligne du produit qui dit si un
// import a REUSSI.
//
// Elle est ici, et non dans le corps d'un handler de `main.cjs`, parce que c'est
// elle qui decide de ce que l'utilisateur recoit. La seule ligne qui l'en
// empechait — « pas de paquet, pas de succes » — n'etait couverte par AUCUN test :
// le handler n'est pas executable ici (il cree des dossiers et demande le
// verrou d'instance unique des son chargement), et le test de convention ne
// voyait que des REGEX sur le texte source. Une derive de noms, pas un
// comportement.
//
// Ce que la mutation « `success: true` inconditionnel » produirait, de mesurable :
// l'aplatissement est APPEL SUR `null` et LEVE (« paquet nul ou illisible »), donc
// la mutation ne rend pas `{ messages: {} }` — elle rend un `fallbackToRenderer`,
// et le renderer refait l'import a la main. Une reponse parasite, pas un paquet
// fantome. La forme reellement dangereuse est donc le paquet NON NUL et vide, dont
// la construction est analysee sous la garde ci-dessous.
//
// Ce qui rend la ligne non decorative : la mutation « pas de garde », elle, rend
// `{ success: true, package: { messages: {} } }` sur une ANNULATION — donc le
// renderer hydrate une `Map` VIDE, `PackageManager.importQueueItem` pose
// `schemaVersion` dessus, et le paquet est ecrit en base : il sera relu comme un
// import VALIDE au redemarrage. La meme mutation transforme un echec d'archive en
// « OK ».
//
// Les quatre formes d'echec, et pourquoi aucune ne transporte de paquet :
//
//   - `fallbackToRenderer` : le main process ne peut pas importer du tout. Le
//     renderer refait l'import avec le `File` qu'il detient deja.
//   - paquet nul : un echec d'archive, ou une annulation. Aucun paquet — ni
//     partiel, ni complet, ni vide.
//   - serialisation qui leve : l'import A abouti, c'est la mise en forme qui a
//     echoue. C'est un bug, donc le renderer refait l'import plutot que
//     d'afficher une erreur technique sans chemin local ; le prix est un import
//     fait deux fois, et il est assume.
//   - `success: true` : le SEUL cas ou un paquet existe.
//
// `cancelled` est recopie tel quel : c'est lui qui distingue une annulation d'un
// echec d'archive, et l'IHM teste `reponse.cancelled` avant `reponse.error`.
function buildImportResponse(resultat, serialiser = aplatitPackagePourIpc) {
  const echec = {
    success: false,
    package: null,
    mode: resultat?.mode ?? null,
    reason: resultat?.reason ?? null,
    cancelled: Boolean(resultat?.cancelled),
    error: resultat?.error ?? null,
  };

  if (resultat?.fallbackToRenderer) return { ...echec, fallbackToRenderer: true };
  //
  // LA GARDE, ET SON INVARIANT : « pas de paquet, pas de succes ». Elle est une
  // garde de PRESENCE, donc `{ package: {} }` la traverse — et c'est DELIBERE, pas
  // un oubli. `{ package: {} }` est un succes parce qu'il n'est pas produit :
  //
  //   - Les DEUX chemins de production construisent le paquet par `assemble`, qui
  //     LEVE sur l'absence de `Compte/user.json`
  //     (electron/packageImporter.parse.cjs:311 ; le chemin de reference leve
  //     pareil, src/services/packageImporter.service.js:392). Un paquet sans
  //     `user` n'est donc produit par AUCUN des deux.
  //   - Refuser un paquet « vide » casserait le cas LEGITIME « un compte, zero
  //     message » : `user` present, `messages` vide. C'est un import reussi, et il
  //     DOIT etre persiste. Refuser « aucun message » refusera un import valide ;
  //     refuser « aucun `user` » serait une ligne correcte, mais elle redoublerait
  //     une regle deja portee par `assemble` sur les deux chemins — donc un
  //     troisieme endroit ou la faire diverger, sans rien couvrir que `assemble`
  //     ne couvre deja.
  //
  // Le test « un paquet nul n est JAMAIS presente comme un succes » fixe donc cet
  // invariant comme il est — presence, pas contenu — et prouve separement que le
  // paquet SANS `user` est inatteignable par les deux chemins.
  if (!resultat?.package) return echec;
  try {
    return { success: true, package: serialiser(resultat.package), mode: echec.mode, reason: echec.reason };
  } catch (error) {
    return { ...echec, fallbackToRenderer: true, error: error.message };
  }
}

// La CLE DE ROUTAGE d'un evenement de progression.
//
// Le renderer filtre sur `info.fichier === item.file.name` : deux fichiers de
// meme nom dans la file contamineraient leurs jauges. La cle se pose donc EN
// DERNIER — `{ ...info, fichier }` et non `{ fichier, ...info }` — parce que le
// spread vient apres et ecraserait la cle de routage si une phase portait un
// `fichier` concurrent. C'est une ligne, donc une fonction nommee : elle est le
// seul endroit du produit ou l'ordre des deux ecritures est decide, et elle a un
// test qui l'injecte.
function routeProgression(fichier, info) {
  return { ...info, fichier };
}

// L'ecart entre la taille ANNONCEE et la taille REELLEMENT ouverte, ou `null`
// quand il n'y a rien a signaler.
//
// Le renderer envoyait `taille` et le main process ne la lisait pas : il
// ouvrait le fichier du chemin annonce sans rien comparer. Un fichier remplace
// entre la selection et l'ouverture etait alors importe sans que rien ne le
// signale, alors que la file avait enregistre le nom et la taille de celui que
// l'utilisateur avait choisi. `taille` etait donc un parametre mort qui avait
// l'air protege — le pire des deux.
//
// Une valeur ABSENTE, nulle, zero ou non finie n'est pas une declaration : elle
// ne peut pas faire refuser quoi que ce soit. Seul un ecart entre deux tailles
// reelles est un refus, et il est nomme.
function ecartTailleAnnonce(annoncee, reelle) {
  const attendu = Number(annoncee);
  const trouve = Number(reelle);
  if (!Number.isFinite(attendu) || attendu <= 0) return null;
  if (!Number.isFinite(trouve) || trouve < 0) return null;
  if (attendu === trouve) return null;
  return `${attendu} annonces, ${trouve} trouvees`;
}

// L'IMPORT COMPLET, DEPUIS LE CHEMIN — c'est le corps du handler de main.cjs,
// ici pour etre teste.
//
// Il tient les trois decisions qui n'appartiennent pas au pilote : ouvrir le
// descripteur, COMPARER la taille annoncee a la taille reellement trouvee, et
// rendre l'enveloppe. `main.cjs` ne fait plus que router la progression et
// rendre cette reponse.
//
// Sur un ecart de taille, il n'y a PAS de repli, et c'est le point le plus
// contre-intuitif de ce fichier.
//
// Le renderer.detient le `File` de la selection, donc `importDiscordPackage(
// item.file)` lit un fichier dont le CHEMIN est le meme que celui qu'on vient de
// refuser. Le repli ne changerait donc pas la donnee : il relirait le fichier
// REMPLACE, le.marquerait reussi, y poserait `schemaVersion`, et l'enregistrerait.
// L'utilisateur ne verrait rien, et l'import serait fait deux fois — le second
// etant celui du fichier que personne n'a choisi. Ce que le renderer lit n'est
// d'ailleurs garanti par rien : le `File` d'une selection est une CHEMIN, pas un
// instantane des octets.
//
// Le refus est donc FRANC : `success: false`, `cancelled: false`, pas de
// `fallbackToRenderer`. `PackageManager.readPackage` leve alors, `item.statusText`
// affiche le motif, et rien n'est persiste. C'est le seul echec de ce fichier qui
// ne donne aucun chemin de secours a l'utilisateur — et c'est le seul qui doive
// etre franc, parce que c'est le seul ou l'autre chemin donnerait un SUCCES FAUX.
async function importArchiveDepuisChemin(demande = {}, { onProgress = () => {} } = {}) {
  const chemin = typeof demande.chemin === 'string' ? demande.chemin : '';
  const nom = typeof demande.nom === 'string' ? demande.nom : 'package.zip';
  if (!chemin) return { success: false, package: null, fallbackToRenderer: true, error: 'Aucun chemin de fichier.' };

  let lecteur;
  try {
    lecteur = await openArchiveReader(chemin, nom);
  } catch (error) {
    // Fichier absent, inaccessible, verrouille : ce n'est pas l'archive qui est
    // illisible, donc le renderer garde la main.
    return { success: false, package: null, fallbackToRenderer: true, error: `Fichier illisible : ${error.message}` };
  }

  // La course entre la SELECTION et l'OUVERTURE, fermee ici et nulle part ailleurs :
  // c'est le seul moment ou le fichier ouvert et la taille annoncee coexistent.
  const ecart = ecartTailleAnnonce(demande.taille, lecteur.size);
  if (ecart) {
    await fermerLecteur(lecteur);
    return { success: false, package: null, cancelled: false, error: `Fichier modifie depuis sa selection : taille ${ecart}.` };
  }

  try {
    // La CLE DE ROUTAGE passe en DERNIER : `{ fichier: nom, ...info }` la
    // laisserait ecraser par un `info.fichier`, et la jauge d'une archive se
    // remplirait avec la progression d'une autre. Le nom demande est donc pose
    // APRES les informations de phase, qui ne le portent pas aujourd'hui.
    const resultat = await importPackageWithFallback(lecteur, { onProgress: info => onProgress(routeProgression(nom, info)) });
    return buildImportResponse(resultat);
  } catch (error) {
    // `importPackageWithFallback` rend un resultat et ne leve pas : n'arriver ici
    // signifierait un BUG du service. La reponse dit donc « le renderer peut
    // refaire l import » — ce qui est vrai et ce qui coute : un bug se deguise en
    // « main indisponible » et fait refaire l import. Le prix est assume, parce
    // que l'utilisateur, lui, garde un chemin vers son archive.
    return { success: false, package: null, fallbackToRenderer: true, error: error.message };
  }
}

// Un descripteur qu'on ne parvient pas a fermer est un incident de nettoyage, pas
// un echec d'import : `closeSync` peut lever sur un fichier qui a disparu entre
// temps, et laisser l'exception se propager remplacerait le resultat — donc faire
// recommencer l'import dans le renderer.
async function fermerLecteur(lecteur) {
  try {
    await lecteur?.close?.();
  } catch (error) {
    console.warn(`Import : fermeture du descripteur impossible (${error.message}).`);
  }
}

// Ni `NOISE_PREFIXES` ni `isNoisePath` ne sont REEXPORTES d'ici, meme si le
// second est appele deux fois dans ce fichier. Un reexport est un second chemin
// d'acces a la regle pour les taches suivantes, donc une divergence future
// possible — et l'argument vaut mot pour mot pour les deux : celui qui veut la
// regle l'importe de `packageImporter.rules.cjs`, le seul module qui l'expose.
// (C'etait le cas pour NOISE_PREFIXES depuis la tache 2 ; `isNoisePath` a ete
// laisse jusqu'ici, sans consommateur : retire.)
//
// L'appel DOUBLE, lui, reste et reste volontaire : une fois dans `selectEntries`
// pour classer, une fois dans `importViaIndex` pour attribuer chaque entree
// ecartee a `noise` ou `oversized` comme le fait le chemin flux. C'est la MEME
// fonction, dans le MEME module, sur la MEME chaine : le double appel ne peut pas
// diverger. Rappeler la regle est donc moins risqué que modifier son interface
// pour qu'elle rende la repartition.
module.exports = { MAX_ENTRY_BYTES, selectEntries, inflateEntry, importViaIndex, importPackageWithFallback, openArchiveReader, aplatitPackagePourIpc, buildImportResponse, ecartTailleAnnonce, routeProgression, importArchiveDepuisChemin };
