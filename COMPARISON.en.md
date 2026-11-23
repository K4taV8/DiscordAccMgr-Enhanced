# ` 🆚 `︲Comparison: original Bherl1 vs Enhanced fork.

---

A factual comparison between the original code by **Bherl1** (`DiscordAccMgr-main`, version **1.5.6**) and the **Discord Account Manager - Enhanced** fork (`A - D.A.M-E-MAIN`, version **1.5.6**). The findings come from the source code, not from a runtime benchmark.

> [!NOTE]
> The fork builds on the original project's idea and scope. This document lists verifiable differences without disparaging Bherl1's work.

---

## ` 📊 `︲At a glance.

| Indicator | Original Bherl1 | Enhanced fork |
|---|---:|---:|
| Source files (JS/CJS/TS/HTML/CSS) | 21 | 72 |
| Source lines | 2,845 | 16,376 |
| Test files | 0 | 50 |
| Tests | 0 | 602 |
| Electron modules | 2 | 19 |
| Renderer components | 5 | 12 |
| Renderer services | 0 | 8 |
| IPC handlers | 25 | 54 |
| Themes | 1 (fixed dark) | 6 |
| Languages | EN | FR + EN |

Line counts are indicative: they measure size, not quality. The fork's suite was run for this comparison: **602 tests, 600 passed, 0 failed, 2 skipped**.

---

## ` 🧭 `︲Detailed comparison.

| Category | Original Bherl1 | Enhanced fork | Evidence |
|---|---|---|---|
| Architecture | Electron 29, a single `electron/main.js`, ESM renderer, axios and discord.js called directly from IPC handlers. | Electron 43.8.12, `electron/main.cjs` + 19 modules, ESM renderer, shared types, centralized `discordFetch` and 54 IPC handlers. | `package.json`, `electron/main.*`, `electron/*.cjs` |
| Sign-in | Manual token only. | Manual token + native Discord window; dedicated session and authentication purged on every open/close. | `electron/discordLogin.service.cjs`, `electron/main.cjs` |
| Token storage | Plain JSON in `%APPDATA%/saved_tokens.json`, returned to the renderer. | Encrypted at rest with `safeStorage`, versioned envelope, atomic writes, metadata only returned to the renderer. | `electron/tokenStore.cjs`, `electron/preload.cjs` |
| Renderer security | `contextIsolation: true`, `nodeIntegration: false`; no CSP and no explicit `sandbox: true`. | `sandbox: true`, strict CSP (`script-src 'self'`, `connect-src 'self'`), `openExternal` allowlist, `media://` validation with `realpath`. | `index.html`, `electron/main.cjs` |
| Network / rate-limit | Direct axios, no global timeout, no `maxRedirects`, fixed 500/1500 ms pauses and a single 429 retry for DMs/groups. | Single `discordFetch`, scheduler driven by `X-RateLimit-*`, 25 r/s reads / 4 r/s deletes, 15 s timeout, `maxRedirects: 0`, bounded retries. | `electron/rateLimiter.cjs`, `electron/main.cjs` |
| Resume / integrity | No checkpoint or resume; full collection then deletion, an interruption starts over. | Checkpoints, watermarks, anti-ghost ledger, atomic JSON writes and per-operation resume. | `electron/persist.cjs`, `electron/main.cjs`, `src/utils/persist.js` |
| Server cleanup | No message deletion or reaction removal; only mute/unmute, leave and read all. Owned servers are excluded. | 4 modes (messages, reactions, combined, full + leave), multi-select, owned servers included with a badge, parallel scan and checkpoints. | `src/components/ServerManager.js`, `src/components/CleaningModeSelector.js`, `src/utils/serverMessageDeleter.js` |
| DM/group cleanup | Message deletion (newest/oldest order), DM close, group leave and bulk actions; no reactions or combined mode. | 4 modes, reaction removal, combined mode, close/leave, progress, cancellation and bulk actions. | `src/components/DMManager.js`, `src/components/GroupManager.js`, `src/utils/reactionRemover.js` |
| Data Package | Absent. | ZIP import, Messages view, gallery, filters, search, ZIP/JSON export, local media mirror and `media://` protocol. | `src/components/PackageManager.js`, `src/services/*`, `electron/packageImporter.*`, `electron/mediaMirror.service.cjs` |
| Persistence / portability | `app.getPath('userData')`, data in `%APPDATA%`, no portable mode. | `data/` next to the executable, legacy-location migration, local cache/sessions/logs/media. | `electron/main.cjs` |
| Interface | Sidebar + lists, English only, single dark theme, simple modals. | Bento + list view, 6 themes, FR/EN, compact profile, Info, Help, mode selector, action dock and progress panel. | `src/components/*`, `src/styles/app.css`, `src/styles/theme.css`, `src/i18n/*` |
| Performance / rendering | Lists rendered in one pass, no preloading or virtualization. | Chunked server-list rendering (50 cards/frame), page preloading, virtualized gallery and tile recycling. | `src/components/ServerManager.js`, `src/utils/pagePreloader.js`, `src/services/galleryIndex.service.js` |
| i18n | Hard-coded English strings. | FR/EN dictionaries, direct toggle and localized dates. | `src/i18n/*`, `src/components/LanguageSelector.js` |
| Tests / quality | 0 tests, no typecheck, no coverage, no audit. | 50 test files, 602 tests, `tsc --noEmit`, coverage, `npm audit` and ASAR verification. | `test/*`, `package.json` |
| Packaging | NSIS only. | NSIS + portable folder, `package:portable`, `verify:asar` and file allowlist. | `package.json`, `scripts/verifier-asar.cjs` |
| Updates | GitHub network check on every start. | Neutralized handler (`hasUpdate: false`): no automatic GitHub request. | `electron/main.cjs` |
| Documentation | Rich README, but it advertises features absent from the supplied code: adding/searching friends, joining servers and deleting server messages. | README aligned with the features actually present, with gallery, comparison, roadmap and AI transparency. | both repositories' `README.md` |
| Maintainability | 565-line `electron/main.js`, 2 Electron modules, no separate services. | 19 Electron modules, 12 components, 8 services, 50 tests and shared types. | file trees |

---

## ` ✅ `︲What the fork keeps.

* The same idea: manage your own Discord account without the official client.
* Friends, servers, DMs and groups lists, plus token sign-in.
* The MIT license and attribution to **Bherl1**.
* The goal of saving time on repetitive tasks, without spam or abuse.

---

## ` ⚖️ `︲Fair reading.

The fork is more complete, more tested and more hardened on security. The original remains lighter: 21 source files, 2 Electron modules and only two runtime dependencies. "Superiority" therefore depends on the use case: minimal simplicity for the original, feature coverage and maintenance for the fork.

---

## ` ⚠️ `︲Limitations.

* Static code comparison, not a performance benchmark.
* File and line counts are indicative and do not measure quality on their own.
* The fork's features depend on the state of the code at the time of this comparison.
