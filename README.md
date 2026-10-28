# Diva

Widget companion pour Windows : contrôle de la musique, lanceur d'apps et « setups » (plusieurs apps d'un clic).

## Lancer

```powershell
npm install
npm start
```

- `Ctrl+Alt+D` : afficher / masquer le widget (modifiable dans la config)
- Glisser la barre du haut pour le déplacer : la position est retenue
- Icône dans la barre des tâches : config, lancement au démarrage de Windows, quitter

## Configurer

Clic droit sur l'icône → **Modifier la config**. Le fichier (`%APPDATA%\Diva\config.json`) est rechargé dès qu'on l'enregistre.

```json
{
  "hotkey": "Ctrl+Alt+D",
  "alwaysOnTop": true,
  "apps": [
    { "name": "Spotify", "open": "spotify:", "icon": "🎵" },
    { "name": "Steam", "open": "C:\\Program Files (x86)\\Steam\\steam.exe" }
  ],
  "setups": [
    { "name": "Gaming", "icon": "🎮", "apps": ["Steam", "Spotify"] }
  ]
}
```

- `open` : un `.exe`, un raccourci `.lnk`, n'importe quel fichier, ou un lien (`spotify:`, `https://...`). Les variables comme `%APPDATA%` sont acceptées.
- `icon` (facultatif) : un emoji. Sans lui, Diva prend la vraie icône de l'app.
- Un setup liste des **noms** d'apps déclarées dans `apps`.

### Apps récentes

Par défaut, la grille affiche les apps **les plus lancées ces 30 derniers jours** (8 maximum), lues dans l'historique de Windows (le même que « Plus utilisées » du menu Démarrer). Elle se met à jour toutes les 10 minutes et quand on rouvre le widget.

```json
"recent": { "enabled": true, "count": 8, "days": 30, "exclude": ["Notepad"] }
```

- `exclude` : noms d'apps à ne jamais afficher.
- `"enabled": false` : la grille montre la liste `apps` à la place.
- Windows ne compte que les lancements depuis le menu Démarrer, la barre des tâches ou le bureau (pas les jeux lancés depuis Steam, par exemple). Les outils système et les installeurs sont ignorés.

La config par défaut est dans [src/default-config.json](src/default-config.json).

## Structure

```
src/
├── main.js            # fenêtre, barre des tâches, raccourci, config, lancement d'apps
├── preload.js         # fonctions exposées à l'interface
├── default-config.json
└── renderer/          # l'interface du widget (HTML/CSS/JS)
helpers/
├── media.ps1          # pont avec le contrôle média de Windows (titre, pochette, lecture)
└── recent-apps.ps1    # apps les plus lancées, d'après l'historique UserAssist de Windows
```

La musique passe par le contrôle média de Windows : ça marche avec Spotify, mais aussi YouTube dans le navigateur, etc.

`npm start` vide `ELECTRON_RUN_AS_NODE`, que certains environnements (VS Code) définissent et qui ferait démarrer Electron comme un simple Node.
