# Roadmap produit — ERP modulaire tunisien, gestion commerciale et framework d'intégration

Version de cadrage : 1.2 — 10 novembre 2026. Mise à jour après la refonte UX, les échéanciers configurables et l’audit métier initial.

Statut : proposition de produit et de séquencement. Ce document ne lance aucun développement et ne constitue pas une certification fiscale.

La vision mini-ERP est conservée comme chantier distinct. Les PR #12/#13 ont été testées localement sur `82220bb` dans un checkout et une base séparés. L’état GitHub décrit dans le bilan est celui du 7 novembre ; il n’a pas été revérifié le 10 novembre. La branche locale `feat/billing-schedules` ajoute les évolutions UX et facturation. Aucune fusion dans `main` n’a été réalisée pendant ces travaux. Voir la [passation de branche](passation-branche-ux-facturation.md), l’[audit métier initial](audit-metier-produit-2026-11-10.md) et le [bilan n8n](validation-n8n-automatisations.md).

## 1. Vision et périmètre

Construire une plateforme ERP pour PME tunisiennes, configurable par des consultants, réunissant :

1. La gestion commerciale décrite dans l'analyse Finco v2 : contacts, articles, ventes, achats, paiements, trésorerie, stock, projets et rapports.
2. Un socle d'extension : modules, droits, règles, champs, circuits de validation, documents et automatisations.
3. Une comptabilité générale en partie double et une localisation tunisienne maintenue.
4. Les métiers déjà développés : formation, cours particuliers, coworking, location, site web et portail.
5. Un espace consultant pour déployer la solution et un framework pour connecter les systèmes externes.

L'analyse Finco est une référence fonctionnelle issue d'observations d'interface. Les DTO et relations reconstruits ne sont pas un schéma à reproduire automatiquement ; les comportements non vérifiés deviennent des scénarios de conception et de recette.

Référence locale : `C:/Users/haith/OneDrive/Bureau/TakeOff/finco-functional-analysis-v2.md`.

### Positionnement initial

- Packs commerciaux : Services, Commerce, Centre de formation et Coworking.
- Une plateforme commune, sans copie du code pour chaque client.
- Première cible : PME de services et commerce simple, avec complexité maîtrisée.
- Hors V1 : production industrielle/MRP, consolidation de groupes, fiscalités de plusieurs pays, comptabilités sectorielles spécialisées, paie salariale complète et marketplace ouverte d'extensions.

## 2. Contrat de configurabilité

« 100 % configurable » signifie que chaque domaine expose explicitement les paramètres et extensions qu'il supporte. Les processus couverts sont configurables sans modifier le code du client. Un nouveau comportement métier peut nécessiter une extension développée.

### Trois niveaux

| Niveau                | Exemples                                                                            | Utilisateur           |
| --------------------- | ----------------------------------------------------------------------------------- | --------------------- |
| Paramétrage           | Tarifs, échéances, horaires, modèles et notifications                               | Administrateur client |
| Configuration avancée | Approbations, règles conditionnelles, champs, correspondances comptables et imports | Consultant            |
| Extension             | Nouveau métier, calcul spécialisé, nouveau connecteur ou composant d'interface      | Développeur           |

### Garanties fixes

- Isolation des données et autorisations contrôlées côté serveur.
- Équilibre débit/crédit et absence de double comptabilisation.
- Protection contre le double paiement et les doubles mouvements de stock.
- Correction traçable des opérations validées ; conservation des pièces historiques.
- Séquences et contrôles cohérents avec les obligations du dossier.
- Aucun changement de configuration ne réécrit silencieusement l'historique.

### Cycle d'une configuration

`Brouillon → Simulation → Recette → Approbation → Publication avec date d'effet → Historique`

Chaque paramètre porte son type, sa portée, sa valeur par défaut, ses contraintes, son aide et ses permissions. Les règles publiées sont versionnées. La préséance entre valeur société, établissement et exception métier doit être visible.

Une configuration déployée peut être remplacée pour les opérations futures. Un retour de configuration ne supprime pas les opérations déjà produites et n'annule pas automatiquement leurs effets.

Les formules avancées utilisent un langage limité, typé et déterministe : pas de SQL arbitraire ni d'exécution de code libre depuis un formulaire.

## 3. Socle commun et catalogue de modules

