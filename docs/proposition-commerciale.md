# AXÉLIA — Proposition commerciale

**Toutes vos activités, un seul système.**

Version du 18 novembre 2026. Les champs marqués « à compléter » sont fixés avec le client avant envoi. Les tarifs de la section 10 sont une proposition à valider.

## 1. Votre contexte

Un établissement multi-activités gère souvent la formation, le coworking et le café avec des outils séparés : cahiers, tableurs, caisses indépendantes, relances faites à la main. Les chiffres se recoupent mal, les impayés se suivent difficilement et la clôture de caisse prend du temps.

## 2. Notre réponse

AXÉLIA réunit formation, coworking, café et site web dans une seule application. Chaque établissement active ses modules et paramètre ses règles sans intervention technique. Le suivi commercial (prospects, demandes du site, visiteurs) et les automatisations (relances, rappels, synthèse du jour) sont dans le même outil.

## 3. Les modules et fonctions livrés

### Formation

- Inscriptions, groupes, planning, présences et feuilles de présence à valider.
- Formules de paiement : intégral, échéancier, mensuel ou à la séance, avec prorata du mois partiel.
- Reports d'échéance et remises, soumis à l'approbation d'un administrateur selon le réglage du centre.
- Reçus numérotés sans trou, impayés, relances.
- Paie des formateurs en trois étapes : calcul, vérification, paiement. Les règles de rémunération se paramètrent par formateur, avec une date d'effet.

### Coworking

- Ressources (postes, bureaux, salles, espaces événementiels), plan des étages et des zones.
- Tarifs par type de client (visiteur ou membre), heures creuses, tarif dégressif et plafond par jour, options payantes.
- Abonnements, packs de passages, codes promotionnels.
- Réservations avec approbation par type de ressource, rappel par e-mail avant chaque réservation.
- Registre des visiteurs : annonce, enregistrement de l'arrivée, notification du client.
- Courrier et domiciliation : enregistrement, avis au client, remise.
- Arrivée par QR code sur les places (option).
- Statistiques d'occupation.

### Café et point de vente

- Vente au comptoir avec tickets numérotés.
- Caisse séparée de celle du centre, ou caisse unique, au choix.
- Stock mis à jour à chaque vente, inventaires avec motif, alertes de stock bas.
- Fournisseurs, bons de commande, achats simples ou contrôlés, selon le choix du centre.

### Site web et espace client

- Pages, articles, médias et publication depuis le back-office.
- Demandes des visiteurs (contact, demande de visite, demande de devis) traitées dans l'application.
- Espace client : réservations, paiements et visiteurs consultés en ligne.

### Suivi commercial

- Prospects : étapes, relances, activités (appel, e-mail, visite, note) et conversion en élève ou en client du coworking.
- Une demande du site devient un prospect en un clic, sans double saisie.

### Factures (module optionnel, désactivé par défaut)

- Factures et avoirs numérotés, au format PDF, pour les clients qui les demandent.
- Taux de taxe pour les entreprises, réglable. **Le taux, le droit de timbre et les mentions légales se valident avec l'expert-comptable du client avant activation.**

### Automatisations

Chaque tâche répétitive se met en mode désactivé, à confirmer ou automatique : relances d'impayés, paie du mois, programme du lendemain, avis de courrier. Une tâche à confirmer attend la validation d'une personne habilitée. Chaque exécution est tracée.

### Intégrations et assistants IA

