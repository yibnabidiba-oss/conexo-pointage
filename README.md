# Pointage Conexo

Application web de pointage des heures de log des conseillers du centre d'appels Conexo.

- **Conseiller** : se connecte avec son matricule et son code PIN, puis indique son statut : Production, Pause, Déjeuner, Brief / formation, Fin de journée. L'heure enregistrée est **celle du serveur**, le réglage de l'horloge du PC ne change rien.
- **Encadrement** (`/encadrement`) : plateau en direct, heures de log et adhérence au planning par période, corrections tracées, gestion des conseillers et de leur horaire, export Excel.

Aucune dépendance à installer : Node.js 22.13 ou plus récent suffit (base SQLite intégrée à Node).

## Règles de calcul

| Indicateur | Calcul |
|---|---|
| Heures de log | Temps connecté hors déjeuner = Production + Pauses + Brief/formation |
| Production | Temps passé en statut Production |
| Dépassement de pause | Pauses du jour au-delà de la pause autorisée (30 min par défaut) |
| Retard | Première connexion après l'heure prévue, au-delà de la tolérance (5 min par défaut) |
| Départ anticipé | Fin de journée avant l'heure de fin prévue, au-delà de la tolérance |
| Absence | Jour avec horaire prévu et aucun pointage |
| Oubli de déconnexion | Pas de « Fin de journée » : le compteur s'arrête à l'heure de fin prévue et la journée est signalée « À corriger » |
| Adhérence | Temps au poste (hors déjeuner) pendant l'horaire prévu ÷ temps prévu (horaire − déjeuner), calculée une fois la journée terminée |

Tolérance, pause autorisée et liste des activités se règlent dans **Paramètres**.
Toute correction exige un motif et apparaît dans le journal des modifications (administrateurs).

Les journées sont découpées à minuit, fuseau `Africa/Casablanca` par défaut (variable `APP_TZ`). Une équipe de nuit qui passe minuit n'est pas gérée dans cette version.

## Lancer en local

```bash
node --version          # doit afficher v22.13 ou plus
npm start               # http://localhost:3000
npm test                # tests des règles de calcul
```

Au premier lancement, ouvrez `/encadrement` : la page demande de créer le compte administrateur. Ajoutez ensuite les conseillers (un par un ou en import `matricule;nom;prénom;activité;PIN`) et leur horaire de la semaine.

## Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `3000` | Port HTTP |
| `DATA_DIR` | `./data` | Dossier de la base `pointage.db` — **doit être un disque persistant** |
| `APP_TZ` | `Africa/Casablanca` | Fuseau horaire des calculs |
| `COOKIE_SECURE` | — | Mettre `1` si le site est en HTTPS sans en-tête `X-Forwarded-Proto` |

## Mettre sur GitHub

```bash
git init
git add .
git commit -m "Pointage Conexo v1"
git branch -M main
git remote add origin https://github.com/<compte>/conexo-pointage.git
git push -u origin main
```

Le dossier `data/` est exclu par `.gitignore` : la base ne part jamais sur GitHub.

## Héberger

Point clé : la base est un fichier SQLite. L'hébergeur doit fournir un **disque persistant**, sinon les pointages sont perdus à chaque redéploiement.

**Railway** (le plus simple depuis GitHub)
1. New Project → Deploy from GitHub repo → choisir `conexo-pointage`.
2. Ajouter un **Volume** monté sur `/data`.
3. Variables : `DATA_DIR=/data`, `APP_TZ=Africa/Casablanca`.
4. Settings → Networking → Generate Domain (HTTPS automatique).

**Render**
Web Service depuis le dépôt, Build Command vide, Start Command `npm start`, ajouter un **Persistent Disk** monté sur `/data` (offre payante) et `DATA_DIR=/data`. L'offre gratuite n'a pas de disque persistant : à éviter.

**VPS (OVH, Hostinger, Contabo…) avec Docker**
```bash
git clone https://github.com/<compte>/conexo-pointage.git && cd conexo-pointage
docker build -t conexo-pointage .
docker run -d --name pointage --restart unless-stopped -p 3000:3000 -v /srv/pointage:/data conexo-pointage
```
Mettez ensuite un reverse proxy HTTPS devant (Caddy ou Nginx + Let's Encrypt). Avec Caddy : `pointage.votredomaine.ma { reverse_proxy localhost:3000 }`.

**Sauvegarde** : copiez régulièrement `pointage.db` depuis le dossier de données (par exemple une tâche cron quotidienne vers un autre serveur ou un stockage cloud).

## Sur les postes

Mettez l'adresse du site en page d'accueil du navigateur de chaque poste. Le conseiller ferme sa session avec « Fermer ma session sur ce poste » quand il quitte le poste ; sinon la session expire seule après 14 heures.

Après 5 codes PIN faux, le matricule est bloqué 5 minutes.

## Structure

```
server.js          serveur HTTP et API
lib/calc.js        règles de calcul (heures, retards, adhérence)
lib/db.js          schéma SQLite
lib/time.js        dates et fuseau
public/            écrans conseiller (index.html) et encadrement (admin.html)
test/              tests des règles de calcul
```
