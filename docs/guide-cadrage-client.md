# Guide de cadrage client

Ce guide s'adresse au consultant qui qualifie un centre avant de déployer AXÉLIA. Il sert à deux choses : comprendre comment
le centre fonctionne, et rassembler chaque information dont l'installation a besoin. Il se déroule en ateliers avec le client,
avant toute saisie dans l'application. À la fin, la fiche de synthèse (section 20) tient lieu de cahier de paramétrage.

Règle de lecture : chaque question indique **pourquoi on la pose** (le réglage ou l'écran de l'application qui en dépend) et la
**réponse attendue**. Une question sans réponse du client reçoit la valeur par défaut du produit, notée dans la colonne « Défaut ».
Les réglages se décrivent dans `docs/guide-parametrage.md` ; les points qui relèvent d'un expert-comptable ou d'un juriste sont
marqués **[À valider]** et listés dans `docs/hypotheses-a-valider.md`.

## 0. Déroulé et livrables

| Étape | Atelier                                        | Participants côté client                     | Livrable                                                  |
| ----- | ---------------------------------------------- | -------------------------------------------- | --------------------------------------------------------- |
| 1     | Découverte : activité, organisation, objectifs | Direction                                    | Sections 1 à 3 remplies                                   |
| 2     | Fonctionnement métier, un atelier par module   | Responsables de chaque activité, secrétariat | Sections 4 à 11 remplies                                  |
| 3     | Finances et obligations                        | Direction, comptable, expert-comptable       | Sections 5, 6 et 19 remplies, points [À valider] tranchés |
| 4     | Communication et intégrations                  | Direction, responsable informatique          | Sections 12 à 14 remplies                                 |
| 5     | Reprise de données                             | Secrétariat, comptable                       | Section 15 : fichiers reçus et contrôlés                  |
| 6     | Infrastructure et sécurité                     | Responsable informatique                     | Sections 16 et 17 remplies                                |
| 7     | Plan de recette et de formation                | Utilisateurs clés                            | Sections 18 et 19 : scénarios signés                      |

Documents à demander dès le premier contact : registre du commerce et matricule fiscal, logo en bon format, tarifs en vigueur
(affichés ou imprimés), contrats types des intervenants, modèles de reçus et de factures actuels, plan des locaux, exports de
tous les fichiers (Excel ou logiciel existant) listant élèves, intervenants, clients et impayés, charte graphique du site.

## 1. Identité du centre et contexte

| Question                                                                               | Pourquoi                                                                  | Réponse attendue                                | Défaut                        |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------- |
| Raison sociale et nom commercial                                                       | En-têtes de reçus, factures, e-mails, site                                | Texte exact                                     | Aucun                         |
| Adresse complète du siège et des sites d'accueil                                       | Documents imprimés, site, e-mails                                         | Adresse postale                                 | Aucune                        |
| Matricule fiscal                                                                       | Factures et mentions légales **[À valider]**                              | Numéro tel que déclaré                          | Aucun                         |
| Le centre est-il une société, une association, un entrepreneur individuel ?            | Obligations fiscales et mentions légales **[À valider]**                  | Forme juridique                                 | Aucune                        |
| Combien de sites physiques ? Un seul centre dans l'application suffit-il ?             | Une installation = un centre ; plusieurs centres = installations séparées | Nombre de sites, indépendance comptable         | Un centre                     |
| Devise, nombre de décimales                                                            | Tous les montants                                                         | TND, 3 décimales (millimes)                     | TND, 3                        |
| Langue de l'application et des documents                                               | Interface et documents                                                    | Français ou arabe                               | Français                      |
| Fuseau horaire                                                                         | Heures de séances, de réservation, de clôture                             | Fuseau                                          | Africa/Tunis                  |
| Jours et heures d'ouverture                                                            | Calcul de l'occupation des salles                                         | Plage et jours                                  | 08:00 à 20:00, lundi à samedi |
| Logo                                                                                   | Reçus, factures, back-office                                              | PNG, JPEG ou WebP                               | Aucun                         |
| Quelle est l'activité principale ? Combien d'élèves, de membres, de clients par mois ? | Dimensionnement et priorités du déploiement                               | Ordres de grandeur                              | Aucun                         |
| Objectifs du projet (réduire les impayés, remplacer Excel, ouvrir un portail, etc.)    | Ordre des chantiers et critères de succès                                 | Trois objectifs classés                         | Aucun                         |
| Quels outils sont utilisés aujourd'hui, et lesquels doivent rester ?                   | Reprise de données, intégrations                                          | Liste (Excel, logiciel de caisse, comptabilité) | Aucun                         |