| Domaine                   | Fonctionnalités cibles                                                                                 | Priorité             |
| ------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------- |
| Organisation              | Client logiciel, sociétés juridiques, établissements, domaines et utilisateurs                         | P0                   |
| Identité et droits        | Profils personnalisés, permissions par action/périmètre, double authentification, accès consultant     | P0                   |
| Contacts                  | Personnes/entreprises, clients et fournisseurs, adresses, données fiscales, rapprochement des doublons | P0                   |
| Catalogue                 | Produits/services, unités, familles, marques, tarifs, devises et catégories fiscales                   | P0                   |
| Documents                 | Pièces jointes, modèles, séquences, exports et historique                                              | P0                   |
| Ventes                    | Devis, commandes, livraisons, factures, avoirs, retours et sorties                                     | P0                   |
| Achats                    | Commandes, réceptions, factures fournisseurs, avoirs et retours                                        | P1                   |
| Stock                     | Entrepôts, emplacements, réservations, mouvements, transferts, inventaires et valorisation             | P1                   |
| Paiements                 | Encaissements/décaissements, affectations, acomptes, remboursements et retenues                        | P0                   |
| Trésorerie                | Caisses et banques, transferts, chèques/traites, rapprochement et prévisions                           | P1                   |
| Fiscalité Tunisie         | Paramètres applicables au dossier, justificatifs, retenues, échanges et suivi réglementaire            | P0/P1                |
| Comptabilité              | Journaux, écritures, auxiliaires, lettrage, immobilisations, clôtures et états                         | P1                   |
| Projets et analytique     | Axes, budgets, coûts, marges et rentabilité                                                            | P1                   |
| CRM                       | Demandes, prospects, opportunités, activités et transformation en devis                                | P1                   |
| Formation                 | Offre, groupes, inscriptions, présences et facturation                                                 | Existant à raccorder |
| Rémunération intervenants | Règles, éléments, validation, règlements et justificatifs                                              | Existant à raccorder |
| Coworking/location        | Espaces, plan, réservations, abonnements et facturation                                                | Existant à raccorder |
| Site et portail           | Pages, demandes, réservations, documents et suivi client                                               | Existant à raccorder |
| Studio et automatisations | Champs, vues, règles, approbations et actions planifiées                                               | P0 puis P1           |
| Implémentation            | Packs, imports, recette et publication des configurations                                              | P0 puis P1           |
| Intégrations              | API, événements, webhooks, connecteurs et supervision                                                  | P0 puis P1           |

P0 = fondation ou première version commerciale ; P1 = extension nécessaire à la V1 complète.

### Dépendances à formaliser

- Les modules métier utilisent Contacts, Catalogue et Documents selon leurs besoins.
- Facturation dépend de Contacts, Catalogue, Documents et Moteur fiscal.
- Comptabilité dépend des services financiers et de ses référentiels ; elle peut aussi recevoir des écritures externes validées.
- La localisation Tunisie complète le moteur comptable et fiscal.
- Stock et facturation sont reliés par les lignes d'origine, sans produire deux mouvements pour la même livraison.
- La désactivation d'un module conserve les données et leur lecture historique ; les opérations actives et dépendances peuvent empêcher sa désactivation.

Chaque module possède un manifeste : identifiant, version, dépendances, permissions, paramètres, menus, routes, migrations, événements et tests de compatibilité.

## 4. Architecture de migration du projet

Conserver Node.js, TypeScript, Fastify, React, PostgreSQL et les règles métier réutilisables. Structurer l'application unique en domaines avec des interfaces explicites. Séparer les traitements asynchrones lorsque nécessaire sans imposer immédiatement des microservices.

### Évolution de l'organisation

- Distinguer le client du logiciel, la société qui facture et l'établissement qui exécute la prestation.
- Décider explicitement du mode d'isolation : base dédiée par client ou base partagée avec garanties testées. La présence de `centre_id` ne prouve pas à elle seule l'isolation.
- Adapter la sélection des domaines publics : le code actuel sert une seule société/centre sur la surface publique d'une installation.
- Introduire le contact commun avec des correspondances vers les élèves, responsables, membres, loueurs et intervenants existants.

### Évolution des finances

- Ajouter la facturation commune et les liens vers les inscriptions, réservations et abonnements.
- Faire évoluer les paiements existants par migration contrôlée, sans créer un deuxième registre d'encaissements concurrent.
- Conserver les événements financiers et l'audit ; documenter les événements qui pourront produire une écriture.
- Définir une date de reprise comptable, importer les soldes d'ouverture et enrichir les pièces nécessaires.
- Les événements historiques actuels ne suffisent pas à reconstruire automatiquement des factures fiscales et une comptabilité complète.
- Réconcilier les soldes avant/après chaque migration et conserver les identifiants et références utiles.

## 5. Moteurs métier transversaux

### 5.1 Documents et transformations

Parcours : `Devis → Commande → Livraison → Facture → Paiement → Comptabilité`.

- Lignes liées à leur origine et gestion des transformations partielles.
- Quantités commandées, réservées, livrées, facturées et retournées suivies séparément.
- Regroupement de plusieurs livraisons sur une facture et ventilation d'une commande.
- Avoir financier distinct du retour physique.
- Facturation directe capable de créer une livraison associée lorsque le processus le prévoit.
- Moteur commun de lignes, calculs et présentation, avec validations propres à chaque type de document.

### 5.2 États distincts

Séparer : cycle du document, état logistique, solde financier, état du moyen de paiement et état de transmission électronique.

L'écran présente une synthèse compréhensible et permet de consulter le détail. Un chèque reçu ne doit pas être confondu avec un encaissement bancaire définitif.

### 5.3 Prix et fiscalité

- Prix HT/TTC, remises ligne/globales, tarifs par quantité/client/période.
- Quantités, taux et prix avec précision décimale définie ; montants comptabilisés en unités monétaires entières selon la devise.
- Ordre d'application, bases, arrondis et affectations des taxes explicitement définis et testés.
- Suspension/exonération avec justificatif et validité, et traitement distinct d'un taux nul.
- Règles fiscales versionnées, datées et figées sur les documents validés.
- Profils fiscaux adaptés aux opérations et au dossier ; aucune généralisation automatique d'un régime à toutes les formations ou prestations.

### 5.4 Paiements et trésorerie

