# Audit initial du produit et des règles métier — GCF vers ERP

L’audit du 10 novembre 2026 porte sur `feat/billing-schedules`, issue de `82220bb`. Les décisions validées et leur premier lot de mise en œuvre sont repris sur `feat/enrolment-proration` au commit `3b43a70`. Voir [la passation](passation-branche-ux-facturation.md).

## Conclusion de cadrage

GCF dispose d’un métier utilisable et de protections financières utiles. Il constitue une base de migration vers un ERP de services. Il ne possède pas encore un moteur de gestion commerciale général, une comptabilité générale ou un studio consultant complet. Réutiliser son monolithe et ses contrôles est préférable à une réécriture générale.

Les priorités sont la définition des états financiers et périodes de service, la cohérence des disponibilités, la reprise des automatismes après interruption et les contrats des futures extensions. Une multiplication immédiate des modules augmenterait les ambiguïtés déjà visibles pour l’accueil.

Cet audit repose sur la lecture des domaines, migrations et permissions, les tests PostgreSQL et quelques parcours administrateur dans le navigateur. Il ne constitue ni un audit exhaustif de sécurité, ni une certification fiscale, ni une recette de tous les rôles. « Confirmé par lecture » signifie qu’un chemin de code est identifié ; « à reproduire » signifie que le scénario n’a pas encore été exécuté.

## 1. Utilisateurs et résultats à préserver

| Utilisateur           | Travail principal                                             | Preuve d’un parcours réussi                                                                 |
| --------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Accueil / secrétariat | Inscrire, placer, pointer les présences, encaisser            | Trouver la bonne action, voir le montant exigible, terminer sans connaître les identifiants |
| Responsable de centre | Traiter les urgences, définir les offres et suivre l’activité | Chaque indicateur conduit aux dossiers concernés                                            |
| Comptable             | Contrôler les pièces, paiements, caisse et rémunérations      | Soldes et corrections réconciliables, provenance conservée                                  |
| Client                | Choisir une offre, réserver, suivre ses paiements             | Prix, disponibilité et règles expliqués avant confirmation                                  |
| Consultant cible      | Configurer et importer un dossier client                      | Pack reproductible, simulation, recette, publication et retour de configuration             |

La volumétrie de production, l’équipe de maintenance, le budget et les temps de tâche réels ne sont pas mesurés dans cette recette. Ne pas dimensionner une architecture distribuée à partir de volumes supposés.

## 2. Constats et décisions prioritaires

### A01 — Période consommée et date d’exigibilité doivent être différentes

**Priorité P0 — correction livrée pour les nouvelles mensualités ; décision de prorata confirmée et implémentée sur `feat/enrolment-proration`.**

- Preuves : `domain/enrolmentSchedule.ts`, `domain/enrolmentChanges.ts`, migrations `0018` et `0019`, test `billing-schedules.test.ts`.
- Ancien raisonnement : une échéance future est annulable lors d’un abandon. Avec une mensualité payable le 31 octobre, un abandon le 20 octobre pouvait annuler le mois commencé.
- Correction : les nouvelles mensualités portent leur période de service ; le mois commencé reste dû, les périodes futures non touchées sont annulées ou transférées. Les données anciennes restent inchangées.
- Prorata : activé par défaut à la nouvelle inscription mensuelle. Un administrateur ou la personne qui a créé la fiche élève peut le décocher. Les forfaits et tranches personnalisées restent à leur montant convenu. Les anciennes échéances ne sont pas recalculées.
- Recette complémentaire : abandon le premier jour du mois, fin de groupe en milieu de mois, échéance reportée, mensualité partiellement réglée, acompte sur période future.

### A02 — Aperçu d’encaissement : contrôler le centre du payeur même sans sélection

**Priorité P0 — correction livrée et test de régression ajouté.**

- Preuves : `routes/payments.ts`, `domain/ledger.ts`, test `billing-schedules.test.ts`.
- Le contrôle des échéances sélectionnées revenait immédiatement quand la liste était vide. Le calcul du crédit identifie un payeur par son ID ; l’aperçu devait vérifier son appartenance au centre avant ce calcul.
- Correction : contrôle explicite du payeur, y compris sans échéance cochée, avant aperçu et création. Un identifiant d’un autre centre répond 404.
- Portée : correction de ce chemin. Ne pas en déduire que tous les endpoints sont exempts de risques d’isolation ; ajouter une matrice systématique de tests entre deux centres.

### A03 — Le plan et le compteur de disponibilités ne partagent pas tous leurs contrôles

**Priorité P1 — confirmé par lecture, scénario à reproduire.**

