# Which country has the best DJ?

Tournoi par élimination directe entre pays : chaque pays envoie ses DJ (nés dans le pays), à tour de rôle, puis on vote. Les vues YouTube cumulées donnent le « vote populaire ».

## Fichiers

- `index.html` : le site
- `data/countries.json` : les pays et leurs DJ (à modifier librement)
- `data/videos.json` : vidéos et vues, **généré automatiquement**, ne pas modifier à la main
- `scripts/update-videos.mjs` : script qui interroge l'API YouTube
- `.github/workflows/deploy.yml` : met à jour les vues chaque jour et publie le site

## Ajouter ou modifier un DJ

Dans `data/countries.json` :

```json
{ "artist": "Avicii", "song": "Levels" }
```

`song` peut être vide. Pour imposer une vidéo précise, ajoutez son identifiant (les 11 caractères après `v=` dans l'URL) :

```json
{ "artist": "Avicii", "song": "Levels", "videoId": "_ovdm2yX4MA" }
```

Après un commit, l'action cherche automatiquement les nouveaux morceaux.

## La clé API

Elle est stockée dans les secrets GitHub (`YT_API_KEY`) et n'est jamais publiée sur le site.