- Paiements reçus/émis, non affectés ou répartis entre documents.
- Règlement partiel, acompte, remboursement et trop-perçu.
- Retenue fiscale identifiée séparément du cash et liée à son certificat.
- Cycle de vie des chèques/traites et rapprochement avec la banque.
- Solde, montant en attente d'encaissement et montant réellement encaissé présentés distinctement.

### 5.5 Stock

- Disponible, réservé et physique avec définitions visibles.
- Contrôle concurrent des réservations et sorties ; politique de stock négatif configurable et auditée.
- Réceptions/livraisons partielles, retours et transferts.
- Inventaire avec écarts, approbation et ajustements traçables.
- Méthode de valorisation déterminée avec le comptable ; prise en charge des coûts et retours.
- Lots, séries et codes-barres avancés en extension selon les premiers clients.

## 6. Comptabilité générale et localisation tunisienne

### Moteur commun

- Plan de comptes, journaux et exercices.
- Écritures et lignes débit/crédit, dates, pièces et axes analytiques.
- Brouillon, validation, verrouillage de période et correction par contrepassation.
- Soldes clients/fournisseurs, lettrage et rapprochement bancaire.
- Écritures automatiques et manuelles selon les droits.
- Immobilisations, amortissements, régularisations et clôtures.
- Grand livre, journaux, balances et états.

### Localisation Tunisie

- Référentiels et modèles validés pour le périmètre de clients ciblés.
- Paramètres fiscaux applicables, retenues et justificatifs.
- Documents et états correspondant aux normes applicables.
- Connecteurs ou échanges TTN/El Fatoora et TEJ selon les spécifications et possibilités officielles.
- Signature, références, accusés, rejets et archivage des échanges.
- Maintenance réglementaire : source, date d'effet, version livrée, tests et note de changement.

Les démarches d'accès aux plateformes, spécifications et validations commencent dès le cadrage. Un export XML généré n'est pas présenté comme une déclaration effectivement déposée ou acceptée.

### Limites et recette

- Travailler avec un expert-comptable tunisien dès la conception.
- Valider les cas métier et les états sur des résultats de référence indépendants.
- La rémunération actuelle des intervenants ne remplace pas une paie salariale avec obligations sociales et fiscales.
- La consolidation et les régimes sectoriels spécialisés restent hors V1.
- Le périmètre de conformité annoncé doit être explicite et validé ; la présence d'un bouton fiscal ne constitue pas une preuve de conformité.

## 7. Studio de configuration

État après les PR #12/#13 : un catalogue de quatre automatisations et une boîte de propositions existent et ont été testés. Ils sont à réutiliser. Ils ne remplacent pas le studio générique décrit ci-dessous ; les tâches et leurs modes restent définis dans le code.

### Première version

- Registre des paramètres avec recherche, aide et valeurs héritées.
- Profils de droits par fonction et périmètre.
- Champs personnalisés typés : texte, nombre, date, liste, booléen et relation autorisée.
- Obligations conditionnelles, visibilité et validation côté serveur.
- Documents avec logo, sections, langues, mentions et options.
- Modèles d'approbation et seuils ; historique des décisions.
- Export/import d'une configuration versionnée.

### Version avancée

- Éditeur de vues : listes, formulaires, colonnes et filtres.
- Circuits d'approbation configurables dans les transitions supportées.
- Automatisations événement/condition/action avec simulation.
- Planification, notifications et escalades.
- Explication de la règle appliquée, de sa priorité et de sa version.
- Tests de non-régression attachés aux packs et configurations.

Une formule de calcul ou automatisation doit être limitée en temps et en ressources. Les permissions des champs personnalisés, imports et exports sont également contrôlées.

## 8. Framework d'implémentation pour consultants

### Parcours client

`Qualification → Choix du pack → Configuration → Reprise → Recette → Formation → Mise en service → Suivi`

Fonctionnalités :

1. Portefeuille de clients et accès délégués temporaires.
2. Fiche de cadrage, modules choisis et dépendances.
3. Packs Commerce, Services, Formation et Coworking.
4. Assistant d'installation avec progression et blocages expliqués.
5. Import CSV/Excel avec modèles, correspondances, contrôles, prévisualisation et rapport.
6. Reprise des soldes, stocks et pièces ouvertes avec réconciliation.
7. Environnement de recette et jeux de démonstration séparés.
8. Comparaison des configurations et approbation de publication.
9. Documentation générée des réglages et écarts au pack standard.
10. Checklist, preuves de recette et date de bascule.
11. Historique des interventions et procédure de support.

Un pack contient des paramètres, référentiels et modèles, sans données opérationnelles de production. La copie vers la recette doit prévoir l'anonymisation des informations sensibles.

## 9. Framework d'intégration et SDK

État après les PR #12/#13 : jetons restreints, attribution de l'audit au jeton, file transactionnelle de webhooks signés, tentatives et renvoi manuel sont disponibles sur la branche de PR et vérifiés localement avec n8n 2.46.6. La prochaine étape est leur durcissement et leur généralisation, sans créer un dispatcher concurrent. Les contrats API versionnés, scopes fins, SDK et packs consultants restent à réaliser.

### 9.1 Contrats

