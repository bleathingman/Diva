# Diva

Widget companion pour Windows : contrôle de la musique, volume et lanceur d'apps.

- **Musique** : titre, pochette, lecture/pause, barre de progression (clic ou glisser pour avancer dans le morceau), visualiseur calé sur le son du PC, ❤ pour liker sur Spotify.
- **Volume** : volume général et coupure du son ; la flèche déplie le volume de chaque app qui a du son. Sortie audio changeable d'un clic (casque, écran...).
- **Recherche** : taper n'importe quelle lettre sur le widget (ou la loupe) cherche dans les apps installées, épinglées, récentes et les liens ; fait aussi les calculs (`12*4`, `200*15%`, Entrée copie le résultat) et propose une recherche web. ↑ ↓ Entrée, Échap.
- **Apps et liens** : apps épinglées, sites et dossiers favoris, et les apps les plus lancées (voir plus bas).
- **Fenêtre** : toujours au premier plan, se cacher quand on clique ailleurs, aimantation aux bords de l'écran, opacité au repos (pleine au survol).
- **Taille** : Petit / Moyen / Grand dans les réglages, ou sur mesure en tirant un coin du bas du widget (de 75 % à 160 %). Tout est mis à l'échelle, la mise en page reste la même.

## Installer

```powershell
npm install
npm run dist
```

Puis lancer `dist\Diva-Setup-<version>.exe` : Diva s'installe pour l'utilisateur (sans droits admin) dans `%LOCALAPPDATA%\Programs\Diva`, avec un raccourci dans le menu Démarrer. Pour une mise à jour, augmenter `version` dans `package.json`, refaire `npm run dist` et relancer l'installeur.

L'exe n'est pas signé : au premier lancement, Windows SmartScreen peut afficher « Windows a protégé votre ordinateur » → **Informations complémentaires** → **Exécuter quand même**.

## Développer

```powershell
npm install
npm start
```

La version installée et `npm start` partagent la même config (`%APPDATA%\Diva`) et ne peuvent pas tourner en même temps.

- `Ctrl+Alt+D` : afficher / masquer le widget (modifiable dans la config)
- Glisser la barre du haut pour le déplacer : la position est retenue
- Icône dans la barre des tâches : config, lancement au démarrage de Windows, quitter

## Configurer

Clic droit sur l'icône → **Modifier la config**. Le fichier (`%APPDATA%\Diva\config.json`) est rechargé dès qu'on l'enregistre.

```json
{
  "hotkey": "Ctrl+Alt+D",
  "window": { "alwaysOnTop": true, "hideOnBlur": false, "snapToEdges": true, "idleOpacity": 100, "scale": 1, "visualizer": true },
  "apps": [
    { "name": "Spotify", "open": "spotify:", "icon": "🎵" }
  ]
}
```

- `apps` : apps nommées, prioritaires sur celles trouvées automatiquement (le bouton « Ouvrir Spotify » lance celle qui s'appelle `Spotify`).
- `open` : un `.exe`, un raccourci `.lnk`, n'importe quel fichier, ou un lien (`spotify:`, `https://...`). Les variables comme `%APPDATA%` sont acceptées.
- `icon` (facultatif) : un emoji. Sans lui, Diva prend la vraie icône de l'app.

### Grille d'apps

La grille affiche d'abord tes apps **épinglées**, puis la complète avec les apps **les plus lancées ces 30 derniers jours**, lues dans l'historique de Windows (le même que « Plus utilisées » du menu Démarrer). Elle se met à jour toutes les 10 minutes et quand on rouvre le widget.

Tout se règle dans le widget :

- **Engrenage** → Réglages : réordonner ou retirer les épinglées, réafficher les masquées, nombre d'apps (4 à 16), compléter ou non avec les récentes, options de la fenêtre.
- **+ App** : recherche parmi toutes les apps installées (menu Démarrer, Store, jeux Steam).
- **+ Lien** : un site (`youtube.com`) ou un dossier, épinglé comme une app. L'icône du site est récupérée automatiquement (dans `%APPDATA%\Diva\icons`).
- **Clic droit sur une app** de la grille : épingler, désépingler, masquer.

Ces réglages sont enregistrés dans la config :

```json
"grid": {
  "count": 8,
  "fillWithRecent": true,
  "recentDays": 30,
  "pinned": [{ "name": "Spotify", "open": "shell:AppsFolder\\SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify" }],
  "hidden": ["Notepad"]
}
```

Windows ne compte que les lancements depuis le menu Démarrer, la barre des tâches ou le bureau (pas les jeux lancés depuis Steam, par exemple). Les outils système et les installeurs sont ignorés.

La config par défaut est dans [src/default-config.json](src/default-config.json).

### Spotify (❤)

Réglages → Spotify → Connecter, puis suivre les 3 étapes. Il faut une app gratuite sur [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard), avec un compte **Premium** (obligatoire pour les apps en mode développement) et la Redirect URI `http://127.0.0.1:43117/callback`.

Le jeton est chiffré dans `%APPDATA%\Diva\spotify.token`. Spotify impose de se reconnecter tous les 6 mois.

### Visualiseur

Il analyse le son qui sort du PC (toutes les apps, pas seulement Spotify). Le son n'est ni enregistré ni envoyé, et la capture s'arrête quand la musique est en pause ou le widget caché. Il se désactive dans Réglages → Fenêtre.

## Structure

```
src/
├── main.js            # fenêtre, barre des tâches, raccourci, config, lancement d'apps
├── preload.js         # fonctions exposées à l'interface
├── spotify.js         # connexion Spotify et ❤
├── default-config.json
└── renderer/          # l'interface du widget (HTML/CSS/JS)
helpers/
├── media.ps1          # pont avec le contrôle média de Windows (titre, pochette, lecture, position)
├── audio.ps1          # pont avec le mélangeur de volume de Windows (Core Audio)
├── recent-apps.ps1    # apps les plus lancées, d'après l'historique UserAssist de Windows
├── installed-apps.ps1 # toutes les apps installées (pour « Ajouter une app »)
└── common.ps1         # fonctions partagées par les deux scripts d'apps
```

La musique passe par le contrôle média de Windows : ça marche avec Spotify, mais aussi YouTube dans le navigateur, etc.

`npm start` vide `ELECTRON_RUN_AS_NODE`, que certains environnements (VS Code) définissent et qui ferait démarrer Electron comme un simple Node.