- Preuves : `domain/coworking/availability.ts`, fonctions `freeCounts`, `freeResources`, `floorState` ; `routes/coworking/bookings.ts` ; `pages/coworking/walkin.tsx`.
- Les compteurs de créneaux excluent une ressource liée à une salle utilisée via `room_bookings`. Le rendu de l’état d’étage consulte les réservations coworking et abonnements ; il ne consulte pas directement les occupations de salle hors coworking.
- Risque : une salle peut paraître libre sur le plan alors que le devis ou la réservation la refuse. Le nouveau sélecteur conserve le contrôle serveur final, mais ne supprime pas cette incohérence préexistante.
- Recette : lier une ressource coworking à une salle, y placer un cours ou une location, vérifier compteur, couleur, sélection, devis puis concurrence de deux réservations.
- Recommandation : partager le prédicat de disponibilité et conserver la protection PostgreSQL contre les conflits. Ne pas dupliquer les règles dans le front.

### A04 — Double soumission : verrouillage financier et idempotence répondent à deux problèmes

**Priorité P1 — absence de contrat d’idempotence HTTP repérée ; reproduction concurrente à compléter.**

- Preuves : `routes/payments.ts`, `domain/ledger.ts`, recherche des contrats d’idempotence dans l’API.
- Les écritures sont transactionnelles et le payeur est verrouillé. Cela protège les montants alloués. Deux requêtes légitimes distinctes peuvent toutefois créer deux paiements si le client réessaie après avoir perdu la première réponse.
- Recommandation : clé d’idempotence par centre et commande, empreinte du corps, résultat durable, réponse identique au rejeu, refus si même clé et corps différent. Appliquer aussi aux futurs documents, imports, écritures et mouvements de stock.
- Recette : double clic, deux requêtes simultanées, réponse perdue après commit, rejeu par n8n. Ne pas présenter la désactivation du bouton comme garantie serveur.

### A05 — Une proposition confirmée peut rester sans résultat après un arrêt

**Priorité P1 — confirmé par lecture ; déjà signalé dans la recette n8n.**

- Preuves : `domain/automations/proposals.ts`, `scheduler.ts`, migration `0017`.
- La décision est enregistrée avant l’exécution. Un arrêt entre ces étapes laisse une proposition confirmée sans résultat ; un run déjà inséré comme `running` est bloqué par son unicité lors du prochain passage.
- Recommandation : décision distincte de l’état d’exécution, bail de traitement, reprise des éléments interrompus et progrès par intervenant. Une action déjà appliquée doit être reconnaissable au rejeu.
- La paie n’est pas validée automatiquement : conserver cette séparation.

### A06 — Webhooks : livraison HTTP et exécution métier externe sont distinctes

**Priorité P1 — confirmé par lecture.**

- Preuves : `domain/webhooks.ts`, `audit.ts`, migration `0016`, guide n8n.
- La file transactionnelle, les signatures et les retries sont réutilisables. Une réponse 2xx marque la livraison ; elle ne prouve pas que les actions ultérieures de n8n sont réussies. Une interruption après réception peut entraîner un rejeu.
- Recommandation : déduplication durable sur l’identifiant d’événement, version du contrat, corrélation et suivi de l’exécution externe. Une signature valide ne remplace pas la déduplication.
- Aucun besoin démontré d’un second bus d’événements pour les premiers clients.

### A07 — L’échéancier opérationnel n’est pas encore un sous-livre comptable

**Priorité P0 pour la comptabilité cible — constat de périmètre, pas une régression UX.**

- Preuves : `domain/financialEvents.ts`, `domain/payrollCalc.ts`, `routes/enrolments.ts`, absence actuelle de moteur de journaux débit/crédit.
- Les échéances futures existent déjà en base et produisent des faits opérationnels à l’inscription. Les séparer à l’écran ne transforme pas ces faits en factures légales ou en revenu comptable reconnu.
- La base de paie « facturé » utilise actuellement le mois de `due_date`. Changer la date de règlement peut donc changer le mois de cette base. La période économique, la date de facture et le calendrier de paiement devront être distingués avant généralisation.
- Décision attendue : assiette de chaque règle de rémunération, rattachement des produits, acomptes, remises, retenues et annulations. Construire des exemples chiffrés acceptés par le responsable et le comptable.
- Les nouveaux reçus utilisent le total exigible via `payerTotals`. Les anciens snapshots restent immuables ; préciser les libellés et versionner le contrat de document pour l’ERP.

### A08 — La validation d’un compte, d’une réservation et d’une inscription pédagogique sont trois actions

**Priorité P1 produit — navigation corrigée, modèle à expliquer.**

- Preuves : `pages/coworking/requests.tsx`, `memberPicker.tsx`, endpoints de validation des membres, `routes/enrolments.ts`.
- La cloche et l’onglet des comptes en attente rendent la validation coworking visible. Cela ne crée pas d’inscription à une formation et ne confirme pas toutes les réservations du client.
- Recommandation : vocabulaire précis, filtres distincts, liens de dossier et notification de résultat. Mesurer si les utilisateurs comprennent l’étape suivante sans assistance.

