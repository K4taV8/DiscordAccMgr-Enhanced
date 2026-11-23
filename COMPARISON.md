# ` 🆚 `︲Comparaison : original Bherl1 vs fork Enhanced.

---

Comparaison factuelle entre le code original de **Bherl1** (`DiscordAccMgr-main`, version **1.5.6**) et le fork **Discord Account Manager - Enhanced** (`A - D.A.M-E-MAIN`, version **1.5.6**). Les constats viennent du code source, pas d'un benchmark d'exécution.

> [!NOTE]
> Le fork reprend l'idée et le cadre du projet original. Ce document liste les différences vérifiables, sans dénigrer le travail de Bherl1.

---

## ` 📊 `︲En bref.

| Indicateur | Original Bherl1 | Fork Enhanced |
|---|---:|---:|
| Fichiers source (JS/CJS/TS/HTML/CSS) | 21 | 72 |
| Lignes source | 2 845 | 16 376 |
| Fichiers de test | 0 | 50 |
| Tests | 0 | 602 |
| Modules Electron | 2 | 19 |
| Composants renderer | 5 | 12 |
| Services renderer | 0 | 8 |
| Handlers IPC | 25 | 54 |
| Thèmes | 1 (sombre fixe) | 6 |
| Langues | EN | FR + EN |

Les lignes de code sont indicatives : elles mesurent la taille, pas la qualité. La suite du fork a été exécutée pour cette comparaison : **602 tests, 600 réussis, 0 échec, 2 ignorés**.

---

## ` 🧭 `︲Comparaison détaillée.

