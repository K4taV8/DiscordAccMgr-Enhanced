// Socle pur du miroir media — TACHE 1 du chantier « galerie-media-mirror ».
//
// Une tache ulterieure telechargera les 2 208 pieces jointes (~1,83 Gio) d'un
// export Discord dans `data/media`, mais AUCUNE de ces operations ne vit ici :
// ce module ne fait ni reseau ni disque distant, ne connait ni `electron` ni
// l'IPC, et se teste donc sous Node nu. Il etablit les quatre fondations dont
// les taches 2 a 5 dependront, et leurs noms sont le contrat :
//
//   1. `mediaMirrorKey` — une CLE STABLE d'un lot d'URL. Triee, dedupliquee,
//      hachee : deux exports qui portent les memes pieces jointes, meme dans un
//      ordre different ou avec des doublons, tombent sur le meme dossier. Une
//      cle qui bougerait ferait retelecharger 1,83 Gio pour rien.
//   2. `sanitizeMediaName` — un NOM que Windows accepte. Les caracteres
//      interdits, les points et espaces finaux (que Windows retirent
//      silencieusement, ce qui ferait diverger le nom ecrit du nom attendu) et
//      les caracteres de controle sont neutralises.
//   3. `resolveMediaPath` — le GARDE ANTI-TRAVERSEE, et le seul du projet. Un
//      nom venant d'une piece jointe Discord est une donnee NON FIABLE : « .. »
//      y est parfaitement legal. Toute resolution qui sort de la racine est
//      refusee, et les taches 3 et 5 reutiliseront cette fonction plutot que
//      d'en ecrire une seconde.
//   4. `readManifest` / `writeManifest` — le MANIFESTE, ecrit par fichier
//      temporaire puis renomme : un manifeste a demi ecrit serait cru, et
//      relancerait ou sauterait des telechargements a tort.
//
// CommonJS, a l'image de `electron/packageImporter.service.cjs` : le fichier est
// charge par le main process Electron ET par les tests sous Node nu.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');

// Le dossier, sous `data/`, ou le miroir se range. La constante existe pour que
// l'ecriture du dossier et la lecture des chemins ne puissent pas diverger.
const MIRROR_DIR_NAME = 'media';
// Longueur de la cle de lot (12 caracteres hexadecimaux de SHA-1 = 48 bits). Le
// risque de collision reste negligeable pour quelques lots, et un dossier court
// se lit mieux qu'un condensat complet.
const MIRROR_KEY_LENGTH = 12;
// Longueur du hash d'URL utilise dans le nom de fichier (8 hex = 32 bits) : il
// distingue deux pieces jointes homonymes d'un meme salon.
const MIRROR_HASH_LENGTH = 8;
// Le nom du manifeste, et le nom du repli quand un nom assaini ne laisse rien.
const MANIFEST_FILE_NAME = 'manifest.json';
const NOM_DE_REPLI = 'piece-jointe';