## 2. Modules à activer

Les modules s'activent par l'éditeur, centre par centre. Un module non souscrit n'apparaît nulle part (menus, droits, API).

| Module         | Question de qualification                                                           | À activer si                                                     |
| -------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Formation      | Le centre dispense-t-il des cours, des formations ou du soutien, avec des groupes ? | Élèves, groupes, présences, paie des intervenants                |
| Coworking      | Le centre loue-t-il des places, des bureaux, des salles à des membres ?             | Réservations, abonnements, visiteurs, courrier                   |
| Café           | Y a-t-il un café ou un point de vente avec une caisse ?                             | Produits, stock, tickets, clôture de caisse                      |
| Site web       | Le centre veut-il publier son site depuis l'application ?                           | Pages, demandes reçues, médias                                   |
| Arrivée par QR | Les membres doivent-ils signaler leur arrivée en scannant un code sur leur place ?  | Option du coworking                                              |
| Factures       | Le centre émet-il des factures (clients entreprises) en plus des reçus ?            | Option désactivée par défaut ; **[À valider]** avec le comptable |

Les locations de salles, les encaissements, les reçus, la caisse, les rapports et l'audit appartiennent au socle : ils sont
toujours disponibles.

## 3. Utilisateurs, rôles et droits

Quatre rôles existent et ne sont pas modifiables par client : **Admin** (tout), **Secrétariat** (accueil, inscriptions,
encaissements, présences, coworking, café en vente), **Comptable** (contrôle des pièces, caisse, paie, rapports, lecture),
**Éditeur du site** (pages, demandes du site).

| Question                                                                    | Pourquoi                                                         | Réponse attendue                     |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------ |
| Qui travaille dans l'application, avec quel poste ?                         | Création des comptes                                             | Nom, e-mail, rôle de chaque personne |
| Qui est administrateur ? Combien d'administrateurs au minimum ?             | Continuité si l'un est absent                                    | Deux personnes au moins recommandées |
| Qui encaisse ? Qui clôture la caisse ? Qui annule un paiement ?             | Rôles Secrétariat ou Comptable ; annulation réservée à l'admin   | Matrice personne par action          |
| Qui approuve une remise, un report d'échéance ?                             | Seul un administrateur approuve ; décide du circuit réel         | Règle d'approbation du centre        |
| Le besoin d'un droit particulier n'entre-t-il dans aucun des quatre rôles ? | Un rôle sur mesure n'existe pas encore ; le signaler à l'éditeur | Description du besoin                |
| Qui a accès depuis l'extérieur (téléphone, domicile) ?                      | Politique d'accès et de mot de passe                             | Oui ou non, par personne             |

## 4. Formation et cours particuliers

### 4.1 Comprendre le fonctionnement

| Question                                                                                              | Pourquoi                                           | Réponse attendue           |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------- | -------------------------- |
| Quelles activités de formation (soutien scolaire, langues, informatique, formation professionnelle) ? | Matières, études, formations                       | Liste                      |
| Un cours régulier (groupe qui se réunit chaque semaine) ou une formation à durée fixe ? Les deux ?    | Deux types de groupes : « étude » et « formation » | Pour chaque offre, le type |
| Comment un élève s'inscrit-il aujourd'hui, de bout en bout ? Qui fait quoi ?                          | Parcours d'inscription et droits                   | Description pas à pas      |
| Existe-t-il des cours particuliers (un élève, un intervenant) ?                                       | Groupes à la séance, absences facturées            | Oui ou non, tarif          |
| Un élève peut-il suivre plusieurs offres à la fois ?                                                  | Inscriptions multiples                             | Oui ou non                 |

### 4.2 Données de référence à collecter

| Entité            | Champs de l'application                                                                                                                                   | Obligatoire               | Remarque                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------ |
| Salles            | Nom, capacité, équipement, statut                                                                                                                         | Nom, capacité             | Les salles servent aussi aux locations et au coworking |
| Matières          | Nom                                                                                                                                                       | Nom                       | Regroupent les études                                  |
| Études            | Matière, nom, mode de facturation (mensuel ou à la séance), prix, absences facturées, séances par semaine, capacité                                       | Nom, mode, prix           | Cours réguliers                                        |
| Formations        | Intitulé, catégorie, description, durée en heures, prix, capacité                                                                                         | Intitulé, prix            | Durée fixe                                             |
| Plans de paiement | Nom, type (comptant, échéances, mensuel, à la séance), montant, jour d'échéance (anniversaire, début de mois, fin de mois, jour fixe), délai en jours     | Au moins un par offre     | Un plan par défaut par offre                           |
| Intervenants      | Nom, prénom, type (professeur ou formateur), statut (salarié, freelance, vacataire), téléphone, e-mail, matières enseignées, disponibilités               | Nom, prénom, type, statut | La paie en dépend                                      |
| Groupes           | Type, étude ou session de formation, nom, intervenant, salle, capacité, dates de début et fin, créneaux hebdomadaires, prix particulier, réglages propres | Nom, offre, dates         | Voir le niveau « groupe » du guide de paramétrage      |
| Élèves            | Nom, prénom, date de naissance, mineur oui ou non, téléphone, e-mail, e-mail du reçu, nom, téléphone et e-mail du tuteur, notes                           | Nom, prénom               | Tuteur exigible selon le réglage du centre             |
| Inscriptions      | Élève, groupe, date d'effet, mode de paiement, plan, prix de séance                                                                                       | Élève, groupe, date       | Prorata du mois partiel : réglage                      |

