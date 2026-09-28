# ` 🎤 `︲Discord Account Manager - Enhanced Forked By KataV8 : Gestion de comptes Discord sans client officiel

<p align="center">
  <img src="https://img.shields.io/badge/Electron-43-2C2E33?logo=electron&logoColor=white&style=for-the-badge">
  <img src="https://img.shields.io/badge/Node.js-22-blue?logo=nodedotjs&logoColor=white&style=for-the-badge">
  <img src="https://img.shields.io/badge/Stack-ESM_%7C_CJS-8E95E1?style=for-the-badge">
  <img src="https://img.shields.io/badge/API-Discord_v9-5865F2?style=for-the-badge">
  <img src="https://img.shields.io/badge/Anti_RateLimit-X_RateLimit_aware-00b87c?style=for-the-badge">
  <img src="https://img.shields.io/badge/Persistence-Checkpoint_%7C_Watermark_%7C_Ledger-4b0082?style=for-the-badge">
  <img src="https://img.shields.io/badge/Tests-52_verts-3ba55d?style=for-the-badge">
  <img src="https://img.shields.io/badge/License-MIT-lightgrey?style=for-the-badge">
</p>

---

<p align="center">Application de bureau Electron — gestion de serveurs, amis, messages et réactions. Automatisation d'actions Discord sans client officiel, sur son propre compte.</p>

---

> [!CAUTION]
> **Outil non officiel.** Utilisation sous votre entière responsabilité — pas d'abus, pas de spam.
> `discord.js-selfbot-v13` et l'API v9 avec un jeton utilisateur **violent les conditions d'utilisation de Discord** : risque de bannissement du compte. Cette application est un outil de gestion de données personnelles, pas un bot d'automatisation abusive.

---

## `📑`︲Sommaire