// Les caracteres que Windows interdit dans un nom de fichier, plus les
// caracteres de controle (U+0000 a U+001F). Le bit `u` n'est pas necessaire : la
// classe est explicite, et un nom contenant un emoji reste intact.
const CARACTERES_INTERDITS = /[<>:"/\\|?*\u0000-\u001f]/g;
// Points et espaces finaux : Windows les retire silencieusement a l'ecriture, ce
// qui ferait diverger le nom sur le disque du nom calcule ici.
const FINAUX_RETIRES = /[. ]+$/;

// SHA-1 hexadecimal d'une chaine, tronque a `longueur` caracteres.
//
// Le hash est utilise pour IDENTIFIER, jamais pour proteger : SHA-1 reste
// parfaitement suffisant ici, et sa sortie courte est stable d'un Node a l'autre.
function sha1Tronque(valeur, longueur) {
  return crypto.createHash('sha1').update(valeur).digest('hex').slice(0, longueur);
}

// La cle d'un lot d'URL.
//
// L'ordre et les doublons ne doivent pas compter : on TRIE et on DEDUPLIQUE
// avant de hacher, et les entrees vides sont ecartees. Un lot vide — ou une
// entree qui n'est pas un tableau — n'a pas de cle : `''` le dit explicitement,
// plutot qu'un hash de rien qui aurait l'air d'une vraie cle.
function mediaMirrorKey(urls) {
  if (!Array.isArray(urls)) return '';
  const vues = new Set();
  for (const url of urls) {
    if (typeof url === 'string' && url !== '') vues.add(url);
  }
  if (vues.size === 0) return '';
  return sha1Tronque([...vues].sort().join('\n'), MIRROR_KEY_LENGTH);
}

// Un nom de fichier sur : les caracteres interdits et de controle deviennent
// `_`, les points et espaces finaux sont retires, et un nom qui ne laisse rien
// de visible replie sur `piece-jointe` plutot que de produire un fichier sans nom.
//
// Une entree non-chaine n'est pas un nom : elle replie aussi, sans jeter.
function sanitizeMediaName(name) {
  const brut = typeof name === 'string' ? name : '';
  const remplace = brut.replace(CARACTERES_INTERDITS, '_').trim();
  const nettoie = remplace.replace(FINAUX_RETIRES, '');
  return nettoie === '' ? NOM_DE_REPLI : nettoie;
}

// Le hash court d'une URL, tel qu'il apparait en tete du nom de fichier.
function mediaHash8(url) {
  return sha1Tronque(String(url ?? ''), MIRROR_HASH_LENGTH);
}

// Le nom de fichier d'une piece jointe : le hash de son URL, puis le nom assaini.
// Le hash vient en tete pour que deux pieces jointes de meme nom dans un meme
// salon ne s'ecrasent pas l'une l'autre.
function mediaFileName(url, fileName) {
  return `${mediaHash8(url)}-${sanitizeMediaName(fileName)}`;
}

// Le chemin RELATIF complet, sous `data/media`.
//
// La cle EST le premier segment : c'est ce qui range tout un lot sous un meme
// dossier, et c'est ce qui permet a une tache ulterieure de retrouver les
// fichiers d'un lot sans relire les URL. Chaque segment est assaini — un
// identifiant de salon ou un nom venant de Discord n'est jamais de confiance.
function mediaRelPath(key, channelId, url, fileName) {
  return [key, channelId, mediaFileName(url, fileName)].map(sanitizeMediaName).join('/');
}

// L'URL du protocole `media://` d'un chemin relatif COMPLET sous `data/media`.
//
// Le chemin et l'URL suivent une seule et meme regle : ce que la boucle ecrit
// sous `data/media` — la cle incluse — est exactement ce que le protocole sert.
// Chaque SEGMENT est encode (`encodeURIComponent`) : un `%` litteral ou une
// espace dans un nom de piece jointe traverse alors l'URL intact. Le decodage se
// fait UNE seule fois, dans `mediaRequestPath`, a la frontiere URL : ni
// `resolveMediaPath` (utilisee a l'ecriture) ni le handler ne decodent.
const MEDIA_SCHEME = 'media';
const MEDIA_HOST = 'mirror';
function mediaUrlFor(relPath) {
  const segments = String(relPath).split('/').map(encodeURIComponent);
  return `${MEDIA_SCHEME}://${MEDIA_HOST}/${segments.join('/')}`;
}

// LE garde anti-traversee du projet.
//
// `relPath` vient d'une piece jointe Discord, donc d'une donnee que rien ne
// garantit. `..` y est legal. La fonction est PURE et NE DECODE PAS : le
// decodage d'URL appartient a `mediaRequestPath`, seule frontiere URL du module.
// Melanger les deux faisait qu'un `%` LITTERAL (`100%off.png`) ecrit par
// `downloadMirror` etait re-decode a la lecture, ce qui levait (`URI malformed`)
// ou redirigeait vers un sous-dossier (`%2f`).
//
// Elle normalise AVANT de comparer, puis mesure l'ecart avec
// `path.relative(root, resolved)` :
//
//   - un resultat qui COMMENCE par `..` designe un parent de la racine ;
//   - un resultat ABSOLU designe un autre volume, que `path.relative` n'a pas su
//     rendre relatif (lecteur different sous Windows) ;
//   - un resultat VIDE (`relPath` vide, `'.'`, `'foo/..'`) se normalise sur la
//     racine ELLE-MEME : la postcondition exige « strictement SOUS » la racine,
//     donc c'est refuse aussi.
// Dans ces cas, et sur un OCTET NUL (qui tronque un chemin au niveau du systeme
// de fichiers), on rend `null` : rien qui ne soit strictement sous la racine ne
// peut etre ecrit ou lu.
//
// Un chemin ABSOLU en entree (`/etc/passwd`, `C:\...`) est refuse avant meme le
// `join` : `path.join` le recolle sous la racine, donc le comparer apres coup
// ne le verrait pas.
//
// Un `%2e%2e` arrive ici LITTERAL : c'est le nom d'un dossier, SOUS la racine.
// C'est `mediaRequestPath` qui le decode en `..` et refuse alors la traversee.
function resolveMediaPath(rootDir, relPath) {
  if (typeof rootDir !== 'string' || rootDir === '') return null;
  if (typeof relPath !== 'string') return null;
  if (relPath.includes('\u0000')) return null;
  if (path.isAbsolute(relPath)) return null;

  const racine = path.resolve(rootDir);
  const resolu = path.resolve(path.join(racine, relPath));
  const relatif = path.relative(racine, resolu);
  if (relatif === '') return null;
  if (relatif.startsWith('..') || path.isAbsolute(relatif)) return null;
  return resolu;
}

// Le chemin ABSOLU d'une requete `media://`, ou `null` si elle sort de la racine.
//
// C'EST LA FRONTIERE URL DU MODULE, et le SEUL endroit qui decode. Le `pathname`
// d'une URL standard commence TOUJOURS par `/` et arrive encore encode
// (`'%20'`, `'%25'`) :
//
//   1. on retire le `/` de tete, que `resolveMediaPath` refuserait comme absolu ;
//   2. on `decodeURIComponent` UNE fois, dans un `try/catch` : un encodage pour
//      cent malforme (`'%E0%A4%A'`) rend `null` plutot que de jeter ;
//   3. on delegue au garde PUR, qui n'a plus qu'a normaliser et comparer.
//
// Decoder une deuxieme fois (`resolveMediaPath` le faisait) casserait un `%`
// LITTERAL : `100%off.png` traverse l'ecriture brut, mais serait decode ici,
// puis re-decode la, et leverait.
function mediaRequestPath(rootDir, urlPathname) {
  if (typeof urlPathname !== 'string') return null;
  const relatif = urlPathname.startsWith('/') ? urlPathname.slice(1) : urlPathname;
  let decode;
  try {
    decode = decodeURIComponent(relatif);
  } catch (error) {
    return null;
  }
  return resolveMediaPath(rootDir, decode);
}

// Vrai si `candidate` (chemin ABSOLU, DEJA passe par `fs.realpath`) est
// STRICTEMENT sous `rootDir`.
//
// Le handler du protocole `media://` s'en sert APRES `realpath` : la garde
// lexicale de `resolveMediaPath` ne voit pas les LIENS SYMBOLIQUES, or
// `realpath` les suit. `resolveMediaPath` reste donc pure (aucun `fs`), et ce
// controle reste, lui aussi, purement lexical — donc testable sans disque.
function isMediaPathInside(rootDir, candidate) {
  if (typeof rootDir !== 'string' || rootDir === '') return false;
  if (typeof candidate !== 'string' || candidate === '') return false;
  const racine = path.resolve(rootDir);
  const relatif = path.relative(racine, path.resolve(candidate));
  return relatif !== '' && !relatif.startsWith('..') && !path.isAbsolute(relatif);
}

// Analyse d'un en-tete HTTP `Range` (forme simple `bytes=a-b`, `bytes=a-`,
// `bytes=-n`). PURE et testable sans disque ni Electron.
//
// Retourne :
//   - `null`       : en-tete absent ou illisible (l'appelant sert tout le fichier) ;
//   - `'invalid'`  : plage syntaxiquement lisible mais hors fichier -> 416 (l'API
//     `Response` ne permet pas de distinguer « pas de plage » de « plage
//     invalide » par un objet, d'ou la sentinelle) ;
//   - `{ start, end }` : bornes INCLUSIVES, `end` borne a `size - 1`.
function parseByteRange(header, size) {
  if (typeof header !== 'string' || header.trim() === '') return null;
  const correspondance = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!correspondance) return null;
  const [, debutBrut, finBrut] = correspondance;
  if (debutBrut === '' && finBrut === '') return null;
  const taille = Number(size);
  if (!Number.isFinite(taille) || taille <= 0) return 'invalid';

  let debut;
  let fin;
  if (debutBrut === '') {
    // Forme suffixe : les `n` derniers octets.
    const n = Number(finBrut);
    if (!Number.isFinite(n) || n <= 0) return 'invalid';
    debut = Math.max(0, taille - n);
    fin = taille - 1;
  } else {
    debut = Number(debutBrut);
    fin = finBrut === '' ? taille - 1 : Number(finBrut);
    if (!Number.isFinite(debut) || !Number.isFinite(fin)) return 'invalid';
    if (fin > taille - 1) fin = taille - 1;
  }
  if (debut >= taille || debut > fin) return 'invalid';
  return { start: debut, end: fin };
}

