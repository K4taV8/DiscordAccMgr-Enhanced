# ` 📘 `︲Discord Account Manager - Enhanced.

<p align="center">
  <img src="assets/logo.png" alt="Logo Discord Account Manager" width="120">
</p>

<p align="center">
  <img alt="Electron 43.8.12" src="https://img.shields.io/badge/Electron-43.8.12-47848F?logo=electron&logoColor=white&style=for-the-badge">
  <img alt="Node.js 22.18+" src="https://img.shields.io/badge/Node.js-22.18%2B-5FA04E?logo=nodedotjs&logoColor=white&style=for-the-badge">
  <img alt="Version 1.5.6" src="https://img.shields.io/badge/Version-1.5.6-8E95E1?style=for-the-badge">
  <img alt="Stack ESM et CJS" src="https://img.shields.io/badge/Stack-ESM_%7C_CJS-8E95E1?style=for-the-badge">
  <img alt="API Discord v9" src="https://img.shields.io/badge/API-Discord_v9-5865F2?style=for-the-badge">
  <img alt="Tests node:test" src="https://img.shields.io/badge/Tests-node%3Atest-3BA55D?style=for-the-badge">
  <img alt="Licence MIT" src="https://img.shields.io/badge/License-MIT-lightgrey?style=for-the-badge">
</p>

---

Application de bureau Electron pour gérer son propre compte Discord : serveurs, amis, messages privés, groupes, réactions, archives d'export et médias. Elle centralise les opérations répétitives dans une interface unique, avec contrôle du débit, reprise sur interruption et stockage local.

> **English version:** [README.en.md](README.en.md).

> [!NOTE]
> Code, outillage et documentation générés majoritairement par IA, sous supervision, tests et relecture humains. Basé sur Discord Account Manager par Bherl1, incluant les enrichissements de KataV8.<br>
> Ce projet peut être ignoré si le développement assisté par IA ne correspond pas à vos exigences de confiance.

---

> [!CAUTION]
> L'utilisation d'un **jeton utilisateur** avec l'API Discord (`discord.js-selfbot-v13`, API v9) est contraire aux conditions d'utilisation de Discord et peut entraîner une suspension ou un bannissement du compte. L'application est destinée à la gestion de ses propres données, sans spam ni usage abusif.

---

## ` 📑 `︲Sommaire.

