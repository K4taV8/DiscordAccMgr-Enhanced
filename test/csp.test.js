import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// --- Pourquoi un parseur, et pas des motifs ---------------------------------
// La CSP est une LISTE de directives. Une directive a un nom, une valeur qui
// est un ENSEMBLE de sources, et en cas de doublon Chromium n'en applique que
// la PREMIÈRE occurrence. Un motif regex ne connaît rien de tout cela et laisse
// passer trois faux verts : `[^"]*` traverse le point-virgule et retrouve le
// CDN dans img-src alors que media-src vaut 'none' ; `connect-src 'self'\s*$`
// accepte un doublon qui ouvre le CDN juste avant ; et l'ordre des directives
// décide du résultat alors qu'il n'a aucune signification. On parse donc en
// table et on compare des ensembles triés : ni l'ordre des directives ni
// l'ordre des sources n'a de sens, donc aucun des deux ne doit pouvoir faire
// rougir le test.

const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

// Toutes les balises meta CSP, pas seulement la première : Chromium applique
// chacune d'elles, donc une seconde doit faire rougir le test.
const BALISE_CSP = /<meta\b[^>]*http-equiv\s*=\s*["']?Content-Security-Policy["']?[^>]*>/gi;

// La spec CSP découpe sur les ESPACEMENTS ASCII : six caractères, tous
// acceptés comme séparateurs par Chromium (espace, tabulation, saut de ligne,
// retour chariot, saut de page, saut de ligne vertical). En n'en retenant
// qu'un, on laissait passer `worker-src<TAB>https://cdn.discordapp.com` : le
// nom d'une directive non épinglée devenait un seul jeton sans source, et la
// règle « origine distante » passait au vide. Un `\s` de JS conviendrait mal
// dans l'autre sens : il mange aussi les espaces Unicode (nbsp, idéographiques)
// que le navigateur ne reconnaît PAS comme séparateurs, donc on verrait une
// ouverture là où il n'y en a pas. La classe est écrite en toutes lettres.
// Chromium retire aussi le `:` éventuel en fin de nom de directive (grammar
// CSP2, format d'en-tête hérité), donc on le retire aussi.
const ESPACEMENT = /[ \t\n\r\f\v]/;

// nom de directive -> ENSEMBLE de sources. Les noms passent en minuscules (la
// spec les déclare insensibles à la casse) et un doublon est IGNORÉ : c'est la
// règle du navigateur, donc vérifier autre chose reviendrait à tester une
// directive que le navigateur ne lit pas.
function directivesCsp() {
  const balises = [...HTML.matchAll(BALISE_CSP)]
    .map((m) => /\bcontent\s*=\s*"([^"]*)"/.exec(m[0])?.[1] ?? '');
  const table = new Map();
  const doublons = [];
  for (const brute of (balises[0] ?? '').split(';')) {
    const d = brute.trim();
    if (!d) continue;
    const i = d.search(ESPACEMENT);
    let nom = i === -1 ? d : d.slice(0, i);
    if (nom.endsWith(':')) nom = nom.slice(0, -1);
    nom = nom.toLowerCase();
    if (table.has(nom)) {
      doublons.push(nom);
      continue;
    }
    // Directive sans valeur : elle n'accorde rien, donc un ensemble VIDE,
    // Decide explicitement plutot que par effet de bord. `new Set('')` donnait
    // deja un ensemble vide (chaine iterable et vide), mais `new Set(' ')` aurait
    // donne { ' ' } : on normalise donc la valeur avant de la filtrer.
    const valeur = (i === -1 ? '' : d.slice(i)).trim();
    table.set(nom, valeur === '' ? new Set() : new Set(valeur.split(ESPACEMENT).filter(Boolean)));
  }
  return { balises, table, doublons };
}

// Ensembles comparés comme chaînes triées : l'ordre des sources dans une
// directive n'a pas de sens, donc `img-src data: 'self'` et
// `img-src 'self' data:` sont la même CSP.
const liste = (sources) => [...sources].sort().join(' ');

function assertDirective(table, nom, attendu, pourquoi) {
  const trouve = table.get(nom);
  const attenduTri = liste(new Set(attendu));
  assert.ok(trouve, `la CSP doit déclarer ${nom} : ${pourquoi}`);
  assert.equal(liste(trouve), attenduTri,
    `${nom} doit valoir exactement {${attenduTri}}, pas {${liste(trouve)}} : ${pourquoi}`);
}

// Jetons qui n'ouvrent aucune origine distante. Une directive ajoutée plus
// tard et qui n'utilise que ceux-là ne peut pas transformer le renderer en
// client réseau, quel que soit son nom.
const LOCAUX = new Set(["'self'", "'none'", 'data:', 'blob:']);

test('une seule balise CSP dans index.html, avec un contenu exploitable', () => {
  const { balises } = directivesCsp();
  assert.equal(balises.length, 1,
    `une seconde balise CSP serait elle aussi appliquée par le navigateur (trouvées : ${balises.length})`);
  assert.ok(balises[0].trim(),
    'la balise CSP a un attribut content vide : les tests suivants ne regarderaient que du vide');
  assert.match(balises[0], /(^|;)\s*default-src\b/,
    'la CSP lue doit contenir default-src, sinon on compare autre chose');
});