### 4.3 Règles à arbitrer avec le client

| Question                                                                                      | Réglage dans l'application                                                                    | Défaut               |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------- |
| Un élève mineur doit-il toujours avoir un parent joignable ?                                  | Exiger un tuteur joignable                                                                    | Non                  |
| Une absence justifiée compte-t-elle comme présence ?                                          | Taux de présence, paie au prorata                                                             | Non                  |
| Un rattrapage dans un autre groupe compte-t-il comme présence du groupe d'origine ?           | Rattrapages comptés                                                                           | Oui                  |
| Combien de fois une échéance peut-elle être reportée ? Le secrétariat peut-il reporter seul ? | Reports maximum, validation par l'admin                                                       | 2 ; validation oui   |
| Après combien de jours une échéance impayée est-elle en retard ?                              | Délai de grâce                                                                                | 0 jour               |
| Une inscription en cours de mois : le premier mois est-il proratisé, ou facturé en entier ?   | Prorata du mois partiel, jour d'échéance                                                      | Prorata oui          |
| En cours particulier, une absence est-elle facturée ?                                         | Absences facturées                                                                            | Selon l'offre        |
| Quand un élève abandonne en cours de mois, que reste-t-il dû ?                                | Règle d'abandon : la période commencée reste due, les périodes futures intactes sont annulées | Décision validée R03 |
| Un élève change de groupe : comment traiter l'historique de paiement ?                        | Transfert d'inscription                                                                       | Selon le cas         |
| Qui valide la feuille de présence, et sous quel délai ?                                       | Une séance tenue n'est payée qu'après validation                                              | Contrôle fixe        |

## 5. Finances : encaissements, caisse, retards, remises

| Question                                                                                                | Pourquoi                                                                      | Réponse attendue                 |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------- |
| Quels moyens de paiement le centre accepte-t-il ? (espèces, virement, chèque, carte)                    | Les quatre sont gérés ; un chèque a un cycle (reçu, déposé, encaissé, impayé) | Liste réelle                     |
| Combien de caisses (centre, café, autres) ? Qui est responsable de chacune ?                            | Caisse du centre et caisse du café sont séparées                              | Nombre, responsable              |
| Quel fond de caisse chaque matin ?                                                                      | Fond proposé à l'ouverture                                                    | Montant en TND                   |
| À quelle heure et par qui la caisse se clôture-t-elle ? Que faire d'un écart ?                          | Clôture journalière, écart commenté                                           | Procédure                        |
| Quelle numérotation pour les reçus (préfixe) ? La numérotation actuelle doit-elle continuer ?           | Numérotation continue sans trou, par année                                    | Préfixe, dernier numéro utilisé  |
| Quelles mentions doivent figurer au pied des reçus ?                                                    | Texte de pied de reçu **[À valider]**                                         | Texte                            |
| Délai de grâce avant retard ? Relances d'impayés, à quel rythme, à qui ?                                | Automatisation « relances d'impayés »                                         | Jour, heure, ancienneté minimale |
| Quelles remises le centre accorde-t-il (fratrie, fidélité, paiement comptant) ? Qui peut les accorder ? | Remises et validation par l'admin                                             | Liste, plafonds, circuit         |
| Un remboursement est-il possible ? Dans quels cas ?                                                     | Un remboursement est un mouvement distinct, jamais un effacement              | Règle du centre                  |
| Des paiements arrivent-ils d'un tiers (parent, employeur, organisme) ?                                  | Payeur distinct de l'élève                                                    | Cas fréquents                    |
| Des acomptes ou des avances sont-ils pris à l'inscription ?                                             | Plan « échéances » avec acompte                                               | Règle                            |

### Factures et obligations (option « Factures »)

Section à n'ouvrir que si le module est activé. **Toute réponse est à faire valider par l'expert-comptable du client.**