// Le manifeste d'un dossier de miroir, ou `{}` s'il est absent ou illisible.
//
// Une tache ulterieure s'en sert pour savoir ce qui a deja ete telecharge : un
// manifeste absent doit donc se lire « rien de telecharge », jamais lever. Un
// JSON tronque — ecriture interrompue — se lit de meme : c'est le role du
// fichier temporaire de `writeManifest`, mais la lecture reste tolerante.
function readManifest(dir) {
  try {
    const contenu = fs.readFileSync(path.join(dir, MANIFEST_FILE_NAME), 'utf8');
    const parsed = JSON.parse(contenu);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    return {};
  }
}

// Ecrit le manifeste SANS jamais en laisser un a demi ecrit.
//
// On ecrit d'abord un fichier temporaire DANS le meme dossier (donc sur le meme
// volume, condition d'un renommage atomique), puis on le renomme sur le nom
// final. Un lecteur voit soit l'ancien manifeste, soit le nouveau, jamais un
// fichier tronque. Le nom temporaire porte le PID et un compteur pour qu'aucun
// appel concurrent ne puisse ecraser le temporaire d'un autre.
let compteurTemporaire = 0;
function writeManifest(dir, manifest) {
  fs.mkdirSync(dir, { recursive: true });
  compteurTemporaire += 1;
  const temporaire = path.join(dir, `${MANIFEST_FILE_NAME}.${process.pid}.${compteurTemporaire}.tmp`);
  const donnees = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(temporaire, donnees, 'utf8');
  try {
    fs.renameSync(temporaire, path.join(dir, MANIFEST_FILE_NAME));
  } catch (error) {
    // Un renommage rate ne doit pas laisser son temporaire derriere lui.
    try {
      fs.unlinkSync(temporaire);
    } catch (nettoyage) {
      // Rien de plus a faire : le temporaire sera ecrase par un prochain appel.
    }
    throw error;
  }
}

