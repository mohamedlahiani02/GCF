# GCF : gestion de centre de formation

Back-office interne d'un centre de formation et d'études privées : élèves, groupes, présences, encaissements et reçus,
paie des intervenants, location de salles, planning, caisse et rapports. Usage réservé au personnel du centre
(Admin, Secrétariat, Comptable), sans compte élève, intervenant ou loueur en Phase 1.

## Stack

| Couche | Choix | Raison |
| --- | --- | --- |
| Langage | TypeScript (strict) sur Node.js 22 | Un seul langage du serveur à l'interface, types partagés |
| API | Fastify 5 | Rapide, validation et hooks explicites |
| Base | PostgreSQL 16 | Transactions, contraintes et triggers pour l'intégrité financière |
| Accès base | Kysely + migrations SQL versionnées | Requêtes typées, SQL lisible et revu tel quel |
| Validation | Zod 4 | Les mêmes schémas côté serveur et client |
| Mots de passe | Argon2id | Recommandation OWASP actuelle |
| Tests | Vitest, tests d'intégration sur une vraie base PostgreSQL | Aucune base simulée pour les règles métier |

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
apps/api            API Fastify (routes, authentification, migrations SQL)
packages/shared     Règles métier pures et testées : argent, présence, paie, dates
docs/               Hypothèses à valider avec le client
```

## Démarrage

Prérequis : Node.js 22+, pnpm 10, PostgreSQL 16.

```bash
pnpm install
cp apps/api/.env.example apps/api/.env      # renseigner DATABASE_URL et WEB_ORIGIN
pnpm --filter @gcf/api migrate
pnpm --filter @gcf/api bootstrap -- --centre "Nom du centre" --email admin@centre.tn --name "Prénom Nom"
pnpm --filter @gcf/api dev
```

Le mot de passe de l'administrateur est saisi dans le terminal, jamais en argument.

## Tests

```bash
pnpm --filter @gcf/shared test
TEST_DATABASE_URL=postgres://user@localhost:5432/gcf_test pnpm --filter @gcf/api test
```

`TEST_DATABASE_URL` doit pointer vers une base jetable : le schéma `public` est recréé à chaque exécution.

## Avancement

| Lot | Contenu | État |
| --- | --- | --- |
| 1 | Socle : centre, utilisateurs et rôles, sessions, journal d'audit, élèves | Livré |
| 2 | Études, formations, groupes, plans de tranches, inscriptions, échéanciers | À faire |
| 3 | Séances et présences (feuille, rattrapages, verrouillage, PDF A4) | À faire |
| 4 | Encaissements, imputation, avances, reçus PDF numérotés, écritures comptables | À faire |
| 5 | Règles de rémunération et calcul de la paie | Règles de calcul livrées dans `packages/shared`, API à faire |
| 6 | Salles, locations, planning unifié et détection de conflits | À faire |
| 7 | Caisse, rapports, tableau de bord | À faire |
| 8 | Interface web | À faire |