- **Jetons d'accès** à rôle limité (secrétariat, comptabilité, éditeur), révocables à tout moment.
- **Webhooks signés** : chaque événement (paiement, réservation, demande du site) peut être envoyé vers un outil externe, par exemple n8n. La signature permet de vérifier l'origine de chaque message.
- **Serveur MCP** : un assistant IA compatible (Claude et d'autres) peut consulter les données du centre et, si le jeton le permet, agir comme un employé. Chaque action passe par les mêmes contrôles qu'à l'écran et figure au journal d'audit, sous le nom du jeton. Les données personnelles (e-mail, téléphone, adresse, matricule fiscal, date de naissance) sont masquées par défaut. Un jeton en lecture seule ne peut rien modifier.

### Reprise et mise en service

Un consultant d'implémentation paramètre l'établissement et reprend les données de départ à la date de bascule : élèves, groupes, inscriptions, abonnements, stock du café, impayés et avances. Les fichiers sont vérifiés avant chargement et un rapport est remis au client.

### Socle commun

Tableau de bord, raccourcis personnalisables par utilisateur, rapports (chiffre d'affaires, encaissements, impayés, paie, café), rôles et droits, journal d'audit.

## 4. Le fonctionnement au quotidien

1. **Le matin** : chaque caisse (centre, café) saisit son fond de caisse.
2. **Dans la journée** : l'équipe travaille depuis ses raccourcis (encaisser, inscrire, pointer les présences, vendre au café, traiter les demandes du site). Le tableau de bord liste les actions en attente et les impayés.
3. **Le soir** : clôture de chaque caisse. Espèces attendues = fond de caisse + recettes en espèces ; l'écart avec le montant compté est enregistré avec un commentaire.
4. **En fin de mois** : paie des formateurs, rapports de recettes et d'encaissements par activité et par caisse.

Tous les montants sont en dinars tunisiens, à 3 décimales (exemple : 1 250,000 TND).

## 5. Ce qui se paramètre par établissement

- Les modules actifs et les options (factures, arrivée par QR code).
- Les formules de paiement, les règles de rémunération des formateurs, les tarifs du coworking.
- Les règles de réservation : délais, annulations, approbation, rappels.
- Les automatisations et leur mode.
- L'impression des tickets : aucune, navigateur, ticket 58 mm ou 80 mm.
- Les achats du café : simple entrée de stock, fournisseurs, ou bons de commande.
- Le fond de caisse habituel, le stock négatif autorisé ou non, le préfixe des tickets.
- Les rôles : administration, secrétariat, comptabilité, éditeur du site.

Le paramétrage est réalisé par un consultant d'implémentation, avec le guide fourni.

## 6. Déploiement

| Étape           | Contenu                                                                                |
| --------------- | -------------------------------------------------------------------------------------- |
| Cadrage         | Recueil des règles de gestion et choix des modules, avec le guide de cadrage.          |
| Paramétrage     | Configuration de l'établissement, des tarifs, des droits et des automatisations.       |
| Reprise         | Chargement des données de départ par fichiers vérifiés, puis rapprochement des totaux. |
| Formation       | Prise en main par rôle, sur vos propres cas.                                           |
| Mise en service | Date de bascule convenue, démarrage accompagné, puis support.                          |

Durées et dates : à compléter.

## 7. Intégrations

Jetons d'accès, webhooks signés (n8n et autres outils), serveur MCP pour assistants IA, automatisations de relance et de synthèse. Les intégrations sont livrées et documentées ; leur mise en place fait partie du paramétrage.

## 8. Ce qui n'est pas encore livré

Ces fonctions sont prévues. Elles ne sont **pas** incluses dans les offres tant qu'elles ne sont pas livrées, et nous ne les promettons pas à une date sans accord écrit :

- **Agent WhatsApp ELIA** : un agent qui répondrait aux clients et aux membres, avec le rôle de son utilisateur. Conditions à réunir d'abord : vérification d'un compte Meta Business et décision de conformité sur les données personnelles.
- **Appel d'outils externes depuis AXÉLIA** (par exemple publier une alerte dans Slack ou créer un événement dans un agenda). Aujourd'hui, c'est l'assistant IA ou n8n qui relie les outils.
- **Paiement en ligne** (cartes, Flouci, Konnect, D17) : il faut d'abord choisir un prestataire et ses frais.
- **Événements** : une version simple est envisagée, sans calendrier de réalisation.
- **Badges et casiers**, **maintenance des équipements**, **double authentification**.

## 9. Limites connues

- L'impression passe par le navigateur ; il n'y a pas de pilotage direct d'imprimante thermique.
- La réception d'un bon de commande est totale, pas partielle.
- Les factures et paiements fournisseurs ne sont pas gérés.
- AXÉLIA n'est pas un logiciel de comptabilité générale : il produit les recettes, les encaissements, les factures (si l'option est activée) et les clôtures à transmettre à votre comptable.
- Une installation sert un seul établissement pour son site public. Plusieurs établissements sont mis en place sur des installations séparées.
- Les règles fiscales (taux de taxe, timbre, mentions légales) sont à valider avec votre expert-comptable.

## 10. Offres proposées

Proposition à valider avant envoi. Montants en dinars tunisiens, hors taxes.

|                                    | **Essentiel** | **Croissance** | **Complet** |
| ---------------------------------- | ------------- | -------------- | ----------- |
| Abonnement mensuel                 | 290 TND       | 490 TND        | 790 TND     |
| Abonnement annuel (2 mois offerts) | 2 900 TND     | 4 900 TND      | 7 900 TND   |
| Mise en service (une fois)         | 1 200 TND     | 2 000 TND      | 3 500 TND   |
| Formation                          | ✔             | ✔              | ✔           |
| Coworking, visiteurs, courrier     |               | ✔              | ✔           |
| Site web et demandes               |               | ✔              | ✔           |
| Café et point de vente             |               |                | ✔           |
| Arrivée par QR code (option)       |               |                | ✔           |
| Suivi commercial (prospects)       | ✔             | ✔              | ✔           |
| Automatisations et intégrations    | ✔             | ✔              | ✔           |
| Reprise de données par fichier     | ✔             | ✔              | ✔           |

**Options** : module factures (désactivé par défaut), arrivée par QR code pour un pack qui ne l'inclut pas.

**Sur mesure (sur devis)** : pour plusieurs établissements, une reprise complexe ou une intégration spécifique. Le devis détaille les jours de travail par poste et ce qui est exclu, au tarif journalier convenu.

## 11. Conditions

| Élément                    | Valeur      |
| -------------------------- | ----------- |
| Modules retenus            | à compléter |
| Mise en service (une fois) | à compléter |
| Abonnement                 | à compléter |
| Hébergement et sauvegardes | à compléter |
| Support                    | à compléter |
| Validité de l'offre        | à compléter |

---

AXÉLIA — Au cœur de votre organisation.