| Question                                                                                                    | Pourquoi                                                                |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Le centre est-il assujetti à la TVA ? Quel taux, sur quelles prestations ?                                  | Taux affiché aux clients entreprises ; les particuliers voient le total |
| Le droit de timbre s'applique-t-il ?                                                                        | Non géré automatiquement ; à décider                                    |
| Mentions légales exigées sur les factures (matricule fiscal, registre du commerce, adresse)                 | Pied de facture                                                         |
| Numérotation des factures et des avoirs (préfixes `FA` et `AV` par défaut)                                  | Continuité de la séquence d'origine                                     |
| Délai de paiement habituel (défaut 15 jours)                                                                | Échéance imprimée, statut « en retard »                                 |
| Faut-il reprendre les remises sur la facture ? Les factures sont-elles transmises à un logiciel comptable ? | Les remises n'y figurent pas aujourd'hui ; export à définir             |

## 6. Paie des intervenants

| Question                                                                                                                                                                                                 | Pourquoi                                                            | Réponse attendue                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------ |
| Comment chaque intervenant est-il rémunéré : pourcentage des encaissements ou du facturé, pourcentage du tarif de séance, montant fixe par séance, forfait mensuel, taux horaire, forfait de formation ? | Base de la règle de rémunération                                    | Pour chaque intervenant, la base et les montants |
| Rythme : par séance, par mois, à la fin de la formation ?                                                                                                                                                | Périodicité de la règle                                             | Rythme                                           |
| La paie dépend-elle de la présence des élèves ? Prorata, seuil minimum, aucun effet ?                                                                                                                    | Effet de la présence, seuil, plancher                               | Règle et seuil                                   |
| Une séance annulée par le centre est-elle payée ? Une séance sans élève présent ?                                                                                                                        | Payer séances annulées, payer séances vides                         | Oui ou non, par intervenant                      |
| Y a-t-il des primes ou des retenues ?                                                                                                                                                                    | Éléments de paie de type prime et retenue                           | Liste, règle de calcul                           |
| À quelle date le centre paie-t-il, et par quel moyen ?                                                                                                                                                   | Règlement des paies, automatisation du mois                         | Jour du mois, moyen                              |
| Quelle règle s'appliquait aux mois déjà payés ?                                                                                                                                                          | Reprise : les mois validés ou payés deviennent des éléments validés | Historique à reprendre                           |
| Qui valide la paie ?                                                                                                                                                                                     | La validation reste une décision de la comptabilité                 | Personne                                         |

Chaque règle d'un intervenant porte une date d'effet : une règle n'est jamais modifiée, une nouvelle la remplace. Le
consultant doit donc recueillir la date de début de chaque condition.

## 7. Locations de salles

| Question                                                                        | Pourquoi                                           | Réponse attendue |
| ------------------------------------------------------------------------------- | -------------------------------------------------- | ---------------- |
| Quelles salles sont louées à des tiers, et à quels moments ?                    | Planning, conflits avec les cours                  | Salles, créneaux |
| Quels tarifs : à l'heure, à la demi-journée, à la journée, au mois, à l'année ? | Tarifs par salle et par unité                      | Grille           |
| Paiement : comptant, acompte puis solde, récurrent ?                            | Mode de paiement d'une location                    | Règle            |
| Qui sont les locataires habituels (nom, société, téléphone, e-mail) ?           | Fiches locataires                                  | Liste            |
| Un devis est-il remis ? Sur quel modèle ?                                       | Devis de location imprimé                          | Modèle actuel    |
| Les locations sont-elles rattachées au coworking (salle de réunion) ?           | Une salle peut être liée à une ressource coworking | Oui ou non       |

## 8. Coworking

### 8.1 Comprendre le fonctionnement

| Question                                                                                                             | Pourquoi                                         | Réponse attendue      |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------- |
| Quels espaces propose-t-on : poste libre, poste dédié, bureau privé, salle de réunion, cabine, espace événementiel ? | Catégories de ressources                         | Liste                 |
| Un client est-il un **membre** (compte inscrit) ou une **entreprise** ? Les visiteurs ne sont pas des clients        | Tout client s'inscrit comme membre ou entreprise | Confirmer le principe |
| Comment un client réserve-t-il aujourd'hui (téléphone, WhatsApp, sur place) ? Veut-on un portail ?                   | Portail client, inscription libre ou validée     | Parcours cible        |
| Les inscriptions sont-elles libres ou validées par l'accueil ?                                                       | Inscription libre, approbation                   | Règle                 |

### 8.2 Données à collecter

