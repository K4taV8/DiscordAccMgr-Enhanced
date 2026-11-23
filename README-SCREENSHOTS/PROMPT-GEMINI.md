# Prompt FLUXX / Gemini, version 3

Copier le texte ci-dessous avec les **10 captures** du dossier. Le prompt impose une hiérarchie 1 + 4 + 5 pour éviter le collage désordonné.

```text
Tu es directeur artistique et spécialiste des visuels de README GitHub.

Contexte
Je prépare le README de « Discord Account Manager - Enhanced », une application desktop Electron de gestion de compte Discord. Les 10 captures fournies servent uniquement à la capture d'écran de présentation du README. Elles sont anonymisées : ne réintroduis aucun nom, aucune photo ni aucune donnée personnelle.

Objectif
Crée un visuel de présentation unique, propre et hiérarchisé, au format 1920 × 1280 px, export PNG. Le rendu doit ressembler à une planche produit premium, avec une grande capture principale, quatre captures moyennes et cinq captures secondaires. Aucun chevauchement, aucune perspective, aucune capture coupée.

Fichiers à utiliser, tous les 10
- 03-serveurs.png : capture principale.
- 02-amis.png, 04-messages-prives.png, 05-groupes.png, 09-nettoyage.png : captures moyennes.
- 06-archives.png, 07-profil.png, 08-informations.png, 10-themes.png, 01-connexion.png : captures secondaires.

Composition imposée
- Fond général : #0f1015. Marge extérieure : 64 px.
- En-tête en haut à gauche :
  - Titre : « Discord Account Manager - Enhanced », 54 px, gras, couleur #f4f4f5, à x = 64, y = 48.
  - Sous-titre : « Nettoyage, serveurs, MP, groupes, archives et médias », 24 px, couleur #b9b9c3, à x = 64, y = 118.
  - Trait lavande #8E95E1 de 96 × 4 px à x = 64, y = 158.

- Capture principale : 03-serveurs.png.
  - Image : x = 64, y = 244, largeur = 884, hauteur = 636, ratio environ 1.39:1.
  - Légende « Serveurs » centrée sous l'image, à y = 904, sur le fond.

- Quatre captures moyennes, à droite de la principale, en grille 2 × 2 :
  - Colonne A : x = 972. Colonne B : x = 1426. Largeur = 430, hauteur = 290.
  - Rangée A : y = 244. Rangée B : y = 590.
  - Légendes centrées sous chaque image, aux centres y = 558 et y = 904, sur le fond.
  - Ordre : 02-amis.png en haut à gauche, 04-messages-prives.png en haut à droite, 05-groupes.png en bas à gauche, 09-nettoyage.png en bas à droite.
  - Légendes : Amis, Messages privés, Groupes, Nettoyage.

- Cinq captures secondaires, en bas, sur une rangée de 5 cartes alignées :
  - y = 936. Largeur = 346, hauteur = 248. Espacement = 16 px.
  - x = 64, 426, 788, 1150, 1512.
  - Légendes centrées sous chaque image, à y = 1208, sur le fond.
  - Ordre : 06-archives.png, 07-profil.png, 08-informations.png, 10-themes.png, 01-connexion.png.
  - Légendes : Archives, Profil, Informations, Thèmes, Connexion.

Cadres et détails
- Chaque capture est encadrée par une bordure fine rgba(255,255,255,0.10), un rayon de 14 px et un fond #15171f.
- La barre de titre de l'application reste visible dans chaque capture.
- Les images ne doivent être ni déformées, ni tournées, ni partiellement masquées. Si un ratio ne tombe pas juste, ajoute un fond #0f1015 autour de l'image, sans couper l'interface.
- Les légendes sont placées sous les images, sur le fond général, jamais à l'intérieur du cadre. Elles sont centrées, en 20 px, couleur #d8d8df, avec au moins 12 px d'espace sous l'image.
- Ombres très douces, maximum 20 px de flou. Aucun néon, aucun verre dépoli, aucune perspective 3D, aucun reflet, aucun faux appareil, aucune personne, aucune photo stock.
- Le rendu reste fidèle aux captures : ne redessine pas l'interface, ne remplace pas les fenêtres par des mockups.

Contraintes de vérité
- N'invente aucune fonctionnalité, aucun chiffre, aucun témoignage, aucun badge, aucun prix.
- N'ajoute pas de noms de personnes ou de comptes.
- Ne modifie pas le contenu des captures.
- Ne présente pas l'application comme une application Discord officielle.
- Le visuel est une illustration du README, pas une capture supplémentaire de l'application.

Priorité si les coordonnées exactes sont difficiles à tenir
- Garde impérativement la hiérarchie : une grande capture Serveurs, quatre captures moyennes à droite, cinq petites en bas.
- Garde les 10 captures, sans chevauchement.
- Réduis uniformément l'ensemble si nécessaire, jamais une capture isolée.

Livrable
- Un seul PNG 1920 × 1280, nommé readme-presentation.png.
- Texte incrusté uniquement : le titre, le sous-titre et les 10 légendes ci-dessus.
```