// Le correctif de la tâche 1, vérifié sans reliance à l'ordre des directives :
// la valeur exacte de media-src, pas « le CDN est-il mentionné quelque part ».
test('media-src accorde exactement le CDN Discord et le média local', () => {
  const { table } = directivesCsp();
  assertDirective(table, 'media-src', ["'self'", 'https://cdn.discordapp.com', 'media:'],
    "sans le CDN les .mp4 du data package restent des rectangles noirs à contrôles inertes ; sans 'self' plus aucun média local ne se lit ; sans media: la copie du miroir est refusée au chargement");
  assertDirective(table, 'img-src', ["'self'", 'data:', 'https://cdn.discordapp.com', 'media:'],
    "img-src et media-src sont les deux seules directives autorisées à toucher le CDN, et img-src doit le rester exactement, 'self', data: et media: compris");
});

// Tâche 4 : `media:` sert les copies locales téléchargées par le miroir. Sans
// ce jeton, la CSP refuse le schéma et la copie est rejetée au chargement,
// exactement comme le CDN l'était avant le plan 1. On repin les invariants
// S3/S4 dans le même souffle pour qu'aucun ajout ne les ouvre en douce.
test('img-src et media-src autorisent le schéma media: du miroir', () => {
  const { table } = directivesCsp();
  assert.ok(table.get('img-src').has('media:'),
    'la copie locale se charge dans les <img>');
  assert.ok(table.get('media-src').has('media:'),
    'la copie locale se lit dans <video>/<audio>');
  assert.deepEqual([...table.get('connect-src')], ["'self'"], 'connect-src reste verrouillé');
  assert.deepEqual([...table.get('script-src')], ["'self'"], 'script-src reste verrouillé');
});

// README l. 269 (S3) : connect-src 'self'. Une XSS du renderer ne doit pas
// pouvoir exfiltrer les tokens par fetch, donc aucune origine distante.
test("default-src et connect-src restent verrouillés sur 'self'", () => {
  const { table } = directivesCsp();
  assertDirective(table, 'default-src', ["'self'"],
    "toute directive non déclarée retombe dessus : un '*' ouvrirait le renderer entier");
  assertDirective(table, 'connect-src', ["'self'"],
    "le renderer ne doit pas pouvoir fetch une origine distante (README S3, ligne 269) ; un doublon dont la première occurrence est plus large n'échappe pas à cette comparaison");
});

// README l. 270 (S4) : script-src 'self'. La seule concession inline du dépôt
// est sur style-src, pas sur les scripts.
test("script-src reste verrouillé sur 'self', sans concession inline", () => {
  const { table } = directivesCsp();
  assertDirective(table, 'script-src', ["'self'"],
    "toute concession ici ('unsafe-inline', un doublon plus large en tête) rouvre une XSS du renderer (README S4, ligne 270)");
});

test('style-src garde la seule concession inline du dépôt', () => {
  const { table } = directivesCsp();
  assertDirective(table, 'style-src', ["'self'", "'unsafe-inline'"],
    "les styles inline sont tolérés ici, et c'est tout : ni '*' ni https:, sinon cette concession devient un couloir");
});

// Couvre les directives qu'on n'a pas énumérées : le mutant worker-src distant
// meurt ici, mais un font-src 'self' ou un frame-ancestors 'none' passe, parce
// qu'aucune des deux n'ouvre d'origine distante.
test("aucune directive, hors img-src et media-src, n'accorde d'origine distante", () => {
  const { table } = directivesCsp();
  for (const [nom, sources] of table) {
    if (nom === 'img-src' || nom === 'media-src') continue; // épinglées valeur exacte plus haut
    const ouvertes = [...sources].filter((s) => !LOCAUX.has(s)
      && !(s === "'unsafe-inline'" && nom === 'style-src'));
    assert.deepEqual(ouvertes, [],
      `${nom} n'accorde que des sources locales (${liste(LOCAUX)}), plus 'unsafe-inline' sur style-src ; or elle accorde ${liste(ouvertes)}`);
  }
});

test("aucune directive n'est déclarée deux fois", () => {
  const { doublons } = directivesCsp();
  assert.deepEqual(doublons, [],
    `en doublon, seule la première occurrence compte : réordonner la CSP changerait alors sa portée sans que le diff le montre (doublons : ${doublons.join(', ')})`);
});

// Durcissement b3829aa : quatre directives fermées par défaut, chacune réduite
// à une seule source. On les épingle à la valeur exacte (pas seulement « le
// jeton est présent ») pour qu'un élargissement — un `object-src *`, une
// `base-uri` distante, une `form-action` qui poste ailleurs, un
// `frame-ancestors` ouvert — fasse rougir le test au lieu de passer en douce.
test('directives durcies : object-src, base-uri, form-action, frame-ancestors', () => {
  const { table } = directivesCsp();
  assertDirective(table, 'object-src', ["'none'"],
    "un plugin/embed distant ne doit jamais s'exécuter dans le renderer (ferme la famille <object>/<embed>)");
  assertDirective(table, 'base-uri', ["'self'"],
    "sans elle, une <base> injectée détourne silencieusement toutes les URL relatives de la page");
  assertDirective(table, 'form-action', ["'self'"],
    "aucune saisie ne doit pouvoir être postée vers une origine distante (exfiltration par formulaire)");
  assertDirective(table, 'frame-ancestors', ["'none'"],
    "l'app ne doit jamais pouvoir être encadrée par un site distant (clickjacking)");
});