| Entité                 | Champs de l'application                                                                                                                                      | Obligatoire          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- |
| Étages et plans        | Nom, ordre, plan (image), emplacement de chaque ressource sur le plan                                                                                        | Nom                  |
| Zones                  | Étage, nom, couleur                                                                                                                                          | Facultatif           |
| Types de ressources    | Nom, catégorie, description, photo, approbation requise, minutes maximum par jour, délai tampon, visible sur le portail                                      | Nom, catégorie       |
| Ressources             | Type, étage, zone, code, nom, capacité, salle liée, statut, motif d'indisponibilité                                                                          | Type, code           |
| Formats de réservation | Type, libellé, nature (durée fixe, plage nommée, libre), durée, pas de départ, bornes horaires, jours, minimum, maximum, seuil et plafond des longues durées | Au moins un par type |
| Tarifs                 | Par format et par profil (visiteur ou membre) : prix, prix heures creuses, prix longue durée                                                                 | Un prix par format   |
| Abonnements            | Nom, description, période (mois, trimestre, année), prix, facturation (d'avance ou mensuelle), domiciliation incluse, type affecté, préavis, droits inclus   | Facultatif           |
| Forfaits (packs)       | Nom, type, nature du quota (minutes ou réservations), quota, validité en jours, prix                                                                         | Facultatif           |
| Options payantes       | Type, nom, prix au forfait, par personne ou par unité, prix abonné                                                                                           | Facultatif           |
| Codes promotionnels    | Code, pourcentage ou montant, validité, nombre d'usages, profils concernés                                                                                   | Facultatif           |
| Fermetures             | Dates, libellé, horaires particuliers                                                                                                                        | Facultatif           |
| Clients                | Membres (nom, prénom, e-mail, téléphone, notes) et entreprises (nom, matricule fiscal, adresse, e-mail, téléphone, rôle du membre)                           | Nom, e-mail          |

### 8.3 Règles à arbitrer

| Question                                                                                          | Réglage dans l'application                                | Défaut                       |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------- |
| À combien de jours à l'avance peut-on réserver ? Délai minimal avant le début ?                   | Horizon, préavis minimal                                  | Selon le défaut du coworking |
| Combien de réservations actives en même temps par client ?                                        | Plafond de réservations actives                           | Selon le défaut              |
| Qui valide une réservation : personne, les visiteurs seulement, tout le monde ?                   | Mode d'approbation, approbation par type                  | Selon le défaut              |
| Annulation gratuite jusqu'à quelle heure ? Frais en cas d'annulation tardive ?                    | Délai d'annulation gratuite, pourcentage de frais         | Selon le défaut              |
| Combien de minutes de retard avant de libérer la place ? Absence non signalée ?                   | Tolérance, libération automatique                         | Selon le défaut              |
| Combien de temps une demande reste-t-elle ouverte avant d'expirer ?                               | Délai d'expiration des demandes                           | Selon le défaut              |
| Heures creuses : quand ?                                                                          | Début des heures creuses                                  | Aucune                       |
| Tarif dégressif sur longue durée, plafond de prix par jour : le centre les adopte-t-il ?          | Options adoptées centre par centre                        | Non                          |
| Afficher la taxe aux entreprises ? À quel taux ? **[À valider]**                                  | Taxe détaillée pour les entreprises                       | Non                          |
| Rappel avant réservation : combien d'heures ?                                                     | Rappel par e-mail                                         | 24 heures                    |
| Textes des e-mails (confirmation, refus, annulation, rappel)                                      | Modèles d'e-mail                                          | Textes fournis               |
| Registre des visiteurs : prévenir le client à l'arrivée de son visiteur ? Durée de conservation ? | Notification et conservation des visites                  | Oui ; 90 jours               |
| Courrier et domiciliation : faut-il un registre du courrier, un avis au destinataire ?            | Registre du courrier, automatisation « avis de courrier » | Selon l'abonnement           |
| Arrivée par QR : pour quelles ressources ?                                                        | Option « arrivée par QR »                                 | Désactivée                   |

## 9. Café et point de vente

| Question                                                                              | Pourquoi                              | Réponse attendue               |
| ------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------ |
| Quels produits vend-on, à quel prix, par quelle catégorie ?                           | Catalogue du café                     | Liste produits et prix         |
| Quels produits suivent un stock (ce qui se prépare sur place, non) ? Seuil d'alerte ? | Suivi de stock, alerte de stock bas   | Par produit                    |
| Peut-on vendre en rupture de stock ?                                                  | Vente en rupture autorisée ou refusée | Oui ou non (défaut non)        |
| Caisse à part ou caisse unique avec le centre ?                                       | Mode de caisse                        | Choix (défaut : caisse à part) |
| Fond de caisse habituel ?                                                             | Fond proposé chaque matin             | Montant                        |
| Imprimante de tickets : aucune, bureau, ticket 58 mm, ticket 80 mm ?                  | Impression des tickets                | Modèle, connexion              |
| Préfixe des tickets ?                                                                 | Numérotation des tickets, par année   | Préfixe (défaut `CAF`)         |
| Achats : simple réception, fournisseur obligatoire, ou bons de commande ?             | Circuit des achats                    | Choix                          |
| Fournisseurs : noms, contacts ?                                                       | Fiches fournisseurs                   | Liste                          |
| Stock initial de chaque produit ?                                                     | Inventaire d'ouverture                | Quantités à une date           |

## 10. Site web

| Question                                                                                         | Pourquoi                                    | Réponse attendue             |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------- | ---------------------------- |
| Le centre a-t-il déjà un site ? Garde-t-on son adresse (domaine) ?                               | Publication, adresse publique, redirections | Domaine, hébergeur actuel    |
| Quelles pages : accueil, offres, tarifs, contact, articles ? Quels contenus et images existent ? | Pages, sections, médias                     | Arborescence et textes       |
| Langues du site : français, anglais ?                                                            | Langues et langue par défaut                | Choix                        |
| Charte : couleurs, police, thème, logo, favicon                                                  | Apparence du site                           | Fichiers et codes            |
| Formulaires : contact, visite, devis ? Qui reçoit les demandes, et qui les traite ?              | Demandes du site et suivi comme prospect    | Personne, délai de réponse   |
| Coordonnées publiques : adresse, téléphone, e-mail, carte, réseaux sociaux ?                     | Paramètres du site                          | Texte exact                  |
| Qui publie, qui relit ?                                                                          | Rôle Éditeur, publication                   | Personnes                    |
| Référencement : titres et descriptions à conserver ? Anciennes adresses à rediriger ?            | Redirections                                | Liste des anciennes adresses |

## 11. Portail client (espace élève ou membre)

| Question                                                                                      | Pourquoi                                      | Réponse attendue             |
| --------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------- |
| Les clients doivent-ils consulter leurs réservations, paiements et factures en ligne ?        | Activation du portail                         | Oui ou non                   |
| Inscription libre ou sur invitation ? Validation par l'accueil ?                              | Inscription libre, approbation                | Règle                        |
| Quelles actions en libre-service : réserver, annuler, annoncer un visiteur, voir les droits ? | Fonctions du portail                          | Liste                        |
| Langue du portail ?                                                                           | Français ou anglais                           | Choix                        |
| Paiement en ligne souhaité ?                                                                  | Non disponible aujourd'hui (chantier reporté) | Besoin, prestataire envisagé |

## 12. Communications

| Question                                                                                 | Pourquoi                                                                    | Réponse attendue                                               |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Quel serveur d'envoi d'e-mails (SMTP) ? Quelle adresse expéditrice ?                     | Sans serveur d'envoi, les e-mails échouent ; reçus et relances en dépendent | Hôte, port, compte, adresse (secrets non écrits dans ce guide) |
| Quels e-mails automatiques le centre veut-il ? (confirmation, rappel, relance, reçu)     | Modèles et automatisations                                                  | Liste                                                          |
| Ton et signature des e-mails ?                                                           | Modèles de texte                                                            | Texte                                                          |
| Le centre utilise-t-il WhatsApp ou SMS avec ses clients ?                                | Chantier ELIA reporté ; besoin à documenter                                 | Usage actuel                                                   |
| Un reçu doit-il être envoyé automatiquement ? À quelle adresse (élève, tuteur, payeur) ? | E-mail du reçu                                                              | Règle                                                          |

## 13. Automatisations

| Question                                                                                                                      | Pourquoi                                             | Réponse attendue      |
| ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------- |
| Quelles tâches répétitives le centre veut-il automatiser ? (relances, paie du mois, programme du lendemain, avis de courrier) | Automatisations disponibles                          | Choix                 |
| Pour chacune : désactivée, à confirmer, ou automatique ?                                                                      | Trois modes ; la confirmation exige un rôle habilité | Mode par tâche        |
| Quels jours, heures, destinataires ?                                                                                          | Réglages de l'automatisation                         | Planning              |
| Un besoin d'automatisation n'est-il pas dans la liste ?                                                                       | Passe par n8n ou par un chantier du produit          | Description du besoin |

## 14. Intégrations

| Question                                                                                         | Pourquoi                                                                                   | Réponse attendue                         |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | ---------------------------------------- |
| Quel logiciel comptable le centre utilise-t-il ? Doit-il recevoir des écritures ou des exports ? | Aucun export comptable normé aujourd'hui ; à cadrer                                        | Logiciel, format attendu **[À valider]** |
| Un outil de messagerie d'équipe (Slack), d'agenda, de tâches doit-il être relié ?                | Webhooks, n8n, serveur MCP ; client MCP prévu (`docs/chantiers-a-venir.md`)                | Outils, événements à relayer             |
| Un assistant IA doit-il lire les données du centre ? Avec quelles limites ?                      | Serveur MCP : jeton à rôle limité, lecture seule par défaut, données personnelles masquées | Cas d'usage, rôle du jeton               |
| Un accès programmatique par un tiers est-il nécessaire ?                                         | Jetons d'accès, webhooks signés                                                            | Tiers, droits                            |
| Un lecteur de badges, un terminal de paiement, une serrure connectée ?                           | Non pris en charge (badges, casiers : non construits)                                      | Besoin à signaler à l'éditeur            |

## 15. Reprise de données

Cette section décide de ce que l'on charge, depuis quelle source et à quelle date de bascule. Aujourd'hui, l'application n'a
pas d'import de fichiers : chaque fiche se saisit, ou se charge par script sur mesure (voir
`docs/etude-framework-integration.md`). Les fichiers sont néanmoins à collecter et à nettoyer dès maintenant.

