# Analyse technique

Application CommonJS Node.js : Fastify 4, interface HTML/JS servie par
@fastify/static, better-sqlite3 11 avec SQLite WAL. Pas de PostgreSQL/Redis requis.
La passerelle SMS tourne sur Android, hors Docker.

Docker utilise Node 22 Debian slim et une étape de compilation pour le module
natif SQLite ; les outils de compilation ne sont pas dans l'image finale.
Le démarrage direct node src/server.js utilise les variables injectées par Compose,
car npm start attend un fichier .env. Un volume garde la base, WAL et SHM.
L'application traite déjà SIGTERM/SIGINT. Le planning applique explicitement UTC+3.

Tous les fichiers de l'archive d'origine sont conservés sans modification.

| Priorité | Constat | Suite proposée |
| --- | --- | --- |
| Haute | Webhooks acceptés sans signature si la clé est vide | Configurer WEBHOOK_SIGNING_KEY ; durcir ensuite le contrôle au démarrage |
| Haute | Envois SMS sans timeout applicatif ni reprise durable | Prévoir timeout, file d'envoi et nouvelles tentatives |
| Haute | Destinataires enregistrés avant l'envoi ; inbox dédupliquée avant fin du traitement | Prévoir reprise après arrêt ou échec partiel |
| Haute | Jeton administrateur unique pour toutes les API | Ajouter comptes, rôles et isolation par fokontany avant un service multi-client |
| Moyenne | SMS envoyés successivement malgré le commentaire « en même temps » | Éviter l'accumulation des lenteurs via une file de travail adaptée |
| Moyenne | /health indique seulement ok | Superviser séparément la passerelle et les livraisons |
| Moyenne | Expéditeur inconnu transmis à tous les chefs | Confirmer cette règle métier |
| Moyenne | Comparaison de jetons : longueur de chaîne avant timingSafeEqual sur les Buffer | Vérifier la longueur des Buffer pour éviter une erreur 500 avec certains caractères Unicode |
| Moyenne | Empreintes et triggers dans la même base | Conserver des empreintes externes : un administrateur peut réécrire la base |
| Moyenne | Logs des SMS simulés avec numéros et contenu | Protéger les logs et définir leur rétention |

Dépendances conservées pour éviter une migration hors périmètre. Aucun audit
complet de vulnérabilités ni essai de passerelle Android réalisé. Les garanties de
livraison et de reprise doivent être validées avant usage pour des alertes réelles.
