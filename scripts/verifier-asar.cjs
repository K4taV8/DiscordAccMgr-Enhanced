// VERIFICATION DU BUILD PACKAGE — la propriete la plus fragile de la tache 5.
//
// Ce que verifie : que le VRAI binaire Electron lit un module ESM du renderer
// depuis le MAIN PROCESS, DANS un `app.asar`. C'est la propriete dont depend
// `chargerCheminFlux` (electron/packageImporter.service.cjs), et elle n'est
// couverte par AUCUN test du depot : la suite tourne sous Node, hors asar.
//
// POURQUOI UN SCRIPT ET PAS UN TEST. Un test devrait construire un asar, lancer
// `electron.exe`, et lire sa sortie : lent, et il exige le binaire. `npm test`
// doit rester jouable partout, donc cette porte se franchit explicitement — et
// son resultat doit etre consigne, sinon elle n'est jamais franchie.
//
// LE RISQUE, EN UNE PHRASE. `electron` est epingle en `43.4.0` dans package.json :
// une montee a 44.x, meme volontaire, peut CASSER CETTE PROPRIETE SILENCIEUSEMENT : le
// symptome ne serait pas une erreur, ce serait « les imports redeviennent lents »,
// parce que le filet `fallbackToRenderer` ferait refaire le travail par le
// renderer. Aucun test du depot ne verrait rien. Lancer ce script apres tout
// changement de version d'Electron.
//
// SON AUTRE METIER : il exerce LE MECANISME UTILISE, pas le mecanisme en
// general. Une forme d'`import()` qui marche sur une version peut ne pas marcher
// sur la suivante — en particulier le PIEGE MESURE ici : sur Windows, un CHEMIN
// ABSOLU (`C:\\...\\app.asar\\src\\...`) est refuse par le chargeur ESM
// (« Received protocol 'c:' ») ; seule la forme RELATIVE ou une URL `file://`
// fonctionne. Le code de production utilise la forme relative, donc ce script
// l'exerce reellement, et exerce aussi la forme fautive pour consigner qu'elle
// echoue.
//
//    npm run verify:asar
//
// Sortie : un rapport sur stdout, code de sortie 1 si une assertion tombe.
// Aucune assertion ne « passe silencieusement » : chaque ligne dit ce qui a ete
// fait, pour qu'une sortie collee dans un rapport vaille quelque chose.

const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync, writeFileSync, mkdirSync, cpSync, readFileSync, existsSync, statSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { crc32 } = require('node:zlib');

// Un ZIP minimal, en STOCAGE (method 0), construit ici plutot qu'avec `fflate` :
// la sonde doit pouvoir tourner SANS dependre d'un module du paquet qu'elle
// verifie, et `node:zlib` suffit. Les entrees sont declarees dans l'ordre, avec
// les champs COMPLETS de la norme — c'est ce que `readZipIndex` relit.
function zipStocke(entrees) {
  const locaux = [];
  const central = [];
  let decalage = 0;
  for (const { nom, contenu } of entrees) {
    const octets = Buffer.from(contenu, 'utf8');
    const nomOctets = Buffer.from(nom, 'utf8');
    const crc = crc32(Buffer.from(octets));

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(10, 4);            // version needed
    local.writeUInt16LE(0x0800, 6);        // flag : noms en UTF-8
    local.writeUInt16LE(0, 8);             // method 0 : STOCAGE
    local.writeUInt16LE(0, 10);            // temps
    local.writeUInt16LE(0x21, 12);         // date fixe : archive reproductible
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(octets.length, 18);
    local.writeUInt32LE(octets.length, 22);
    local.writeUInt16LE(nomOctets.length, 26);
    local.writeUInt16LE(0, 28);
    locaux.push(local, nomOctets, octets);

    const entree = Buffer.alloc(46);
    entree.writeUInt32LE(0x02014b50, 0);
    entree.writeUInt16LE(20, 4);           // version made by
    entree.writeUInt16LE(10, 6);           // version needed
    entree.writeUInt16LE(0x0800, 8);
    entree.writeUInt16LE(0, 10);
    entree.writeUInt16LE(0, 12);
    entree.writeUInt16LE(0x21, 14);
    entree.writeUInt32LE(crc, 16);
    entree.writeUInt32LE(octets.length, 20);
    entree.writeUInt32LE(octets.length, 24);
    entree.writeUInt16LE(nomOctets.length, 28);
    entree.writeUInt32LE(decalage, 42);    // offset de l en-tete local
    central.push(entree, nomOctets);
    decalage += local.length + nomOctets.length + octets.length;
  }

  const tailleCentral = central.reduce((total, morceau) => total + morceau.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entrees.length, 8);
  eocd.writeUInt16LE(entrees.length, 10);
  eocd.writeUInt32LE(tailleCentral, 12);
  eocd.writeUInt32LE(decalage, 16);

  return Buffer.concat([...locaux, ...central, eocd]);
}

