# Passation développeur — branche UX, facturation et accueil coworking

Date : 10 novembre 2026. Destinataire : agent développeur chargé de diagnostiquer les changements et de préparer le merge. Ce document est le point d’entrée ; aucune fusion ni publication n’est effectuée par sa création.

## 1. Versions et périmètre

- Worktree : `C:/Users/haith/OneDrive/Bureau/GCF/gcf-n8n-review`.
- Branche de travail actuelle : `feat/billing-schedules`.
- Base fonctionnelle de la refonte : `82220bb` (`test/n8n-automations`), intégrations et automatisations incluses.
- Branche UX précédente : `feat/ux-launchpad`. Ses trois commits sont ancêtres de la branche actuelle :
  - `fff0ef1` : navigation, espaces, raccourcis, vocabulaire et première version du zoom ;
  - `fd1ca71` : zoom corrigé, déplacement et vue agrandie ;
  - `2bbc0d2` : tableau de bord, notifications, validation des comptes et pied du tiroir d’encaissement.
- Les changements de facturation, sélection sur plan et les documents de passation sont ajoutés après `2bbc0d2` ; voir `git log` et les inventaires en fin de document pour les commits finaux.
- Le checkout `C:/Users/haith/OneDrive/Bureau/GCF/gcf` et son `main` restent séparés. Aucun merge, push, reset ou remplacement de ce checkout n’est inclus.
- Les fonctionnalités n8n et automatisations proviennent de la base. Elles ne sont pas réécrites dans cette refonte. Leur bilan historique est dans [validation-n8n-automatisations.md](validation-n8n-automatisations.md).

Ce dossier couvre tous les changements locaux de la refonte depuis `82220bb`, pas seulement le nom de la branche courante. Ne pas prendre une différence contre `main` pour la seule refonte : elle contient aussi les PR d’intégration héritées.

## 2. Navigation et vocabulaire

**But :** réduire la longueur du menu et rendre les tâches quotidiennes accessibles sans connaître l’arborescence.

- Menu principal : Tableau de bord, Mes raccourcis, Formation et cours, Coworking, Finances, Site web, À traiter ; Paramètres en bas.
- Espaces métier présentant actions courantes et référentiels ; navigation contextuelle dans leurs pages.
- Raccourcis personnalisables et recherche d’actions. Stockage local par identifiant utilisateur ; pas de synchronisation entre appareils.
- Menu compact et mobile, lien d’évitement, focus visible.
- « Intervenant » devient « Prof / Formateur » dans les libellés concernés. Les identifiants, routes et paramètres techniques existants sont conservés.
- Filtres de menu et gardes de routes basés sur les permissions existantes ; aucune nouvelle permission ni modification de la matrice des rôles.

Fichiers de référence : `lib/navigation.ts`, `pages/launchpad.tsx`, `components/shell.tsx`, `styles/workspace.css`, `lib/labels.ts`, et les écrans portant les libellés. Le détail historique est dans [refonte-navigation-ux.md](refonte-navigation-ux.md).

## 3. Tableau de bord, comptes en attente et notifications

- `/` est le tableau de bord opérationnel ; `/tableau-de-bord` redirige vers `/`. Les raccourcis sont à `/raccourcis`.
- KPI réellement alimentés, priorités filtrables, programme réunissant cours, locations et réservations, graphique des encaissements.
- `lib/action-queue.ts` centralise les requêtes et catégories selon les droits. Les caches React Query sont partagés.
- Cloche avec compteur ; rouge pour une urgence. Pop-up pour une nouvelle action ou montée de priorité, sans avalanche au premier chargement, sans répétition sur un polling identique, sans son.
- Un seul pop-up, 12 secondes avec pause au focus / survol, différé si dialogue ouvert ou onglet masqué ; respect de la réduction des animations.
- Il s’agit d’actions agrégées en attente, pas d’une boîte de réception exhaustive avec accusé de lecture. Le nombre de messages du site est plafonné et signalé avec « + ».
- `/coworking/demandes?type=comptes` affiche les comptes en attente et la validation existante. L’onglet Réservations conserve ses actions distinctes.
- La validation d’un compte utilise les contrôles et l’audit existants ; ce n’est pas la validation d’une inscription pédagogique ni celle de toutes ses réservations.