| Question                                                                                 | Pourquoi                                                | Réponse attendue                       |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------- |
| Quelle est la date de bascule ? Que se passe-t-il pour les opérations du mois en cours ? | Coupure nette entre l'ancien et le nouveau système      | Date, règle pour le mois de bascule    |
| Quelles données historiques faut-il reprendre ? Depuis quand ?                           | Volume et durée de la reprise                           | Périmètre par entité                   |
| Les impayés à la date de bascule : liste par élève ou client, avec montants et échéances | Charges ouvertes à reprendre ; pas d'import automatique | Fichier à jour, signé par le comptable |
| Les paiements déjà reçus pour des périodes à venir (avances)                             | Crédit du payeur                                        | Fichier                                |
| Les numéros de reçus et de factures déjà émis                                            | Continuité de la numérotation                           | Dernier numéro par série               |
| Les chèques non encaissés                                                                | Cycle du chèque                                         | Liste                                  |
| Le stock du café à la date de bascule                                                    | Inventaire d'ouverture                                  | Quantités                              |
| Les règles et paies déjà versées                                                         | Les mois validés deviennent des éléments validés        | Historique                             |
| Qui valide la qualité des fichiers avant chargement ?                                    | Responsabilité du contrôle                              | Personne côté client                   |

Critères de qualité d'un fichier à exiger : une ligne par personne ou objet, pas de cellule fusionnée, dates au format
jour/mois/année, montants en TND avec trois décimales ou en millimes (une seule convention), identifiants uniques (e-mail ou
numéro interne) pour éviter les doublons, encodage UTF-8.