- API documentée OpenAPI, versionnement et politique de compatibilité.
- Identifiants externes et tables de correspondance.
- Comptes techniques avec autorisations par client/module/opération.
- Pagination, filtres, limites de débit et erreurs structurées.
- Clés d'idempotence pour les créations et traitements sensibles.
- Événements métier versionnés avec identifiant, origine, date, contexte et version du schéma.

### 9.2 Exécution fiable

- Enregistrement de l'événement et de son envoi prévu dans la même transaction métier (outbox).
- Livraison pouvant être répétée ; consommateurs protégés contre les doublons.
- Webhooks signés, secrets renouvelables, contrôle des répétitions et tentatives espacées.
- File d'erreurs, identifiant de corrélation, diagnostic et relance contrôlée.
- Ordonnancement et gestion des événements arrivant en retard lorsque nécessaires.
- Aucune promesse de livraison exactement une fois entre systèmes ; garantir les effets uniques par déduplication et transactions.

### 9.3 Connecteurs

- Interface commune d'authentification, configuration, correspondance, synchronisation et diagnostic.
- Connexion test/production séparée, secrets chiffrés et masqués.
- Modes import/export, synchronisation initiale et incrémentale.
- Gestion explicite des conflits et de la source de référence pour chaque champ.
- Kit de développement, connecteur exemple et tests contractuels.
- Revue et installation contrôlée des extensions développées ; aucun dépôt de code arbitraire exécuté depuis le back-office.

### Priorités

1. Imports CSV/Excel et exports documentés.
2. TTN/El Fatoora et TEJ selon périmètre applicable et possibilités d'intégration.
3. E-mail/SMS et import de relevés bancaires.
4. Paiement en ligne, prestataire sélectionné selon clients.
5. E-commerce/CRM et contrôle d'accès coworking selon demande réelle.

## 10. UI/UX cible

- Navigation : Accueil, Ventes, Achats, Stock, Finance, Activités et Paramètres ; uniquement les fonctions autorisées.
- Trois espaces : Opérations, Administration et Implémentation consultant.
- Recherche globale, favoris, raccourcis et filtres enregistrés.
- Page « À traiter » par rôle : documents en attente, impayés, anomalies et approbations.
- Fiche contact regroupant documents, solde, activités et échanges.
- Prochaine action sur chaque dossier et liens entre pièces.
- Boutons indisponibles accompagnés de leur cause et de l'action permettant de débloquer.
- Prévisualisation des calculs, transformations, imports et changements de paramètres.
- Sélection groupée, actions groupées autorisées et résultat détaillé.
- Sauvegarde des brouillons, protection contre perte de saisie et gestion des conflits de modification.
- Montants, dates, terminologie et comportements de tableau cohérents.
- Français en premier, architecture prête pour l'arabe avec sens RTL et l'anglais.
- Contraste, navigation clavier, focus, libellés accessibles et présentation mobile des opérations courantes.
- Bannière explicite Démo/Recette/Production et société courante toujours visible.

Le problème déjà observé sur les paies doit devenir un scénario de référence : une ligne soldée affiche « Déjà payé — reste 0 » au lieu d'une sélection simplement grisée.

## 11. Roadmap par versions

Les horizons sont cumulatifs à partir du démarrage d'une équipe dédiée ; ils ne représentent pas des dates promises. Hypothèse : trois développeurs expérimentés, QA régulière, UX/produit et expert-comptable disponibles. Ajouter une marge pour les accès externes, reprises et retours pilotes.

| Version / horizon indicatif | Produit livré                                                                   | Consultant et intégration                                                                                       | Condition de sortie                                                                       |
| --------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Cadrage — semaines 1 à 3    | Périmètre, modèles, cas de référence et architecture de migration               | Parcours d'implémentation et inventaire des connecteurs                                                         | Validation produit + comptable des scénarios critiques                                    |
| V0.1 — mois 1 à 2           | Organisation, contacts, catalogue, droits, registre des modules et paramètres   | Reprise des briques n8n existantes, traitements de panne/reprise, pack initial, import et premiers contrats API | Isolation, restauration, migration pilote et reprise des automatisations vérifiées        |
| V0.2 — mois 3 à 4           | Devis, commandes, factures, avoirs, taxes, tarifs, affectations de paiements    | Assistant consultant, configurations versionnées, événements/outbox                                             | Cycle vente-service complet, soldes réconciliés et documents vérifiés                     |
| V0.3 — mois 5 à 6           | Achats, réceptions, livraisons, retours, entrepôts, inventaires et valorisation | Imports stock/achats, SDK et premier connecteur de référence                                                    | Flux partiels, retours et concurrence sans double mouvement                               |
| V0.4 — mois 7 à 8           | Trésorerie, chèques/traites, rapprochement, projets et analytique               | Généralisation des propositions et automatisations existantes en studio, supervision des échanges               | Paiements, rejets, retenues, rapprochements et reprises expliqués et testés               |
| V0.5 — mois 9 à 11          | Comptabilité générale, localisation tunisienne et états ciblés                  | Reprise comptable, correspondances, connecteurs fiscaux prioritaires                                            | Comptes et états validés par expert ; traitements rejouables sans doublons                |
| V1 — mois 12 à 15           | Raccordement complet des métiers, optimisation, pilotes et support              | Packs publiés, recette→production, documentation et compatibilité                                               | Pilotes acceptés, restaurations prouvées, critères réglementaires du périmètre satisfaits |