Voir [notifications-inscriptions-dashboard.md](notifications-inscriptions-dashboard.md) et `apps/web/test/notification-events.test.ts`.

## 4. Plan coworking et zoom

Composant partagé de consultation : `components/zoomable-floor-plan.tsx`.

- 100 % = vue d’ensemble ajustée ; plage 50–400 %, pas de 25 points.
- Hauteur stable ; le zoom conserve le centre regardé, sans redimensionner la page.
- Déplacement à la souris, défilement tactile et flèches ; un glissement n’active pas une place.
- Vue agrandie dans un dialogue natif, fermeture Échap, retour de focus ; sélectionner une ressource ouvre son parcours normal.
- Changement d’étage réinitialise la vue ; rafraîchissement des états conserve le zoom.
- Coordonnées, plans enregistrés et éditeur ne sont pas transformés par le zoom.

Une première implémentation trop dépendante de la position dans la page a été remplacée dans `fd1ca71`. Relire le résultat final, pas seulement le premier commit.

## 5. Accueil coworking : choisir depuis le plan

**Demande de la capture utilisateur :** remplacer les boutons D-01, D-02… par la sélection spatiale.

Fichier : `pages/coworking/walkin.tsx`.

- Étapes Client → Place → Prix → Paiement conservées.
- Type, format, durée éventuelle et créneau du jour restent sélectionnables.
- Les disponibilités d’étages sont relues pour le créneau entier, avec actualisation toutes les 30 secondes.
- Onglets d’étage avec compteur ; dessin du plan, zones et image existantes ; zoom et vue agrandie réutilisés.
- Les places libres du type choisi sont des boutons accessibles. Autres types, places occupées, bloquées ou hors service restent du contexte non sélectionnable.
- Un clic ou Entrée sur la place passe au devis prérempli avec la bonne ressource, le format et l’heure.
- Plan manquant ou places non positionnées : message de configuration, pas de substitution silencieuse par une liste de codes.
- Pendant le rafraîchissement, la sélection attend les disponibilités à jour. Le devis et la réservation contrôlent toujours le choix côté serveur.
- Échap dans la vue agrandie ne ferme plus le parent : ajustement de `useEscape` dans `components/ui.tsx` et du dialogue du composant de zoom.

**Limite à revoir :** le prédicat de `floorState` ne couvre pas directement toutes les occupations externes d’une salle partagée. Voir A03 dans l’audit. Le sélecteur visuel n’a pas réécrit ce domaine serveur.

Recette navigateur : les deux étages sont affichés ; D-10 occupé n’est pas sélectionnable ; Entrée sur D-01 mène au devis de D-01 ; Échap ferme uniquement la vue agrandie. Aucune réservation ni arrivée n’a été soumise par l’agent dans ce parcours.

## 6. Encaissement : exigible, futur et crédit

### 6.1 Lien des impayés

Les actions « Voir les impayés » du tableau de bord et de la cloche utilisent `/encaissements?onglet=impayes`.

La page Encaissements conserve son journal Paiements et ajoute l’onglet Impayés. Celui-ci charge `GET /api/payments/overdue`, paginé et filtré sur les échéances ouvertes non soldées, après le délai de grâce du centre. Il couvre élèves, locataires et clients coworking, sous `payments:read` ; le bouton Encaisser dépend de `payments:write`.

### 6.2 Totaux

`payerTotals` / `studentTotals` retournent désormais :

| Champ              | Sens                                                                |
| ------------------ | ------------------------------------------------------------------- |
| `due`              | Reste des charges ouvertes dont `dueDate <= asOf`                   |
| `future`           | Reste des charges ouvertes dont `dueDate > asOf`                    |
| `totalRemaining`   | `due + future`                                                      |
| `asOf`             | Date locale du centre, calculée côté serveur                        |
| `credit`           | Argent reçu non affecté, selon le grand livre opérationnel existant |
| `pendingDiscounts` | Remises restant à approuver                                         |

La liste des élèves utilise également le montant exigible. Les vues de compte concernées indiquent « Exigible aujourd’hui » et une projection à venir. La modification du sens de `due` touche tous les consommateurs de `payerTotals`, y compris locations et portail : relire ces écrans lors de la recette de merge.

Dans le tiroir d’encaissement : échéances exigibles séparées, échéancier prévisionnel repliable, règlement anticipé possible et expliqué dans l’aperçu. L’aperçu soustrait séparément les imputations actuelles et futures pour éviter un dû négatif en cas d’anticipation.

