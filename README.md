# Diva

Widget companion pour Windows : contrôle de la musique et lanceur d'apps.

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

- **Engrenage** → Réglages des apps : réordonner ou retirer les épinglées, réafficher les masquées, nombre d'apps (4 à 16), compléter ou non avec les récentes.
- **+ Ajouter une app** : recherche parmi toutes les apps installées (menu Démarrer, Store, jeux Steam).
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

## Structure

```
src/
├── main.js            # fenêtre, barre des tâches, raccourci, config, lancement d'apps
├── preload.js         # fonctions exposées à l'interface
├── default-config.json
└── renderer/          # l'interface du widget (HTML/CSS/JS)
helpers/
├── media.ps1          # pont avec le contrôle média de Windows (titre, pochette, lecture)
├── recent-apps.ps1    # apps les plus lancées, d'après l'historique UserAssist de Windows
├── installed-apps.ps1 # toutes les apps installées (pour « Ajouter une app »)
└── common.ps1         # fonctions partagées par les deux scripts d'apps
```

La musique passe par le contrôle média de Windows : ça marche avec Spotify, mais aussi YouTube dans le navigateur, etc.

`npm start` vide `ELECTRON_RUN_AS_NODE`, que certains environnements (VS Code) définissent et qui ferait démarrer Electron comme un simple Node.