Le raccordement des métiers commence dès V0.2 : formation et coworking utilisent progressivement les nouvelles briques. Les démarches fiscales, la conception comptable, l'UX, la sécurité et les tests commencent au cadrage et traversent toutes les versions.

### Jalons commerciaux

- Première livraison : configuration industrialisée des métiers déjà présents, sur un périmètre limité.
- MVP commercial : V0.2 pour entreprises de services, à condition que les obligations fiscales nécessaires à ces clients soient satisfaites. Le numéro de version ne vaut pas autorisation de mise en production fiscale.
- Couverture du périmètre commercial Finco visé : V0.3/V0.4, avec matrice des écarts et rapports prioritaires.
- Mini-ERP complet sur le périmètre V1 : 12 à 15 mois en scénario favorable ; enveloppe prudente 12 à 18 mois.
- Reprioriser après chaque pilote. Le calendrier dépend de l'équipe et du périmètre réellement confirmé.

## 12. Épics prioritaires et scénarios de recette

| Épic           | Scénario obligatoire                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Isolation      | Un utilisateur et une clé API du client A ne lisent ni n'altèrent les données du client B, y compris via export et pièce jointe |
| Configurations | Une nouvelle règle datée modifie les opérations futures sans réécrire les documents validés                                     |
| Documents      | Commande de 20 articles, livraisons de 8 puis 12, facturation partielle puis finale sans double sortie                          |
| Paiements      | Un paiement réparti sur deux factures, paiements partiels et remboursement : soldes exacts                                      |
| Chèque rejeté  | Rejet après dépôt : solde et suivi bancaire corrigés, historique conservé                                                       |
| Retenues       | Montant retenu et net versé distincts, certificat relié et absence de faux mouvement bancaire                                   |
| Stock          | Deux réservations concurrentes respectent la politique de disponibilité ; transfert équilibré                                   |
| Fiscalité      | Jeu de référence indépendant : bases, taxes, remises, arrondis, avoirs et date d'effet                                          |
| Comptabilité   | Écritures équilibrées ; document→écriture→contrepassation ; période clôturée protégée                                           |
| Intégrations   | Rejeu d'un webhook et interruption réseau : aucun doublon de facture, paiement ou mouvement                                     |
| Reprise        | Totaux des tiers, pièces ouvertes, stock et soldes d'ouverture identiques avant/après migration                                 |
| Consultant     | Déploiement d'un pack sur un dossier vierge, import, recette et publication avec preuves                                        |
| Métier         | Une inscription et un abonnement coworking produisent des pièces dans le même moteur de facturation                             |
| UX             | Tout blocage de règlement explique l'état et indique l'action suivante                                                          |

## 13. Qualité, exploitation et gouvernance

### Livraisons

- Environnements développement, recette et production séparés.
- Pipeline de contrôles : typage, tests métier, intégration, parcours UI et sécurité.
- Test des combinaisons de modules supportées, migrations et compatibilité des packs.
- Notes de version et procédure de mise à niveau avant déploiement client.
- Stratégie de reprise en cas d'échec de migration ; une simple rétrogradation du code ne suffit pas toujours.

### Exploitation

- Sauvegarde des bases, documents et configurations ; restaurations régulièrement testées.
- Objectifs de perte de données admissible et de délai de reprise convenus par offre.
- Journaux, métriques, alertes, traçage des traitements et visibilité des tâches de fond.
- Conservation des documents et données selon le cadre applicable, avec politique explicite.
- Sessions, authentification forte, secrets, chiffrement, dépendances et contrôle des accès support.

### Gouvernance

- Responsable produit : périmètre, priorités et acceptation métier.
- Responsable technique : architecture, migrations, sécurité et intégrations.
- Expert-comptable tunisien : schémas, cas fiscaux, états et validation du périmètre comptable.
- Consultant référent : imports, packs, reprise et recette.
- QA/UX : scénarios transversaux et facilité d'usage.
- Support/exploitation : surveillance, incidents, sauvegardes et procédures client.

## 14. Indicateurs produit

À établir sur une base pilote, puis mesurer à chaque version :

- Temps pour créer une facture simple et enregistrer un règlement.
- Nombre de clics et taux d'abandon des opérations courantes.
- Part des implémentations réalisées sans modification spécifique du code.
- Temps d'installation d'un dossier à partir d'un pack, hors reprise complexe.
- Taux d'import accepté et nombre de corrections nécessaires.
- Écarts de réconciliation financière et de stock : aucun écart inexpliqué avant bascule.
- Taux de réussite et délai des synchronisations ; ancienneté de la file d'erreurs.
- Nombre d'incidents de double traitement : aucun accepté.
- Disponibilité et temps de réponse mesurés sur volumes de référence documentés.
- Couverture des scénarios fiscaux/comptables validés et délai de mise à jour réglementaire.

## 15. Décisions à prendre avant le développement

1. Secteurs et profils fiscaux précisément couverts par la V1.
2. Produit multi-clients hébergé, installation dédiée ou offres distinctes.
3. Modèle société/établissement et stratégie de migration depuis les centres actuels.
4. Liste P0 des documents et des rapports ; tout le catalogue de rapports ne doit pas bloquer le premier pilote.
5. Validation des schémas fiscaux et comptables ; périmètre des connecteurs et démarches d'accès.
6. Méthodes et conditions de valorisation du stock.
7. Besoins multidevises, séries/lots et multi-entrepôts des premiers clients.
8. Périmètre du studio : paramètres, règles, vues et extensions supportées.
9. Équipe disponible, enveloppe, clients pilotes et conditions de mise en service.

