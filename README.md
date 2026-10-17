# GCF : gestion de centre de formation

Back-office d'un centre de formation et de cours particuliers : élèves, groupes, présences, encaissements et reçus,
paie des intervenants, location de salles, planning, caisse et rapports.

L'application se vend par modules, activés centre par centre :

| Module      | Contenu                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| `training`  | Le back-office de formation ci-dessus (activé par défaut)                                                                 |
| `coworking` | Espaces, plan interactif, formules et tarifs, réservations, abonnements, packs, domiciliation, portail client `/espace`   |
| `website`   | Site public bilingue (français, anglais) : pages en sections, thème, médiathèque, publication programmée, demandes reçues |

Chaque permission appartient à un module : l'API refuse et le menu masque ce qui relève d'un module non activé. Les
modules sont activés par l'éditeur du logiciel, pas depuis le back-office :

```bash
pnpm --filter @gcf/api modules                              # liste les centres et leurs modules
pnpm --filter @gcf/api modules -- --enable coworking        # ou --disable website ; --centre <id> si plusieurs centres
```

Rôles du personnel : Admin, Secrétariat, Comptable, Éditeur (site web). Les clients du coworking ont leur propre compte,
distinct des comptes du personnel, dans le portail client.

## Stack

| Couche         | Choix                                                     | Raison                                                                   |
| -------------- | --------------------------------------------------------- | ------------------------------------------------------------------------ |
| Langage        | TypeScript (strict) sur Node.js 22                        | Un seul langage du serveur à l'interface, types partagés                 |
| API            | Fastify 5                                                 | Rapide, validation et hooks explicites                                   |
| Base           | PostgreSQL 16                                             | Transactions, contraintes et triggers pour l'intégrité financière        |
| Accès base     | Kysely + migrations SQL versionnées                       | Requêtes typées, SQL lisible et revu tel quel                            |
| Validation     | Zod 4                                                     | Les mêmes schémas côté serveur et client                                 |
| Mots de passe  | Argon2id                                                  | Recommandation OWASP actuelle                                            |
| Tests          | Vitest, tests d'intégration sur une vraie base PostgreSQL | Aucune base simulée pour les règles métier                               |
| PDF et exports | PDFKit, ExcelJS                                           | Reçus, bulletins, feuilles de présence, contrats, rapports Excel/CSV/PDF |
| Interface      | React 19, React Router 7, TanStack Query 5, Vite 8        | Écrans d'après les maquettes validées, police IBM Plex Sans embarquée    |

## Règles d'implémentation

- Montants en entiers de la plus petite unité (millimes pour le TND, 3 décimales). Aucun flottant.
- Arrondi unique, au demi supérieur, au moment où un taux s'applique à un montant (`packages/shared/src/money.ts`).
- Aucune suppression financière ou d'élève : archivage, annulation ou contre-passation, avec motif et trace.
- Journal d'audit en ajout seul, garanti par un trigger PostgreSQL (UPDATE, DELETE et TRUNCATE refusés).
- `centre_id` sur chaque table métier.
- Sessions côté serveur : cookie `HttpOnly`, `Secure`, `SameSite=Strict`, expiration d'inactivité et absolue,
  vérification de l'en-tête `Origin` sur toute requête qui modifie des données.

## Structure

```
apps/api            API Fastify (routes, authentification, migrations SQL, PDF et exports)
apps/web            Back-office (React), servi par l'API en production
apps/portal         Portail client du coworking (React, français et anglais), servi sous /espace/ sur PUBLIC_ORIGIN
packages/shared     Règles métier pures et testées : argent, présence, paie, dates, échéanciers, plan d'étage, sections du site
packages/floorplan  Affichage du plan d'étage (SVG), partagé par le back-office et le portail
docs/               Décisions validées avec le client et points encore ouverts
```

## Démarrage

Prérequis : Node.js 22+, pnpm 10, PostgreSQL 16.

```bash
pnpm install
cp apps/api/.env.example apps/api/.env      # renseigner DATABASE_URL et WEB_ORIGIN
pnpm --filter @gcf/api migrate
pnpm --filter @gcf/api bootstrap -- --centre "Nom du centre" --email admin@centre.tn --name "Prénom Nom"
pnpm --filter @gcf/api dev                  # API sur le port 3000
pnpm --filter @gcf/web dev                  # interface sur http://localhost:5173 (proxy /api vers l'API)
pnpm --filter @gcf/portal dev               # portail client sur http://localhost:5174/espace/ (coworking)
```

