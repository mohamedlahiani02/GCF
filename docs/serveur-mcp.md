# Serveur MCP (assistants IA)

AXÉLIA expose un serveur MCP (Model Context Protocol) à l'adresse `https://<back-office>/api/mcp`. Un assistant
compatible (Claude et d'autres) peut y lire les données du centre et, si le jeton le permet, agir comme un employé.

## Brancher un assistant

1. Paramètres > Intégrations > Jetons d'accès : créer un jeton pour l'assistant, avec le rôle le plus limité qui suffit.
2. Donner à l'assistant l'adresse du serveur (affichée sur la même page) et le jeton, en en-tête
   `Authorization: Bearer <jeton>`.
3. Révoquer le jeton suffit pour couper l'accès.

## Garde-fous

| Règle                  | Effet                                                                                                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rôle du jeton          | L'assistant n'a que les droits du rôle du jeton (secrétariat, comptable, éditeur ; jamais administrateur). Chaque appel repasse par l'API REST et ses contrôles. |
| Jeton en lecture seule | Les outils d'écriture ne sont pas proposés et toute écriture est refusée.                                                                                        |
| Confirmation           | Les outils d'écriture sont signalés comme tels (`readOnlyHint: false`) : l'assistant demande confirmation à l'utilisateur avant de les appeler.                  |
| Données personnelles   | Masquées par défaut (e-mail, téléphone, adresse, matricule fiscal, date de naissance). Une case du jeton les rend visibles.                                      |
| Traçabilité            | Chaque modification est écrite au journal d'audit avec le nom du jeton.                                                                                          |

## Outils

| Outil                                                             | Rôle                                                                                                                            |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `list_entities`                                                   | Types de données lisibles par ce jeton et leurs filtres.                                                                        |
| `list_records`, `get_record`                                      | Liste et détail : élèves, groupes, clients et réservations coworking, visiteurs, locations, encaissements, factures, prospects. |
| `centre_overview`                                                 | Tableau de bord du jour.                                                                                                        |
| `coworking_occupancy`                                             | Places libres, réservées et occupées, étage par étage.                                                                          |
| `overdue_charges`                                                 | Impayés en retard.                                                                                                              |
| `create_prospect`, `log_prospect_activity`, `move_prospect_stage` | Suivi des prospects.                                                                                                            |
| `announce_visitor`, `record_visitor`                              | Registre des visiteurs.                                                                                                         |
| `create_coworking_booking`                                        | Réservation d'une place ou d'une salle.                                                                                         |
| `send_invoice`                                                    | Envoi d'une facture par e-mail.                                                                                                 |

Montants en millimes (1 TND = 1000). Transport : HTTP « streamable », réponses JSON, versions de protocole
2025-06-18, 2025-03-26 et 2024-11-05.

## Hors périmètre de cette version

L'agent WhatsApp (ELIA) agira avec le rôle de son utilisateur, administrateur compris. Les jetons actuels ne
portent jamais le rôle administrateur : il faudra un jeton personnel lié à un utilisateur, prévu avec ELIA.