### A09 — Paramétrable aujourd’hui ne signifie pas framework consultant déjà livré

**Priorité P1 architecture — confirmé par lecture.**

- Preuves : `auth/permissions.ts`, `db/types.ts`, `domain/automations/definitions.ts`, CLI modules.
- Les rôles, modules et tâches sont définis dans le code. Les menus sont filtrés ; les droits ne sont pas encore des profils personnalisés par dossier. La navigation seule ne constitue pas une isolation métier.
- Recommandation : registre de modules et paramètres typés, dépendances, périmètres, configurations versionnées ; ensuite packs et simulation. Livrer d’abord un pack Formation et un pack Coworking reproductibles.
- Éviter un système d’extensions arbitraires avant d’avoir deux besoins d’extension réels et une politique de compatibilité.

### A10 — Une seule organisation publique par déploiement

**Priorité P1 pour le SaaS multi-clients — limite explicite confirmée.**

- Preuve : `publicCentre.ts` refuse une surface publique quand plusieurs centres portent les modules publics.
- Décision de déploiement : installation séparée par client ou routage domaine → tenant vérifié. Ne pas promettre plusieurs sites clients avec le simple champ `centre_id` actuel.
- Recette future : domaines, sessions, médias, exports, jobs, sauvegardes et restauration d’un tenant sans effet sur un autre.

### A11 — Les notifications actuelles sont une file d’actions agrégées

**Priorité P2 — limite documentée et confirmée.**

- Preuves : `lib/action-queue.ts`, `components/notifications.tsx`, tests des événements de notification.
- Elles comparent catégories, compteurs et priorités par polling. Une arrivée et une résolution simultanées peuvent conserver le même compteur et ne pas déclencher un pop-up individuel.
- Recommandation : conserver ce mécanisme pour le tableau de bord ; n’ajouter une boîte de réception durable par événement que si le produit exige accusés de lecture, affectation et historique.
- Ne pas rendre toutes les dettes anciennes urgentes de façon permanente sans discuter seuils, ancienneté et responsable : risque de banaliser le rouge.

### A12 — L’accessibilité reste une recette à élargir

**Priorité P1 UX — inspection partielle réalisée.**

- Vérifié : navigation clavier sur les places du plan, zoom, Échap de la vue agrandie sans fermer l’assistant, tiroir d’encaissement et formats mobiles déjà documentés.
- À compléter : focus piégé et restitué sur tous les anciens composants modaux, lecteur d’écran, contrastes, erreurs de formulaire et rôles autres qu’Admin. La fenêtre agrandie du plan utilise un dialogue natif ; les anciens modaux ne le font pas tous.
- Ne pas annoncer une conformité WCAG sur la seule base des contrôles de types ou des tests de logique.

## 3. Registre des décisions métier validées

Le porteur du projet a donné son GO pour R01 à R09, avec précision sur R02 et confirmation explicite de R04. Une décision validée fixe le comportement cible ; les actions de recette et les chantiers de conception restent identifiés séparément.

| ID  | Décision validée                                                                                                                                                      | État et suite                                                                                                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| R01 | Le client choisit début ou fin de mois parmi les formules proposées ; l’accueil enregistre le choix à l’inscription.                                                  | Disponible dans la démo Maths Bac.                                                                                                               |
| R02 | Prorata par défaut pour les périodes mensuelles partielles. Un administrateur ou la personne qui a créé la fiche élève peut décocher l’option pour cette inscription. | Implémenté sur `feat/enrolment-proration` : jours calendaires couverts, arrondi au millime, choix conservé.                                      |
| R03 | À l’abandon, la période commencée reste due au montant de l’échéancier signé ; les périodes futures intactes sont annulées.                                           | Conserver la distinction période de service / exigibilité et vérifier les limites de dates en recette.                                           |
| R04 | Aucune restitution automatique et aucun paiement supprimé pour les avances et mensualités déjà partiellement réglées.                                                 | Confirmé et couvert par un test d’abandon avec avance. L’avoir ou remboursement reste une action dédiée avec droits et audit.                    |
| R05 | La formule explicite prime ; sans prix propre à la formule, le tarif effectif du groupe sert de référence.                                                            | Continuer à montrer la source du prix dans la recette commerciale.                                                                               |
| R06 | L’assiette de rémunération doit préciser par règle si la période suit facture, service ou exigibilité.                                                                | Principe validé. Le mode historique « facturé » utilise toujours la date d’exigibilité ; implémentation à traiter avec le lot paie/comptabilité. |
| R07 | Échéance réellement en retard, expiration proche et incident opérationnel peuvent mériter une alerte immédiate.                                                       | Principe validé. Calibrer seuils, responsables et répétition sur l’usage réel.                                                                   |
| R08 | Validation métier, facturation, livraison et règlement ont des états distincts.                                                                                       | Principe validé pour les nouveaux documents. Définir transitions, corrections et droits dans le lot commercial.                                  |
| R09 | Séparer tenant, société juridique et établissement.                                                                                                                   | Principe validé pour le socle ; le premier dossier pilote doit définir les entités, droits et domaines réels.                                    |

