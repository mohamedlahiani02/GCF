# Démo autonome AXELIA

Configuration préparée le 14 novembre 2026 pour une présentation par le responsable commercial depuis le poste du client.

Render Free héberge Fastify, le back-office compilé, le site public et le portail. Neon Free héberge une copie PostgreSQL de la base AXELIA de démonstration. Les données, photos et PDF archivés sont dans PostgreSQL.

Le fichier `render.yaml` prépare le service gratuit et ses commandes de compilation et de démarrage. Les dépendances de développement sont installées explicitement, car le projet exécute TypeScript avec `tsx`. Les migrations sont exécutées avant chaque démarrage avec le migrateur transactionnel existant.

Après connexion aux comptes Render et Neon, publier la branche de revue, créer le projet PostgreSQL de démonstration et restaurer la sauvegarde locale `review-ux/axelia-demo-ready-20261113.dump` dans cette nouvelle base avec les options `--no-owner --no-acl`. La connexion PostgreSQL distante doit utiliser TLS. Les secrets sont renseignés dans les variables du service.

`WEB_ORIGIN` doit être l’adresse HTTPS exacte du back-office Render. `PUBLIC_ORIGIN` est préparée pour `https://demo.axelia.software`. Ajouter ce domaine au service Render, appliquer l’enregistrement DNS indiqué par Render, puis vérifier le certificat HTTPS. Ces deux hôtes permettent au routage existant de distinguer l’administration du site et du portail.

Le dernier contrôle porte sur les connexions administrateur et client, les photos, les téléchargements PDF, les encaissements, la paie et les liens de réservation depuis un navigateur distant.

Le service gratuit se met en veille après 15 minutes sans trafic et son réveil peut prendre environ une minute. Les traitements planifiés s’exécutent pendant les périodes où le serveur fonctionne. Ouvrir les liens avant le rendez-vous permet de vérifier le réveil. Les quotas gratuits conditionnent la disponibilité. [Offre Render Free](https://render.com/docs/free), [offre Neon Free](https://neon.com/pricing).

La création des services, la restauration distante et la configuration DNS attendent les connexions aux comptes nécessaires.