1. [`📘`︲Aperçu.](#apercu)

   * [`✨`︲Fonctionnalités.](#fonctionnalites)
   * [`🧰`︲Stack technique.](#stack)

   ---

2. [`⚡`︲Démarrage.](#demarrage)

   * [`📋`︲Prérequis.](#prerequis)
   * [`🛠️`︲Installation et lancement.](#installation)

   ---

3. [`🧭`︲Utilisation.](#utilisation)

   * [`🔌`︲Connexion.](#connexion)
   * [`🧹`︲Gestion et nettoyage.](#nettoyage)
   * [`📦`︲Archives et médias.](#archives)

   ---

4. [`⚙️`︲Configuration et données.](#configuration)

   * [`📁`︲Données locales.](#donnees)
   * [`🎨`︲Thèmes et langue.](#themes-langue)

   ---

5. [`🔐`︲Sécurité.](#securite)

   ---

6. [`🏗️`︲Architecture et structure.](#architecture)

   * [`📁`︲Structure du dépôt.](#structure)

   ---

7. [`🧪`︲Tests et scripts.](#tests)

   * [`📋`︲Scripts npm.](#scripts)

   ---

8. [`📦`︲Packaging Windows.](#packaging)

   ---

9. [`🩹`︲Dépannage.](#depannage)

   ---

10. [`📄`︲Licence et crédits.](#licence)

    ---

11. [`🧰`︲Outils et ressources.](#outils)

---

<a id="apercu"></a>
# ` 📘 `︲Aperçu.

---

Discord Account Manager est une application Electron sans bundler ni framework front-end. Le renderer est écrit en JavaScript ESM, le processus principal et le preload en CommonJS. Les opérations réseau passent par un point unique dans le processus principal, ce qui permet d'appliquer un ordonnanceur conscient des en-têtes `X-RateLimit-*`.

<a id="fonctionnalites"></a>
### ` ✨ `︲Fonctionnalités.

---

* **Comptes et listes** : connexion Discord native ou jeton manuel, comptes enregistrés, amis, serveurs, messages privés et groupes.
* **Nettoyage** : suppression des messages, retrait des réactions, mode combiné et mode complet avec sortie du serveur ou du groupe.
* **Traitement par lot** : sélection multiple, dock d'actions, progression, bouton d'arrêt et reprise par checkpoint pour les serveurs.
* **Lecture et modération** : marquage de serveurs comme lus, mise en sourdine et copie d'identifiants.
* **Archives Discord** : import d'un export `.zip`, exploration des messages par salon, galerie photos/vidéos/audio/fichiers et miroir média local.
* **Thèmes et langue** : thèmes Sombre, Clair, Discord, Mono, OLED Lavande et Mono OLED ; interface FR/EN commutable avant ou après connexion.

<a id="stack"></a>
### ` 🧰 `︲Stack technique.

---

| Couche | Technologie | Version |
|---|---|---|
| Runtime desktop | Electron | 43.8.12 |
| Processus principal | Node.js | 22.x |
| Langages | JavaScript ESM/CJS, TypeScript (types) | TypeScript 7.0.2 |
| Interface | HTML, CSS et JavaScript vanilla | — |
| HTTP | axios | 1.21.1 |
| Client Discord | discord.js-selfbot-v13 | 3.4.6 |
| Archives ZIP | fflate | 0.8.3 |
| Packaging | electron-builder | 26.18.1 |
| Tests | node:test | fourni par Node.js |

---

<a id="demarrage"></a>
# ` ⚡ `︲Démarrage.

---

<a id="prerequis"></a>
### ` 📋 `︲Prérequis.

---

| Élément | Valeur | Remarque |
|---|---|---|
| Node.js | **≥ 22.18** | Requis pour les tests qui importent les miroirs `.ts` |
| npm | Fourni avec Node.js | Installation des dépendances |
| Système | Windows | Cible de packaging définie dans `package.json` |
| Compte Discord | Compte personnel | Connexion native ou jeton utilisateur |

<a id="installation"></a>
### ` 🛠️ `︲Installation et lancement.

---

<!-- Dépôt du fork : https://github.com/K4taV8/DiscordAccMgr-Enhanced -->

1️⃣︲**Récupérer le dépôt.**

```bash
git clone https://github.com/K4taV8/DiscordAccMgr-Enhanced.git
cd DiscordAccMgr-Enhanced
```

2️⃣︲**Installer les dépendances.**

```bash
npm install
```

3️⃣︲**Lancer l'application.**

```bash
npm start
```

---

<a id="utilisation"></a>
# ` 🧭 `︲Utilisation.

---

<a id="connexion"></a>
### ` 🔌 `︲Connexion.

---

La connexion native ouvre une fenêtre Discord dédiée : Discord gère le mot de passe, la 2FA et le captcha, puis l'application récupère la session. Un jeton utilisateur peut aussi être collé manuellement. Les comptes enregistrés sont chiffrés au repos et rechargés depuis la page de connexion.

<a id="nettoyage"></a>
### ` 🧹 `︲Gestion et nettoyage.

---

Chaque carte expose les actions disponibles pour son type : suppression des messages, retrait des réactions, mise en sourdine, copie d'identifiant, fermeture d'une conversation ou sortie d'un serveur/groupe. Le bouton **Nettoyer** regroupe quatre modes : messages, réactions, messages + réactions, ou nettoyage complet avec sortie.

Une opération longue affiche sa progression et peut être arrêtée. Les nettoyages de serveurs utilisent des checkpoints, des watermarks et un ledger anti-fantômes ; les nettoyages de MP et de groupes relancent leur scan après une interruption.

> [!WARNING]
> Les suppressions sont **irréversibles**. Les confirmations destructives sont systématiques, mais aucune action ne peut annuler une suppression déjà envoyée à Discord.

<a id="archives"></a>
### ` 📦 `︲Archives et médias.

---

L'import accepte l'export Discord officiel au format `.zip` et le traite localement. La vue Messages permet de parcourir les échanges par salon ; la vue Galerie regroupe les photos, vidéos, fichiers audio et pièces jointes. Le bouton **Télécharger les médias** crée un miroir local dans `data/media`, servi par le protocole interne `media://`.

---

<a id="configuration"></a>
# ` ⚙️ `︲Configuration et données.

---

<a id="donnees"></a>
### ` 📁 `︲Données locales.

---

| Élément | Emplacement | Remarque |
|---|---|---|
| Données applicatives | `data/` à côté de l'exécutable | Mode portable |
| Jetons | `data/userData/saved_tokens.json` | Chiffrés avec `safeStorage` |
| Sessions et cache | `data/sessionData/`, `data/cache/` | Cache local |
| Journaux du main | `data/logs/main.log` | Rotation de 5 Mo, 3 archives |
| Miroir média | `data/media/` | Fichiers téléchargés localement |

Les débits nominaux de secours sont définis dans `electron/rateLimiter.cjs` et appliqués dans `electron/main.cjs` :

| Opération | Débit nominal | Burst | Concurrence |
|---|---|---|---|
| Lecture | 25 requêtes/s | 16 | 12 |
| Suppression | 4 requêtes/s | 2 | 4 |

<a id="themes-langue"></a>
### ` 🎨 `︲Thèmes et langue.

---

Le sélecteur de thème du rail propose Sombre, Clair, Discord, Mono, OLED Lavande et Mono OLED. Le choix est conservé dans `localStorage`. Le bouton de langue, disponible sur la page de connexion et dans le rail, bascule l'interface entre français et anglais ; la préférence est également persistée.

---

<a id="securite"></a>
# ` 🔐 `︲Sécurité.

---

* **Jetons** : chiffrement au repos via `safeStorage`, enveloppe versionnée, écritures sérialisées et atomiques (`electron/tokenStore.cjs`, `electron/persist.cjs`).
* **Renderer** : `sandbox`, `contextIsolation`, `nodeIntegration` désactivé et CSP stricte (`script-src 'self'`, `connect-src 'self'`) dans `index.html`.
* **Réseau** : un seul chemin HTTP dans le processus principal (`discordFetch`), timeout global de 15 s, suivi des en-têtes de débit et `maxRedirects: 0` sur l'API Discord.
* **Médias** : protocole `media://` avec validation lexicale, `realpath` et contrôle de sortie du dossier `data/media`.
* **Liens externes** : allowlist d'URL pour `shell.openExternal` dans `electron/main.cjs`.

Les appels IPC sensibles (`connectDiscord`, `saveToken`, `getTokens`, `loginNative`) sont rédigés en `[redacted]` avant journalisation dans `electron/preload.cjs`.

---

<a id="architecture"></a>
# ` 🏗️ `︲Architecture et structure.

---

| Sous-système | Fichiers | Rôle |
|---|---|---|
| Renderer | `src/` | Interface ESM, managers, galerie, opérations de scan et de suppression |
| Preload | `electron/preload.cjs` | Pont `contextBridge`, API IPC exposée au renderer |
| Main | `electron/main.cjs` et services `electron/*.cjs` | Autorité réseau, persistance, jetons, protocole média et fenêtre de connexion |

```text
renderer (src/, ESM)
  │  contextBridge / IPC
  ▼
preload.cjs
  │
  ▼
main.cjs (CJS)
  ├─ discordFetch → route scheduler (X-RateLimit-*)
  ├─ persist.cjs → JSON atomique
  ├─ tokenStore.cjs → safeStorage
  └─ media:// → data/media
```

<a id="structure"></a>
### ` 📁 `︲Structure du dépôt.

---

<details>
<summary>📁︲Arborescence complète.</summary>

```text
electron/        processus principal, preload et services
src/components/  managers, cartes Bento, modales et sélecteurs
src/services/    import/export d'archives, stockage, galerie
src/utils/       suppression, réactions, progression, thèmes, i18n
src/styles/      app.css et thèmes
src/types/       déclarations TypeScript globales
shared/          types partagés
scripts/         vérification de l'ASAR
test/            suite node:test
assets/          logo, avatars et icônes
resources/       ressources de packaging
index.html       document du renderer
```

</details>

---

<a id="tests"></a>
# ` 🧪 `︲Tests et scripts.

---

La suite utilise `node:test` et couvre le renderer, les services d'import/export, la persistance, le rate limiting, les suppressions, les thèmes et l'i18n. `npm test` exécute d'abord `tsc --noEmit`, puis les tests.

<a id="scripts"></a>
### ` 📋 `︲Scripts npm.

---

| Commande | Rôle |
|---|---|
| `npm start` | Lance Electron |
| `npm test` | Typecheck puis suite `node:test` |
| `npm run typecheck` | Vérifie les types TypeScript |
| `npm run test:coverage` | Exécute les tests avec couverture |
| `npm run audit:sca` | Audit des dépendances de production |
| `npm run verify:asar` | Vérifie l'import ESM depuis une archive ASAR |
| `npm run package` | Construit l'installeur NSIS et le dossier Windows |
| `npm run package:portable` | Construit le dossier portable |

---

<a id="packaging"></a>
# ` 📦 `︲Packaging Windows.

---

La configuration `electron-builder` cible Windows avec deux sorties : un installeur NSIS et un dossier exécutable. Le dossier portable conserve ses données dans `data/`, à côté de l'exécutable, et peut être déplacé sans installation.

```bash
npm run package
npm run package:portable
npm run verify:asar
```

Les artefacts sont produits dans `dist/`. La signature de code n'est pas configurée dans `package.json` ; Windows Defender peut afficher un avertissement sur l'exécutable non signé.

---

<a id="depannage"></a>
# ` 🩹 `︲Dépannage.

---

**La connexion Discord reste bloquée.**  
Le captcha et la 2FA sont gérés dans la fenêtre Discord. Si la fenêtre native ne se termine pas, utiliser la connexion par jeton manuel.

**Une vidéo ne se lit pas.**  
Les formats `.mov` et `.mkv` ne sont pas décodés par Chromium. Le lecteur propose l'enregistrement du fichier ; les `.mp4` et `.webm` se lisent directement.

**Où sont stockées les données ?**  
Dans `data/`, à côté de l'exécutable en mode portable. Les jetons se trouvent dans `data/userData/saved_tokens.json` et sont chiffrés.

**Un code 429 apparaît ?**  
L'ordonnanceur doit éviter ces réponses par construction. Vérifier `data/logs/main.log` et s'assurer qu'aucun appel HTTP ne contourne `discordFetch`.

---

<a id="licence"></a>
# ` 📄 `︲Licence et crédits.

---

* **Application originale** : créée par **Bherl1** — [dépôt original](https://github.com/Bherl1/DiscordAccMgr).
* **Fork et enrichissements** : **KataV8** — [dépôt du fork](https://github.com/K4taV8/DiscordAccMgr-Enhanced) (thèmes, interface Bento, Data Package, galerie média, miroir local, connexion Discord native, traduction FR/EN, logo).
* **Licence** : MIT — voir [LICENSE](LICENSE). © 2024 Bherl1. Le dépôt n’a pas de fichier `CONTRIBUTING` ; les modifications doivent conserver `npm test`, `npm run typecheck` et `npm run audit:sca` fonctionnels.

---

<a id="outils"></a>
# ` 🧰 `︲Outils et ressources.

---

* [Electron](https://www.electronjs.org/) — runtime desktop.
* [Node.js](https://nodejs.org/) — runtime de développement et tests.
* [axios](https://axios-http.com/) — client HTTP.
* [discord.js-selfbot-v13](https://www.npmjs.com/package/discord.js-selfbot-v13) — client Discord.
* [fflate](https://github.com/101arrowz/fflate) — archives ZIP.
* [electron-builder](https://www.electron.build/) — packaging Windows.
* [Boxicons](https://boxicons.com/) — pack d'icônes.

Les liens externes et le rendu des badges n'ont pas été vérifiés en ligne.