## 16. Premier sprint de cadrage

Livrables des deux premières semaines :

1. Matrice des fonctionnalités : déjà présent / à faire évoluer / à construire / différé.
2. Glossaire et modèle conceptuel des entités communes.
3. Catalogue des modules, dépendances et permissions.
4. Parcours vente, achat, stock, paiement et comptabilisation avec transitions.
5. Modèle des paramètres et contrat des extensions.
6. Plan de migration des données et choix du premier client pilote.
7. Prototypes des écrans Facture, Contact, Centre d'implémentation et Supervision des intégrations.
8. Backlog V0.1/V0.2 avec critères d'acceptation et estimations par épic.

## 17. Sources et portée

- Analyse fonctionnelle Finco v2 fournie par le porteur du projet, audit daté du 11 juillet 2026 : référence de périmètre observé, pas preuve d'architecture interne ni validation réglementaire.
- Code du projet GCF et documentation locale, commit `1a70b03` lors du cadrage.
- Finco, présentation éditeur : https://finco.tn/ — référence de positionnement commercial.
- Odoo, configuration comptable et localisations : https://www.odoo.com/documentation/19.0/applications/finance/accounting/getting_started/initial_configuration/setup.html — référence d'approche pour les packages de localisation.
- OECT, système comptable tunisien : https://oect.org.tn/systeme-comptable-tunisien/ — point de départ du référentiel comptable.
- OECT, NC 01 : https://oect.org.tn/wp-content/uploads/2023/01/NC_01.pdf — organisation et présentation comptables.

Les taux, cas d'assujettissement, formats et modalités réglementaires doivent être confirmés sur les textes et spécifications en vigueur à la date de chaque livraison. Aucun barème fiscal définitif n'est fixé dans cette roadmap.

## 18. Avancement compatible — n8n et automatisations

### Décision de cadrage

Les PR #12/#13 sont compatibles avec la cible mini-ERP. Elles constituent la première implémentation de certaines fondations d'intégration et d'autonomie, pas une livraison du framework complet. Le programme Finco/comptabilité reste distinct et conservé.

### Réalisé sur la branche de PR, vérifié localement

- Jetons Secrétariat/Comptable/Éditeur, lecture seule par défaut, expiration/révocation et trace d'audit.
- Mise en file atomique avec l'audit, webhooks HMAC, nouvelles tentatives et journal de livraison.
- Parcours réel GCF→n8n→API GCF avec jeton limité ; fausse signature, signature expirée et jeton révoqué refusés.
- Quatre automatismes, paramètres et propositions sous les droits de la personne qui décide.
- Calcul de paie automatique possible, avec validation et paiement toujours manuels.
- 264 tests automatisés réussis sur les bases isolées, typage et compilation réussis.

### À traiter avant généralisation

1. Séparer décision et exécution d'une proposition ; récupérer les traitements interrompus et les runs `running` orphelins.
2. Rendre la progression/reprise par intervenant visible en cas de calcul partiellement exécuté.
3. Définir l'accusé de réception n8n, les erreurs de traitement et la déduplication durable des effets externes.
4. Protéger les secrets et définir les droits techniques/destinations selon le mode d'hébergement.
5. Stabiliser les contrats d'événements et leur version, puis les contrats API et le SDK.
6. Généraliser le catalogue de tâches en studio configurable, avec simulations et configurations versionnées.

Relances et paie supportent Désactivé/À confirmer/Automatique. Programme quotidien et avis de courrier supportent seulement Désactivé/Automatique dans cette version.

### Rôle de n8n dans le produit

- GCF conserve les règles, droits, soldes, validation et comptabilisation.
- n8n orchestre les systèmes et canaux externes sous des jetons limités.
- Le même travail ne doit pas être planifié simultanément dans GCF et n8n sans propriétaire et identifiant d'idempotence définis.
- Le futur agent IA/MCP utilise les mêmes API, permissions et propositions ; il ne contourne pas les validations financières.
- WhatsApp reste un chantier séparé, conditionné au cadrage des données, des destinataires et de leur traitement.

Cette mise à jour évite de refaire les composants déjà présents. Elle ne justifie pas à elle seule de raccourcir l'estimation globale de la comptabilité, du stock et de la gestion commerciale. Le backlog et les charges devront être réestimés à partir des briques effectivement réutilisées et des réserves du rapport de validation.

## 19. Point de départ du chantier — 10 novembre 2026

### 19.1 Briques réutilisables et compatibilité

