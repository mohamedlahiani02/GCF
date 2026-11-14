# Démonstration AXELIA et site du centre

Proposition du 13 novembre 2026, fondée sur `origin/main` au commit `30c9de6`. La marque AXELIA et les deux variantes du symbole ont été fournies par le porteur du projet. Les volumes, offres et tarifs de ce document sont proposés pour un centre fictif de démonstration. La ville, les coordonnées et les tarifs commerciaux restent à préciser.

Le scénario présente un centre réunissant formation, cours particuliers, coworking et café. Les parcours passent par le site, le portail client, l’accueil, les prestations et leurs règlements. Le contenu cible les quatre modules activables et les fonctions communes de l’application.

**État vérifié du dépôt et de l’environnement**

La récupération de `main` le 13 novembre confirme que le checkout possède déjà sa dernière version. Les préparatifs de déploiement sont présents sur la branche de travail `feat/heroku-client-demos` sous forme de modifications locales. Le serveur local a été remis en route sur le port 3010.

La base locale `gcf_pr12_review` possède les quatre modules actifs. Elle contient 16 élèves, 5 profs/formateurs, 7 groupes, 11 clients coworking et 5 pages du site. Le café compte zéro produit et zéro vente, les locations zéro opération, et le personnel possède uniquement le rôle Admin. Ces nombres décrivent l’état lu avant la préparation de cette proposition.

**Jeu de données proposé**

Les personnes et entreprises seront fictives. Les libellés métier utiliseront des noms courants, comme Mathématiques – Bac ou Cybersécurité. Quatre comptes du personnel permettront de présenter les droits Admin, Secrétariat, Comptable et Éditeur, avec un compte portail client distinct et utilisable.

| Domaine               | Volume cible et exemples                                                                                        | Action à montrer au client                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Identité et accueil   | Centre AXELIA, coordonnées de démonstration, horaires, logo, quatre rôles et raccourcis adaptés                 | Le secrétariat ouvre les actions courantes et retrouve les demandes à traiter                                          |
| Cours particuliers    | 24 élèves au total avec les formations, dont des mineurs avec responsables, 5 profs/formateurs et 4 cours       | Inscrire un élève à Mathématiques – Bac, Mathématiques – 3e année secondaire, Physique – Bac ou Anglais – Conversation |
| Formations            | Intelligence artificielle, Cybersécurité, Développement web, avec des formules adaptées                         | Comparer paiement intégral, tranches, mensuel et séance, puis choisir une formule à l’inscription                      |
| Groupes et planning   | Environ 8 groupes, 4 salles et des séances autour du jour de présentation                                       | Créer une séance, voir le prochain créneau et saisir les présences depuis le groupe                                    |
| Présences et suivi    | Feuilles validées, une feuille à compléter, absence justifiée, absence à justifier et séance annulée            | Compléter une feuille puis montrer son effet sur les montants et la paie selon la règle                                |
| Encaissements         | Paiements complets et partiels, mensualités futures, avance, chèque, remise et remboursement identifié          | Afficher exigible, projections et crédit, encaisser et télécharger le reçu                                             |
| Paie                  | Règles à la séance, au mois, horaires et au forfait formation, avec plusieurs règles pour un même prof          | Calculer, valider un élément éligible et effectuer un règlement partiel avec justificatif                              |
| Coworking             | Plan publié de 13 ressources, tarifs membre/visiteur, formats horaires et journée, abonnements et pack d’heures | Choisir sa place sur le plan, réserver, accueillir le client et encaisser                                              |
| Clients coworking     | Environ 10 membres, un invité, 2 entreprises, un compte portail actif et une demande de compte en attente       | Valider le compte en attente et retrouver réservations, documents et soldes du client actif                            |
| Domiciliation         | Un abonnement de domiciliation, un courrier reçu, un colis et un courrier retiré                                | Enregistrer un courrier et consulter la préparation de sa notification                                                 |
| Locations             | 3 loueurs et 3 cas de location, ponctuelle avec acompte/solde, récurrente et annulée                            | Consulter le planning commun, produire le contrat et encaisser le solde                                                |
| Café                  | 7 produits, un fournisseur, du stock, des ventes en espèces/carte, une commande fournisseur et un inventaire    | Vendre un café et une eau, voir la monnaie, consulter le ticket puis le mouvement de stock                             |
| Caisses et rapports   | Un fonds de caisse par caisse utilisée, une clôture historique et une journée de présentation ouverte           | Voir les encaissements du centre, la caisse du café, les écarts et les rapports associés                               |
| Automatisations       | Exemples de relance, programme du lendemain, calcul préparatoire de paie et courrier reçu                       | Ouvrir une proposition, contrôler le détail et présenter la confirmation sous les droits du bon rôle                   |
| Intégrations et audit | Un scénario n8n de test, un événement signé, son journal et une lecture API limitée                             | Suivre l’événement, les tentatives et l’auteur d’une action dans l’audit                                               |
| Site et portail       | Pages AXELIA, médias fournis, demande de visite, demande de renseignements et réservation                       | Partir du site et retrouver chaque demande dans son écran de gestion                                                   |

