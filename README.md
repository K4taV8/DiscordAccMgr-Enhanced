# Discord Account Manager — Enhanced Fork (KataV8)

<p align="center">
  <img src="assets/logo.png" alt="Logo" width="120">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Electron-43-2C2E33?logo=electron&logoColor=white&style=for-the-badge">
  <img src="https://img.shields.io/badge/Node.js-22-blue?logo=nodedotjs&logoColor=white&style=for-the-badge">
  <img src="https://img.shields.io/badge/Stack-ESM_%7C_CJS-8E95E1?style=for-the-badge">
  <img src="https://img.shields.io/badge/API-Discord_v9-5865F2?style=for-the-badge">
  <img src="https://img.shields.io/badge/Tests-420_verts-3ba55d?style=for-the-badge">
  <img src="https://img.shields.io/badge/License-MIT-lightgrey?style=for-the-badge">
</p>

<p align="center">Application de bureau Electron pour la gestion de votre propre compte Discord : serveurs, amis, messages privés, groupes, réactions, import d'export de données, galerie média et nettoyage — sans le client officiel.</p>

---

> [!CAUTION]
> **Outil non officiel, à usage personnel.** L'utilisation d'un **jeton utilisateur** avec l'API Discord (`discord.js-selfbot-v13`, API v9) **est contraire aux conditions d'utilisation de Discord** et peut entraîner la **suspension ou le bannissement du compte**. Cette application est un outil de gestion de vos propres données : pas d'abus, pas de spam. Utilisation sous votre entière responsabilité.

---

## Sommaire