const RACINE = resolve(__dirname, '..');
const VERSION_ASAR = require('@electron/asar/package.json').version;

let echecs = 0;

function dire(texte) { process.stdout.write(`${texte}\n`); }

// `etape` est ASYNCHRONE : `asar.createPackage` l'est aussi (elle parcourt le
// dossier), et une promesse non attendue ferait echouer la construction sans
// qu'aucune assertion ne le dise. Le detail de l'echec est donc remonte.
async function etape(intitule, fn) {
  try {
    const detail = await fn();
    dire(`  ok    ${intitule}${detail ? ` — ${detail}` : ''}`);
    return true;
  } catch (error) {
    echecs += 1;
    dire(`  ECHEC ${intitule}`);
    dire(`        ${error.message}`);
    return false;
  }
}

function affirmer(condition, message) {
  if (!condition) throw new Error(message);
}

// `require('electron')` rend le CHEMIN de l'executable — pas le module : c'est
// la seule forme exploitable hors Electron.
function binaireElectron() {
  const chemin = require('electron');
  affirmer(typeof chemin === 'string' && existsSync(chemin), `le binaire Electron est introuvable (« ${chemin} »). Lancez \`npm i\` avant.`);
  return chemin;
}

// La sonde executee DANS le main process du binaire reel, depuis l'archive. Elle
// est un module `.cjs` place dans l'asar : c'est la forme du code de production
// (`electron/packageImporter.service.cjs` est un `.cjs`), donc l'archive
// reproduit le cas reel. Elle ecrit une ligne par etape, que le script parent lit.
const SONDE = [
  "'use strict';",
  "const { app } = require('electron');",
  "const { existsSync, statSync, readFileSync } = require('node:fs');",
  "const { join } = require('node:path');",
  "const cheminArchive = process.env.SONDE_ARCHIVE;",
  "",
  "function dire(texte) { process.stdout.write(texte + String.fromCharCode(10)); }",
  "async function etape(intitule, fn) {",
  "  try { const detail = await fn(); dire('OK|' + intitule + '|' + (detail || '')); }",
  "  catch (error) { dire('ECHEC|' + intitule + '|' + (error && error.message)); process.exitCode = 1; }",
  "}",
  "function affirmer(condition, message) { if (!condition) throw new Error(message); }",
  "",
  "app.whenReady().then(async () => {",
  "  const racine = app.getAppPath();",
  "  dire('APPPATH|' + racine);",
  "",
  "  await etape('l archive est bien un asar', () => {",
  "    affirmer(racine.endsWith('.asar'), 'app.getAppPath() ne donne pas un asar : ' + racine);",
  "    return racine;",
  "  });",
  "",
  "  await etape('les fichiers du main process sont DANS l archive', () => {",
  "    for (const relatif of ['main.cjs', 'sonde.cjs', 'electron/packageImporter.service.cjs', 'electron/zipIndex.cjs', 'electron/packageImporter.parse.cjs', 'package.json']) {",
  "      affirmer(existsSync(join(racine, relatif)), 'absent de l archive : ' + relatif);",
  "    }",
  "    return 'main.cjs, sonde.cjs, packageImporter.service.cjs, zipIndex.cjs, packageImporter.parse.cjs, package.json';",
  "  });",
  "",
  "  await etape('le service ESM du renderer et fflate sont DANS l archive', () => {",
  "    const service = join(racine, 'src/services/packageImporter.service.js');",
  "    const fflate = join(racine, 'node_modules/fflate/esm/browser.js');",
  "    affirmer(existsSync(service), 'absent de l archive : src/services/packageImporter.service.js');",
  "    affirmer(existsSync(fflate), 'absent de l archive : node_modules/fflate/esm/browser.js');",
  "    return 'service ' + statSync(service).size + ' o, fflate ' + statSync(fflate).size + ' o';",
  "  });",
  "",
  "  // L'ASSERTION CENTRALE. Le specificateur est RELATIF, comme dans",
  "  // `chargerCheminFlux` : c'est la forme dont l'echec serait SILENCIEUX, le",
  "  // repli `fallbackToRenderer` prenant le relais sans rien dire.",
  "  await etape('un import() RELATIF d un ESM de renderer depuis le main process DANS l asar', async () => {",
  "    const module = await import('./src/services/packageImporter.service.js');",
  "    affirmer(typeof module.importDiscordPackage === 'function', 'le module est charge sans exposer importDiscordPackage');",
  "    return 'importDiscordPackage est une ' + typeof module.importDiscordPackage;",
  "  });",
  "",
  "  // Le contre-exemple, rendu MESURABLE : la forme qui echoue sur cet Electron.",
  "  // Consignation, pas assertion — un tiers qui construira un jour un",
  "  // specificateur avec path.join doit voir pourquoi, pas le decouvrir.",
  "  await etape('CONTRE-EXEMPLE : un import() par CHEMIN ABSOLU echoue sur cet Electron', async () => {",
  "    const chemin = join(racine, 'src/services/packageImporter.service.js');",
  "    try {",
  "      await import(chemin);",
  "      return 'chemin absolu ACCEPTE sur cette version : le piege Windows a disparu, la forme relative reste la seule verifiee';",
  "    } catch (error) {",
  "      affirmer(/Received protocol 'c:'|must be valid file/.test(error.message), 'echec inattendu, et pas celui qu on attendait : ' + error.message);",
  "      return error.message.split(String.fromCharCode(10))[0];",
  "    }",
  "  });",
  "",
  "  // Le chemin par index doit importer une VRAIE archive DEPUIS l'archive, par",
  "  // le CORPS du handler — donc avec la comparaison de taille et l'enveloppe.",
  "  await etape('le chemin par index importe une vraie archive DEPUIS l asar', async () => {",
  "    const taille = statSync(cheminArchive).size;",
  "    const service = require('./electron/packageImporter.service.cjs');",
  "    const reponse = await service.importArchiveDepuisChemin({ chemin: cheminArchive, nom: 'package.zip', taille: taille }, {});",
  "    affirmer(reponse.success === true, 'l import n aboutit pas : ' + JSON.stringify(reponse));",
  "    affirmer(reponse.package && reponse.package.user, 'aucun paquet rendu');",
  "    affirmer(reponse.mode === 'index', 'le chemin par defaut n a pas ete pris : ' + reponse.mode);",
  "    affirmer(reponse.package.channels.length >= 1, 'aucun salon rendu — la fixture en contient un');",
  "    affirmer(reponse.package.totalMessages >= 1, 'aucun message rendu — la fixture en contient un');",
  "    affirmer(reponse.package.messages instanceof Map === false, 'le paquet n est pas aplati pour le fil');",
  "    affirmer(Object.keys(reponse.package.messages).length >= 1, 'la table des messages aplatie est vide');",
  "    return 'user ' + reponse.package.user.id + ', ' + reponse.package.channels.length + ' salon(s), ' + reponse.package.totalMessages + ' message(s), mode ' + reponse.mode;",
  "  });",
  "",
  "  // Et le chemin de REFERENCE doit se charger depuis l'archive lui aussi : c'est",
  "  // lui que le repli doit pouvoir refaire l'import si l'index echoue.",
  "  await etape('le repli vers le chemin flux se charge DEPUIS l asar', async () => {",
  "    const service = require('./electron/packageImporter.service.cjs');",
  "    const resultat = await service.importPackageWithFallback({ name: 'faux.zip', size: 11, slice: () => ({ arrayBuffer: async () => new ArrayBuffer(11) }) }, {});",
  "    affirmer(resultat.mode === 'stream', 'l index echoue, le flux doit prendre le relais : ' + JSON.stringify(resultat));",
  "    affirmer(resultat.error === 'Unable to read ZIP archive: invalid zip data', 'l erreur du chemin de reference est attendue : ' + resultat.error);",
  "    affirmer(resultat.fallbackToRenderer === undefined, 'le flux a reussi a se charger depuis l archive : aucun repli n a lieu');",
  "    return 'mode stream, motif « ' + resultat.error + ' », aucun repli';",
  "  });",
  "",
  "  app.exit(process.exitCode || 0);",
  "}).catch(error => { dire('CRASH|' + (error && error.stack || error)); app.exit(2); });",
].join('\n');