Les allocations automatiques existantes sont conservées. Un montant supérieur à l’exigible peut régler des échéances futures ; l’avertissement et l’aperçu le montrent. Ce n’est pas un nouveau mécanisme « ne payer que la sélection » : les cases restent des priorités d’imputation.

### 6.3 Tiroir et contrôle du payeur

Le pied du tiroir reste visible en Grand texte et sur petit écran ; le corps défile. Validation, impression et envoi restent accessibles, avec une explication quand le bouton est désactivé.

Un contrôle du centre du payeur a été ajouté avant le calcul de l’aperçu, même sans échéance sélectionnée. Sans cela, la lecture du crédit n’était pas précédée de ce contrôle dans ce chemin. Un test de régression utilise un second centre et vérifie une réponse 404 sans solde divulgué.

Aucune règle d’autorisation financière n’a été étendue.

## 7. Formules proposées au client

Les formations et les cours particuliers peuvent avoir leurs propres formules. La configuration est réservée à `catalogue:write` ; l’accueil choisit une formule autorisée à l’inscription.

- Paiement intégral : prix propre ou prix de la formation ; pour un cours, prix de forfait explicite obligatoire.
- Échéancier personnalisé : tranches en montant ou pourcentage, date fixe ou délai après inscription ; contrôle du total.
- Mensuel : début de mois, fin de mois, anniversaire ou jour personnalisé (1–31, ramené au dernier jour des mois courts).
- À la séance : prix et règle d’absence copiés à l’inscription ; échéance produite par la présence validée.
- Délai supplémentaire configurable pour les formules appropriées ; une tranche personnalisée porte sa propre date.

Le choix demandé par l’utilisateur est bien **début ET fin de mois disponibles au client**, pas une valeur globale imposée à tout le centre.

L’écran Formules de paiement est accessible depuis chaque cours particulier ; les formations réutilisent leur écran existant. L’assistant d’inscription propose les formules actives, présélectionne celle par défaut et montre l’échéancier avant confirmation.

Un cours sans formule conserve son mode historique. Dès que des formules actives existent, une nouvelle inscription doit en choisir une ; l’API refuse de contourner ce choix en envoyant seulement un mode.

### Règles de calendrier à connaître

- Une mensualité de fin de mois devient exigible le dernier jour du mois de service ; le dernier mois partiel est inclus.
- Le premier paiement de début de mois n’est pas antidaté avant le début de l’inscription.
- Les mois partiels ne sont pas proratisés automatiquement dans cette branche.
- Les échéances, prix à la séance et délais existants ne sont pas recalculés lors d’une modification de formule.
- Les nouvelles mensualités portent une période de service distincte de la date d’exigibilité. À l’abandon / transfert, la période commencée est conservée ; les périodes futures intactes suivent les règles existantes d’annulation / transfert.
- Les échéances déjà touchées par paiement ou remise et les données historiques restent protégées. Pas de remboursement automatique.
- Le transfert conserve les conditions de formule. Le recalcul au tarif du nouveau groupe reste réservé aux inscriptions mensuelles historiques sans formule ; l’interface et l’API le reflètent.

Les décisions à confirmer et les limites sont détaillées dans l’audit, registre R01–R09.

## 8. Migrations et effet sur les données

### `0018_billing_schedules`

- Propriétaire de formule : formation ou cours particulier, exactement un des deux.
- `training_id` nullable, ajout de `study_id`, FK et unicité de la formule active par défaut d’un cours.
- Calendrier mensuel, jour éventuel et délai supplémentaire sur formules et inscriptions.
- Prix explicite possible sur un échéancier de forfait.
- Valeurs de compatibilité : anniversaire et délai nul pour les enregistrements existants.

### `0019_service_periods`

- Début et fin de période de service optionnels sur les échéances, avec contrainte de cohérence.
- Renseignés pour les nouvelles mensualités ; pas de reconstitution supposée pour les anciennes.

Ces migrations ajoutent les colonnes et contraintes ; elles ne réécrivent ni paiements, ni reçus, ni échéances déjà datées. Avant merge, vérifier la numérotation des migrations dans la vraie branche cible : un éventuel autre `0018` ou `0019` doit être traité explicitement, sans modifier une migration déjà utilisée en production.

