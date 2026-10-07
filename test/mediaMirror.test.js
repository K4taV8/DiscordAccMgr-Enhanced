// Tests du socle du miroir media : cle stable, noms assainis, chemins
// anti-traversee, manifeste. Le service est un module CommonJS, teste sous Node
// nu (aucun Electron), donc charge via createRequire depuis ce fichier ESM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  mediaMirrorKey,
  sanitizeMediaName,
  mediaHash8,
  mediaFileName,
  mediaRelPath,
  mediaUrlFor,
  mediaRequestPath,
  resolveMediaPath,
  isMediaPathInside,
  readManifest,
  writeManifest,
  mirrorCategory,
  mirrorCategoryRank,
  planDownloads,
  downloadMirror,
  MIRROR_CONCURRENCY,
  MIRROR_DIR_NAME,
  MIRROR_KEY_LENGTH,
  MIRROR_HASH_LENGTH,
} = require('../electron/mediaMirror.service.cjs');

// Clé stable : l'ordre et les doublons ne comptent pas, le renommage d'export non plus.
test('mediaMirrorKey : meme cle quel que soit l ordre et les doublons', () => {
  const urls = ['https://cdn.discordapp.com/a/1.png', 'https://cdn.discordapp.com/a/2.mp4'];
  assert.equal(mediaMirrorKey(urls), mediaMirrorKey([...urls].reverse()));
  assert.equal(mediaMirrorKey(urls), mediaMirrorKey([...urls, urls[0]]));
  assert.notEqual(mediaMirrorKey(urls), mediaMirrorKey([...urls, 'https://cdn.discordapp.com/a/3.gif']));
  assert.equal(mediaMirrorKey(urls).length, 12);
  assert.equal(mediaMirrorKey(urls).length, MIRROR_KEY_LENGTH);
  assert.equal(mediaMirrorKey([]), '');
});

test('mediaMirrorKey : les URL vides sont ignorees, un tableau invalide rend une chaine vide', () => {
  const urls = ['https://cdn.discordapp.com/a/1.png'];
  assert.equal(mediaMirrorKey([...urls, '']), mediaMirrorKey(urls));
  assert.equal(mediaMirrorKey(['', '']), '');
  assert.equal(mediaMirrorKey(null), '');
  assert.equal(mediaMirrorKey(undefined), '');
  assert.equal(mediaMirrorKey('pas un tableau'), '');
});

// Nom hostile : caracteres Windows interdits, point final, espaces finaux.
test('sanitizeMediaName : caracteres Windows interdits, point final, espaces finaux', () => {
  assert.equal(sanitizeMediaName('a<b>c:d"e/f\\g|h?i*j.png'), 'a_b_c_d_e_f_g_h_i_j.png');
  assert.equal(sanitizeMediaName('photo.png... '), 'photo.png');
  assert.equal(sanitizeMediaName('   '), 'piece-jointe');
  assert.equal(sanitizeMediaName(''), 'piece-jointe');
});

test('sanitizeMediaName : caracteres de controle, points seuls, entrees non-chaines', () => {
  assert.equal(sanitizeMediaName('a\u0000b\u001fc'), 'a_b_c');
  assert.equal(sanitizeMediaName('...'), 'piece-jointe');
  assert.equal(sanitizeMediaName('   ...   '), 'piece-jointe');
  assert.equal(sanitizeMediaName('nom.'), 'nom');
  assert.equal(sanitizeMediaName('nom '), 'nom');
  assert.equal(sanitizeMediaName(42), 'piece-jointe');
});

test('mediaHash8 : 8 caracteres hexadecimaux du SHA-1 de l URL', () => {
  const url = 'https://x/photo.png';
  assert.equal(mediaHash8(url).length, MIRROR_HASH_LENGTH);
  assert.match(mediaHash8(url), /^[0-9a-f]{8}$/);
  assert.equal(mediaHash8(url), mediaHash8(url));
  assert.notEqual(mediaHash8('https://x/a.png'), mediaHash8('https://x/b.png'));
});

