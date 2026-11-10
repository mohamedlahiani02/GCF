# Notifications, inscriptions et encaissement

Évolution sur `feat/ux-launchpad`, après la correction du zoom (`fd1ca71`). Aucun changement des permissions serveur ni des règles de paiement ou de création des comptes.

## Où valider une inscription

Coworking → Demandes et inscriptions → Inscriptions. Accès direct : `/coworking/demandes?type=comptes`.

Cette liste affiche les comptes dont le statut est `pending`, leur date de création et leurs coordonnées. Chaque ligne permet d’ouvrir la fiche ou de valider l’inscription après confirmation. L’opération utilise le point d’entrée existant `/coworking/members/:id/validate`, qui conserve l’audit et l’envoi de notification au client. Un échec d’envoi est distingué d’un échec de validation.

Le réglage actuel du centre est affiché : inscription automatique, validation par l’accueil ou inscriptions fermées. Un administrateur peut rejoindre les règles de réservation pour le modifier. Aucun réglage n’est modifié automatiquement.

L’autre onglet, Réservations, conserve l’acceptation, le refus et la réaffectation existants. Les liens depuis le plan en direct ouvrent explicitement cet onglet.

## Cloche et priorités

La cloche est accessible sur toutes les pages du back-office. Elle présente les actions réellement en attente, filtrées selon les permissions, et utilise les mêmes données que le tableau de bord.

- Urgent : échéances en retard et réservations expirant dans moins d’une heure.
- À traiter : inscriptions, présences non validées, journées de caisse ouvertes, paie validée à régler et propositions des automatisations.
- À suivre : nouveaux messages du site.

Les notifications se résolvent en traitant leur source. Le compteur représente les actions à faire, pas un historique de messages non lus. Les inscriptions et réservations sont relues toutes les 30 secondes ; les autres sources toutes les 60 secondes, ainsi qu’au retour dans la fenêtre. Les caches React Query sont partagés avec les pages existantes.

La cloche devient rouge tant qu’une urgence existe. Une nouvelle action ou une montée en urgence déclenche une brève animation et un pop-up avec un lien vers l’action. Les alertes déjà présentes au chargement servent de référence et ne provoquent aucun déluge de pop-ups. Une résolution ou une actualisation identique reste silencieuse.

Un seul pop-up est affiché à la fois ; une urgence passe avant une alerte ordinaire. Il se ferme manuellement ou après 12 secondes, avec pause au survol ou au focus. L’affichage est différé quand un dialogue est ouvert ou que l’onglet est masqué. Aucun son, notification système, permission de navigateur ni validation automatique n’est ajouté. Les mouvements sont désactivés selon la préférence de réduction des animations.

Cette détection compare les catégories, compteurs et priorités lors des actualisations ; elle ne constitue pas un flux exhaustif de chaque événement individuel.

Les messages du site sont limités à 100 résultats pour éviter de charger tout l’historique : un « + » indique que le nombre est un minimum. Une erreur d’une source reste visible et ne devient pas un faux « tout est à jour ».

## Tableau de bord et raccourcis

Le tableau de bord devient la page `/`. L’ancien chemin `/tableau-de-bord` redirige vers elle. La page de boutons personnalisables reste disponible dans le menu sous « Mes raccourcis », à `/raccourcis`.

Le tableau de bord présente les encaissements, impayés, séances et réservations du jour selon les modules et permissions disponibles. Une liste de priorités se filtre par niveau et un agenda réunit les cours, locations et réservations coworking. Les montants et taux sont issus des API existantes. Le graphique conserve le choix jour / semaine / mois.

## Bouton de validation de l’encaissement

Le tiroir utilise la hauteur de son conteneur fixe plutôt que `100vh`, qui débordait en mode Grand texte. Le corps défile et son pied reste visible. Le bouton principal s’appelle « Valider l’encaissement » ; les actions d’impression et d’envoi restent disponibles. Une indication explique pourquoi la validation est inactive : payeur, montant ou coordonnées du chèque manquants.

L’agent n’a soumis aucun paiement pendant ces vérifications.

## Vérifications locales

- Compilation et contrôle TypeScript du front ; formatage des fichiers modifiés.
- Données réelles du centre local : compteurs, KPI, agenda et filtre Urgent.
- Ouverture de la cloche, fermeture par Échap et lien vers les inscriptions.
- Création par l’API normale du portail d’une inscription fictive `Test UX Inscription a valider`, adresse `test-inscription-ux-20261110@example.test`.
- La liste, le compteur Coworking et la cloche passent à une inscription en attente. Ouverture de la confirmation vérifiée, sans valider le compte ni envoyer d’e-mail.
- Deux comptes fictifs ont servi au test local : `test-inscription-ux-20261110@example.test` et `test-alerte-ux-20261110@example.test`. Leurs mots de passe aléatoires ne sont pas conservés. Ils peuvent être traités manuellement depuis la liste ; aucune décision n’a été soumise par l’agent.
- L’onglet des réservations affiche correctement son état vide.
- Tableau de bord à 1440 × 1000 et 390 × 844 : disposition adaptée, aucun débordement horizontal de la page mobile.
- À 390 px, panneau de notifications entièrement contenu et bouton de validation d’encaissement visible.
- Encaissement coworking du client affiché dans la capture utilisateur : saisie de 15,000 TND, bouton actif et visible ; aucune soumission.
- Mode Grand texte : bouton de validation toujours dans la hauteur visible du navigateur.
- Huit tests automatiques des règles de notification : première ouverture, actualisation identique, nouvelle demande, hausse de compteur, résolution, montée en urgence, baisse de priorité et priorité des urgences.
- Essai réel d’une nouvelle inscription pendant l’ouverture du tiroir d’encaissement : le compteur se met à jour sans pop-up sur le formulaire. À sa fermeture, le pop-up apparaît avec le lien de validation.
- Fermeture du pop-up puis actualisation du tableau de bord : aucune répétition de la même alerte.

Commande des tests de notification : `pnpm --filter @gcf/api exec tsx --test ../web/test/notification-events.test.ts` (utilise l’outil déjà installé dans le monorepo).

Les parcours authentifiés sont vérifiés avec le compte administrateur de démonstration. Les autres rôles sont filtrés par les permissions existantes ; ils n’ont pas fait l’objet d’une session navigateur distincte. Ce contrôle n’est pas une certification d’accessibilité.