### Environnement local

| Usage                   | Adresse / base                               |
| ----------------------- | -------------------------------------------- |
| UI de revue Vite        | `http://localhost:3010`                      |
| API de revue            | `http://127.0.0.1:3012`                      |
| Base de revue           | `gcf_pr12_review`                            |
| Base jetable des tests  | `gcf_pr12_test`                              |
| Démo habituelle séparée | `http://localhost:3000`, `gcf_demo_20261107` |
| n8n local existant      | `http://localhost:5678`                      |

PostgreSQL 16 dans `gcf-postgres`, port hôte 55432. Les variables et secrets restent dans les fichiers ignorés, non reproduits ici.

Sauvegarde avant migration : `C:/Users/haith/OneDrive/Bureau/GCF/review-ux/gcf-before-billing-20261110.dump`, archive custom PostgreSQL vérifiée avec `pg_restore --list`. Les migrations sont appliquées sur la base de revue uniquement. Ne pas restaurer cette archive par-dessus une autre base sans contrôle du nom et de la perte éventuelle de données plus récentes.

`createHarness` détruit et recrée le schéma public : `TEST_DATABASE_URL` doit impérativement viser une base jetable. Ne jamais le pointer sur la revue ou la démo habituelle.

### Données ajoutées pour la recette

- Deux comptes fictifs de notifications, déjà documentés : `test-inscription-ux-20261110@example.test` et `test-alerte-ux-20261110@example.test`. Aucune validation de compte n’a été soumise par l’agent ; l’utilisateur peut avoir traité le premier entre-temps.
- Deux formules sur Maths Bac dans la seule base de revue : « Mensuel — début du mois » et « Mensuel — fin du mois », 80 TND/mois, délai nul. La première est proposée par défaut, les deux restent sélectionnables à l’inscription.
- Aucune inscription existante ne change de formule. Le seed n’est pas relancé, les enregistrements existants ne sont ni dupliqués ni renommés par ce lot.
- Les opérations de réservation et d’encaissement créées par l’utilisateur pendant sa recette sont conservées. L’agent n’a pas soumis de paiement, de réservation ou de check-in dans les essais UI décrits ici.
- Les fixtures des tests automatiques, y compris leurs paiements, vivent exclusivement dans la base jetable.

## 9. Vérifications et portée

Les résultats exacts de la dernière exécution sont ajoutés en fin de document. Commandes utilisées :

```powershell
pnpm -r typecheck
pnpm --filter @gcf/shared test
# Avec TEST_DATABASE_URL visant uniquement gcf_pr12_test :
pnpm --filter @gcf/api exec vitest run
pnpm --filter @gcf/api exec tsx --test ../web/test/notification-events.test.ts
pnpm --filter @gcf/web build
pnpm --filter @gcf/portal build
```

Le formatage est contrôlé sur les fichiers modifiés compatibles Prettier ; les SQL ne sont pas traités par un parseur non installé. Le contrôle global historique signalait des différences de fins de ligne sur des fichiers non modifiés : aucune normalisation massive n’est effectuée.

Recette UI : navigation et raccourcis ; compteur et pop-up différé ; comptes à valider ; bouton d’encaissement ; impayés ouverts sur le bon onglet ; 140 TND exigibles et 240 TND futurs séparés sur le compte démo observé ; aperçu d’un paiement anticipé non soumis ; configuration des deux formules mensuelles ; choix d’une place sur chacun des deux plans et passage au devis correct.

Les parcours sont essayés avec Admin. Les permissions API ont des tests ; une recette navigateur exhaustive Secrétariat / Comptable / Éditeur reste à effectuer. L’envoi SMTP réel, la conformité fiscale, la reprise sur panne de toutes les automations et un audit complet d’accessibilité ne sont pas annoncés comme validés.

Captures locales, non incluses dans Git : `C:/Users/haith/OneDrive/Bureau/GCF/review-ux/`, notamment `accueil-coworking-choix-plan.jpg`. Ne pas joindre des sauvegardes, `.env` ou données personnelles à une PR publique.

## 10. Dossier roadmap et audit