test('mediaFileName : commence par le hash de l URL', () => {
  const url = 'https://x/photo.png';
  assert.equal(mediaFileName(url, 'photo.png'), `${mediaHash8(url)}-photo.png`);
  assert.ok(mediaFileName(url, 'a<b>.png').startsWith(mediaHash8(url)));
  assert.equal(mediaFileName(url, 'a<b>.png'), `${mediaHash8(url)}-a_b_.png`);
});

test('mediaRelPath : la cle est le premier segment, tout est assaini', () => {
  const rel = mediaRelPath('k', 'c', 'https://x/photo.png', 'photo.png');
  assert.ok(rel.startsWith('k/c/'));
  assert.ok(rel.endsWith('photo.png'));
  assert.equal(rel, `k/c/${mediaFileName('https://x/photo.png', 'photo.png')}`);
});

test('mediaRelPath : chaque segment passe par sanitizeMediaName', () => {
  const rel = mediaRelPath('k:1', 'c/2', 'https://x/photo.png', 'p:j.png');
  assert.equal(rel, `k_1/c_2/${mediaHash8('https://x/photo.png')}-p_j.png`);
});

// Traversee : tout ce qui sort de la racine est refuse. F1 : `resolveMediaPath`
// ne DECODE plus ; le decodage appartient a `mediaRequestPath`, a la frontiere
// URL. Le garde ne fait plus que normaliser (`path.join` + `path.resolve`) et
// comparer (`path.relative`).
test('resolveMediaPath : refuse tout ce qui sort de la racine', () => {
  const root = 'C:/data/media';
  assert.equal(resolveMediaPath(root, '..'), null);
  assert.equal(resolveMediaPath(root, '../secret.txt'), null);
  assert.equal(resolveMediaPath(root, 'key/chan/ok.png'), 'C:/data/media/key/chan/ok.png'.replace(/\//g, path.sep));
  assert.equal(resolveMediaPath(root, '/etc/passwd'), null);
  assert.equal(resolveMediaPath(root, 'key/../../secret'), null);
});

test('resolveMediaPath : octet nul litteral et entrees non-chaines', () => {
  const root = 'C:/data/media';
  assert.equal(resolveMediaPath(root, 'key/\u0000evil'), null);
  assert.equal(resolveMediaPath(root, null), null);
  assert.equal(resolveMediaPath(null, 'a'), null);
});

// F1 : un `%` LITTERAL n'est plus decode par `resolveMediaPath`. `%2e%2e` y est
// un nom de dossier ordinaire, SOUS la racine (pas `null`) ; `%00` y est un nom,
// pas un octet nul. C'est le point cle de la correction.
test('resolveMediaPath : un % litteral est un nom, pas un encodage (F1)', () => {
  const root = 'C:/data/media';
  assert.equal(resolveMediaPath(root, 'key/%2e%2e/x.png'), path.resolve(root, 'key/%2e%2e/x.png'));
  assert.equal(resolveMediaPath(root, 'key/%00evil'), path.resolve(root, 'key/%00evil'));
});

test('resolveMediaPath : un dossier frere au prefixe commun est refuse', () => {
  const root = 'C:/data/media';
  assert.equal(resolveMediaPath(root, '../media-evil/x.png'), null);
  assert.equal(resolveMediaPath(root, '..\\media-evil\\x.png'), null);
});

// Ronde de correction 1 : un chemin qui se normalise sur la racine ELLE-MEME
// n'est pas « strictement sous » la racine, donc il est refuse. Sans cette
// garde, `resolveMediaPath(root, '')` rendait la racine, et un appelant qui ne
// verifiait pas le prefixe aurait pu ecrire a la racine du miroir.
test('resolveMediaPath : un chemin qui se normalise sur la racine est refuse', () => {
  const root = 'C:/data/media';
  assert.equal(resolveMediaPath(root, ''), null);
  assert.equal(resolveMediaPath(root, '.'), null);
  assert.equal(resolveMediaPath(root, './'), null);
  assert.equal(resolveMediaPath(root, 'foo/..'), null);
  assert.equal(resolveMediaPath(root, 'foo/../.'), null);
  assert.equal(resolveMediaPath(root, 'foo/bar/../..'), null);
});

test('resolveMediaPath : accepte un chemin profond legitime, strictement sous la racine', () => {
  const root = 'C:/data/media';
  const resolved = resolveMediaPath(root, 'k/c/h-p.png');
  assert.equal(resolved, path.resolve(root, 'k/c/h-p.png'));
  assert.ok(resolved.startsWith(path.resolve(root) + path.sep));
});

// Manifeste : aller-retour, et absence rend {} sans jeter.
test('readManifest : absence et illisibilite rendent {} sans jeter', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miroir-'));
  try {
    assert.deepEqual(readManifest(dir), {});
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{ coupe', 'utf8');
    assert.deepEqual(readManifest(dir), {});
    assert.deepEqual(readManifest(path.join(dir, 'dossier-absent')), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeManifest/readManifest : aller-retour, ecrasement, aucun temporaire laisse', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miroir-'));
  try {
    const manifest = { key: 'abc', files: [{ rel: 'k/c/x.png', bytes: 12 }] };
    writeManifest(dir, manifest);
    assert.deepEqual(readManifest(dir), manifest);

    const second = { key: 'def', files: [] };
    writeManifest(dir, second);
    assert.deepEqual(readManifest(dir), second);

    const restants = fs.readdirSync(dir).filter(nom => nom !== 'manifest.json');
    assert.deepEqual(restants, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('constantes du miroir', () => {
  assert.equal(MIRROR_DIR_NAME, 'media');
  assert.equal(MIRROR_KEY_LENGTH, 12);
  assert.equal(MIRROR_HASH_LENGTH, 8);
});

// ---------------------------------------------------------------------------
// TACHE 3 : l'URL du protocole `media://` et le chemin d'une requete.
// ---------------------------------------------------------------------------

// `mediaUrlFor` prend le chemin RELATIF COMPLET sous `data/media`, cle incluse,
// et le prefixe du schema. Le handler remappe le pathname de l'URL sous
// `data/media` : une URL `media://` standard doit donc rendre ce chemin tel quel.
test('mediaUrlFor : prefixe media://mirror/ et pathname preserve', () => {
  assert.equal(mediaUrlFor('k/c/f.png'), 'media://mirror/k/c/f.png');
  assert.equal(decodeURIComponent(new URL(mediaUrlFor('k/c/f.png')).pathname), '/k/c/f.png');
});

test('mediaUrlFor : compose avec mediaRelPath, cle incluse', () => {
  const rel = mediaRelPath('k', 'c', 'https://x/photo.png', 'photo.png');
  assert.equal(mediaUrlFor(rel), `media://mirror/${rel}`);
  assert.equal(decodeURIComponent(new URL(mediaUrlFor(rel)).pathname), `/${rel}`);
});

// Ronde de correction 1 / F2 : chaque segment est encode, donc un `%` litteral
// ou une espace traverse l'URL sans etre pris pour un debut d'encodage.
test('mediaUrlFor : encode chaque segment (%, espaces)', () => {
  assert.equal(mediaUrlFor('k/c/100%off.png'), 'media://mirror/k/c/100%25off.png');
  assert.equal(mediaUrlFor('k/c/rapport 2024.png'), 'media://mirror/k/c/rapport%202024.png');
});

// Ronde de correction 1 / F1 : c'est CE test qui manquait et a laisse passer C1.
// Le pathname d'une URL standard commence par `/` ; `mediaRequestPath` le retire
// AVANT de deleguer au garde, donc un fichier reel redevient servable.
test('mediaRequestPath : un pathname absolu d URL redevient relatif (C1)', () => {
  const racine = 'C:/data/media';
  const resolu = mediaRequestPath(racine, '/k/c/f.png');
  assert.notEqual(resolu, null);
  assert.equal(resolu, path.resolve(racine, 'k/c/f.png'));
});

// La traversee reste refusee, y compris encodee : c'est desormais
// `mediaRequestPath` qui decode UNE fois, puis delegue au garde pur.
test('mediaRequestPath : refuse la traversee, y compris encodee', () => {
  const racine = 'C:/data/media';
  assert.equal(mediaRequestPath(racine, '/../secret'), null);
  assert.equal(mediaRequestPath(racine, '/%2e%2e/secret'), null);
  assert.equal(mediaRequestPath(racine, '/k/../../secret'), null);
  assert.equal(mediaRequestPath(racine, null), null);
});

// F1 : les assertions de DECODAGE vivent ICI, plus dans `resolveMediaPath`.
// `%2e%2e` decode devient `..` -> traverse -> null ; `%00` decode devient un
// octet nul -> null ; un encodage pour cent invalide fait jeter -> null.
test('mediaRequestPath : decode une fois, puis refuse ce qui sort (F1)', () => {
  const racine = 'C:/data/media';
  assert.equal(mediaRequestPath(racine, '/%2e%2e/%2e%2e/secret'), null);
  assert.equal(mediaRequestPath(racine, '/key/%00evil'), null);
  assert.equal(mediaRequestPath(racine, '/%E0%A4%A'), null, 'encodage pour cent invalide');
  // Double encodage : un seul decodage donne `%2e%2e` LITTERAL, pas `..`.
  assert.equal(mediaRequestPath(racine, '/%252e%252e/secret'), path.resolve(racine, '%2e%2e/secret'));
});

// Ronde de correction 1 / I2 : round-trip d'un nom contenant un `%` LITTERAL.
// Un double decodage ferait lever `decodeURIComponent` et 404erait a tort.
test('mediaRequestPath : round-trip d un nom contenant un % litteral (I2)', () => {
  const racine = 'C:/data/media';
  const rel = 'k/c/100%off.png';
  const pathname = new URL(mediaUrlFor(rel)).pathname;
  assert.equal(mediaRequestPath(racine, pathname), path.resolve(racine, rel));
});

test('mediaRequestPath : round-trip d un nom avec espace', () => {
  const racine = 'C:/data/media';
  const rel = 'k/c/rapport 2024.png';
  const pathname = new URL(mediaUrlFor(rel)).pathname;
  assert.equal(mediaRequestPath(racine, pathname), path.resolve(racine, rel));
});

// F1 : fuzz maison. Toute entree hostile doit rendre `null` OU un chemin
// STRICTEMENT sous la racine, sur les deux fonctions. `%252e%252e` verrouille le
// decodage UNIQUE : decode deux fois, il deviendrait `..` et sortirait.
test('garde anti-traversee : jamais hors racine, sur les deux fonctions (F1)', () => {
  const racine = path.resolve('C:/data/media');
  const hostiles = ['..', '../x', '..\\x', '/etc/passwd', 'C:\\Windows\\system32',
    'key/../../secret', '%2e%2e', '%2e%2e/%2e%2e', '%252e%252e', '%2Fetc',
    'key/%00x', '\u0000', '', '.', 'foo/..', 'a/%2e%2e/../../b'];
  const dedans = cible => {
    if (cible === null) return true;
    const rel = path.relative(racine, cible);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  for (const hostile of hostiles) {
    const resolu = resolveMediaPath(racine, hostile);
    assert.ok(dedans(resolu), `resolveMediaPath(${JSON.stringify(hostile)}) = ${resolu}`);
    const pathname = `/${hostile.split('\\').join('/')}`;
    const requete = mediaRequestPath(racine, pathname);
    assert.ok(dedans(requete), `mediaRequestPath(${JSON.stringify(pathname)}) = ${requete}`);
  }
});

// ---------------------------------------------------------------------------
// TACHE 2 : le plan de telechargement et la boucle.
// ---------------------------------------------------------------------------

// Le `kind` vient de l'appelant (calcule par le renderer). Le service ne fait
// aucune detection d'extension : il lit le champ et le range en categorie.
test('mirrorCategory : image->photo, audio->audio, video->video, sinon file', () => {
  assert.equal(mirrorCategory('image'), 'photo');
  assert.equal(mirrorCategory('audio'), 'audio');
  assert.equal(mirrorCategory('video'), 'video');
  assert.equal(mirrorCategory('file'), 'file');
  assert.equal(mirrorCategory('application/zip'), 'file');
  assert.equal(mirrorCategory(undefined), 'file');
});

test('mirrorCategoryRank : photo 0, audio 1, file 2, video 3', () => {
  assert.equal(mirrorCategoryRank('photo'), 0);
  assert.equal(mirrorCategoryRank('audio'), 1);
  assert.equal(mirrorCategoryRank('file'), 2);
  assert.equal(mirrorCategoryRank('video'), 3);
});

test('MIRROR_CONCURRENCY vaut 4', () => {
  assert.equal(MIRROR_CONCURRENCY, 4);
});

// Ordre : photos, puis audio, puis fichiers, puis videos.
test('planDownloads : trie par categorie, photos-fichiers-videos', () => {
  const items = [
    { url: 'v.mp4', fileName: 'v.mp4', kind: 'video', channelId: 'c' },
    { url: 'f.zip', fileName: 'f.zip', kind: 'file', channelId: 'c' },
    { url: 'a.ogg', fileName: 'a.ogg', kind: 'audio', channelId: 'c' },
    { url: 'p.png', fileName: 'p.png', kind: 'image', channelId: 'c' },
  ];
  assert.deepEqual(planDownloads(items, {}), ['p.png', 'a.ogg', 'f.zip', 'v.mp4']);
});

test('planDownloads : l ordre d entree est conserve a rang egal', () => {
  const items = [
    { url: 'a1.png', fileName: 'a1.png', kind: 'image', channelId: 'c' },
    { url: 'a2.png', fileName: 'a2.png', kind: 'image', channelId: 'c' },
    { url: 'z1.mp4', fileName: 'z1.mp4', kind: 'video', channelId: 'c' },
    { url: 'z0.mp4', fileName: 'z0.mp4', kind: 'video', channelId: 'c' },
  ];
  assert.deepEqual(planDownloads(items, {}), ['a1.png', 'a2.png', 'z1.mp4', 'z0.mp4']);
});

// Reprise : un fichier 'done' est saute, un 'error' est refait.
test('planDownloads : saute les done, refait les error', () => {
  const items = [
    { url: 'v.mp4', fileName: 'v.mp4', kind: 'video', channelId: 'c' },
    { url: 'f.zip', fileName: 'f.zip', kind: 'file', channelId: 'c' },
    { url: 'a.ogg', fileName: 'a.ogg', kind: 'audio', channelId: 'c' },
    { url: 'p.png', fileName: 'p.png', kind: 'image', channelId: 'c' },
  ];
  const manifest = { 'p.png': { state: 'done', bytes: 3 }, 'a.ogg': { state: 'error' } };
  assert.deepEqual(planDownloads(items, manifest), ['a.ogg', 'f.zip', 'v.mp4']);
});

// Les quatre pieces jointes du lot de reference, dans l'ordre de l'entree.
function itemsReference() {
  return [
    { url: 'v.mp4', fileName: 'v.mp4', kind: 'video', channelId: 'c' },
    { url: 'f.zip', fileName: 'f.zip', kind: 'file', channelId: 'c' },
    { url: 'a.ogg', fileName: 'a.ogg', kind: 'audio', channelId: 'c' },
    { url: 'p.png', fileName: 'p.png', kind: 'image', channelId: 'c' },
  ];
}

// Un echec (ici un 404 sur f.zip) n'interrompt pas les autres telechargements,
// et le manifeste garde la trace de l'echec pour la reprise.
test('downloadMirror : un echec n interrompt pas les autres', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-'));
  try {
    const transport = {
      head: async () => 3,
      get: async url => { if (url === 'f.zip') throw new Error('404'); return Buffer.from('abc'); },
    };
    const res = await downloadMirror({ rootDir, key: 'k', items: itemsReference(), transport });
    assert.equal(res.done, 3);
    assert.equal(res.failed, 1);
    assert.equal(res.cancelled, false);

    const manifest = readManifest(path.join(rootDir, 'k'));
    assert.equal(manifest['f.zip'].state, 'error');
    assert.equal(manifest['p.png'].state, 'done');
    assert.equal(manifest['p.png'].bytes, 3);
    assert.equal(manifest['a.ogg'].state, 'done');
    assert.equal(manifest['v.mp4'].state, 'done');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

// Un fichier n'est 'done' qu'apres une ecriture complete verifiee : ici `head`
// annonce 10 octets mais `get` n'en rend que 3, donc 'error' et partiel supprime.
test('downloadMirror : taille incoherente -> error, partiel supprime', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-'));
  try {
    const items = [{ url: 'p.png', fileName: 'p.png', kind: 'image', channelId: 'c' }];
    const transport = { head: async () => 10, get: async () => Buffer.from('abc') };
    const res = await downloadMirror({ rootDir, key: 'k', items, transport });

    assert.equal(res.done, 0);
    assert.equal(res.failed, 1);
    const manifest = readManifest(path.join(rootDir, 'k'));
    assert.equal(manifest['p.png'].state, 'error');

    const cible = resolveMediaPath(rootDir, mediaRelPath('k', 'c', 'p.png', 'p.png'));
    assert.equal(fs.existsSync(cible), false);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

// Annulation : shouldStop devient vrai avant le 2e fichier. Le premier est
// ecrit et verifie, le second n'est jamais ouvert, `cancelled` vaut true.
test('downloadMirror : annulation avant le 2e fichier, aucun tronque', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-'));
  try {
    let appels = 0;
    const shouldStop = () => { appels += 1; return appels >= 2; };
    const transport = { head: async () => 3, get: async () => Buffer.from('abc') };
    const res = await downloadMirror({
      rootDir, key: 'k', items: itemsReference(), transport, shouldStop, concurrency: 1,
    });

    assert.equal(res.cancelled, true);
    assert.equal(res.done, 1);

    const manifest = readManifest(path.join(rootDir, 'k'));
    assert.equal(manifest['p.png'].state, 'done');
    assert.equal(manifest['a.ogg'], undefined);

    const cible2 = resolveMediaPath(rootDir, mediaRelPath('k', 'c', 'a.ogg', 'a.ogg'));
    assert.equal(fs.existsSync(cible2), false);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

// Reprise reelle : relancer avec le manifeste deja ecrit ne retravaille aucun
// 'done' (le transport `get` n'est plus jamais appele).
test('downloadMirror : reprise, les done ne sont pas retravailles', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-'));
  try {
    const transport1 = { head: async () => 3, get: async () => Buffer.from('abc') };
    const res1 = await downloadMirror({ rootDir, key: 'k', items: itemsReference(), transport: transport1 });
    assert.equal(res1.done, 4);
    assert.equal(Object.keys(readManifest(path.join(rootDir, 'k'))).length, 4);

    let gets = 0;
    const transport2 = {
      head: async () => 3,
      get: async () => { gets += 1; return Buffer.from('abc'); },
    };
    const res2 = await downloadMirror({ rootDir, key: 'k', items: itemsReference(), transport: transport2 });
    assert.equal(res2.done, 0);
    assert.equal(res2.failed, 0);
    assert.equal(gets, 0);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

// Le pool borne le parallélisme : jamais plus de `concurrency` requetes en vol.
test('downloadMirror : au plus concurrency requetes en vol', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-'));
  try {
    const nombreux = [];
    for (let i = 0; i < 8; i += 1) {
      nombreux.push({ url: `f${i}.png`, fileName: `f${i}.png`, kind: 'image', channelId: 'c' });
    }
    let enVol = 0;
    let maxEnVol = 0;
    const transport = {
      head: async () => 3,
      get: async () => {
        enVol += 1;
        if (enVol > maxEnVol) maxEnVol = enVol;
        await new Promise(resolve => setTimeout(resolve, 5));
        enVol -= 1;
        return Buffer.from('abc');
      },
    };
    const res = await downloadMirror({ rootDir, key: 'k', items: nombreux, transport, concurrency: 2 });

    assert.equal(res.done, 8);
    assert.ok(maxEnVol <= 2, `requetes en vol ${maxEnVol} > 2`);
    assert.equal(maxEnVol, 2);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

// onProgress est appele apres chaque fichier.
test('downloadMirror : onProgress est notifie apres chaque fichier', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-'));
  try {
    const transport = { head: async () => 3, get: async () => Buffer.from('abc') };
    const evenements = [];
    const onProgress = p => evenements.push(p);
    await downloadMirror({
      rootDir, key: 'k', items: itemsReference(), transport, onProgress, concurrency: 1,
    });
    assert.equal(evenements.length, 4);
    assert.equal(evenements[evenements.length - 1].done, 4);
    assert.equal(evenements[evenements.length - 1].bytesDownloaded, 12);
    assert.ok(evenements.every(e => typeof e.current === 'string'));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// F1 : bout en bout HORS RESEAU. Un nom a `%` litteral est ECRIT par
// `downloadMirror`, puis SERVABLE par `mediaRequestPath` (pas 404). C'est le
// symptome exact : a l'ecriture, `resolveMediaPath` re-decodaient le nom brut,
// donc jetait (`URI malformed`) ou ecrivait dans un sous-dossier.
// ---------------------------------------------------------------------------

test('downloadMirror puis mediaRequestPath : un nom a % litteral (F1)', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-e2e-'));
  try {
    const items = [{ url: 'https://x/p.png', fileName: '100%off.png', kind: 'image', channelId: 'c' }];
    const transport = { head: async () => 3, get: async () => Buffer.from('abc') };
    const res = await downloadMirror({ rootDir, key: 'k', items, transport });
    assert.equal(res.done, 1, 'le fichier est ecrit, pas refuse');

    const rel = mediaRelPath('k', 'c', 'https://x/p.png', '100%off.png');
    assert.equal(fs.existsSync(path.join(rootDir, rel)), true, 'ecrit au nom LITTERAL');

    const servi = mediaRequestPath(rootDir, new URL(mediaUrlFor(rel)).pathname);
    assert.equal(servi, path.resolve(rootDir, rel), 'la requete media:// retombe sur CE fichier');
    assert.equal(fs.existsSync(servi), true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('downloadMirror puis mediaRequestPath : un nom avec espace (F1)', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-e2e-'));
  try {
    const items = [{ url: 'https://x/s.png', fileName: 'rapport 2024.png', kind: 'image', channelId: 'c' }];
    const transport = { head: async () => 3, get: async () => Buffer.from('abc') };
    const res = await downloadMirror({ rootDir, key: 'k', items, transport });
    assert.equal(res.done, 1);

    const rel = mediaRelPath('k', 'c', 'https://x/s.png', 'rapport 2024.png');
    const servi = mediaRequestPath(rootDir, new URL(mediaUrlFor(rel)).pathname);
    assert.equal(servi, path.resolve(rootDir, rel));
    assert.equal(fs.existsSync(servi), true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// F3 : `resolveMediaPath` reste PURE (aucun `fs`) ; c'est le handler `media://`
// qui suit le lien avec `realpath`, puis confirme via cette fonction pure que la
// cible REELLE est sous `data/media`.
// ---------------------------------------------------------------------------

test('isMediaPathInside : vrai seulement STRICTEMENT sous la racine (F3)', () => {
  const root = 'C:/data/media';
  assert.equal(isMediaPathInside(root, 'C:/data/media/k/c/f.png'), true);
  assert.equal(isMediaPathInside(root, 'C:/data/media'), false, 'la racine elle-meme n est pas dedans');
  assert.equal(isMediaPathInside(root, 'C:/data/media-evil/x.png'), false, 'prefixe commun');
  assert.equal(isMediaPathInside(root, 'C:/data/other/x.png'), false);
  assert.equal(isMediaPathInside(root, 'C:/Windows/System32/x.png'), false);
  assert.equal(isMediaPathInside(root, null), false);
});

test('servirMedia : realpath + confinement sous data/media (F3)', () => {
  const main = fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  const debut = main.indexOf('async function servirMedia');
  const bloc = main.slice(debut, main.indexOf('\n}', debut));
  assert.match(bloc, /fsp\.realpath\(/, 'un lien symbolique est suivi avant la decision');
  assert.match(bloc, /isMediaPathInside\(/, 'et la cible reelle est confinee sous data/media');
});
