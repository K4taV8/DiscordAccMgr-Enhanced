# Discord Account Manager

> Gestion de compte Discord via application desktop
> Serveurs · Amis · Messages · Nettoyage

---

> [!CAUTION]
> Outil non officiel.
>
> Utilisation sous ta responsabilité.
> Pas d’abus, pas de spam.

---

## Usage

Gestion du compte sans client Discord officiel :

* serveurs (liste, rejoindre, quitter)
* amis (liste, ajout, suppression)
* messages (suppression en masse)

Objectif : automatiser les actions répétitives.

---

## Fonctionnalités

### Serveurs

* liste
* rejoindre / quitter
* recherche

### Amis

* liste
* ajout
* suppression
* recherche

### Messages

* suppression (DMs / serveurs)
* volume configurable

### Général

* rapide
* interface simple
* multi-plateforme (Windows / macOS / Linux build)

---

## Stack

* Electron
* Node.js
* discord.js-selfbot-v13
* npm
* electron-builder

---

## Prérequis

* Node.js (LTS)
* npm
* Git

```bash
node -v
npm -v
```

---

## Installation

```bash
git clone https://github.com/Bherl1/DiscordAccMgr.git
cd DiscordAccMgr
npm install
```

---

## Lancement

```bash
npm run start
```

DevTools :

* Windows / Linux : Ctrl + Shift + I
* macOS : Cmd + Option + I

---

## Build Windows

* exécutable .exe disponible (Releases)
* aucune dépendance requise
* lancement direct

Note : alerte Windows Defender possible (application non signée)

---

## Utilisation

### Serveurs

* accès via Server Manager
* actions immédiates

### Amis

* gestion directe
* recherche intégrée

### Messages

* suppression irréversible
* progression affichée
* respect des limites Discord

Note : suppression massive = lenteur normale

---

## Contribution

```bash
fork → branch → commit → pull request
```

---

## Licence

MIT — sans garantie

---