| Brique actuelle                                         | Utilisation dans la cible                                              | Ce qui reste à construire                                                                                    |
| ------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Espaces métier et raccourcis                            | Navigation adaptée aux modules et aux tâches de chaque rôle            | Packs de menus versionnés, recette par rôle et personnalisation partagée si nécessaire                       |
| Tableau de bord et cloche                               | Suivi des actions et liens vers les dossiers                           | Seuils d’urgence, affectation et historique si requis ; le polling agrégé n’est pas un journal exhaustif     |
| Formules de paiement                                    | Conditions proposées au client et choisies à l’inscription             | Conditions commerciales réutilisables par les documents génériques, contrats versionnés et règle de prorata  |
| Exigible / futur / crédit                               | Présentation cohérente des sommes à encaisser                          | Sous-livre client, factures, avoirs et rapprochement comptable ; une projection n’est pas un produit reconnu |
| Périodes de service                                     | Rattachement des nouvelles mensualités et protection lors d’un abandon | Règles d’abonnement, produits constatés d’avance et ventilation analytique à définir avec le comptable       |
| Plans coworking                                         | Sélection spatiale à l’accueil, zoom, étages et états                  | Unifier les disponibilités de salles partagées et poursuivre la recette sur mobile                           |
| Jetons, audit, outbox et webhooks                       | Base du framework d’intégration                                        | Contrats versionnés, idempotence des commandes, déduplication et preuve de traitement externe                |
| Propositions et automatismes                            | Validation humaine et délégation contrôlée                             | Reprise après arrêt, suivi par étape et paramètres consultant versionnés                                     |
| Faits financiers, millimes, verrous et pièces immuables | Sources opérationnelles et garde-fous                                  | Moteur débit/crédit, journaux, périodes, écritures équilibrées et rapprochements                             |

Décision : ces travaux sont compatibles avec la cible et doivent être conservés après revue. Ils ne remplacent ni le socle comptable ni le framework consultant. Les chantiers n8n et ERP partagent les mêmes droits et contrats ; ils ne doivent pas avoir deux moteurs concurrents pour valider ou modifier une dette.

### 19.2 Passage obligatoire avant l’élargissement des modules

Le lot immédiat est une stabilisation métier et une revue de branche, estimée par scénarios, avant toute promesse de livraison ERP. Les points A01 à A12 de l’audit servent de registre initial ; leur priorité de correction ne signifie pas qu’un scénario non exécuté serait déjà un défaut reproduit.

1. Relire les migrations `0018` et `0019`, les nouveaux contrats de totaux et l’absence de reprise silencieuse de l’historique ; tester la migration depuis la branche cible réelle.
2. Corriger ou circonscrire pour le pilote les divergences de disponibilité des salles partagées.
3. Arrêter les décisions de prorata, abandon, avances, prix du groupe et assiette de rémunération ; produire les exemples attendus avant de coder de nouvelles règles.
4. Établir les commandes idempotentes et la reprise des propositions / runs interrompus.
5. Constituer un jeu de référence signé fonctionnellement : données initiales, opération, état final, montant et pièces attendues, résultat après rejeu.

La revue et le merge restent au développeur responsable. Ne pas appliquer automatiquement des modifications réglementaires ou de schéma à une base client à partir de ce document.

### 19.3 Backlog de lancement, dans l’ordre de dépendance

| Lot / PR suggérée                  | Résultat concret                                                                                                          | Critères de sortie                                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| ERP-00 — audit et décisions        | Glossaire : engagement, prestation, exigibilité, retard, acompte, facture, encaissement, revenu ; matrice des cas actuels | Cas R01–R09 arbitrés pour le premier pack ; incertitudes restantes nommées                                                   |
| ERP-01 — fiabilité des commandes   | Idempotence de l’encaissement, reprises des propositions et jobs, corrélation des échanges                                | Double requête et arrêt après commit sans double effet ; erreurs et reprise visibles                                         |
| ERP-02 — frontières d’organisation | Tenant, société juridique, établissement, domaine public et droits par périmètre                                          | Deux dossiers pilotes isolés ; restauration et résolution de domaine vérifiées                                               |
| ERP-03 — registre et packs         | Manifestes de modules, dépendances, paramètres typés, pack Formation et pack Coworking                                    | Installation vide reproductible ; désactivation contrôlée et historique lisible                                              |
| ERP-04 — consultant V1             | Questionnaire, import simulé, correspondances, recette, publication datée et diff de configuration                        | Un consultant configure un nouveau client sans fork ; mêmes données et résultats après rejeu                                 |
| ERP-05 — commerce Services         | Contact, service, devis, commande, facture / avoir, échéancier et affectation de paiement                                 | Vente complète avec avance, partiel, remise, annulation, arrondi et règle fiscale validée                                    |
| ERP-06 — socle comptable           | Plan de comptes, journaux, écritures et lignes, axes, périodes et contrepassation                                         | Débit = crédit ; source unique, clôture protégée et rapprochement du sous-livre                                              |
| ERP-07 — achats et stock           | Réception/livraison liée aux origines, retours, réservations, entrepôts et valorisation                                   | BL lié à facture : une seule sortie ; retours et doubles requêtes sans double mouvement                                      |
| ERP-08 — localisation tunisienne   | Paramètres datés, documents, retenues et échanges nécessaires au dossier pilote                                           | Matrice des obligations, spécifications officielles et recette expert-comptable ; aucune conformité déduite d’un PDF produit |
| ERP-09 — intégration V1            | API documentée, événements versionnés, SDK léger, connecteur n8n de référence et supervision                              | Migration d’une version de contrat, rejeu d’événement et incident externe traités sans double effet                          |
| ERP-10 — pilotes et exploitation   | Parcours par rôle, support, sauvegardes, restauration et plan de mise à niveau                                            | Acceptation des pilotes, contrôles financiers et procédure de reprise démontrés                                              |

