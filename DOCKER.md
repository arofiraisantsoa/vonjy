# Vonjy : environnement Docker

Prérequis : Docker Engine et plugin Compose v2 récent, ou Docker Desktop.
Commandes Bash (Linux/WSL), depuis le répertoire contenant compose.yaml.

## Démarrage

```bash
cp docker/.env.example .env
chmod 600 .env
openssl rand -hex 24
```

Reporter le résultat dans ADMIN_TOKEN dans .env (16 caractères minimum).
Pour un essai : SMS_DRY_RUN=true et SIMULATION=true.

```bash
docker compose config --quiet
docker compose build --pull
docker compose up -d --wait
docker compose ps
curl --fail http://localhost:3000/health
```

Ouvrir http://localhost:3000 et entrer le jeton. Données fictives optionnelles :

```bash
docker compose exec app node scripts/seed.js
```

La base déjà renseignée n'est pas réinitialisée. Dans le simulateur, envoyer
VONJY depuis 0340000001, puis consulter le planning pour choisir un patrouilleur
qui répond OK. Ne pas utiliser npm run demo pour l'exploitation : il efface sa
base de démonstration à chaque lancement.

SQLite est stocké dans un volume nommé (vonjy_data par défaut). Une seule instance
app : ne pas répliquer le service. La passerelle SMS Android reste externe.
Le processus utilise UID 1000, le système de fichiers est en lecture seule hors
données et /tmp, et aucun secret .env n'est copié dans l'image.

L'écoute publiée est locale par défaut. Pour un essai sur le LAN : mettre
BIND_IP=0.0.0.0 puis docker compose up -d et ouvrir http://IP_SERVEUR:3000.
Limiter cet accès au réseau de test. Pour Internet, utiliser HTTPS.

## HTTPS optionnel

Créer un DNS pointant vers le serveur, ouvrir TCP 80/443 (UDP 443 facultatif),
et vérifier qu'aucun autre service n'occupe ces ports. Dans .env :

```dotenv
DOMAIN=vonjy.exemple.fr
ACME_EMAIL=admin@exemple.fr
BIND_IP=127.0.0.1
```

```bash
docker compose -f compose.yaml -f compose.https.yaml config --quiet
docker compose -f compose.yaml -f compose.https.yaml up -d --build --wait
```

Ouvrir https://vonjy.exemple.fr. Garder ces deux options -f pour la gestion de
cette installation (up, logs, down). Si vous avez déjà un proxy HTTPS sur l'hôte,
utiliser uniquement compose.yaml et le diriger vers 127.0.0.1:3000. Un proxy
conteneurisé doit partager un réseau avec app et utiliser app:3000 ; son localhost
ne désigne pas l'hôte.

## SMS réels

Renseigner dans .env : SIMULATION=false, SMS_DRY_RUN=false,
SMS_GATEWAY_URL, SMS_GATEWAY_USER, SMS_GATEWAY_PASS, WEBHOOK_SIGNING_KEY et
SERVICE_NUMBER. Exemple d'URL locale : http://192.168.1.50:8080.
Le téléphone doit être joignable depuis le conteneur ; localhost ne le désigne
pas. Le README d'origine décrit aussi la passerelle cloud.

Appliquer avec docker compose up -d (restart ne recharge pas les variables).
Déclarer dans la passerelle le webhook https://VOTRE_DOMAINE/webhooks/sms pour
sms:received. Ne pas laisser la clé de signature vide : le code d'origine accepte
alors des webhooks sans vérification. Tester avec le téléphone : SMS entrant,
notifications, accusés et refus d'une signature invalide. Le protocole de signature
reste à confirmer avec la version Android utilisée.

## Gestion

```bash
docker compose logs --tail=100 -f app
docker compose restart app
docker compose down
```

Down conserve les données. **Down -v supprime les volumes et la base** (et les
certificats avec la variante HTTPS). Healthcheck contrôle HTTP, pas la livraison
SMS ; restart: unless-stopped ne redémarre pas un conteneur simplement unhealthy.

## Sauvegarde cohérente SQLite

Ne pas copier seulement le fichier .db actif : il utilise aussi WAL/SHM.
L'API backup utilisée ci-dessous crée un snapshot cohérent à chaud :

```bash
mkdir -p backups
chmod 700 backups
backup_name="vonjy-$(date -u +%Y%m%dT%H%M%SZ).db"
docker compose exec -T app node scripts/backup.js "/tmp/$backup_name"
docker compose cp "app:/tmp/$backup_name" "backups/$backup_name"
chmod 600 "backups/$backup_name"
docker compose exec -T app rm "/tmp/$backup_name"
```

Copier la sauvegarde hors du serveur. Sauvegarder .env séparément et le protéger.
/tmp est limité à 32 Mio ; augmenter cette taille ou monter un volume de sauvegarde
si la base dépasse cette taille.

Restauration : sauvegarder d'abord l'état actuel, arrêter l'application et remplacer
la base (procédure destructive pour la base actuelle, à tester en environnement isolé) :

```bash
docker compose stop app
docker compose run --rm --no-deps -T --entrypoint sh app -c \
  'umask 077; rm -f /app/data/vonjy.db-wal /app/data/vonjy.db-shm; cat > /app/data/vonjy.db' \
  < backups/vonjy-AAAAMMJJTHHMMSSZ.db
docker compose up -d --wait
```

Vérifier les données et /api/audit/verify avec Authorization: Bearer VOTRE_JETON.

## Tests et mises à jour

```bash
docker build --target test -t vonjy:tests .
```

Le build runtime ne lance pas implicitement cette étape. Après sauvegarde et tests :

```bash
docker compose build --pull
docker compose up -d --wait
```

Le volume est conservé. Les tags Node/Caddy suivent une version majeure ; pour une
construction strictement immuable, figer leurs digests après validation.
En cas d'erreur de téléchargement, vérifier l'accès aux registres npm/Docker.
En cas d'EACCES sur SQLite avec un bind mount, donner les droits au UID 1000 ; le
volume nommé fourni évite cette préparation. Ne pas utiliser chmod 777.