| Catégorie | Original Bherl1 | Fork Enhanced | Preuve |
|---|---|---|---|
| Architecture | Electron 29, `electron/main.js` unique, renderer ESM, axios et discord.js appelés directement dans les handlers IPC. | Electron 43.8.12, `electron/main.cjs` + 19 modules, renderer ESM, types partagés, `discordFetch` centralisé et 54 handlers IPC. | `package.json`, `electron/main.*`, `electron/*.cjs` |
| Connexion | Jeton manuel uniquement. | Jeton manuel + fenêtre Discord native ; session dédiée et authentification purgée à chaque ouverture/fermeture. | `electron/discordLogin.service.cjs`, `electron/main.cjs` |
| Stockage des jetons | JSON en clair dans `%APPDATA%/saved_tokens.json`, renvoyé au renderer. | Chiffré au repos avec `safeStorage`, enveloppe versionnée, écritures atomiques, métadonnées seulement renvoyées au renderer. | `electron/tokenStore.cjs`, `electron/preload.cjs` |
| Sécurité renderer | `contextIsolation: true`, `nodeIntegration: false` ; pas de CSP ni de `sandbox: true` explicite. | `sandbox: true`, CSP stricte (`script-src 'self'`, `connect-src 'self'`), allowlist `openExternal`, validation `media://` avec `realpath`. | `index.html`, `electron/main.cjs` |
| Réseau / rate-limit | Axios direct, pas de timeout global, pas de `maxRedirects`, pauses fixes de 500/1500 ms et un seul retry 429 pour les MP/groupes. | `discordFetch` unique, scheduler piloté par `X-RateLimit-*`, 25 r/s lecture / 4 r/s suppression, timeout 15 s, `maxRedirects: 0`, retries bornés. | `electron/rateLimiter.cjs`, `electron/main.cjs` |
| Reprise / intégrité | Aucun checkpoint ni reprise ; collecte complète puis suppression, une interruption repart de zéro. | Checkpoints, watermarks, ledger anti-fantômes, écritures JSON atomiques et reprise par opération. | `electron/persist.cjs`, `electron/main.cjs`, `src/utils/persist.js` |
| Nettoyage serveurs | Aucune suppression de messages ni retrait de réactions ; seulement mute/unmute, leave et read all. Les serveurs possédés sont exclus. | 4 modes (messages, réactions, combiné, complet + leave), sélection multiple, serveurs possédés inclus avec badge, scan parallèle et checkpoints. | `src/components/ServerManager.js`, `src/components/CleaningModeSelector.js`, `src/utils/serverMessageDeleter.js` |
| Nettoyage MP/groupes | Suppression de messages (ordre récent/ancien), fermeture MP, leave groupe et actions en lot ; pas de réactions ni de mode combiné. | 4 modes, retrait des réactions, combiné, fermeture/leave, progression, annulation et actions en lot. | `src/components/DMManager.js`, `src/components/GroupManager.js`, `src/utils/reactionRemover.js` |
| Data Package | Absent. | Import ZIP, vue Messages, galerie, filtres, recherche, export ZIP/JSON, miroir média local et protocole `media://`. | `src/components/PackageManager.js`, `src/services/*`, `electron/packageImporter.*`, `electron/mediaMirror.service.cjs` |
| Persistance / portabilité | `app.getPath('userData')`, données dans `%APPDATA%`, pas de mode portable. | `data/` à côté de l'exécutable, migration de l'ancien emplacement, cache/sessions/logs/médias locaux. | `electron/main.cjs` |
| Interface | Sidebar + listes, anglais uniquement, thème sombre unique, modales simples. | Bento + vue liste, 6 thèmes, FR/EN, profil compact, Info, Help, sélecteur de modes, dock d'actions et panneau de progression. | `src/components/*`, `src/styles/app.css`, `src/styles/theme.css`, `src/i18n/*` |
| Performance / rendu | Listes rendues en bloc, sans préchargement ni virtualisation. | Rendu chunké de la liste serveurs (50 cartes/frame), préchargement des pages, galerie virtualisée et recyclage des tuiles. | `src/components/ServerManager.js`, `src/utils/pagePreloader.js`, `src/services/galleryIndex.service.js` |
| i18n | Chaînes anglaises codées en dur. | Dictionnaires FR/EN, bascule directe et dates localisées. | `src/i18n/*`, `src/components/LanguageSelector.js` |
| Tests / qualité | 0 test, pas de typecheck, pas de couverture, pas d'audit. | 50 fichiers de test, 602 tests, `tsc --noEmit`, couverture, `npm audit` et vérification ASAR. | `test/*`, `package.json` |
| Packaging | NSIS uniquement. | NSIS + dossier portable, `package:portable`, `verify:asar` et allowlist de fichiers. | `package.json`, `scripts/verifier-asar.cjs` |
| Mise à jour | Vérification réseau GitHub à chaque démarrage. | Handler neutralisé (`hasUpdate: false`) : aucune requête GitHub automatique. | `electron/main.cjs` |
| Documentation | README riche, mais annonce des fonctions absentes du code fourni : ajout/recherche d'amis, join de serveurs et suppression de messages serveur. | README aligné sur les fonctions réellement présentes, avec galerie, comparaison, roadmap et transparence IA. | `README.md` des deux dépôts |
| Maintenabilité | `electron/main.js` de 565 lignes, 2 modules Electron, pas de services séparés. | 19 modules Electron, 12 composants, 8 services, 50 tests et types partagés. | arborescences |

---

## ` ✅ `︲Ce que le fork conserve.

* La même idée : gérer son propre compte Discord sans passer par le client officiel.
* Les listes amis, serveurs, MP et groupes, ainsi que la connexion par jeton.
* La licence MIT et l'attribution à **Bherl1**.
* L'objectif de faire gagner du temps sur les tâches répétitives, sans spam ni usage abusif.

---

## ` ⚖️ `︲Lecture honnête.

Le fork est plus complet, plus testé et plus durci sur la sécurité. L'original reste plus léger : 21 fichiers source, 2 modules Electron et seulement deux dépendances runtime. La « supériorité » dépend donc de l'usage : simplicité minimale pour l'original, couverture fonctionnelle et maintenance pour le fork.

---

## ` ⚠️ `︲Limites.

* Comparaison statique du code, pas un benchmark de performance.
* Les nombres de fichiers et de lignes sont indicatifs et ne mesurent pas la qualité à eux seuls.
* Les fonctions du fork dépendent de l'état du code à la date de cette comparaison.