Pour une démonstration, `pnpm --filter @gcf/api seed:demo -- --email admin@centre.tn` remplit un centre vide, module
par module (activer les modules avant) :

- formation : salles, intervenants, cours particuliers, formations avec plusieurs formules, groupes et séances,
  inscriptions, présences, encaissements, règles de rémunération et éléments de paie à chaque étape ; les dates
  partent du premier jour du mois précédent ;
- coworking : règles, un étage avec son plan publié, postes, salles de réunion, cabine et bureaux privés, formules de
  1 h, 2 h, 3 h, demi-journée, journée et durée libre, tarifs visiteur et membre, abonnements, pack, code promo,
  entreprises, membres et un invité, domiciliation et courrier, réservations dans tous les états des deux dernières
  semaines et des jours suivants, encaissements du jour ;
- site web : identité et thème, pages en français et en anglais, deux articles dont un programmé, redirections et,
  si `PUBLIC_ORIGIN` est renseigné, deux demandes de visiteurs.

Les données passent par l'API, avec ses contrôles et son journal d'audit. Seules les réservations passées du coworking
sont créées par les fonctions métier avec une heure de référence antérieure, l'API refusant un créneau terminé.

Le mot de passe de l'administrateur est saisi dans le terminal, jamais en argument. En développement avec Vite,
`WEB_ORIGIN` vaut `http://localhost:5173` et `COOKIE_SECURE=false`.

## Production

```bash
pnpm install --frozen-lockfile
pnpm --filter @gcf/web build                # produit apps/web/dist
pnpm --filter @gcf/portal build             # produit apps/portal/dist (module coworking)
pnpm --filter @gcf/api migrate
pnpm --filter @gcf/api start                # sert l'API, le back-office, le site et le portail
```

L'API et le back-office partagent la même origine : `WEB_ORIGIN` est l'URL publique (https), `COOKIE_SECURE=true`.
Avec les modules coworking ou site web, `PUBLIC_ORIGIN` est l'adresse publique du site (par exemple
`https://www.centre.tn`) : une requête arrivant sur cet hôte reçoit le site, le portail sous `/espace/`
(`PORTAL_DIST_DIR`), le sitemap et les images ; les API `/api/portal` et `/api/public` n'acceptent que cette origine.
Un seul centre peut exploiter la surface publique d'une installation. Placer un reverse proxy TLS (Nginx, Caddy)
devant le port de l'API, pour les deux noms d'hôte. Après une nouvelle construction des interfaces, redémarrer l'API.
Les variables sont décrites dans `apps/api/.env.example` ; aucun secret n'est versionné.

## Tests

```bash
pnpm --filter @gcf/shared test
TEST_DATABASE_URL=postgres://user@localhost:5432/gcf_test pnpm --filter @gcf/api test
pnpm typecheck                                # API, tests, règles partagées et interface
```

`TEST_DATABASE_URL` doit pointer vers une base jetable : le schéma `public` est recréé à chaque exécution.

## Avancement

| Lot   | Contenu                                                                                                                | État                                                                               |
| ----- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1     | Socle : centre, utilisateurs et rôles, sessions, journal d'audit, élèves                                               | Livré                                                                              |
| 2     | Cours particuliers, formations et leurs formules, groupes, inscriptions, échéanciers, changements de groupe, abandons  | Livré                                                                              |
| 3     | Séances et présences : feuille d'appel, rattrapages, verrouillage, correction motivée, PDF A4                          | Livré                                                                              |
| 4     | Encaissements, imputation, avances, chèques, remboursements, reçus PDF numérotés, reports, relances, journal financier | Livré                                                                              |
| 5     | Règles de rémunération, éléments de paie par intervenant et par règle, validation, règlements partiels, justificatifs  | Livré                                                                              |
| 6     | Salles et tarifs, loueurs, locations, contrats PDF, planning unifié et détection de conflits                           | Livré                                                                              |
| 7     | Caisse et clôture journalière, rapports exportables, tableau de bord par rôle                                          | Livré                                                                              |
| 8     | Interface web d'après les maquettes                                                                                    | Livré                                                                              |
| 9     | Modules vendables, coworking (back-office, plan interactif, portail client), site web public bilingue                  | Livré                                                                              |
| Suite | Écritures comptables légales (plan comptable), paiement en ligne, contrôle d'accès physique                            | Prévu : le journal `financial_events` en ajout seul est la source de ces écritures |
