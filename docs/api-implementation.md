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

Entités de référence : `rooms`, `subjects`, `instructors`, `studies`, `trainings`, `students`, `renters`, `companies`,
`members`, `cafe-products`. Entités de reprise : `groups` (cours réguliers, avec leurs créneaux), `enrolments`,
`subscriptions` (coworking), `cafe-stock` (stock initial, saisi comme un inventaire). Une ligne a la forme du corps de la route REST de création, avec les références écrites par leur nom
(`subject` pour une étude, `subjects` pour un intervenant, `company` pour un membre, nom ou matricule fiscal).

- **preview** n'écrit rien. Chaque ligne reçoit une action : `create`, `exists` (même clé métier déjà présente, rien ne sera
  fait) ou `error` (forme, référence inconnue, doublon dans le fichier, règle du corps de la route).
- **apply** refait la vérification, puis envoie chaque ligne `create` à la route REST de création. Résultat : `created` avec
  l'identifiant, ou `failed` avec le code et le message de l'API (règle métier). Rien n'est modifié ni supprimé ; renvoyer le
  même fichier ne crée rien deux fois.

Une personne (élève, intervenant, membre) se nomme par son e-mail, ou par son prénom et son nom. Un nom porté par plusieurs
fiches est refusé (« ambiguous reference ») : il faut alors l'e-mail. Un groupe se nomme par matière, étude et nom du
groupe ; un plan de paiement par son nom dans l'étude du groupe ; une place du coworking par son code.

Reprise : la date d'effet d'une inscription et la date de début d'un abonnement fixent le début de l'échéancier. À la
reprise, on prend la date de bascule : les impayés antérieurs ne sont pas recréés par ces imports. Un jeton ne peut pas
désactiver le prorata d'un mois partiel (décision réservée à un administrateur). Les groupes de formation (sessions) ne se
chargent pas encore par fichier.

Clés métier : nom (salles, matières, produits du café), matière + nom (études), intitulé (formations), e-mail sinon nom,
prénom et téléphone (personnes), matricule fiscal sinon nom (entreprises). Comparaison sans casse ni espaces superflus.

## Soldes d'ouverture (impayés et avances)

Deux entités chargent ce que les élèves et les membres du coworking devaient, ou avaient payé d'avance, à la date de bascule.
Elles passent par `POST /api/opening-balances/debts` et `/advances`, réservées au jeton Implémentation et à l'administrateur
(permission `opening:write`) ; ce sont les seules routes d'argent que ce jeton atteint.

- `opening-debts` : une dette ancienne. La ligne donne `kind` (`student` ou `member`), la personne (e-mail ou prénom et nom),
  le montant en millimes, la date d'échéance dans l'ancien système (antérieure à aujourd'hui) et un libellé facultatif
  (« Solde d'ouverture » par défaut). Elle se règle, se reporte et se relance comme une échéance, avec son ancienneté. Elle
  n'est ni rattachée à une inscription, ni du chiffre d'affaires de la période : les rapports « facturé » l'ignorent et la
  paie, qui lit les inscriptions, ne la voit jamais. Une fois encaissée, elle figure dans les encaissements sous « Reprise :
  soldes d'ouverture ».
- `opening-advances` : un paiement reçu avant la bascule. Il est enregistré le jour du chargement, avec son reçu, comme tout
  paiement : il règle d'abord les échéances ouvertes du payeur (les plus anciennes d'abord, donc les dettes reprises), le reste
  devient son crédit. La référence de l'ancien système est obligatoire et empêche tout doublon. Un paiement en espèces entre
  dans la caisse du jour : pour une somme qui n'est pas dans la caisse du nouveau système, choisir virement. Un chèque donne son
  numéro et sa banque.

La réponse d'un import d'argent contient `totals` : la somme des montants des lignes par statut, pour rapprocher le fichier du
total de l'ancien système avant et après le chargement.

## Packs de configuration

| Méthode | Adresse                    | Effet                                                                             |
| ------- | -------------------------- | --------------------------------------------------------------------------------- |
| GET     | `/api/implementation/pack` | Réglages actuels au format `axelia.pack/1`                                        |
| POST    | `/api/implementation/pack` | `{ "mode": "preview" \| "apply", "pack": {...} }` : différences, puis application |

Sections : `centre` (sans nom, adresse ni matricule fiscal), `coworking`, `cafe`, `automations`. Une section d'un module
non souscrit est absente de l'export et ignorée à l'application (`skipped`). Un champ inconnu est refusé (422). Les sections
s'appliquent l'une après l'autre par les routes de réglages ; une section refusée figure dans `failed` avec la raison de l'API
et n'annule pas les autres.