1. [Présentation](#presentation)
2. [Fonctionnalités](#fonctionnalites)
3. [Connexion à Discord](#connexion)
4. [Le Data Package (import d'export)](#data-package)
5. [Sécurité](#securite)
6. [Architecture](#architecture)
7. [Performances & anti rate-limit](#performances)
8. [Technologies](#technologies)
9. [Installation](#installation)
10. [Utilisation pas à pas](#utilisation)
11. [Configuration](#configuration)
12. [Garde-fous (Do Not Break)](#gardefous)
13. [Dépannage / FAQ](#depannage)
14. [Crédits & licence](#credits)

---

<a id="presentation"></a>
# 1. Présentation

**Discord Account Manager** est une application de bureau **Electron** qui pilote **votre propre compte Discord** (technique dite « selfbot ») pour vous faire gagner du temps sur les tâches répétitives et la gestion de vos données :

- lister / nettoyer vos **serveurs**, **messages privés**, **groupes** et **amis** ;
- **supprimer vos messages**, **retirer vos réactions** (avec vérification) ;
- **importer un export de compte Discord** (le fichier `.zip` officiel) pour **explorer vos messages, vos photos, vos vidéos et vos fichiers**, et même **télécharger vos médias** en local ;
- le tout avec une **interface claire**, des **thèmes**, et un **contrôle du débit réseau** qui évite les erreurs `429` (rate-limit).

> [!NOTE]
> **Objectif :** une application légère, **sans bundler ni framework**, dont le **cœur réseau est piloté par les en-têtes de débit réels** de l'API (`X-RateLimit-*`), avec **cache local** et **reprise de scan** (checkpointing), pour ne jamais re-scanner inutilement.

---

<a id="fonctionnalites"></a>
# 2. Fonctionnalités

## 2.1 Connexion
- **Connexion avec Discord** (nouveau) : une fenêtre Discord s'ouvre, vous vous connectez (mot de passe, 2FA ou **QR code**) — **Discord gère le captcha et la 2FA** — et l'app récupère votre session. **Isolée et jetable** (voir [Sécurité](#securite)).
- **Jeton manuel** : collez un jeton utilisateur, avec bouton œil pour l'afficher/masquer. Reste disponible à tout moment.
- **Enregistrement de compte** : enregistrez un compte connecté pour le recharger plus tard, **chiffré au repos** (`safeStorage`).

## 2.2 Amis (`Friends`)
- Liste de vos amis (avatar, pseudo, identifiant).
- **Retirer l'ami** (unitaire ou en lot).
- Copie de l'ID en un clic.

## 2.3 Serveurs (`Servers`)
- Liste de vos serveurs, avec badge **Propriétaire** pour ceux que vous possédez.
- **Mettre en sourdine** / réactiver les notifications.
- **Supprimer les messages** (scan + suppression, reprise par checkpoint).
- **Retirer les réactions** (scan complet + re-scan de vérification).
- **Quitter le serveur**.
- **Marquer comme lu** (avec progression live).

## 2.4 Messages privés (`DMs`)
- Liste de vos conversations privées.
- **Supprimer les messages**, **Retirer les réactions**, **Messages + réactions** (combiné), **Fermer la conversation**.

## 2.5 Groupes (`Groups`)
- Liste de vos groupes (DM de groupe), avec **avatar par défaut** si le groupe n'a pas d'icône.
- **Supprimer les messages**, **Retirer les réactions**, **Quitter le groupe**.

## 2.6 Nettoyage en un geste
Chaque carte propose un bouton **Nettoyer** qui ouvre **4 modes** :
| Mode | Effet |
|---|---|
| **Messages** | supprime vos messages |
| **Réactions** | retire vos réactions |
| **Msg + Réac** | supprime messages **et** réactions |
| **Tout + Quitter** | messages + réactions **puis** quitte le serveur/groupe/ferme le MP |

Sélectionnez plusieurs cartes, puis lancez un mode : **tout s'exécute en séquence**, avec progression et annulation.

## 2.7 Data Package — import, galerie et médias
Voir la [section dédiée](#data-package). En résumé :
- **Importez un export Discord `.zip`** (100 % local, aucun envoi) ;
- **Parcourez les messages** par salon, avec recherche, sélection et suppression ;
- **Galerie média** : mosaïque 4 colonnes de **toutes les pièces jointes** (photos, vidéos, audio, fichiers), avec filtres ;
- **Lecteur intégré** pour les **vidéos** et **audios**, navigation clavier ;
- **Enregistrer** n'importe quelle pièce jointe (et les autres formats) via une boîte de dialogue native ;
- **Miroir local** : téléchargez toutes vos pièces jointes en local pour un usage hors ligne.

## 2.8 Marquage « tout lu »
- **Read All** : marque tous vos serveurs comme lus, débit gouverné, **progression live**.

## 2.9 Interface
- **Rail d'icônes** latéral (compact), **grille Bento** (cartes) ou **vue liste** (persistée).
- **Dock flottant** de sélection multiple (actions groupées).
- **Thèmes** : **Sombre**, **Clair**, **Discord** (Blurple) — bascule en un clic.

---

<a id="connexion"></a>
# 3. Connexion à Discord

Deux méthodes, au choix.

### Méthode A — Connexion avec Discord (recommandée)
1. Cliquez sur **« Connexion avec Discord »**.
2. Une fenêtre Discord s'ouvre : connectez-vous (mot de passe / 2FA / **scan du QR**). Discord gère le captcha.
3. Une fois connecté, la fenêtre se ferme et l'app vous connecte.
4. Vous pouvez **enregistrer le compte** pour le réutiliser.

> [!IMPORTANT]
> Cette fenêtre utilise une **session isolée et éphémère** : aucun cookie Discord n'est conservé, elle repart **toujours vierge**. Votre mot de passe ne transite **jamais** par l'application (il reste dans la page Discord).

### Méthode B — Jeton manuel
1. Collez votre **jeton utilisateur** dans le champ, cliquez sur l'œil pour l'afficher.
2. **« Se connecter »**.
3. **« Enregistrer »** pour le conserver (chiffré).

> [!TIP]
> Pour obtenir votre jeton manuellement : dans le client Discord (navigateur), DevTools → onglet Réseau → une requête vers `discord.com/api` → en-tête `Authorization`. **Ne partagez jamais un jeton** : il donne un accès complet à votre compte.

---

<a id="data-package"></a>
# 4. Le Data Package (import d'export)

Le **Data Package** est l'onglet dédié à **l'exploitation locale d'un export de compte Discord** — le fichier `.zip` que Discord vous envoie sur demande (« Mes données » → « Demander mes données »). **Tout est traité sur votre machine.**

## 4.1 Importer
- Glissez-déposez votre `.zip` ou sélectionnez-le. L'app lit l'archive **par tranches** (les centaines de Mo ne sont pas copiés en mémoire) et affiche la progression.

## 4.2 Vue Messages
- Liste des salons, **groupée** (Messages directs, Groupes, puis un bloc par serveur) et triée par volume.
- **Filtres** : par type (Tous / MP / Groupes / Serveurs) et options **« Masquer les MP vides »**, **« Masquer les groupes vides »**, **« Masquer les notifications système »**, **« Masquer les serveurs quittés »**.
- **Recherche** dans les salons/messages.
- **Sélection** (par message ou tout) et **suppression** des messages.
- **Export** de ce que vous voulez en **ZIP** ou **JSON**.

## 4.3 Vue Galerie
- **Mosaïque 4 colonnes** de **toutes** les pièces jointes : **photos, vidéos, audio et fichiers** (icônes par type).
- **Filtres** : par genre (Tout / Photos / Vidéos / Audio / Fichiers) et par **salon**.
- **Tri** : plus récents d'abord, avec bouton pour **inverser** (mémorisé).
- **Clic sur une pièce jointe** → **lecteur** intégré : images, **vidéos** (lecture, plein écran de la visionneuse, navigation ‹ ›) et **audio**.
- Les formats que le moteur ne sait pas lire (`.mov`, `.mkv`) affichent un message clair + un bouton **Enregistrer**.

## 4.4 Miroir local (optionnel)
- **« Télécharger les médias »** : télécharge toutes vos pièces jointes (jusqu'à **~1,8 Gio**) dans un dossier local `data/media`, **photos d'abord** (la galerie devient complète visuellement bien avant la fin), avec **reprise** après coupure, **annulation**, et **progression**.
- Une fois téléchargés, les médias sont servis **depuis le disque** (la galerie **fonctionne hors ligne**) ; sinon, repli automatique sur le CDN Discord.
- **« Purger les médias »** : supprime les copies locales pour libérer l'espace.

## 4.5 Enregistrer une pièce jointe
- Depuis la galerie ou le lecteur, **Enregistrer** ouvre une **boîte de dialogue native** et télécharge le fichier dans le dossier choisi (le téléchargement se fait côté application, pas dans l'interface).

---

<a id="securite"></a>
# 5. Sécurité

> [!IMPORTANT]
> Cette section décrit ce que l'application fait pour **protéger votre compte et vos données**. Les invariants marqués sont des **zones rouges** : ne pas les casser.

## 5.1 Jetons
- **Chiffrés au repos** via `safeStorage` (chiffrement lié au système), jamais en clair sur disque. Enveloppe de schéma **versionnée** + **écritures sériaisées** (mutex) et **atomiques**.
- **Rédaction des IPC sensibles** : les appels `getTokens` / `connectDiscord` / `saveToken` sont masqués (`[redacted]`) dans les journaux internes.
- **Le mot de passe n'est jamais saisi dans l'app** lors de la connexion native : il reste dans la page Discord.

## 5.2 Fenêtre de connexion native — session éphémère
- La fenêtre Discord utilise une **session isolée, en mémoire, jamais écrite sur disque**, avec un **nom unique à chaque tentative**. Elle **repart toujours vierge** : aucune connexion Discord ne « fuit » d'une fois sur l'autre.
- La session est **purgée** (cookies + stockage) à la fermeture, dans tous les cas.
- Aucun `preload`, `nodeIntegration` désactivé : la page distante n'a **aucun accès** à Node ou au système.

## 5.3 Isolation du renderer (CSP)
- **`script-src 'self'`** : aucun script inline (les handlers sont migrés vers `addEventListener` / délégation `data-action`). **Ne jamais réintroduire** de script inline ni `'unsafe-inline'` dans `script-src`.
- **`connect-src 'self'`** : le renderer **ne peut pas** contacter le réseau directement (pas d'exfiltration possible des jetons par une XSS). Tous les appels Discord passent par le **main process**.
- **`img-src` / `media-src`** : limités à `'self'`, `data:`, le CDN Discord, et le schéma interne `media:` (copies locales). **Le renderer ne peut pas lire `file://`.**
- **Ouverture externe verrouillée** : `openExternal` n'autorise qu'une **liste blanche** (aucune URL arbitraire).

## 5.4 100 % portable, zéro télémétrie
- **Toutes** les données (compte, cache, sessions, journaux) vivent dans un dossier **`data/` à côté de l'exécutable** — rien n'est écrit dans `%APPDATA%`.
- **Aucune donnée n'est envoyée** à un serveur tiers : les seules communications sont celles vers **Discord** (pour votre compte) et **GitHub** (si vous cliquez un lien du panneau info).

## 5.5 Données d'export
- Le **Data Package** est traité **entièrement en local**. Le miroir média n'écrit que dans `data/media`.

---

<a id="architecture"></a>
# 6. Architecture

Trois sous-systèmes isolés :

| Sous-système | Fichiers | Rôle |
|---|---|---|
| **UI (renderer, ESM)** | `src/components/`, `src/utils/`, `src/styles/` | Interface, opérations lourdes (scan/suppression), galerie, rendu fluide |
| **Pont (preload)** | `electron/preload.cjs` | `contextBridge` isolé, rédaction des IPC sensibles |
| **Noyau (main, CJS)** | `electron/main.cjs`, `rateLimiter.cjs`, `persist.cjs`, `discordLogin.service.cjs` | Autorité du débit réseau, persistance atomique, sécurité des jetons, fenêtre de connexion native |

> [!IMPORTANT]
> **Un seul chemin HTTP autorisé** : `discordFetch()` dans le main process. Le renderer ne parle **jamais** directement à Discord — uniquement par IPC. C'est ce point unique qui garantit le contrôle du débit.

```
RENDERER (src/ — ESM, sandbox, contextIsolation)
  components/  Managers (Serveurs, MP, Groupes, Amis, Data Package) · bento.js · HelpModal
  utils/       deleters / removers, persist, progressPanel, theme
        │  contextBridge · IPC (invoke / on)
PRELOAD (preload.cjs)  electronAPI (wrappé) · persistAPI · [redacted] sur les appels sensibles
        │
MAIN PROCESS (electron/ — CJS)
  discordFetch()  →  makeRouteScheduler (X-RateLimit-aware)
  persist.cjs     →  JSON atomique (tmp + rename) : checkpoints, watermark, ledger
  safeStorage     →  jetons chiffrés + mutex
  discordLogin    →  fenêtre native + debugger CDP (session éphémère)
        │  HTTPS · axios · timeout 15 s
   DISCORD API v9  (X-RateLimit-Remaining / Reset-After / Global)
```

---

<a id="performances"></a>
# 7. Performances & anti rate-limit

- **Ordonnanceur conscient des en-têtes** : avant chaque requête, le budget réel (`X-RateLimit-Remaining`) est consommé de façon optimiste ; si un bucket (route **ou** global) est à zéro, l'ordonnanceur **attend `X-RateLimit-Reset-After`**. Les `429` sont **évités par construction**.
- **Bursts sûrs** : quand le bucket annonce du budget, les requêtes partent en rafale jusqu'à `remaining`.
- **Débits nominaux (repli)** : lecture **25 r/s**, suppression **4 r/s** (seuils sûrs pour un jeton utilisateur).
- **Scan serveur parallèle segmenté** : jusqu'à 12 segments temporels par canal, 8 canaux en parallèle, débit global plafonné par l'ordonnanceur.
- **Retry borné** (3 tentatives), **timeout global** `axios` 15 s.
- **Reprise** : **checkpoints** (par opération/serveur), **watermarks** (delta par canal, TTL 24 h), **ledger** anti-fantômes pour les réactions. Écritures **atomiques** (jamais de fichier tronqué).
- **Interface fluide** : rendu **chunké** (50 cartes/frame), scroll préservé, ETA temps réel, warm-up au démarrage, rendu galerie **virtualisé** (fenêtrage) et **recyclage des tuiles** au défilement.

---

<a id="technologies"></a>
# 8. Technologies

- **Electron 43** — application de bureau (renderer sandboxé, `contextIsolation`). Icône de fenêtre personnalisée.
- **Node.js 22** — moteur (main/preload `.cjs`, renderer ESM).
- **axios** — HTTP vers l'API Discord (timeout 15 s).
- **discord.js-selfbot-v13** — connexion WebSocket pour la session (les opérations passent par le REST).
- **fflate** — lecture/création des archives ZIP (import/export).
- **electron-builder** — packaging Windows (NSIS / dossier), 100 % portable.
- **TypeScript** — types (aucune étape de build obligatoire).
- **node:test** (stdlib) — **420 tests** (`npm test`), couverture via `npm run test:coverage`.

---

<a id="installation"></a>
# 9. Installation

**Prérequis :** Node.js LTS (≥ 20) et npm.

```bash
git clone https://github.com/Bherl1/DiscordAccMgr.git
cd DiscordAccMgr
npm install
```

**Lancer :**
```bash
npm start
```

**Tests :**
```bash
npm test
npm run test:coverage
```

**Packager (Windows) :**
```bash
npm run package          # installeur NSIS + dossier
npm run package:portable # dossier portable (data/ local)
npm run verify:asar      # vérifie la lecture ESM dans l'archive packagée (gate)
```

> [!NOTE]
> Un avertissement Windows Defender est possible sur l'exécutable non signé (application non signée).

---

<a id="utilisation"></a>
# 10. Utilisation pas à pas

1. **Se connecter** — « Connexion avec Discord » (recommandé) ou jeton manuel (voir [Connexion](#connexion)).
2. **Naviguer** — onglets **Amis / Serveurs / MP / Groupes** en **grille Bento** (ou vue liste).
3. **Agir** — sur chaque carte : boutons d'action (Mute, Supprimer les messages, Retirer les réactions, Quitter…) ou **Nettoyer** pour tout faire d'un coup.
4. **En lot** — cochez plusieurs cartes → le **dock** du bas s'active (compteur, Tout sélectionner / Tout désélectionner, Nettoyer ▾).
5. **Data Package** — glissez votre export `.zip`, puis explorez **Messages** et **Galerie** (voir [Data Package](#data-package)).
6. **Miroir** — dans la galerie, « Télécharger les médias » pour tout avoir en local.

> [!IMPORTANT]
> En cas d'interruption (Stop, perte réseau, fermeture), relancer la même opération propose **« Reprendre / Repartir à zéro »** : la reprise continue **à l'élément près**, sans re-scanner les canaux déjà analysés.

> [!CAUTION]
> **Les suppressions sont irréversibles.** Les confirmations destructives sont systématiques, mais aucune application ne peut annuler une suppression déjà envoyée. Faites une sauvegarde si l'opération est critique.

---

<a id="configuration"></a>
# 11. Configuration

- **Débits nominaux** (`electron/rateLimiter.cjs`) : lecture **25 r/s** (burst 16, 12 concurrents), suppression **4 r/s** (burst 2, 4 concurrents). Ce sont des **planchers de sûreté** ; les en-têtes gouvernent ensuite les bursts réels. **Ne pas les augmenter sans preuve empirique.**
- **TTL** : watermark serveur 24 h · ledger réactions 24 h · cache serveurs 30 s · cache canaux 60 s · checkpoints nettoyés après 7 jours.
- **Jetons** : chiffrés `safeStorage` (préfixe `enc:`), enveloppe `schemaVersion`, migration de l'ancien format, entrées corrompues marquées. Où : `data/userData/saved_tokens.json`.
- **Portable** : `data/` à côté de l'exécutable (`userData`, `sessionData`, `cache`, `crashDumps`, `logs`, `media`). Variable `ELECTRON_DEV=1` force les DevTools.
- **Thème** : bouton dans le rail (Sombre → Clair → Discord), persisté en `localStorage`.

---

<a id="gardefous"></a>
# 12. Garde-fous (Do Not Break)

> [!CAUTION]
> Ces zones protègent la **garantie zéro-429** et **l'intégrité des données**. Les modifier sans comprendre peut provoquer des `429` en cascade, des jetons bloqués, des suppressions manquées ou des états corrompus.

### Réseau / Rate-limit
| # | Zone | Si modifiée |
|---|---|---|
| **G1** | Tout appel HTTP DOIT passer par `discordFetch()` | `429`, restrictions, suspension de jeton |
| **G2** | Ne pas contourner `makeRouteScheduler` | Perte de la lecture des `X-RateLimit-*` |
| **G3** | Ne pas dépasser 25 r/s lecture / 4 r/s suppression sans preuve | Buckets user-token plus stricts |
| **G4** | Garder le retry `429` (3 tentatives) + `Retry-After` | Suppressions perdues, drapeaux d'abus |
| **G5** | Ne pas dépasser 12 segments / concurrence > 8 | Pics locaux sans gain |
| **G6** | Garder `humanDelay` sur les DELETE MP/groupe | Détection comportementale |

### Sécurité
| # | Zone | Si modifiée |
|---|---|---|
| **S1** | Garder `getTokens`/`connectDiscord`/`saveToken` dans `SENSITIVE_CALLS` | Jetons en clair dans la console |
| **S2** | Jetons jamais en clair (`safeStorage` + mutex) | Fuite / perte de jeton |
| **S3** | Ne pas élargir `openExternal` (liste blanche) ni `connect-src 'self'` | Exfiltration possible par XSS |
| **S4** | Garder `script-src 'self'` (aucun script inline) | Réouverture d'une XSS |
| **S5** | La fenêtre de connexion native reste en **session éphémère** (pas de `partition` persistante) | La fenêtre se rouvrirait déjà connectée |

### Persistance
| # | Zone | Si modifiée |
|---|---|---|
| **P1** | Toute écriture passe par `persist.cjs` (atomique) | Fichier tronqué = état corrompu |
| **P2** | Bumper `schemaVersion` + migration si format changé | Reprise cassée |
| **P3** | Ledger : ne consigner que sur `204`/`404`, TTL 24 h | Fantômes ou réactions masquées à tort |
| **P4** | Garder le prompt « Reprendre / Repartir à zéro » | Progression perdue |

### UI / intégrité
| # | Zone | Si modifiée |
|---|---|---|
| **U1** | Rendu chunké 50/frame | Frame bloquée sur gros comptes |
| **U2** | `attachments`/`embeds`/`snapshots` sont des **nombres** (`(x \|\| 0) > 0`) | Messages à pièce jointe seule non supprimés |
| **U3** | `reactions` reste mappé **complet** | Retrait de réactions cassé |

---

<a id="depannage"></a>
# 13. Dépannage / FAQ

**La connexion Discord reste bloquée sur la page de connexion**
Le captcha ou la 2FA sont gérés par Discord : complétez-les dans la fenêtre. Si besoin, utilisez le jeton manuel.

**Les vidéos ne se lisent pas**
Les formats `.mov`/`.mkv` ne sont pas décodables par le moteur : le lecteur propose **Enregistrer**. Les `.mp4`/`.webm` se lisent.

**La galerie rame / les images sautent**
Vérifiez votre connexion (les images viennent du CDN). Lancez « Télécharger les médias » pour un usage local hors ligne.

**Où sont mes données ?**
`data/` à côté de l'exécutable (mode portable). Les jetons : `data/userData/saved_tokens.json` (chiffrés).

**Comment ouvrir le panneau de log ?**
Ouvrez les DevTools (F12) puis tapez `window.toggleDebugLog()`.

**Une erreur `429` ?**
L'app les évite par construction. Si vous en voyez, un appel réseau ne passe pas par `discordFetch()` (voir G1).

**Puis-je annuler une suppression ?**
Non. Les suppressions sont définitives côté Discord.

---

<a id="credits"></a>
# 14. Crédits & licence

- **Application originale** : créée par **Bherl1** (https://github.com/Bherl1/DiscordAccMgr).
- **Fork & enrichissements** : **KataV8** (thèmes, design Bento, Data Package, galerie média, miroir local, connexion Discord native, logo…).

**Licence MIT** — voir `LICENSE`. © 2024 Bherl1.

> [!CAUTION]
> Outil non officiel : l'usage d'un jeton utilisateur avec l'API Discord contredit les conditions d'utilisation de Discord et peut entraîner le bannissement du compte. Vous êtes seul responsable de l'usage que vous en faites.