- [Audit métier et produit du 10 novembre](audit-metier-produit-2026-11-10.md) : constats sourcés, corrections livrées, scénarios encore à exécuter, décisions métier et priorités.
- [Roadmap mini-ERP v1.2](roadmap-mini-erp.md) : copie reprise du document de cadrage local, enrichie en section 19 avec compatibilité, lots ERP-00 à ERP-10, packs consultant, matrice Finco et conditions de sortie.
- [Validation n8n du 7 novembre](validation-n8n-automatisations.md) : document historique copié pour conserver les liens et le contexte. Ses chiffres, versions et états de PR sont datés, pas réaffirmés comme état GitHub courant.

Le nouveau chantier ne consiste pas à commencer simultanément tous les modules : audit des invariants, fiabilité, organisation et premiers packs avant généralisation commerciale et comptable. Aucun nouveau module ERP n’est implémenté par ces documents.

## 11. Revue avant merge par l’agent développeur

1. Lire ce document, l’audit puis le diff complet depuis `82220bb`. Identifier séparément les PR n8n héritées.
2. Vérifier la vraie base GitHub et les éventuelles migrations concurrentes. Ne pas supposer que `main` local décrit son dernier état distant.
3. Relire la modification sémantique de `due` dans tous les appels, API, reçus et écrans ; distinguer exigibilité et revenu.
4. Examiner les cas de prorata, abandon, transfert, échéances touchées et prix explicite des forfaits ; arbitrer les règles ouvertes.
5. Exécuter les tests sur PostgreSQL jetable, puis migrer une copie de la base cible et réconcilier les montants avant/après.
6. Vérifier les disponibilités des salles partagées et les rôles en UI. Traiter A03 avant une promesse de disponibilité universelle.
7. Vérifier absence de secrets, de dumps et de modifications de `.env` dans le commit.
8. Préparer une PR avec les migrations et changements de contrat visibles. La décision de fusion et le déploiement ne font pas partie des actions automatiques de cette passation.

### Prompt prêt à transmettre à Claude Code

> Lis `docs/passation-branche-ux-facturation.md`, `docs/audit-metier-produit-2026-11-10.md` et `docs/roadmap-mini-erp.md`. Examine `feat/billing-schedules`, y compris les trois commits UX ancêtres après `82220bb`, sans confondre la refonte avec les PR n8n déjà héritées. Vérifie la branche cible réelle, les collisions de migrations, les contrats `due/future/totalRemaining/asOf`, l’isolation du payeur, le calendrier choisi à l’inscription, les périodes de service lors d’un abandon/transfert et la sélection sur plan coworking. Reproduis les scénarios critiques sur une base jetable, indique ce qui est vérifié et ce qui reste une hypothèse, puis propose les corrections et la PR de merge avec une recette explicite. Préserve les paiements, pièces et relations historiques ; aucun écrasement de base ou reset destructif. Après stabilisation, utilise les lots ERP-00 à ERP-10 comme backlog de cadrage et fais arbitrer les règles métier ouvertes avant les nouvelles abstractions.

## 12. Résultats finaux et inventaire de revue

Dernier contrôle du 10 novembre 2026 : **239 tests API sur PostgreSQL 16 (22 fichiers), 37 tests partagés et 8 tests de notifications réussis**, soit 284 tests sur ces trois ensembles. Typage de tous les packages, compilation du back-office et du portail, formatage des fichiers modifiés et `git diff --check` réussis. Les compilations signalent la taille de certains bundles ; ce warning n’est pas traité par ce lot.

Les premiers passages comptaient 237 puis 238 tests API avant les tests de périodes de service et d’isolation ajoutés ; seul le dernier passage décrit l’état final.

L’inventaire ci-dessous couvre le diff depuis `82220bb` et les nouveaux fichiers de ce lot. Les statuts définitifs sont à vérifier avec `git status` et `git diff 82220bb...HEAD`. Aucun fichier local de secret, capture ou sauvegarde n’est inclus.

### API : schéma, domaines, routes et tests

- `apps/api/src/db/migrations/0018_billing_schedules.sql`
- `apps/api/src/db/migrations/0019_service_periods.sql`
- `apps/api/src/db/types.ts`
- `apps/api/src/domain/attendance.ts`
- `apps/api/src/domain/enrolmentChanges.ts`
- `apps/api/src/domain/enrolmentSchedule.ts`
- `apps/api/src/domain/ledger.ts`
- `apps/api/src/routes/catalogue.ts`
- `apps/api/src/routes/enrolments.ts`
- `apps/api/src/routes/payments.ts`
- `apps/api/src/routes/students.ts`
- `apps/api/test/billing-schedules.test.ts`
- `apps/api/test/coworking-members.test.ts`
- `apps/api/test/extras.test.ts`
- `apps/api/test/payments.test.ts`
- `apps/api/test/rentals.test.ts`