// ===========================================================================
// TACHE 2 : le plan de telechargement et la boucle.
//
// Aucun reseau ici non plus : le transport est INJECTE
// (`{ head(url) => Promise<number>, get(url) => Promise<Buffer|Readable> }`). La
// tache 3 branchera le vrai (axios) sans toucher a cette logique, qui se teste
// donc sous Node nu. BUG-004 : un `Readable` est ecrit en flux vers le disque,
// jamais materialise en memoire.
// ===========================================================================

// Le nombre de telechargements simultanes. Quatre : assez pour tenir une
// liaison occupee sans noyer l'hote distant ni le systeme de fichiers, et assez
// petit pour que le pool reste lisible et verifiable.
const MIRROR_CONCURRENCY = 4;

// La categorie d'une piece jointe, LUE dans `item.kind`. Le `kind` est fourni
// par l'appelant (le renderer, via `mediaKindOf`) : ce module CommonJS ne peut
// pas importer `attachmentKind` (module ESM), et ne devine donc AUCUNE
// extension. Tout ce qui n'est ni image, ni audio, ni video est un fichier.
function mirrorCategory(kind) {
  if (kind === 'image') return 'photo';
  if (kind === 'audio') return 'audio';
  if (kind === 'video') return 'video';
  return 'file';
}

// L'ordre de telechargement : les photos d'abord — petites, nombreuses, elles
// rendent vite une galerie utilisable — puis l'audio, puis les fichiers, et
// enfin les videos, les plus lourdes. Le rang EST cet ordre. Une categorie
// inconnue retombe sur celui des fichiers, pour ne jamais rendre `undefined`.
const RANGS_CATEGORIE = { photo: 0, audio: 1, file: 2, video: 3 };
function mirrorCategoryRank(category) {
  const rang = RANGS_CATEGORIE[category];
  return rang === undefined ? RANGS_CATEGORIE.file : rang;
}