// Une archive de test PARFAITE et minuscule, mais PAS vide : `Compte/user.json`,
// un `Messages/index.json`, un salon et ses messages. Le minimum serait le compte
// seul — il passerait, mais il ne prouverait que le LECTEUR d'index ; avec un
// salon et un message, ce qui est verifie c'est aussi l'inflation et les
// parseurs, donc l'ensemble du chemin par index depuis l'archive. Les
// identifiants sont en TEXTE BRUT : un litteral numerique de 18-19 chiffres
// serait arrondi par le moteur avant meme d'arriver dans l'archive.
function archiveDeTest() {
  return zipStocke([
    {
      nom: 'Compte/user.json',
      contenu: '{ "id": 1000000000000000001, "username": "sonde", "global_name": "Sonde", "avatar_hash": "a95b780ee6a221f82fca3dea0de7ad6b" }',
    },
    {
      nom: 'Messages/index.json',
      contenu: '{ "111111111111111111": "general" }',
    },
    {
      nom: 'Serveurs/999999999999999999/guild.json',
      contenu: '{ "id": 999999999999999999, "name": "Les Pangolins", "icon": "abc123" }',
    },
    {
      nom: 'Messages/c111111111111111111/channel.json',
      contenu: '{ "id": 111111111111111111, "name": "general", "type": "GUILD_TEXT", "guild": { "id": 999999999999999999, "name": "Les Pangolins" } }',
    },
    {
      nom: 'Messages/c111111111111111111/messages.json',
      contenu: '[{ "ID": 1009136231751360593, "ChannelID": 111111111111111111, "Timestamp": "2026-04-24 11:13:52", "Contents": "appel manque" }]',
    },
  ]);
}

