# Vonjy — prototype

Alerte de quartier par SMS pour les fokontany. Un habitant envoie **VONJY** au numéro du fokontany ; le binôme de garde, le chef fokontany et les proches de l'habitant sont prévenus en même temps. Sans réponse en 3 minutes, l'alerte monte automatiquement vers la réserve, puis vers toute la patrouille.

Ce prototype fonctionne avec de vrais SMS, envoyés et reçus par un simple téléphone Android équipé d'une carte SIM locale.

## Ce qui fonctionne

| Fonction | Comment |
| --- | --- |
| Alerte par SMS | `VONJY` (ou `SOS`) depuis n'importe quel téléphone, même basique |
| Accusé de réception | Le patrouilleur répond `OK` (ou `ENY`) ; l'habitant reçoit « Rado no ho tonga » |
| Escalade automatique | Sans OK en 3 min : réserve + chef + proches ; 3 min plus tard : toute la patrouille |
| Fausse alerte | L'habitant envoie `FOANANA` dans les 2 minutes |
| Numéro non inscrit | L'alerte part quand même vers le chef fokontany, qui rappelle |
| Planning des gardes | Binômes tirés au hasard, jamais deux membres d'une même famille, envoi par SMS |
| Registre des remises | Unité, agent, deux témoins différents ; non modifiable |
| Suite donnée | Poursuivi, libéré, revu dans le quartier |
| Signaux à examiner | Patrouilleur souvent de garde lors d'incidents, alertes sans réponse, suspects remis puis revus par unité |
| Vue de la commune | Totaux par fokontany et par semaine, sans nom ni adresse |
| Journal d'audit | Ajout seulement (refus par la base) + chaîne d'empreintes SHA-256 vérifiable |

Les SMS envoyés sont en malagasy.

## 1. Démo sur un ordinateur, sans téléphone (5 minutes)

Prérequis : Node.js 20 ou plus.

```bash
npm install
npm run demo
```

Ouvrir http://localhost:3000, jeton : `demo-demo-demo-demo`.

Dans l'onglet **Simulateur** :

1. Expéditeur `034 00 000 01` (Hanta), message `VONJY` → l'alerte apparaît dans **Alertes**, les SMS envoyés s'affichent en bas.
2. Regarder dans **Planning** qui est de garde au secteur Nord, puis envoyer `OK` depuis son numéro (Rado `034 00 001 01`, Hery `034 00 001 02`, etc.).
3. Pour voir l'escalade, ne répondez pas : au bout de 3 minutes la réserve est prévenue (raccourcir avec `ACK_TIMEOUT_SECONDS=30`).

Données entièrement fictives. `npm run demo` repart d'une base vide à chaque lancement.

## 2. Pilote avec de vrais SMS

### Matériel

- Un **téléphone Android** (8.0 ou plus), même ancien, avec une **carte SIM locale** (Yas, Orange ou Airtel) et un forfait SMS. Son numéro devient le numéro Vonjy du fokontany.
- Une **alimentation de secours** pour ce téléphone : batterie externe ou petit panneau solaire, à cause des délestages.
- Un **serveur** accessible en HTTPS (petit VPS ; un ordinateur sur place suffit pour un essai).

### Étapes

1. Installer sur le téléphone l'application open source **SMS Gateway for Android** (https://sms-gate.app).
2. Dans l'application, choisir le mode :
   - **Cloud** (le plus simple) : l'application donne un identifiant et un mot de passe ; l'adresse de l'API est `https://api.sms-gate.app`.
   - **Local** : le téléphone et le serveur sur le même réseau ; adresse `http://IP_DU_TELEPHONE:8080`.
3. Copier `.env.example` en `.env` et remplir : `ADMIN_TOKEN` (`openssl rand -hex 24`), `SMS_GATEWAY_URL`, `SMS_GATEWAY_USER`, `SMS_GATEWAY_PASS`, `WEBHOOK_SIGNING_KEY` (copiée depuis Settings > Webhooks > Signing Key).
4. Lancer le serveur : `npm install && npm start`.
5. Déclarer le webhook pour les SMS reçus (une seule fois) :

```bash
curl -u UTILISATEUR:MOT_DE_PASSE -X POST "$SMS_GATEWAY_URL/3rdparty/v1/webhooks" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://VOTRE-SERVEUR/webhooks/sms","event":"sms:received"}'
```

6. Inscrire le fokontany, les membres et les habitants (tableau de bord ou API, voir plus bas), tirer le planning, puis faire un essai : un habitant envoie `VONJY` au numéro du téléphone passerelle.

Pour un premier essai sans serveur public, un tunnel HTTPS temporaire (par exemple Cloudflare Tunnel) vers `localhost:3000` suffit.

### Inscrire les personnes (API)

Toutes les routes `/api` demandent l'en-tête `Authorization: Bearer <ADMIN_TOKEN>`.

```bash
# Fokontany
POST /api/fokontany {"name":"Tanambao"}
# Membre du comité (validé par le chef fokontany)
POST /api/members   {"fokontanyId":1,"name":"Rado","phone":"034 12 345 67","role":"patrol","family":"Rakoto","validatedBy":"Voahangy"}
# Habitant et ses proches
POST /api/residents {"fokontanyId":1,"name":"Hanta R.","phone":"034 ...","address":"Lot 12, Tanambao Avaratra","sector":"Nord",
                     "contacts":[{"name":"Soa","phone":"034 ..."}]}
# Planning du soir puis envoi par SMS
POST /api/shifts/draw   {"fokontanyId":1,"sectors":["Nord","Sud"]}
POST /api/shifts/notify {"fokontanyId":1}
# Révoquer un membre
POST /api/members/7/revoke {"reason":"..."}
```

## 3. Tests

```bash
npm test
```

12 tests couvrent le scénario complet : alerte, accusé de réception, escalade à deux niveaux, annulation, numéro inconnu, signature des webhooks et doublons, journal infalsifiable, tirage sans membres d'une même famille, remises, détection des suspects relâchés, absence de données personnelles dans la vue de la commune, refus des appels sans jeton.

## Organisation du code

```
src/config.js    variables d'environnement
src/db.js        schéma SQLite, déclencheurs « ajout seulement », journal chaîné
src/sms.js       client de la passerelle, signature des webhooks, numéros malgaches
src/service.js   logique : alertes, accusés, escalade, planning, remises, statistiques, signaux
src/app.js       serveur HTTP (Fastify) et routes
public/          tableau de bord du chef fokontany
scripts/seed.js  données fictives
test/            tests
```

## Limites du prototype (à traiter avant un déploiement large)

- **Un seul jeton d'accès** pour le tableau de bord : pas encore de comptes par rôle (chef fokontany, commune, comité). C'est la priorité suivante.
- **Un seul téléphone passerelle** : s'il tombe en panne ou n'a plus de crédit, plus d'alerte. Prévoir un second téléphone et une surveillance (alerte si aucun SMS reçu depuis X heures).
- **Coût des SMS** : chaque alerte envoie 6 à 10 SMS. Négocier un forfait avec l'opérateur.
- **Sauvegarde hors site** du fichier SQLite et de l'empreinte du journal (`/api/audit/verify`), par exemple chaque nuit.
- Le tableau de bord n'affiche pas de carte : la vue de la commune est un tableau de totaux.
- Pas encore d'application smartphone ni de fonction « rentrer en sécurité ».

Données fictives : toutes les personnes et tous les numéros de la démo sont inventés.