## 4. Plan de recette métier

Chaque scénario devra indiquer données initiales, action, montant ou état attendu, événements produits et résultat après rejeu. Les cas non exécutés ne deviennent pas « OK » par lecture.

| Domaine                  | Scénarios indispensables avant pilote ERP                                                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Formation / cours        | Début et fin de mois, jour 31, année bissextile, date d’inscription partielle, tarif figé, changement de formule, groupe complet, transfert, abandon, séance corrigée   |
| Encaissement             | Dû / futur / crédit, paiement partiel et anticipé, remise, chèque rejeté, annulation motivée, remboursement, idempotence et isolation de centre                         |
| Rémunération             | Plusieurs règles, précision de règle, base mensuelle et service, correction de présence après calcul, validation individuelle, règlement partiel, retenue et annulation |
| Coworking                | Plan et créneau cohérents, salle partagée avec cours/location, buffer, abonnement affecté, quotas, demande expirée, no-show, changement de place, annulation payée      |
| Caisse / banque          | Journée ouverte, clôture, écart, réouverture contrôlée, encaissement reçu pendant clôture, chèque reçu / encaissé / rejeté                                              |
| Documents commerciaux    | Devis → commande → livraison → facture partielle, avoir, retour, arrondis, taxes, retenue, séquence et annulation                                                       |
| Stock                    | Une livraison liée à sa facture ne sort le stock qu’une fois ; retours partiels, transfert, inventaire, stock réservé, concurrence et valorisation                      |
| Automatisations          | Confirmation avec droits, montant relu, interruption après décision, reprise, déduplication des e-mails et résultats partiels                                           |
| Intégrations             | Signature, révocation, droits, ordre inversé des événements, rediffusion, corps/version inconnus, réponse perdue et panne de n8n                                        |
| Isolation / exploitation | Deux tenants, domaine public, document exporté, import annulé, restauration, médias, sauvegarde et absence de secrets dans Git                                          |

## 5. Complexité et garde-fous produit

Appréciation qualitative du code parcouru : complexité globalement justifiée par les métiers. Aucune mesure sérieuse de « dette en heures par mois » n’est disponible ; ne pas fabriquer ce chiffre. L’objectif est de garder des frontières simples et testables.

| Décision         | Recommandation                                    | Signal de réexamen                                                                        |
| ---------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Architecture     | Monolithe modulaire PostgreSQL existant           | Mesure démontrant un besoin de déploiement ou de capacité indépendant                     |
| Moteur de règles | Paramètres typés et conditions limitées           | Deux dossiers réels nécessitent une règle nouvelle ; cas et effets précisément documentés |
| SDK / plugins    | Contrats API, événements et packs en premier      | Consultant externe réellement bloqué par une extension validée                            |
| UI               | Espaces métier et parcours courts                 | Temps ou taux d’erreur supérieur au parcours précédent lors d’une recette observée        |
| Notifications    | Actions utiles et dédupliquées                    | Alertes répétées ignorées ou actions urgentes difficiles à distinguer                     |
| IA               | Lecture et préparation sous les mêmes permissions | Usage concret mesuré ; aucune action financière hors des circuits validés                 |

Un incident d’isolation ou une incohérence de solde bloque la mise en production du périmètre concerné. Il ne justifie pas la suppression automatique de données ni l’arrêt aveugle de tous les modules. Responsable produit, référent comptable, responsable de recette et budget du pilote restent à désigner ; ne pas inventer leurs identités.

## 6. Prochain lot recommandé

1. Faire relire la branche et ses migrations par l’agent développeur à l’aide de la passation ; résoudre A03 ou accepter explicitement la limite du pilote.
2. Transformer les décisions R01–R09 validées en cas de recette chiffrés ; documenter le vocabulaire financier et la sémantique du mode de paie historique.
3. Écrire les scénarios d’idempotence et de reprise A04 à A06, puis les implémenter par petits lots.
4. Spécifier les frontières Tenant / Société / Établissement / Contact et un premier pack Formation ou Coworking.
5. Démarrer la tranche commerciale Services : devis → facture → paiement → correction, avec base fiscale cadrée dès la conception.

La [roadmap produit](roadmap-mini-erp.md) donne le séquencement complet et les conditions de sortie. Le développement des nouveaux modules ERP n’est pas engagé par cet audit initial.