async function main() {
  const versionElectron = JSON.parse(readFileSync(join(RACINE, 'node_modules/electron/package.json'), 'utf8')).version;
  dire(`Verification du build package — Electron ${versionElectron}, Node ${process.version}`);
  dire(`Racine : ${RACINE}`);
  dire('');

  const dossier = mkdtempSync(join(tmpdir(), 'verify-asar-'));
  const zone = join(dossier, 'aplat');
  const archive = join(dossier, 'app.asar');
  try {
    await etape('la sonde est posee, avec une archive de test', () => {
      mkdirSync(join(zone, 'electron'), { recursive: true });
      mkdirSync(join(zone, 'src/services'), { recursive: true });
      mkdirSync(join(zone, 'node_modules/fflate/esm'), { recursive: true });
      writeFileSync(join(zone, 'sonde.cjs'), SONDE, 'utf8');
      // Le `type: module` est celui du depot : il decide qu'un `.js` est un ESM,
      // donc la copie ne ferait pas la meme chose sans lui.
      writeFileSync(join(zone, 'package.json'), `${JSON.stringify({ name: 'sonde-asar', version: '0.0.0', main: 'main.cjs', type: 'module' }, null, 2)}\n`, 'utf8');
      writeFileSync(join(zone, 'main.cjs'), "'use strict';\nrequire('./sonde.cjs');\n", 'utf8');
      writeFileSync(join(dossier, 'test.zip'), archiveDeTest());

      for (const fichier of [
        'electron/packageImporter.service.cjs',
        'electron/zipIndex.cjs',
        'electron/packageImporter.parse.cjs',
        'electron/packageImporter.rules.cjs',
      ]) cpSync(join(RACINE, fichier), join(zone, fichier));

      cpSync(join(RACINE, 'src/services/packageImporter.service.js'), join(zone, 'src/services/packageImporter.service.js'));
      cpSync(join(RACINE, 'node_modules/fflate/esm/browser.js'), join(zone, 'node_modules/fflate/esm/browser.js'));
      return 'skelette complet';
    });

    // @electron/asar est la MEME bibliotheque qu'electron-builder utilise pour
    // construire le paquet : la mise en page de l'archive n'est donc pas une
    // approximation. Ce qui reste hors perimetre : l'INSTALLEUR NSIS.
    const asar = require('@electron/asar');
const archiveConstruite = await etape('l asar est construit', async () => {
      await asar.createPackage(zone, archive);
      affirmer(existsSync(archive), `l'archive n'existe pas apres construction : ${archive}`);
      return `${archive} (${statSync(archive).size} o, @electron/asar ${VERSION_ASAR})`;
    });
    // Sans archive, lancer Electron ne prouverait rien : le binaire rapporterait
    // un echec de demarrage, et chaque assertion avouerait son absence.
    if (!archiveConstruite) throw new Error('pas d archive a lancer : la construction a echoue');

    // Un timeout : un `import()` qui ne repondrait pas laisserait ce script
    // pendre indefiniment sur une machine de CI. L'echec est alors explicite.
    let sortieBrute;
    try {
      sortieBrute = execFileSync(binaireElectron(), [archive, '--no-sandbox', '--disable-gpu'], {
        encoding: 'utf8',
        timeout: 180000,
        windowsHide: true,
        env: { ...process.env, SONDE_ARCHIVE: join(dossier, 'test.zip'), ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
      });
    } catch (error) {
      // Electron sort en code 1 quand la sonde signale un ECHEC : la sortie
      // contient alors le rapport, qui vaut mieux que le message d'un `throw`.
      if (!error.stdout) throw new Error(`le binaire Electron n'a rien rendu : ${error.message}`);
      sortieBrute = error.stdout;
    }

    const lignes = sortieBrute.split(/\r?\n/).filter(ligne => /^(OK|ECHEC|CRASH|APPPATH)\|/.test(ligne));
    dire('');
    dire('  Ce que la sonde a constate, DANS le main process du vrai binaire :');
    for (const ligne of lignes) {
      const [etat, intitule, detail = ''] = ligne.split('|');
      if (etat === 'APPPATH') dire(`    appPath : ${intitule}`);
      else dire(`    ${etat === 'OK' ? 'ok   ' : 'ECHEC'} ${intitule}${detail ? ` — ${detail}` : ''}`);
    }
    dire('');

    if (lignes.some(ligne => ligne.startsWith('CRASH|'))) throw new Error('la sonde a plante : voir la sortie ci-dessus');

    // Les assertions sont lues DANS la sortie de la sonde : une etape absente
    // fait rougir le script, ce qui evite qu'une sonde qui n'a rien verifie
    // « passe » parce qu'elle n'a rien dit.
    const rapport = new Map();
    for (const ligne of lignes) {
      const [etat, intitule, detail = ''] = ligne.split('|');
      if (etat === 'OK' || etat === 'ECHEC') rapport.set(intitule, { etat, detail });
    }
    for (const intitule of [
      'l archive est bien un asar',
      'les fichiers du main process sont DANS l archive',
      'le service ESM du renderer et fflate sont DANS l archive',
      'un import() RELATIF d un ESM de renderer depuis le main process DANS l asar',
      'CONTRE-EXEMPLE : un import() par CHEMIN ABSOLU echoue sur cet Electron',
      'le chemin par index importe une vraie archive DEPUIS l asar',
      'le repli vers le chemin flux se charge DEPUIS l asar',
    ]) {
      await etape(`la sonde a verifie : ${intitule}`, () => {
        const trouve = rapport.get(intitule);
        affirmer(trouve, `absent de la sortie de la sonde (etapes rendues : ${rapport.size})`);
        affirmer(trouve.etat === 'OK', `la sonde l'a signalee en ECHEC : ${trouve.detail}`);
        return trouve.detail;
      });
    }

    dire('');
    if (echecs) {
      dire(`ECHEC — ${echecs} point(s) non tenus. La propriete « import() ESM depuis le main process DANS l'asar » n'est PAS verifiee sur Electron ${versionElectron}.`);
      dire("Si c'est une regression de version : revérifier la forme du specificateur dans `chargerCheminFlux` (RELATIVE, jamais `path.join`) avant de chercher plus loin.");
      process.exitCode = 1;
      return;
    }
    dire(`OK — propriete verifiee sur Electron ${versionElectron}, asar construit par @electron/asar ${VERSION_ASAR}.`);
    dire('Hors perimetre : l installeur NSIS d electron-builder. La mise en page de l asar, elle, est celle de la bibliotheque d electron-builder.');
  } finally {
    rmSync(dossier, { recursive: true, force: true });
  }
}

// Le CRASH du script est un ECHEC comme les autres : un `catch` muet laisserait
// croire a une verification reussie alors que rien n'a ete mesure.
main().catch(error => {
  echecs += 1;
  dire(`CRASH DU SCRIPT — ${error && error.stack || error}`);
  process.exitCode = 1;
});