Une reprise ne crée jamais d'historique numéroté : elle charge un état d'ouverture, contrôlé par rapprochement (somme des
impayés avant et après).

## 16. Données personnelles et conformité

| Question                                                                                           | Pourquoi                                                                | Réponse attendue                  |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------- |
| Le centre a-t-il déclaré ses traitements de données personnelles à l'autorité compétente (INPDP) ? | Conformité du client, à confirmer par son conseil **[À valider]**       | Oui, non, en cours                |
| Des données de mineurs sont-elles collectées (nom, tuteur, notes) ?                                | Données sensibles ; accès limité aux rôles habilités                    | Oui ou non, base légale           |
| Combien de temps conserve-t-on les fiches, les paiements, les visites ?                            | Conservation des visites : réglage ; autres durées : décision du client | Durées                            |
| Qui peut exporter ou voir les données personnelles ? Un assistant IA peut-il les voir ?            | Rôles ; données masquées par défaut sur le serveur MCP                  | Règle                             |
| Procédure de suppression ou d'anonymisation à la demande d'une personne                            | Aucune suppression automatique des pièces financières                   | Procédure à écrire avec le client |

## 17. Infrastructure, sécurité et exploitation

| Question                                                                                 | Pourquoi                                                    | Réponse attendue           |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------- |
| Où l'application sera-t-elle hébergée (hébergeur, pays) ? Une instance par centre.       | Une installation séparée par client                         | Hébergeur, contrat         |
| Quels noms de domaine : back-office, portail, site public ?                              | Adresse du back-office, adresse publique (`PUBLIC_ORIGIN`)  | Domaines, DNS              |
| Qui gère les certificats et le DNS ?                                                     | Mise en service                                             | Personne                   |
| Base de données : fréquence de sauvegarde, durée de conservation, test de restauration ? | Reprise après incident                                      | Politique écrite et testée |
| Environnements : recette distincte de la production ?                                    | Recette sur base séparée, données anonymisées               | Oui ou non                 |
| Accès : mots de passe, verrouillage après échecs, double authentification ?              | Verrouillage prévu ; double authentification non disponible | Politique                  |
| Qui reçoit les alertes en cas de panne ? Quel engagement de disponibilité ?              | Supervision, support                                        | Contact, engagement        |
| Mises à jour : qui applique les migrations de base, à quel moment ?                      | Chaque version peut ajouter des migrations                  | Fenêtre de maintenance     |