Les lots ERP-05 et ERP-06 doivent être conçus ensemble pour éviter une seconde réécriture financière. Le cadrage fiscal commence à ERP-00 et conditionne la diffusion d’ERP-05 ; ERP-08 est une livraison et une recette, pas le moment où l’on commence à s’intéresser aux obligations. API et événements sont définis dès les premiers lots ; ERP-09 industrialise leur usage.

### 19.4 Première tranche consultant, volontairement limitée

Le premier framework d’implémentation doit livrer un résultat vérifiable : prendre un nouveau centre, choisir Formation ou Coworking, saisir ses paramètres, simuler un import, vérifier les erreurs, charger les données, exécuter la recette puis publier la configuration.

Artefacts minimaux :

- `module.json` : identifiant, version, dépendances, permissions, paramètres et versions de schéma compatibles.
- Pack versionné : valeurs explicites, provenance, configuration des rôles autorisés, modèles et transformations d’import.
- Import : aperçu des doublons, clés métier et références externes, erreurs par ligne, transaction ou lot contrôlé, reprise et rapport de rapprochement.
- Publication : auteur, date d’effet, approbateur si requis, différences et journal ; les transactions déjà créées ne sont pas supprimées par un retour de configuration.
- Recette : scénarios du pack, solde initial / final et pièces ; déploiement sur une base vide et sur une copie anonymisée.

Ces noms d’artefacts définissent une cible de conception. Ils n’existent pas encore comme framework dans le dépôt. Aucun SQL ou JavaScript arbitraire ne doit être exécutable depuis un champ de configuration client.

### 19.5 Matrice Finco → cible et différenciation

L’analyse Finco v2 est une référence d’observation. Elle ne prouve ni le schéma interne de Finco ni ses invariants comptables. Les montants fiscaux de ses exemples ne deviennent pas des constantes du produit.

| Périmètre observé                      | Cible                                                | Amélioration prioritaire                                                                          |
| -------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Clients / fournisseurs                 | Contact commun avec rôles, société et établissements | Éviter les doublons entre élève, payeur, entreprise et client coworking sans fusion destructive   |
| Articles, tarifs et taxes              | Produits/services, unités et conditions datées       | Montrer l’origine du prix, simuler avant publication, figer le contrat vendu                      |
| Devis, commandes, BL, factures, avoirs | Documents distincts liés par lignes d’origine        | Transformer partiellement sans double facturation ni double sortie de stock                       |
| Paiements, chèques/traites, retenues   | Règlement et encaissement bancaire séparés           | Afficher exigible, projection et crédit ; suivre reçus, rejets et justificatifs                   |
| Entrepôts et inventaires               | Mouvements datés et valorisés                        | Traçabilité de la source, ajustement motivé, contrôle du stock négatif et réservations            |
| Projets et rapports                    | Analytique et indicateurs réconciliables             | Accès depuis chaque KPI aux lignes qui le composent et définition affichée                        |
| Paramètres et champs                   | Packs consultant, paramètres et extensions bornées   | Simulation, historique et publication datée ; menus adaptés au pack, sans prolifération d’options |
| Échanges fiscaux et documents          | Connecteurs localisés maintenus                      | Distinguer émission, acceptation, rejet et archivage ; déduplication et reprise                   |

### 19.6 Références de conception et de conformité à maintenir

Le Système comptable des entreprises tunisien comprend un cadre conceptuel et des normes générales, techniques et sectorielles ; la localisation doit donc être un dossier de règles maintenu et validé pour les activités visées. Référence officielle : [Conseil national de la comptabilité — Ministère des Finances](https://www.finances.gov.tn/fr/conseil-national-de-la-comptabilite-cnc).

Pour la facturation électronique, tenir une matrice activité / régime / client / obligation / date d’effet et vérifier les textes et spécifications officiels applicables au moment du pilote. L’extension aux prestations de services est abordée dans la [procédure administrative publiée sur Idaraty](https://www.idaraty.tn/public/fr/procedures/utilisation-de-la-facture-electronique). Ce point est un travail d’identification et de recette avec le comptable ; ce document ne fixe aucun taux ni exemption.

La notion de manifeste et de dépendances s’inspire de pratiques documentées telles que les [manifestes de modules Odoo](https://www.odoo.com/documentation/master/developer/reference/backend/module.html). Cette référence ne suppose ni réutilisation du code Odoo ni compatibilité binaire avec ses modules.

### 19.7 Conditions de poursuite et estimation

Conserver l’enveloppe initiale de 12 à 18 mois pour une V1 large, sous les hypothèses d’équipe de la section 11. Cette estimation de cadrage n’est pas une mesure de charge issue des derniers changements. La réestimer après ERP-00, l’inventaire des accès externes et les premiers imports pilotes.

Le premier livrable commercial peut être plus restreint : un pack de services ou un centre configuré et fiable, avec facturation répondant aux obligations réellement applicables à ce dossier. Ne pas annoncer « mini-Odoo complet » pour ce premier jalon.

La réussite se mesure par le temps de configuration d’un dossier, les tâches quotidiennes terminées sans aide, les écarts de rapprochement, les doublons au rejeu et la capacité à restaurer. Les valeurs de référence et seuils restent à mesurer et à faire approuver ; aucune cible arbitraire n’est annoncée comme déjà atteinte.
