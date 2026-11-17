# API d'implémentation (contrat du framework consultant)

Le framework d'implémentation (dépôt séparé `integration-framework-gcp`) ne contient aucun code du produit. Il parle à une
installation AXÉLIA par cette API, avec un jeton d'accès de rôle **Implémentation** créé par un administrateur dans
Paramètres > Intégrations.

## Rôle Implémentation

Il configure le centre et charge les données de départ. Il ne touche jamais à l'argent (encaissements, caisse, calcul et
validation de la paie, factures, ventes du café) ni aux utilisateurs et aux jetons. Une session de navigateur, même
administrateur, n'atteint pas ces routes : seul un jeton le peut. Chaque écriture est tracée au journal d'audit avec le nom du
jeton.

## Imports de données de référence

| Méthode | Adresse                               | Effet                                                                              |
| ------- | ------------------------------------- | ---------------------------------------------------------------------------------- |
| GET     | `/api/implementation/imports`         | Entités chargeables, dans l'ordre des dépendances, avec le JSON Schema d'une ligne |
| POST    | `/api/implementation/imports/:entité` | `{ "mode": "preview" \| "apply", "rows": [...] }`, 2 000 lignes au plus par appel  |

Entités : `rooms`, `subjects`, `instructors`, `studies`, `trainings`, `students`, `renters`, `companies`, `members`,
`cafe-products`. Une ligne a la forme du corps de la route REST de création, avec les références écrites par leur nom
(`subject` pour une étude, `subjects` pour un intervenant, `company` pour un membre, nom ou matricule fiscal).

- **preview** n'écrit rien. Chaque ligne reçoit une action : `create`, `exists` (même clé métier déjà présente, rien ne sera
  fait) ou `error` (forme, référence inconnue, doublon dans le fichier, règle du corps de la route).
- **apply** refait la vérification, puis envoie chaque ligne `create` à la route REST de création. Résultat : `created` avec
  l'identifiant, ou `failed` avec le code et le message de l'API (règle métier). Rien n'est modifié ni supprimé ; renvoyer le
  même fichier ne crée rien deux fois.

Clés métier : nom (salles, matières, produits du café), matière + nom (études), intitulé (formations), e-mail sinon nom,
prénom et téléphone (personnes), matricule fiscal sinon nom (entreprises). Comparaison sans casse ni espaces superflus.

## Packs de configuration

| Méthode | Adresse                    | Effet                                                                             |
| ------- | -------------------------- | --------------------------------------------------------------------------------- |
| GET     | `/api/implementation/pack` | Réglages actuels au format `axelia.pack/1`                                        |
| POST    | `/api/implementation/pack` | `{ "mode": "preview" \| "apply", "pack": {...} }` : différences, puis application |

Sections : `centre` (sans nom, adresse ni matricule fiscal), `coworking`, `cafe`, `automations`. Une section d'un module
non souscrit est absente de l'export et ignorée à l'application (`skipped`). Un champ inconnu est refusé (422). Les sections
s'appliquent l'une après l'autre par les routes de réglages ; une section refusée figure dans `failed` avec la raison de l'API
et n'annule pas les autres.