Le catalogue café proposé reprend les produits déjà prévus par le seed. Les prix ci-dessous sont des exemples en TND.

| Produit         | Prix proposé |
| --------------- | ------------ |
| Café express    | 2,500        |
| Capucin         | 3,000        |
| Thé à la menthe | 2,000        |
| Eau             | 1,000        |
| Jus d’orange    | 4,500        |
| Croissant       | 1,800        |
| Sandwich thon   | 6,500        |

Pour l’un des exemples financiers, une inscription court d’octobre à janvier à 80 TND par mois, exigible en fin de mois. Au 13 novembre, octobre représente 80 TND exigibles et les trois autres mensualités représentent une projection de 240 TND. Un encaissement de 30 TND laisse 50 TND exigibles. Un second exemple propose le début de mois, et un troisième une entrée en cours de mois avec prorata. Chaque cas aura son résultat attendu vérifié avant la présentation.

Les opérations à réaliser en direct seront préparées dans un état ouvert. Une feuille de présence, une validation de compte, une demande de visite, un règlement de paie et une vente café resteront disponibles. Les historiques permettront de montrer les états terminés sans épuiser les actions de la démonstration.

**Préparation du seed**

Le seed existant fournit une base réutilisable pour les cours, formations, présences, règlements, paie, coworking, café et site. Les intitulés de ses formations, notamment Couture et modélisme et Bureautique, devront être adaptés au scénario IA, Cybersécurité et Développement web. Les locations, les comptes supplémentaires, les parcours portail et les opérations avancées du café doivent compléter ce jeu.

Le seed courant refuse un centre déjà rempli et chaque création possède sa propre transaction. Pour préparer un jeu reproductible, utiliser une base dédiée au scénario AXELIA, contrôler ses totaux et conserver une sauvegarde de référence avant la présentation. Les dates doivent être relatives au jour prévu, avec des séances et réservations effectivement utilisables ce jour-là. Le jeu standard couvre actuellement le mois précédent jusqu’à la fin du troisième mois suivant.

Les fonctions d’envoi de mails demandent un service SMTP opérationnel. Au contrôle local du 13 novembre, le programme du lendemain signale un envoi impossible car SMTP est absent. Les confirmations, journaux et propositions peuvent être présentés, et un envoi réel demande une boîte de test configurée. Le scénario n8n doit également être vérifié sur un workflow de test disponible.

**Direction visuelle du site**

Le symbole principal de 1024 × 1024 pixels convient aux surfaces claires. La version inversée convient aux surfaces bleu nuit. La palette mesurée dans les fichiers fournis comprend le bleu nuit `#0E1A36`, l’ambre `#E8A33D`, le gris clair `#F4F5F8` et le blanc. L’en-tête proposé associe le nom AXELIA et le symbole.

Le rendu actuel affiche au choix l’image du logo ou le nom du site, et utilise une image de logo commune. L’association du symbole et du nom, ainsi que l’emploi des deux variantes selon les zones du site, demandent une adaptation du rendu pour réaliser cette proposition.

La proposition utilise une typographie Inter, déjà proposée par le CMS, des photographies larges, des titres courts et des boutons lisibles. La direction souhaitée associe les accents ambre à un texte bleu nuit. Les cadrages seront adaptés au mobile lors de l’intégration. Les choix de thème et les emplacements des deux variantes de logo seront contrôlés dans l’aperçu.

Le thème courant contrôle ses deux couleurs configurables contre un texte blanc et son gris clair est fixé dans les styles. Le bleu nuit convient à ces réglages. Les boutons ambre avec un texte bleu nuit et le gris exact de la marque demandent une petite adaptation du thème, avec contrôle des contrastes, pour réaliser la direction proposée.

**Navigation et contenu proposés**

| Entrée du menu      | Contenu et action principale                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Accueil             | Photo principale, présentation d’AXELIA, accès aux activités, aperçu des espaces et invitation à réserver              |
| Formations et cours | IA, Cybersécurité, Développement web et cours particuliers, présentation des modalités et formulaire de renseignements |
| Coworking           | Postes, bureaux et salles, photos associées, tarifs et disponibilités issus du module, accès à la réservation sur plan |
| Le centre           | Présentation, galerie de la vie du centre et sous-page Café                                                            |
| Contact             | Coordonnées à confirmer, horaires, carte et demande de visite                                                          |

