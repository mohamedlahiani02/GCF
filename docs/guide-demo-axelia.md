# Démonstration AXELIA

Version préparée le 13 novembre 2026 sur `feat/finance-demo-axelia`, depuis `30c9de6`.

Le centre fictif AXELIA utilise la base locale dédiée `gcf_axelia_demo_20261113`. Les coordonnées de Tunis et les tarifs sont des exemples pour la présentation.

**Accès**

| Surface        | Adresse                                  |
| -------------- | ---------------------------------------- |
| Application    | http://localhost:3010/                   |
| Site public    | http://www.axelia.localhost:3010/        |
| Portail client | http://www.axelia.localhost:3010/espace/ |

| Compte            | Identifiant                    |
| ----------------- | ------------------------------ |
| Administration    | `admin@axelia.demo.test`       |
| Secrétariat       | `secretariat@axelia.demo.test` |
| Comptabilité      | `comptable@axelia.demo.test`   |
| Éditeur du site   | `editeur@axelia.demo.test`     |
| Client du portail | `client@axelia.demo.test`      |

Le mot de passe commun est conservé dans le fichier local `C:/Users/haith/OneDrive/Bureau/GCF/review-ux/ACCES-AXELIA-DEMO.local.txt` et dans la variable locale ignorée par Git `DEMO_ACCOUNT_PASSWORD`. Le compte portail `inscription@axelia.demo.test` attend volontairement une validation.

**Contenu chargé**

| Domaine              | Contenu                                                                                             |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| Formation et cours   | 24 élèves, 5 profs/formateurs, 4 cours, 3 formations, 8 groupes, 30 inscriptions et 211 séances     |
| Coworking            | 11 membres/invité, 2 entreprises et 13 ressources sur un plan publié, réservations et abonnements   |
| Locations            | 3 locations avec contrats et cas ponctuel, récurrent et annulé                                      |
| Café                 | 7 produits, stocks, 4 ventes dont une annulée, fournisseur et commande à réceptionner               |
| Site                 | 9 pages/articles dont un programmé, français et anglais, 9 médias issus des logos et photos fournis |
| Documents financiers | 21 reçus de paiement, un remboursement et une annulation                                            |
| Automatisations      | Deux propositions à confirmer, relances et calcul de paie                                           |

**Parcours à montrer**

1. Ouvrir Site web, puis « Visiter le site web ». Montrer les photos, les offres et le passage à la réservation sur plan.
2. Se connecter au portail avec le compte client et préparer une première réservation. Depuis le back-office, montrer le compte en attente de validation.
3. Ouvrir un groupe, ses séances, sa feuille de présence et une inscription avec une formule mensuelle.
4. Dans la fiche de Lina Belleval, montrer la formule de fin de mois à 80 TND. Au 13 novembre, le paiement partiel de 30 TND laisse 50 TND exigibles et 240 TND de projections futures.
5. Dans la paie de novembre, sélectionner un élément calculé avec une échéance future. Valider, puis régler depuis la sélection conservée. La date d’échéance sert de référence et la validation porte sur le montant calculé.
6. Dans Encaissements, choisir une activité puis passer entre Paiements, Impayés et Relances. Dans Reçus, chercher un payeur et choisir activité, type, année et mois.
7. Vendre deux produits au café, consulter le ticket et le stock, puis ouvrir la commande fournisseur et les caisses.
8. Montrer une location, son contrat, les rapports et les propositions à confirmer.

Les filtres financiers couvrent Formations, Cours particuliers, Coworking et Locations. Un paiement couvrant plusieurs activités est identifié avec ces activités. Une avance élève sans affectation est affichée « Sans affectation ». Les ventes et tickets du café se consultent dans sa caisse dédiée.

Le site utilise le bleu nuit et les symboles AXELIA avec les photographies fournies. Les coordonnées sont fictives. Les formulaires de formation préparent une demande suivie dans le back-office. Le compte portail actif est préparé pour une première réservation.

Les automations d’envoi sont désactivées ou proposées à confirmation. SMTP est à configurer pour les envois réels. Le jeton n8n d’exemple est révoqué et le webhook d’exemple est désactivé, prêt à être relié à un workflow de test.

**Reproduction et sauvegarde**

Le profil AXELIA réutilise le seed standard et le complète. Sur une base vierge, initialiser le centre et l’administrateur, activer `training`, `coworking`, `website` et `cafe`, définir `PUBLIC_ORIGIN` et `DEMO_ACCOUNT_PASSWORD`, puis exécuter depuis `apps/api`.

```powershell
node --env-file=.env --import tsx src/cli/seedDemo.ts --email admin@axelia.demo.test --profile axelia
```

Le seed refuse un centre déjà rempli. Une sauvegarde de l’état prêt à présenter est disponible dans `C:/Users/haith/OneDrive/Bureau/GCF/review-ux/axelia-demo-ready-20261113.dump`. Restaurer cette sauvegarde dans une base de recette dédiée permet de rejouer la présentation.

La recette Chromium a vérifié la connexion administrateur, la sélection de paie avant échéance, les filtres des encaissements, la recherche des reçus, l’ouverture du site dans un nouvel onglet, le chargement des photos et l’absence de débordement sur mobile. Les captures sont dans `C:/Users/haith/OneDrive/Bureau/GCF/review-ux/axelia-finance-20261113/`.