## 18. Formation et conduite du changement

| Question                                                                   | Pourquoi                                                       | Réponse attendue |
| -------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------- |
| Qui sont les utilisateurs clés par métier ?                                | Premiers formés, relais internes                               | Noms             |
| Quel niveau d'aisance informatique ?                                       | Durée et format de formation                                   | Évaluation       |
| Quelles tâches quotidiennes doivent être maîtrisées au premier jour ?      | Priorité de formation : encaisser, inscrire, pointer, réserver | Liste classée    |
| Quel support après la mise en service, par qui, pendant combien de temps ? | Hypercare                                                      | Engagement       |
| Quelle période d'exploitation en parallèle avec l'ancien système ?         | Sécurité de la bascule                                         | Durée            |

## 19. Recette et mise en service

La recette prouve que la configuration répond au métier du client. Chaque scénario a un résultat attendu écrit avant le test,
un testeur côté client et une signature.

| Module     | Scénarios minimaux                                                                                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Formation  | Inscrire un élève, encaisser une mensualité partielle, reporter une échéance, valider une feuille de présence, calculer la paie d'un intervenant, abandon en cours de mois |
| Finances   | Encaisser en espèces et par chèque, annuler un paiement (admin), clôturer la caisse avec un écart commenté, relancer un impayé                                             |
| Coworking  | Créer une réservation avec options, l'approuver, l'annuler tardivement, annoncer un visiteur, enregistrer un courrier, vérifier les e-mails reçus                          |
| Café       | Vendre, vendre en rupture (selon réglage), clôturer la caisse, recevoir une commande, corriger un stock par inventaire                                                     |
| Site web   | Modifier une page, la publier, recevoir une demande et la traiter                                                                                                          |
| Transverse | Droits par rôle (chaque rôle essaie ce qu'il doit voir et ne doit pas voir), journal d'audit, sauvegarde et restauration                                                   |

Critères d'acceptation : aucun écart de solde entre le fichier de reprise et l'application, aucune anomalie bloquante ouverte,
chaque rôle réussit ses scénarios sans aide, règles de paie recalculées à la main identiques au résultat de l'application sur
au moins trois cas. Date de bascule et plan de retour arrière écrits et signés avant la mise en service.

## 20. Fiche de synthèse de cadrage

À remplir à l'issue des ateliers ; elle devient la référence du paramétrage.

| Rubrique                          | Décision | Validée par | Date |
| --------------------------------- | -------- | ----------- | ---- |
| Modules activés                   |          |             |      |
| Rôles et utilisateurs             |          |             |      |
| Offres de formation et tarifs     |          |             |      |
| Plans de paiement                 |          |             |      |
| Règles de présence et de retard   |          |             |      |
| Règles de paie par intervenant    |          |             |      |
| Caisse : moyens, fonds, clôture   |          |             |      |
| Factures et taxe **[À valider]**  |          |             |      |
| Coworking : ressources et tarifs  |          |             |      |
| Coworking : règles de réservation |          |             |      |
| Café : produits et caisse         |          |             |      |
| Site web : pages et domaine       |          |             |      |
| E-mails et automatisations        |          |             |      |
| Intégrations                      |          |             |      |
| Périmètre de reprise et bascule   |          |             |      |
| Hébergement, sauvegarde, accès    |          |             |      |
| Plan de recette et de formation   |          |             |      |
| Points ouverts et responsables    |          |             |      |

## 21. Hors périmètre actuel du produit

À dire clairement au client dès le cadrage pour ne pas créer d'attente : import de fichiers en masse, rôles sur mesure,
plusieurs centres indépendants dans une même installation, double authentification, paiement en ligne, agent WhatsApp,
événements, badges et casiers, maintenance, export comptable normé, plan comptable. Plusieurs figurent dans la roadmap
(`docs/roadmap-mini-erp.md`) ou dans `docs/chantiers-a-venir.md` ; aucun n'est livré.