Le bouton Réserver ouvre le portail coworking, où le client retrouve également ses réservations et documents. Le bloc principal d’accueil possède actuellement un bouton. Les appels à l’action des autres activités seront placés dans leurs sections respectives.

Ordre proposé pour l’accueil.

1. Une grande photographie avec la phrase « Un lieu pour apprendre, travailler et avancer » et le bouton « Réserver un espace ».
2. Une présentation courte des activités avec des accès aux formations, aux cours et au coworking.
3. Les espaces réservables et leurs photos.
4. La présentation des offres et les liens vers les tarifs.
5. Une galerie de la vie du centre.
6. Un article utile ou un prochain atelier effectivement renseigné.
7. Une invitation à visiter le centre et les coordonnées.

**Affectation des photos reçues**

| Fichier fourni                                         | Dimensions  | Emplacement proposé                                                                   |
| ------------------------------------------------------ | ----------- | ------------------------------------------------------------------------------------- |
| `thinkspace-morningside-coworking-desks-optimized.jpg` | 1920 × 1280 | Image principale d’accueil et présentation générale de l’open space                   |
| `coworking-space-in-berlin.jpg`                        | 2000 × 2000 | Offre poste individuel, détail d’un poste de travail et rubrique consacrée au confort |
| `slm_362104__Copy-of-0879.jpg`                         | 980 × 678   | Présentation du centre et vue d’ensemble dans la galerie                              |
| `images (2).jpeg`                                      | 678 × 452   | Bloc compact sur les services et espaces partagés                                     |
| `images (1).jpeg`                                      | 701 × 438   | Galerie consacrée à la vie collective du centre                                       |
| `images.jpeg`                                          | 547 × 365   | Petite image d’ambiance dans la galerie ou un article                                 |
| `47fb454464e72c7470ebfb85936ecdc5.jpg`                 | 236 × 354   | Vignette portrait de petite taille si elle apporte un cadrage utile                   |

Les originaux sont fournis dans `C:/Users/haith/Downloads/`. Les symboles portent les noms `axelia-symbole-principal (1).png` et `axelia-symbole-inverse (1).png`. Les photos du lot montrent des environnements de coworking. Les rubriques Formation et Café pourront d’abord utiliser leur contenu éditorial, puis accueillir des vues adaptées lorsqu’elles seront disponibles. Les images utilisées recevront un nom descriptif, un texte alternatif et une affectation claire dans la médiathèque.

**Capacités utilisées pour le site**

Le CMS permet les pages, les articles, les galeries, les formulaires Contact/Visite/Devis, les boutons, les brouillons, l’aperçu, les versions publiées et la publication programmée. Les contenus peuvent être préparés en français et en anglais. Les cartes d’espaces, leurs tarifs et leurs disponibilités utilisent les données coworking.

La page Formation sera éditoriale, avec une demande suivie d’une inscription dans le back-office. La page Café présentera le lieu et les produits choisis, et la vente se montrera dans le module Café. Un catalogue Formation synchronisé ou une commande café publique constituerait une évolution du produit. Le CMS du centre et le portail font partie du dépôt courant, tandis que la vitrine commerciale du logiciel AXELIA possède son propre dépôt.

**Parcours de présentation proposé, environ 30 minutes**

| Étape             | Parcours                                                                                |
| ----------------- | --------------------------------------------------------------------------------------- |
| Découverte        | Site AXELIA, espaces, offres, demande de visite et accès au portail                     |
| Accueil coworking | Validation du compte en attente, choix d’une place sur le plan, accueil et encaissement |
| Formation         | Inscription dans un groupe avec choix de formule et contrôle de l’échéancier            |
| Présences et paie | Validation d’une feuille, calcul d’un élément à la séance et règlement partiel          |
| Café et location  | Vente de deux produits, mouvement de stock, puis contrat de location et acompte         |
| Pilotage          | Tableau de bord, impayés, caisses, propositions et audit                                |

Pour la recette finale, vérifier l’accès des quatre rôles, les montants attendus, les liens entre site et gestion, les téléchargements PDF, la disponibilité des places et les parcours sur mobile. Conserver les données ouvertes et la sauvegarde de départ avec le guide de présentation.

Sources examinées dans le dépôt.

- `apps/api/src/modules.ts`
- `apps/api/src/cli/seedDemo.ts`
- `apps/api/src/cli/seedDemoCoworking.ts`
- `apps/api/src/cli/seedDemoWebsite.ts`
- `apps/api/src/domain/automations/definitions.ts`
- `apps/api/src/routes/rentals.ts`
- `packages/shared/src/siteSections.ts`
- `apps/api/src/site/dynamic.ts`
- `apps/api/src/site/theme.ts`
- `apps/api/src/site/render.ts`