### Back-office : navigation, composants, écrans, styles et tests

- `apps/web/src/App.tsx`
- `apps/web/src/api/types.ts`
- `apps/web/src/components/nav-icon.tsx`
- `apps/web/src/components/notifications.tsx`
- `apps/web/src/components/shell.tsx`
- `apps/web/src/components/ui.tsx`
- `apps/web/src/components/zoomable-floor-plan.tsx`
- `apps/web/src/lib/action-queue.ts`
- `apps/web/src/lib/dashboard.ts`
- `apps/web/src/lib/errors.ts`
- `apps/web/src/lib/formulas.ts`
- `apps/web/src/lib/navigation.ts`
- `apps/web/src/lib/notification-events.ts`
- `apps/web/src/main.tsx`
- `apps/web/src/pages/attendance.tsx`
- `apps/web/src/pages/automations.tsx`
- `apps/web/src/pages/catalogue.tsx`
- `apps/web/src/pages/collect.tsx`
- `apps/web/src/pages/coworking/live.tsx`
- `apps/web/src/pages/coworking/member.tsx`
- `apps/web/src/pages/coworking/pending-signups.tsx`
- `apps/web/src/pages/coworking/requests.tsx`
- `apps/web/src/pages/coworking/walkin.tsx`
- `apps/web/src/pages/dashboard.tsx`
- `apps/web/src/pages/enrolment.tsx`
- `apps/web/src/pages/groups.tsx`
- `apps/web/src/pages/instructors.tsx`
- `apps/web/src/pages/launchpad.tsx`
- `apps/web/src/pages/payments.tsx`
- `apps/web/src/pages/payroll.tsx`
- `apps/web/src/pages/planning.tsx`
- `apps/web/src/pages/proposals.tsx`
- `apps/web/src/pages/student.tsx`
- `apps/web/src/pages/students.tsx`
- `apps/web/src/styles/layout.css`
- `apps/web/src/styles/operations.css`
- `apps/web/src/styles/workspace.css`
- `apps/web/test/notification-events.test.ts`

### Calculs partagés

- `packages/shared/src/billingSchedule.test.ts`
- `packages/shared/src/schedule.ts`

### Documentation

- `docs/audit-metier-produit-2026-11-10.md`
- `docs/notifications-inscriptions-dashboard.md`
- `docs/passation-branche-ux-facturation.md`
- `docs/refonte-navigation-ux.md`
- `docs/roadmap-mini-erp.md`
- `docs/validation-n8n-automatisations.md`

## 13. Référence finale de code et dernière recette UI

Le commit applicatif de ce lot est **`7f8ed5f` — Configure billing schedules and select walk-in seats on floor plans**, sur `feat/billing-schedules`. Les trois commits UX ancêtres restent `fff0ef1`, `fd1ca71` et `2bbc0d2`. Le commit de documentation suivant contient cette passation, l’audit et la roadmap ; consulter `git log` pour son identifiant.

Dernier parcours navigateur : choix du dossier de démonstration Hamza Feki, Maths Bac A, effet au 10 novembre 2026. Les deux formules sont proposées ; choisir fin de mois produit les dates 30/11/2026, 31/12/2026, 31/01/2027 et 28/02/2027, marquées prévisionnelles à la date de la recette. Le résumé indique la formule choisie et 320 TND pour l’échéancier complet. Le bouton final d’inscription n’a pas été actionné.

Captures supplémentaires : `formules-debut-fin-mois.jpg`, `inscription-choix-formule.jpg` et `inscription-echeances-fin-mois.jpg` dans le dossier local de recette. Elles illustrent la configuration et l’aperçu, sans créer de nouvelle dette dans la base de revue.

Aucun push ni merge n’a été effectué. Le code de revue tourne sur 3010 / 3012 ; les migrations locales `0018` et `0019` sont appliquées uniquement sur sa base dédiée. Les sources, secrets et données du poste ne sont pas transmis à Claude ou à un service externe par cette passation : l’utilisateur choisit les documents et la branche à lui présenter.
