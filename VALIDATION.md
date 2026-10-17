# État de validation

L'environnement a été recréé le 17 octobre 2026 après perte du fichier temporaire.
Les fichiers originaux sont comparés octet par octet à l'archive fournie.
Le code JavaScript et la syntaxe YAML sont vérifiés séparément lorsque les outils
correspondants sont disponibles ; cela ne remplace pas une recette Docker.

Lors de la première préparation, Docker était absent et npm ci a échoué sur HTTP
403 du registre npm. Aucun succès des tests métier, du build Docker, des volumes,
de HTTPS, ni de sauvegarde/restauration avec SQLite n'est revendiqué.

Recette sur le serveur cible :

1. Renseigner .env et lancer docker compose config --quiet.
2. docker build --target test -t vonjy:tests .
3. docker compose up -d --build --wait ; consulter /health et les logs.
4. En simulation, seed puis scénario VONJY/OK/escalade.
5. Recréer app et vérifier la persistance.
6. Tester sauvegarde et restauration sur une instance isolée.
7. Configurer HTTPS et la passerelle, désactiver la simulation, vérifier les vrais
   SMS et un webhook signé invalide (HTTP 401 attendu).