// Le PLAN : les URL a telecharger, triees par categorie, en SAUTANT celles qui
// sont deja `done` dans le manifeste. Un `error` est REESSAYE : c'est tout
// l'interet du manifeste — ne pas refaire ce qui a reussi, sans abandonner ce
// qui a echoue.
//
// Le tri de `Array` est STABLE depuis ES2019 : a rang egal, l'ordre d'entree
// des pieces jointes est conserve. On filtre AVANT de trier, donc les elements
// hors plan ne decalent rien.
function planDownloads(items, manifest) {
  const etat = manifest && typeof manifest === 'object' ? manifest : {};
  const liste = Array.isArray(items) ? items : [];
  return liste
    .filter(item => item && typeof item.url === 'string')
    .filter(item => {
      const entree = etat[item.url];
      return !(entree && entree.state === 'done');
    })
    .sort((a, b) => mirrorCategoryRank(mirrorCategory(a.kind)) - mirrorCategoryRank(mirrorCategory(b.kind)))
    .map(item => item.url);
}

// Le message d'une erreur, sans supposer que c'en est une (une valeur jetee
// peut etre une chaine).
function messageErreur(error) {
  return error && error.message ? error.message : String(error);
}

// LA BOUCLE. Traite le plan avec un POOL de `concurrency` workers qui tirent
// chacun l'index suivant : il n'y a donc jamais plus de `concurrency` fichiers
// en vol. Chaque fichier est ecrit a
// `resolveMediaPath(rootDir, mediaRelPath(key, channelId, url, fileName))` ; le
// chemin est RE-VERIFIE juste avant d'ecrire.
//
// Le manifeste n'inscrit un fichier `done` QU'APRES une ecriture complete dont
// la taille egale l'octet annonce par `head`. Sinon : `{ state: 'error' }`, le
// partiel est supprime, et la boucle CONTINUE — un echec isole ne doit pas
// arreter 2 208 pieces jointes. `shouldStop()` est consulte AVANT chaque
// fichier : vrai, on s'arrete sans avoir rien ouvert pour ce fichier, donc sans
// partiel, et `cancelled` vaut `true`.
async function downloadMirror(options) {
  const {
    rootDir,
    key,
    items,
    transport,
    shouldStop,
    onProgress,
    concurrency = MIRROR_CONCURRENCY,
    maxBytes = 0,
  } = options || {};

  const dir = path.join(rootDir, key);
  const manifest = readManifest(dir);
  const urls = planDownloads(items, manifest);

  // Les items par URL, pour retrouver `channelId` et `fileName` au moment de
  // construire le chemin.
  const parUrl = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (item && typeof item.url === 'string' && !parUrl.has(item.url)) {
      parUrl.set(item.url, item);
    }
  }

  const resultat = { done: 0, failed: 0, cancelled: false, bytesDownloaded: 0, bytesTotal: 0 };
  let suivant = 0;

  // BUG-012 : la progression compte les fichiers TRAITES (reussis + echoues).
  // Sans cela, une piece jointe en echec ne faisait jamais avancer la barre
  // jusqu'au total. Le resume final garde, lui, `done` = seuls les succes.
  const publierProgression = url => {
    if (!onProgress) return;
    onProgress({ ...resultat, done: resultat.done + resultat.failed, current: url });
  };

  // Supprime un partiel sans jamais jeter : s'il n'existe pas, il n'y a rien a
  // faire, et un echec de suppression ne doit pas masquer l'echec d'origine.
  const retirer = chemin => {
    if (!chemin) return;
    try {
      fs.rmSync(chemin, { force: true });
    } catch (error) {
      // Le partiel restera, mais l'erreur d'origine est celle qui compte.
    }
  };

  // BUG-004 : ecrit dans un temporaire puis renomme. Un Buffer marche comme
  // avant ; un flux est pompe vers le disque sans jamais tenir le fichier
  // entier en memoire. `maxBytes` coupe un flux anormalement gros.
  const ecrire = async (cible, contenu, attenduOctets) => {
    fs.mkdirSync(path.dirname(cible), { recursive: true });
    const temporaire = `${cible}.${process.pid}.part`;
    try {
      if (Buffer.isBuffer(contenu) || contenu instanceof Uint8Array) {
        fs.writeFileSync(temporaire, contenu);
      } else if (contenu && typeof contenu.pipe === 'function') {
        const limite = Number(maxBytes) > 0 ? Number(maxBytes) : 0;
        if (limite > 0) {
          let recus = 0;
          const compteur = new Transform({
            transform(chunk, _encodage, callback) {
              recus += chunk.length;
              if (recus > limite) {
                callback(new Error(`fichier trop volumineux (> ${limite} octets)`));
                return;
              }
              callback(null, chunk);
            },
          });
          await pipeline(contenu, compteur, fs.createWriteStream(temporaire));
        } else {
          await pipeline(contenu, fs.createWriteStream(temporaire));
        }
      } else {
        throw new Error('contenu média invalide');
      }
      const ecrits = fs.statSync(temporaire).size;
      // BUG-012 : on ne compare la taille que si `head` a annonce une longueur
      // (> 0). Sans en-tete `content-length`, `attendu` valait 0 et TOUT fichier
      // non vide etait marque en erreur a tort.
      if (attenduOctets > 0 && ecrits !== attenduOctets) {
        throw new Error(`taille inattendue : ${ecrits} octets ecrits, ${attenduOctets} attendus`);
      }
      fs.renameSync(temporaire, cible);
      return ecrits;
    } catch (error) {
      retirer(temporaire);
      throw error;
    }
  };

  const traiter = async url => {
    const item = parUrl.get(url) || { url };
    // Le chemin est fige MAINTENANT, depuis des donnees venues de Discord.
    const cible = resolveMediaPath(rootDir, mediaRelPath(key, item.channelId, item.url, item.fileName));
    if (!cible) {
      resultat.failed += 1;
      manifest[url] = { state: 'error', error: 'chemin refuse' };
      writeManifest(dir, manifest);
      publierProgression(url);
      return;
    }

    let attendu;
    try {
      attendu = await transport.head(url);
    } catch (error) {
      resultat.failed += 1;
      manifest[url] = { state: 'error', error: messageErreur(error) };
      writeManifest(dir, manifest);
      publierProgression(url);
      return;
    }
    const attenduOctets = Number(attendu) || 0;
    resultat.bytesTotal += attenduOctets;

    let contenu;
    try {
      contenu = await transport.get(url);
    } catch (error) {
      // Un `get` qui jette n'a rien ecrit : aucun partiel a retirer.
      resultat.failed += 1;
      manifest[url] = { state: 'error', error: messageErreur(error) };
      writeManifest(dir, manifest);
      publierProgression(url);
      return;
    }

    try {
      const ecrits = await ecrire(cible, contenu, attenduOctets);
      // `done` SEULEMENT ici : ecriture terminee ET taille verifiee.
      manifest[url] = { state: 'done', bytes: ecrits };
      resultat.done += 1;
      resultat.bytesDownloaded += ecrits;
    } catch (error) {
      // `ecrire` a deja supprime son temporaire ; on nettoie aussi un ancien
      // partiel eventuel reste sur le chemin final.
      retirer(cible);
      resultat.failed += 1;
      manifest[url] = { state: 'error', error: messageErreur(error) };
    }
    writeManifest(dir, manifest);
    publierProgression(url);
  };

  const worker = async () => {
    for (;;) {
      if (resultat.cancelled) return;
      // AVANT d'ouvrir le fichier : une annulation ici ne laisse aucun partiel,
      // puisqu'aucune ecriture n'a commence.
      if (typeof shouldStop === 'function' && shouldStop()) {
        resultat.cancelled = true;
        return;
      }
      const index = suivant;
      suivant += 1;
      if (index >= urls.length) return;
      await traiter(urls[index]);
    }
  };

  const nbWorkers = Math.max(1, Math.min(Number(concurrency) || 1, urls.length || 1));
  await Promise.all(Array.from({ length: nbWorkers }, () => worker()));

  return resultat;
}

module.exports = {
  MIRROR_DIR_NAME,
  MIRROR_KEY_LENGTH,
  MIRROR_HASH_LENGTH,
  MIRROR_CONCURRENCY,
  mediaMirrorKey,
  sanitizeMediaName,
  mediaHash8,
  mediaFileName,
  mediaRelPath,
  mediaUrlFor,
  mediaRequestPath,
  resolveMediaPath,
  isMediaPathInside,
  parseByteRange,
  readManifest,
  writeManifest,
  mirrorCategory,
  mirrorCategoryRank,
  planDownloads,
  downloadMirror,
};