1. [`📘`︲Présentation.](#presentation)
2. [`✨`︲Fonctionnalités.](#fonctionnalites)
3. [`🧩`︲Architecture du projet.](#architecture)
4. [`⚡`︲Performances et optimisations.](#performances)
5. [`🎨`︲Interface : Sidebar Icon-Rail, Bento Grid & Thèmes.](#interface)
6. [`🛡️`︲Garde-fous & Do Not Break.](#gardefous)
7. [`⚖️`︲Choix techniques & limitations.](#choices)
8. [`🧰`︲Technologies utilisées.](#technologies)
9. [`🛠️`︲Installation.](#installation)
10. [`▶️`︲Utilisation.](#utilisation)
11. [`⚙️`︲Configuration.](#configuration)
12. [`🔧`︲Maintenance & débogage.](#maintenance)
13. [`🗺️`︲Roadmap.](#roadmap)
14. [`🤝`︲Contribution.](#contribution)
15. [`📜`︲Licence.](#licence)

---

<a id="presentation"></a>
# `📘`︲Présentation.

---

> [!NOTE]
> **Problème résolu :** gérer plusieurs comptes Discord (serveurs, amis, messages, réactions, « tout marquer comme lu ») sans lancer le client officiel, avec des volumes allant jusqu'à **100 serveurs** (comptes standard) et **200 serveurs** (comptes Nitro), **sans jamais déclencher de rate-limit** (429) ni de drapeau d'abus.
>
> **Objectif :** une application Electron légère, sans bundler ni framework, dont le cœur réseau est **piloté par les en-têtes de débit réels de l'API** (`X-RateLimit-Remaining` / `X-RateLimit-Reset-After`) — jamais par des délais arbitraires — avec une couche de **cache local** et de **reprise de scan** (checkpointing) pour ne jamais re-scanner intégralement des serveurs déjà analysés.

**Architecture en trois sous-systèmes isolés :**

| Sous-système | Fichiers | Rôle |
|---|---|---|
| **UI (renderer, ESM)** | `src/` — `components/` (4 managers + `bento.js`), `utils/` | Interface, opérations lourdes (scan/suppression), rendu fluide |
| **Pont (preload)** | `electron/preload.cjs` | `contextBridge` isolé, redaction des IPC sensibles |
| **Noyau (main, CJS)** | `electron/main.cjs`, `rateLimiter.cjs`, `persist.cjs` | **Autorité débit** (ordonnanceur header-aware), persistance atomique, sécurité des tokens |

---

<a id="fonctionnalites"></a>
# `✨`︲Fonctionnalités.

---

* ` 🖥️ `︲**Serveurs** : liste, quitter, mute / unmute, sélection multiple, suppression de messages et retrait de réactions à l'échelle du serveur.

* ` 👥 `︲**Amis** : liste, suppression.

* ` 💬 `︲**Messages** : suppression dans les DMs et groupes (avec progression, ETA, annulation, reprise par checkpoint).

* ` 🗂️ `︲**Groupes DM** : gestion complète (lister, quitter, supprimer messages, retirer réactions).

* ` ⭐ `︲**Réactions** : retrait de vos propres réactions (DMs, groupes, serveurs). Fiabilité garantie par le modèle **scan → suppression → vérification** : encodage emoji conforme à Discord (`U+FE0F` conservé — un ❤️ n'est plus envoyé comme ❤), scan **complet** à chaque run (plus de delta par watermark qui sautait des canaux et affichait « 0 réaction »), et **re-scan de contrôle** qui ne comptabilise « supprimé » que si Discord confirme l'absence. Registre local de confirmation (ledger) contre les fantômes du cache `me:true` périmé.

* ` 📖 `︲**Read All** : marquer tous les serveurs comme lus, débit gouverné, **progression live** sur le bouton.

* ` 🔑 `︲**Gestion des tokens** : enregistrer / charger / supprimer, **chiffrés au repos** (`safeStorage`), enveloppe de schéma versionnée, écritures sérialisées (mutex) et atomiques.

* ` 🩹 `︲**Reprise de scan** : toute opération interrompue (annulation, perte réseau) propose **« Reprendre / Repartir à zéro »** et reprend à l'élément près.

* ` ⚡ `︲**Delta par watermark** : un serveur déjà nettoyé n'est plus re-scanné intégralement — les canaux inchangés sont sautés (1 requête de contrôle), les modifiés sont scannés **bornés** au dernier point nettoyé.

---

<a id="architecture"></a>
# `🧩`︲Architecture du projet.

---

> [!IMPORTANT]
> **Un seul chemin HTTP autorisé** : `discordFetch()` dans le main process. Le renderer ne parle **jamais** directement à Discord — uniquement par IPC. C'est ce point unique qui garantit le contrôle du débit.

```
┌──────────────────────────────────────────────────────────────────┐
│   RENDERER  (src/ · ESM · sandbox · contextIsolation)            │
│                                                                  │
│   components/  ServerManager · DMManager · GroupManager          │
│                FriendsManager · ProgressBar · bento.js           │
│   utils/       serverMessageDeleter · serverReactionRemover      │
│                messageDeleter · reactionRemover · persist.js     │
│   limiters renderer = FILET (scan 100 r/s · delete 30 r/s)       │
└───────────────────────────────┬──────────────────────────────────┘
                                │  contextBridge · IPC (invoke/on)
┌───────────────────────────────▼──────────────────────────────────┐
│   PRELOAD  (preload.cjs)                                         │
│   electronAPI (handlers wrappés) · persistAPI                    │
│   SENSITIVE_CALLS → args/réponses masqués [redacted]             │
└───────────────────────────────┬──────────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────┐
│   MAIN PROCESS  (electron/ · CJS)                                │
│                                                                  │
│   discordFetch(method, path) ── AUTORITÉ DÉBIT                    │
│      makeRouteScheduler (X-RateLimit-aware)                      │
│        readScheduler     nominal 25 r/s · burst 16 · 12 conc.    │
│        deleteScheduler   nominal  4 r/s · burst  2 ·  4 conc.    │
│      routeKeyFor(path) → bucket par route (snowflakes masqués)   │
│                                                                  │
│   persist.cjs  → JSON atomique (tmp + rename), async             │
│      checkpoints/<op>-<serverId>.json                            │
│      watermark-<serverId>.json  ·  cleaned_reactions.json        │
│   safeStorage (tokens chiffrés) + mutex withTokenLock            │
└───────────────────────────────┬──────────────────────────────────┘
                                │  HTTPS · axios · timeout 15 s
                  ┌─────────────▼─────────────┐
                  │      DISCORD API v9       │
                  │ X-RateLimit-Remaining     │
                  │ X-RateLimit-Reset-After   │
                  │ X-RateLimit-Global        │
                  └───────────────────────────┘
```

**Blocs fonctionnels :**

| Bloc | Fichier | Rôle |
|---|---|---|
| `discordFetch()` | `electron/main.cjs` | Seul proxy REST : acquire scheduler → requête → `applyHeaders` (route + global) |
| `makeRouteScheduler` | `electron/rateLimiter.cjs` | Budget consommé optimistement (`remaining`), pause jusqu'à `reset-after`, repli nominal sans en-têtes, `Retry-After` honoré, anti-deadlock |
| `makeRateLimiter` | `electron/rateLimiter.cjs` | Token-bucket nominal (repli avant premier en-tête) |
| `readJson`/`writeJson` | `electron/persist.cjs` | I/O asynchrone, écriture atomique — **jamais de fichier tronqué** |
| `persist.js` | `src/utils/persist.js` | Checkpoint, watermark, ledger — helpers testables |
| `serverMessageDeleter.js` / `serverReactionRemover.js` | `src/utils/` | Scans (segmentés en parallèle, ≤12 segments), suppression, checkpoint/reprise |
| `messageDeleter.js` / `reactionRemover.js` | `src/utils/` | Opérations DM/groupe (scan + suppression, humanisation DELETE conservée) |
| `rateLimiter.js` | `src/utils/` | Filet renderer — **ne contraint plus** le débit réel (le main décide) |
| `ServerManager.js` | `src/components/` | Rendu chunké de la liste serveurs (50 lignes/frame) |

---

<a id="performances"></a>
# `⚡`︲Performances et optimisations.

---

## Réseau & Anti-Rate-Limit

* ` 🚦 `︲**Ordonnanceur header-aware** (`makeRouteScheduler`) : avant chaque requête, le budget réel annoncé par `X-RateLimit-Remaining` est consommé de façon optimiste ; si le bucket (route **ou** global) est à zéro, l'ordonnanceur **attend `X-RateLimit-Reset-After`** au lieu d'envoyer la requête. **Les 429 sont évités par construction**, pas subis puis punis.

* ` 📊 `︲**Zéro pénalité post-429** : l'ancien mécanisme coupait le débit à 40 % pendant 40 s après chaque 429. Désormais inatteignable : le budget est lu avant d'agir. `Retry-After` reste en ceinture de sécurité.

* ` ⚡ `︲**Bursts sûrs** : quand le bucket annonce du budget, les requêtes partent en rafale jusqu'à `remaining` (au lieu d'être bridées à un taux nominal). Benchmark local : 40 requêtes nominales ≈ 981 ms (~41 r/s) vs **0 ms** avec budget en-têtes.

* ` 🪣 `︲**Débits nominaux calibrés** (repli, avant premier en-tête) : lecture **25 r/s**, suppression **4 r/s** — seuils sûrs pour un jeton utilisateur (selfbot), plus stricts que les 50 r/s documentés des bots. Les en-têtes peuvent ensuite accorder plus.

* ` 🧵 `︲**Scan serveur parallèle segmenté** : jusqu'à 12 segments temporels par canal (découpage snowflake), workers ≤ 8 canaux — le **limiter global** plafonne le débit combiné (pas de pic local).

* ` 🔁 `︲**Retry borné** (3 tentatives) avec backoff `Retry-After` sur les mutations ; 3 tentatives réseau avant d'abandonner un segment de scan (résilience).

* ` ⏱️ `︲**Timeout global** `axios` 15 s — aucun appel ne peut pendre indéfiniment.

## Cache local & Reprise

* ` 💾 `︲**Checkpoints** (`checkpoints/<op>-<serverId>.json`) : état `scan → delete → verifying`, file de travail (`queue`) et progression (`progress.done`) par opération/serveur. Sauvegarde après chaque canal, toutes les 25 suppressions, et **à l'annulation**. Reprise à l'élément près via le prompt « Reprendre / Repartir à zéro ». Nettoyage automatique au-delà de 7 jours.

* ` 🗂️ `︲**Watermarks** (`watermark-<serverId>.json`) : dernier id vu par canal (TTL 24 h). Canal inchangé → **skip** (1 requête de contrôle) ; modifié → scan **borné** au dernier id nettoyé. Un serveur déjà analysé ne repart jamais de zéro.

* ` 🩹 `︲**Ledger anti-fantômes** (`cleaned_reactions.json`) : chaque réaction **confirmée supprimée** (204) ou **confirmée absente** (404) est mémorisée (TTL 24 h). Le cache `me:true` périmé de l'API Discord ne produit donc plus de « réactions fantômes » re-signalées à chaque run.

* ` 🔒 `︲**Écritures atomiques** (`persist.cjs` : tmp + rename, async) — un arrêt brutal ne corrompt jamais un checkpoint, watermark ou ledger.

* ` 📁 `︲**Caches à TTL** : serveurs (persistant, 30 s, contournable en `force` après mutation), canaux (mémoire, 60 s).

## UI/UX — fluidité

* ` 🎨 `︲**Design system léger** : variables CSS dans `src/styles/theme.css` — thèmes **dark** (défaut) / **light** / **discord** pilotés par `data-theme` sur `<html>` (cycle au clic, persisté en localStorage), breakpoints réels dans `app.css` — **768 / 640 / 480 px**.

* ` 📜 `︲**Rendu chunké** des listes serveurs : 50 cartes par frame (`requestAnimationFrame`) — plus de frame bloquée sur 200 entrées.

* ` 🔄 `︲**Scroll préservé** après chaque rafraîchissement de liste (`preservePageScroll`).

* ` ⏳ `︲**ETA temps réel** (suppressions), **progression live** sur « Read All », barres de progression déterminées/indéterminées.

* ` ⚡ `︲**Warm-up GPU/layout** au démarrage (`warmUpPages`) : les premiers changements de page sont aussi fluides que les suivants.

* ` 🖥️ `︲**Panneau de log debug** intégré (draggable, resizable, copie, cap 500 lignes) et `window.__logs` capé à 5000 lignes — pas de fuite mémoire. Ouvert via `window.toggleDebugLog()` depuis la console DevTools (le bouton nav « Log » a été retiré).

* ` 📉 `︲**Mapping minimal des messages** : `attachments`/`embeds`/`sticker_items`/`message_snapshots` transmis en **nombres** (`(x || 0) > 0`) au lieu de tableaux complets — parsing plus léger, `reactions` conservé complet (nécessaire).

---

<a id="interface"></a>
# `🎨`︲Interface : Sidebar Icon-Rail, Bento Grid & Thèmes.

---

## Sidebar Icon-Rail (76px)

* ` 🧊 `︲**Barre latérale compacte** (240px → 76px) : chaque onglet (**Friends / Servers / DMs / Groups**) est un **icon box** carré `48×48` (`border-radius: 12px`, fond `--bg-card`), icône centrée, **tooltip** au survol (`data-tooltip`, pur CSS, sans JS).
* ` 💜 `︲**Onglet actif** : fond `--brand` + icône sombre + glow violet.
* ` 👤 `︲**Profil compact** : avatar + bouton déconnexion (power) en boxes — le nom/texte ont été retirés.
* ` 🌗 `︲**Toggle de thème** (orb 38px) au-dessus de l'avatar : bascule `data-theme="dark|light|discord"` sur `<html>` (cycle Sombre → Clair → Discord), persisté en localStorage
* Le bouton nav « Log » a été **retiré** — le panneau de log debug reste accessible via `window.toggleDebugLog()` (console).

## Bento Grid (cartes)

* ` 🃏 `︲**Composant unifié** `src/components/bento.js` : `bentoCard()` partagé par les **4 managers** (Serveurs, DMs, Groups, Friends) + `FloatingSelectionDock` (dock d'actions groupées) + `listView` (toggle Grid/Liste).
* ` 🧱 `︲**Anatomie de carte** : en-tête (cercle de sélection `(○)` autonome à gauche, badge de statut à droite — `👑 Owner`, `DM`, `Group`, `Friend`) · identité (avatar `40×40` **dégagé de toute superposition** + nom + badge `[ID]` inline + sous-titre) · **grille d'actions 2×2** en bas.
* ` ✅ `︲**Sélection multiple** : cercle autonome (aucun chevauchement / clipping sur l'avatar) ; **Dock flottant** glassmorphism (bas-centre) avec compteur, *Select All* et actions groupées (*Read*, *Mute*, *Delete Msgs*, *Rm Reactions*, *Leave*, *Close*, *Remove*) — les boutons statiques du haut ont été supprimés.
* ` 🔀 `︲**Toggle Grid / Liste** (persisté par page en localStorage) : même DOM, bascule **CSS seule** (`.list-view`).
* ` 🎨 `︲**Actions toujours visibles, texte + emoji, codées par thème de dangerosité** — aucun menu déroulant :
  `🔕 Mute` (slate neutre) · `🗑️ Delete Msgs` (rouge mât) · `💥 Rm Reactions` (ambre) · `🚪 Leave` / `Close DM` / `🚫 Remove` (crimson).
* ` 🆔 `︲**Badge `[ID]`** inline à côté du nom : copie l'ID en 1 clic (toast « Copied to clipboard! »).

## Thèmes Clair / Sombre

* ` 🌗 `︲**Dark Slate** (défaut) : `#0f1015` app · `#16171d` sidebar · `#21232c` cartes · `#f4f4f5` texte · `#8E95E1` brand.
* ` ☀️ `︲**Light Portfolio** : `#f0f2f5` app · `#e5e8ef` sidebar · `#ffffff` cartes · `#18181b` texte · `#6366f1` brand.
* ` 🎮 `︲**Discord Dark** : `#313338` app · `#2b2d31` cartes/sidebar · `#1e1f22` neutre · `#5865f2` (Blurple) · `#f2f3f5` texte.
* ` 🎛️ `︲Toutes les couleurs passent par les variables CSS (`theme.css`, `:root[data-theme="dark|light|discord"]`) ; **transition douce** `background-color / color / border-color` au changement de thème.
* ` 📊 `︲Variables ajoutées : `--bg-sidebar`, `--btn-{neutre,danger,amber,crimson}-*`, `--owner-badge-*`, `--action-grid-*`, `--dock-bg`, `--checkbox-border`, `--hover-overlay`, `--border-subtle/strong`, `--card-shadow`.

## Backend lié

* ` 🏷️ `︲Titre de l'app + modal À propos : **« Discord Account Manager - Enhanced Forked By KataV8 »**, mention **« Forked & Enhanced by KataV8 »** sous la version.
* ` 🖥️ `︲IPC ajouté : `discord:readServer` (marquage « lu » d'un serveur — ack simple, même pattern que `readAll`) + champ `owner` dans la liste des serveurs (badge `👑 Owner`).

---

<a id="gardefous"></a>
# `🛡️`︲Garde-fous & Do Not Break.

---

> [!CAUTION]
> **Ces zones rouges protègent la garantie zéro-429 et l'intégrité des données. Toute modification d'un de ces éléments sans comprendre les conséquences peut entraîner des 429 en cascade, des blocages de jeton, des suppressions manquées ou des états corrompus.**

### 🚫 Réseau / Rate-Limit

| # | Zone rouge | Conséquence si modifiée |
|---|---|---|
| **G1** | Tout appel HTTP DOIT passer par `discordFetch()` (+ `routeKeyFor`, acquire/release scheduler) dans `main.cjs` | 429, coupure de débit, restriction d'IP, suspension de jeton |
| **G2** | Ne pas bypasser `makeRouteScheduler` (`electron/rateLimiter.cjs`) | Perte de la lecture des `X-RateLimit-*` → 429 systématiques |
| **G3** | Ne pas dépasser les nominaux lecture **25 r/s** / suppression **4 r/s** sans preuve empirique | Buckets user-token non documentés et plus stricts que les 50 r/s des bots |
| **G4** | Ne pas retirer les boucles de retry 429 (3 tentatives) ni le `Retry-After` | Suppressions perdues + drapeaux d'abus |
| **G5** | Ne pas dépasser 12 segments de scan parallèle ni `autoConcurrency` > 8 | Aucun gain (débit global déjà plafonné) + pics locaux |
| **G6** | Conserver `humanDelay(200)` sur les **DELETE** DM/groupe (le `sleep` de scan a été retiré à dessein) | Détection comportementale anti-abus (au-delà du rate-limit) |

### 🚫 Sécurité

| # | Zone rouge | Conséquence |
|---|---|---|
| **S1** | Ne jamais retirer `getTokens`/`connectDiscord`/`saveToken` de `SENSITIVE_CALLS` (`preload.cjs`) | Tokens en clair dans la console DevTools |
| **S2** | Ne jamais stocker de token en clair : `safeStorage` + enveloppe `schemaVersion` + **mutex `withTokenLock`** obligatoires | Fuite ou perte de token (race read-modify-write) |
| **S3** | Ne pas élargir l'allowlist `app:openExternal` (dépôt GitHub uniquement) ni `connect-src 'self'` | Surface d'attaque : une XSS du renderer exfiltrerait les tokens |
| **S4** | CSP `script-src 'self'` en place (les 36 handlers inline ont été migrés vers `addEventListener` / délégation `data-action`). **Ne jamais ré-introduire** de handler inline ni `'unsafe-inline'` dans `script-src` | Réouverture d'une XSS du renderer |

### 🚫 Cache / Checkpoint / Ledger

| # | Zone rouge | Conséquence |
|---|---|---|
| **P1** | Toute écriture de persistance passe par `electron/persist.cjs` (atomique) — **jamais de `writeFileSync` brut** | Fichier tronqué sur arrêt brutal → état corrompu |
| **P2** | Ne pas changer le format checkpoint/watermark/ledger sans bumper `schemaVersion` + migration | Fichiers anciens ignorés, reprise cassée |
| **P3** | Ledger : ne ledgérer que sur **204 (supprimé) ou 404 (absent)** ; un **400 ne doit jamais** être ledgéré ; **TTL 24 h à conserver** | Masquer de vraies réactions ré-ajoutées (perte d'intégrité) ou régression fantômes |
| **P4** | Ne pas retirer le prompt « Reprendre / Repartir à zéro » ni la sauvegarde à l'annulation | Progression perdue à la moindre interruption |

### 🚫 UI / Intégrité des données

| # | Zone rouge | Conséquence |
|---|---|---|
| **U1** | Rendu chunké 50/frame dans `ServerManager` à conserver | Frame bloquée sur 200 serveurs |
| **U2** | `attachments`/`embeds`/`snapshots` sont des **nombres** : les consommateurs testent `(x || 0) > 0`, **pas `.length`** | Messages « pièce jointe seule » jamais supprimés (régression déjà rencontrée et corrigée) |
| **U3** | `reactions` doit rester mappé **complet** (`emoji`, `me`) | Retrait de réactions cassé |
| **U4** | Ne pas supprimer `test/routeScheduler.test.js` / `test/persist.test.js` (garanties zéro-429 + atomicité) | Régressions silencieuses |

---

<a id="choices"></a>
# `⚖️`︲Choix techniques & limitations.

| Choix | Justification |
|---|---|
| **Electron 43 + Node 22, sans bundler** | Renderer ESM natif chargé tel quel (`index.html` → `src/main.js`), main/preload en `.cjs`. Aucune étape de build de dev. |
| **`discordFetch()` unique + `makeRouteScheduler`** | Toute la politique de débit vit au **seul endroit** où l'HTTP est émis. Les limiters renderer ne sont qu'un filet (taux relevés : scan 100 r/s, delete 30 r/s) pour ne jamais brider les bursts que les en-têtes autorisent. |
| **Bucket par route normalisée (`routeKeyFor`)** | Approximation des « major params » Discord (snowflakes masqués) — suffisant pour éviter les 429 sans modèle exact de bucket, qui n'est pas public pour les jetons utilisateur. |
| **Persistance JSON atomique plutôt que SQLite/IndexedDB** | Volumes modestes (IDs + curseurs, pas de contenu), zéro dépendance, écriture `tmp+rename` crash-safe. Pas de BBD nécessaire (YAGNI). |
| **Checkpoint en `queue` de chaînes compactes** | `"canal:message:emoji"` — non sensible, dédupliqué, repris à l'index près. Aucun contenu de message n'est stocké. |
| **Ledger TTL 24 h** | Compromis assumé : une réaction réellement ré-ajoutée dans les 24 h serait ignorée (borné dans le temps) ; en échange, le cache `me:true` périmé de Discord ne crée plus de fantômes récurrents. |
| **Scan segmenté (messages serveur)** | La parallélisation temporelle ne débloque pas le débit (plafonné par le limiter) mais rend chaque segment résilient ; la **reprise par canal** couvre l'interruption (un canal `partial` se re-scanne seul). |
| **`humanDelay` conservé sur les DELETE DM** | Au-delà du rate-limit, la suppression est la route la plus surveillée ; l'humanisation est une protection comportementale. Retirée du scan (lecture, peu risquée). |
| **`except` larges dans les opérations GUI** | Un crash silencieux journalisé vaut mieux qu'un traceback non géré qui gèle l'UI ; chaque erreur est loggée avec contexte. |
| **Limitations connues** | Couverture de tests ≈ **36 % ligne** sur le périmètre réel (le cœur pur est bien couvert : `helpers.cjs` 100 %, `emojiUtils.js` 100 %, `tokenStore.cjs` 93 % ; les composants UI et `main.cjs` restent peu testés) · `style-src 'unsafe-inline'` conservé (styles inline = risque faible) · le `X-RateLimit` des jetons utilisateur n'est pas documenté par Discord — les en-têtes sont la seule vérité. |

---

<a id="technologies"></a>
# `🧰`︲Technologies utilisées.

---

* ` ⚛️ ` ︲**Electron 43** : application de bureau (renderer sandboxé, `contextIsolation`).
* ` 🟢 ` ︲**Node.js 22** (bundlé) : moteur (main/preload `.cjs`, renderer ESM).
* ` 🌐 ` ︲**axios** : HTTP vers l'API Discord (timeout 15 s, `validateStatus`).
* ` 🤖 ` ︲**discord.js-selfbot-v13** : connexion WebSocket (login uniquement ; toutes les opérations passent par le REST).
* ` 📦 ` ︲**electron-builder** : packaging Windows (NSIS / dir) — 100% portable.
* ` 🧪 ` ︲**node:test** (stdlib) : 10 fichiers, 52 tests — `npm test`, coverage via `npm run test:coverage`.

---

<a id="installation"></a>
# `🛠️`︲Installation.

---

1️⃣︲**Prérequis.**

* ` 🟢 ` ︲**Node.js LTS** (`^20`) et **npm**.

2️⃣︲**Cloner et installer.**

```bash
git clone https://github.com/Bherl1/DiscordAccMgr.git
cd DiscordAccMgr
npm install
```

3️⃣︲**Lancer l'application.**

```bash
npm run start
```

4️⃣︲**Lancer les tests (52 tests).**

```bash
npm test
npm run test:coverage
```

5️⃣︲**Packager (Windows).**

```bash
npm run package          # NSIS + dir
npm run package:portable # identique à package (toujours portable, dossier data/ local)
```

> [!NOTE]
> Alerte Defender possible sur l'exécutable non signé — application non signée, distribution via Releases.

---

<a id="utilisation"></a>
# `▶️`︲Utilisation.

---

> [!CAUTION]
> **Avant un traitement de masse (suppression de messages / réactions), faites une copie de sauvegarde de votre compte côté Discord si l'opération est critique.** Les suppressions sont **irréversibles**. Les confirmations destructives sont systématiques, mais aucune application ne peut annuler une suppression déjà envoyée à l'API.

1️⃣︲**Se connecter.** Collez votre token utilisateur (bouton œil pour afficher). Le token peut être enregistré localement (chiffré `safeStorage`) pour un usage ultérieur.

2️⃣︲**Naviguer.** Les onglets **Friends / Servers / DMs / Groups** chargent les listes en **vue Bento Grid** (cartes) par défaut (cache 30 s, refetch en arrière-plan) ; bascule **Liste compacte** via le toggle d'en-tête (persisté par page).

3️⃣︲**Opérations par serveur** (onglet Servers, boutons de ligne) :

| Bouton | Action |
|---|---|
| `[ID]` | Copie l'ID du serveur dans le presse-papiers (toast de confirmation) |
| `🔕 Mute` | Mute / unmute le serveur |
| `🗑️ Delete Msgs` | Supprime tous vos messages du serveur — scan + suppression, **reprise par checkpoint** si interrompu |
| `💥 Rm Reactions` | Retire vos réactions — scan complet, suppression, **re-scan de vérification** (jamais de « supprimé » non confirmé) |
| `🚪 Leave` | Quitte le serveur |
| `Read All` | Marque tout comme lu — **progression `Read All (12/200)`** sur le bouton |

4️⃣︲**Lire la progression.** Chaque opération affiche un panneau : phase, compteur, **ETA**, barre de progression, bouton **Stop**.

> [!IMPORTANT]
> En cas d'interruption (Stop, perte réseau, fermeture) : la prochaine exécution de la même opération sur le même serveur propose **« Reprendre / Repartir à zéro »**. La reprise continue **à l'élément près**, sans re-scanner les canaux déjà analysés.

---

<a id="configuration"></a>
# `⚙️`︲Configuration.

---

> [!NOTE]
> Pas de fichier de configuration externe : les réglages sont dans le code, documentés ci-dessous.

* ` 🚦 `︲**Débits nominaux** (`electron/rateLimiter.cjs`) : lecture **25 r/s** (burst 16, 12 concurrents), suppression **4 r/s** (burst 2, 4 concurrents). Ces valeurs sont des **planchers de sécurité** — les en-têtes `X-RateLimit-*` gouvernent ensuite les bursts réels. Ne pas les augmenter sans preuve empirique (G3).

* ` 🪣 `︲**Filet renderer** (`src/utils/rateLimiter.js`) : scan 100 r/s, delete 30 r/s — ne contraint plus le débit (le main décide), ne sert que de protection contre un flood IPC.

* ` 🕰️ `︲**TTL** : watermark serveur 24 h · ledger réactions 24 h · cache serveurs 30 s · cache canaux 60 s · checkpoints nettoyés après 7 jours.

* ` 🔑 `︲**Tokens** : chiffrés `safeStorage` (préfixe `enc:`), enveloppe `schemaVersion: 1`, migration automatique de l'ancien format plat, entrées corrompues marquées (supprimables), écritures sérialisées par mutex.

* ` ⚙️ `︲**Environnement** : `ELECTRON_DEV=1` force l'ouverture des DevTools en build packagé. 100% portable : toutes les données (userData, session, cache, crashDumps, logs) vivent dans `data/` à côté de l'exécutable — aucun écrit dans `%APPDATA%` (migration automatique ponctuelle de l'ancien userData).

---

<a id="maintenance"></a>
# `🔧`︲Maintenance & débogage.

---

* ` 🐞 `︲**Panneau de log** : ouvert via `window.toggleDebugLog()` dans la console DevTools (`Ctrl+Shift+I`) — draggable, redimensionnable, copie dans le presse-papiers, cap 500 lignes.

* ` 🧪 `︲**Tests** : `npm test` (52 tests — rate limiter, ordonnanceur header-aware, persistance, tokens, réactions, escaping, structure `bentoCard`) ; `npm run test:coverage` pour la couverture.

* ` 🧹 `︲**Cache local** : les fichiers de persistance vivent dans `data/userData/` à côté de l'exécutable — `checkpoints/`, `watermark-*.json`, `cleaned_reactions.json`, `saved_tokens.json`, `servers_cache.json`. Les supprimer = retour à un état « à froid » (sans perte de tokens si vous ne touchez pas `saved_tokens.json`).

* ` ⚠️ `︲**Points ouverts** (tracés, à traiter par priorité) : scinder `electron/main.cjs` (monolithe restant) · remonter la couverture réelle (~36 %) vers le seuil de 80 % · création du `CHANGELOG.md` · icône d'application manquante (`src/icons/app-icon.png`) · validation `npm run package`.

---

<a id="roadmap"></a>
# `🗺️`︲Roadmap.

---

> [!NOTE]
> Pistes identifiées à partir du code et des rapports d'audit, à valider/prioriser :

* ` 🧪 `︲Remonter la couverture réelle (~36 %) vers le seuil de 80 % : tester les deleters/removers et les flux IPC avec `safeStorage` mocké.
* ` 📜 `︲Créer `CHANGELOG.md` (format Keep a Changelog) — version 1.6.0 candidate.
* ` 📈 `︲Mesure runtime des Core Web Vitals (Lighthouse/DevTools) à l'occasion d'un lancement.
* ` 🖥️ `︲Fusion des modules DM/serveur dupliqués (`messageDeleter` ↔ `serverMessageDeleter`, réactions idem) dans un cycle dédié.

---

<a id="contribution"></a>
# `🤝`︲Contribution.

---

> [!NOTE]
> Aucune convention formelle : marche à suivre standard ci-dessous.

1️⃣︲**Fork** du dépôt.

2️⃣︲**Créer une branche dédiée :**

```bash
git checkout -b feature/ma-fonctionnalite
```

3️⃣︲**Committer** des changements clairs et atomiques.

4️⃣︲**Ouvrir une Pull Request** en décrivant le contexte, le problème résolu et les effets de bord.

> [!TIP]
> Toute modification touchant au **réseau** (`discordFetch`, schedulers), à la **persistance** (formats checkpoint/watermark/ledger) ou aux **mappings de messages** doit être accompagnée des tests correspondants et d'une vérification des garde-fous (G1–G6, S1–S4, P1–P4, U1–U4).

---

<a id="licence"></a>
# `📜`︲Licence.

---

> [!IMPORTANT]
> Projet distribué sous licence **MIT** — voir le fichier `LICENSE` à la racine du dépôt. Outil non officiel : l'utilisation d'un jeton utilisateur avec l'API Discord est contraire aux conditions d'utilisation de Discord et peut entraîner le bannissement du compte concerné.
