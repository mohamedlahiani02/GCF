# Validation locale — Intégrations n8n et automatisations

Date : 7 novembre 2026.

## Version et statut Git

- `main` : `1a70b03` ; aucun nouveau commit disponible sur cette branche au moment du contrôle.
- PR #12 : https://github.com/mohamedlahiani02/GCF/pull/12 — ouverte, base `main`, branche `feat/integrations`.
- PR #13 : https://github.com/mohamedlahiani02/GCF/pull/13 — fusionnée dans `feat/integrations`, pas encore dans `main`.
- Version testée : `82220bb`, qui contient les deux fonctionnalités.
- Checkout isolé : `C:/Users/haith/OneDrive/Bureau/GCF/gcf-n8n-review`, branche locale `test/n8n-automations`.
- Aucune fusion de la PR dans `main`, aucun push et aucune modification des sources applicatives pendant cette recette.

La roadmap du mini-ERP reste dans `docs/roadmap-mini-erp.md` et est amendée par ce bilan. Ce travail constitue une validation d'intégration locale, pas une certification de sécurité ou de conformité.

## Isolation de la recette

| Ressource | Démo habituelle | Recette PR |
| --- | --- | --- |
| Serveur | http://localhost:3000 | http://localhost:3010 |
| Base | `gcf_demo_20261107` | `gcf_pr12_review` — copie de la démo |
| Base des tests automatisés | Non utilisée | `gcf_pr12_test` — jetable |
| n8n | Aucun | http://localhost:5678 |

- Les migrations `0016_integrations` et `0017_automations` sont appliquées uniquement sur la copie de recette et dans la suite de tests.
- Le code, la configuration et la base de la démo habituelle ne sont pas remplacés.
- n8n est démarré par le compose fourni, projet Docker `gcf-pr12-n8n`, image `docker.n8n.io/n8nio/n8n:2.46.6`.
- Le runtime inclus dans cette image répond `v26.12.1`. Le projet GCF reste exécuté avec Node 22.12.0 ; aucun changement du Node global n'a été nécessaire.
- Aucun compte Telegram, WhatsApp ou service de messagerie externe n'a été relié.
- SMTP reste non configuré sur le serveur de recette. Les scénarios d'e-mail sont vérifiés avec le mailer d'enregistrement des tests ; aucune livraison SMTP réelle n'est annoncée comme vérifiée.
- Les secrets de recette sont conservés localement hors du dépôt, ou dans les `.env` ignorés, et ne sont pas reproduits dans ce rapport.

## Résultats exécutés

| Contrôle | Résultat |
| --- | --- |
| Installation avec lockfile figé | Réussie |
| Migrations de la copie | `0016` et `0017` appliquées |
| `pnpm typecheck` | Réussi sur les cinq packages applicatifs/partagés |
| `pnpm build` | Back-office et portail compilés |
| Tests partagés | 33 réussis |
| Tests API sur PostgreSQL 16 | 231 réussis dans 21 fichiers |
| Total tests automatisés | 264 réussis |
| Authentification sur le serveur de recette | Réussie |
| Workflow n8n publié et exécuté réellement | Réussi |

Les tests API incluent notamment : restrictions de rôle et de lecture seule des jetons, révocation/expiration, attribution de l'audit au jeton, mise en file et signature des webhooks, délais de nouvelles tentatives, renvoi manuel, réception indisponible et concurrence des dispatchers. Les scénarios d'automatisation couvrent les valeurs par défaut, les droits, les périodes, les exclusions de relance, la relecture du solde, le calcul sans validation de paie, les propositions et l'avis de courrier.

## Parcours réel n8n

Workflow : `Recette GCF - signature puis lecture API`.

URL : http://localhost:5678/workflow/gcfPr12Review2026

Parcours :

`Création d'un élève fictif dans la copie GCF → événement student.created → webhook n8n → vérification HMAC et date → lecture de l'élève par jeton Secrétariat en lecture seule → réponse de succès`

Vérifications réalisées :

1. Le jeton en lecture seule lit les élèves.
2. Son écriture d'élève est refusée avec `403 read_only_token`.
3. Son accès aux comptes utilisateurs est refusé avec `403 token_not_allowed`.
4. La création d'un jeton Admin est refusée.
5. Un jeton de recette peut être révoqué ; son appel suivant est refusé avec `401`.
6. Un jeton Secrétariat autorisé en écriture crée un élève fictif.
7. L'audit indique le nom de ce jeton pour l'action `student.created`.
8. L'événement correspondant est livré par le dispatcher GCF à la vraie instance n8n.
9. Le workflow relit le bon élève via l'API GCF et renvoie son identifiant.
10. Une fausse signature est refusée avant l'accusé de succès du workflow de recette.
11. Une signature correctement calculée mais trop ancienne est refusée.
12. Le jeton d'écriture temporaire est révoqué après le scénario.
13. Les quatre automatisations sont initialement désactivées sur cette copie.
14. Le mode `propose` du programme quotidien est explicitement refusé, car non supporté.

Les exécutions n8n en erreur correspondant aux fausses signatures sont attendues : elles démontrent l'arrêt avant la lecture API.

Ce workflow est une recette de lecture. Il ne transmet aucun message à un tiers et ne démontre pas l'idempotence d'une action externe ayant des effets, comme l'envoi d'un message ou la création d'une facture.

## Écrans à tester

| Écran | Adresse |
| --- | --- |
| Intégrations | http://localhost:3010/integrations |
| Automatisations | http://localhost:3010/automatisations |
| Propositions | http://localhost:3010/propositions |
| n8n | http://localhost:5678 |

Connexion GCF : `admin@demo.tn`, mot de passe de la démo fourni dans la conversation.

Connexion n8n : `admin@n8n.local`, mot de passe local communiqué dans la conversation.

Les automatisations sont laissées désactivées. La boîte Propositions peut donc être vide. Le mode « À confirmer » prépare un travail au prochain passage éligible ; l'activation après l'heure prévue marque la période courante comme ignorée, conformément au comportement codé. Les relances ne peuvent pas être envoyées depuis ce serveur sans configurer un transport de messagerie de test.

## Compatibilité avec le mini-ERP

| Élément de roadmap | Apport de ces PR | État |
| --- | --- | --- |
| Comptes techniques | Jetons restreints, révocables, expirables et jamais Admin | Première implémentation utilisable |
| Traçabilité | Action attribuée au créateur et au nom du jeton | Implémenté et vérifié |
| Événements sortants | File transactionnelle issue du journal d'audit | Implémenté pour les événements audités couverts |
| Livraison asynchrone | Signature, tentatives, historique et renvoi manuel | Implémenté, durcissement à prévoir |
| Intégration n8n | Déploiement local et recette événement→lecture API | Vérifié avec instance réelle |
| Autonomie | Catalogue de quatre tâches avec modes contrôlés | Implémenté, catalogue fixe |
| Approbation humaine | Propositions, droits et identité du décideur | Implémenté, reprise après interruption à renforcer |
| Framework générique de workflows | Éditeur de déclencheurs/conditions/actions et versionnement | Non fourni par ces PR |
| Framework consultant | Packs, import, recette→production, documentation des configurations | Reste à construire |
| API ERP versionnée / SDK | Contrats publics, scopes fins et modèles de connecteur | Reste à construire |
| Finco, stock et comptabilité | Aucun moteur commercial/comptable nouveau | Roadmap inchangée |
| Agent IA / MCP | Non livré dans ces branches | À venir, sous les mêmes droits et propositions |
| WhatsApp parents | Non relié | Différé jusqu'au cadrage des données personnelles et des canaux |

Conclusion : compatibles avec la cible. Ces PR constituent une version initiale des intégrations et automatisations, pas l'ensemble du framework ERP.

## Limites et actions à inscrire au backlog

Les points suivants proviennent d'une revue du code et de la documentation. Ils ne doivent pas être confondus avec des échecs de la suite de tests. Les fenêtres de panne décrites nécessitent des scénarios dédiés.

### P0 — Reprise des traitements après interruption

1. **Proposition confirmée avant exécution** : `decideProposal` enregistre la confirmation dans une transaction, puis exécute le travail. Un arrêt du processus entre ces étapes ou pendant le traitement peut laisser une proposition confirmée sans résultat complet. Le contrôle empêchant une seconde décision bloque alors aussi une reprise simple.
   - Prévoir un état d'exécution distinct de la décision : en attente, en cours, partiel, réussi, échoué.
   - Ajouter bail/expiration, progression par élément, reprise idempotente et action de relance.
2. **Run planifié bloqué en `running`** : l'unicité `(centre, tâche, période)` empêche les doublons, mais aucun mécanisme de reprise des runs interrompus n'est visible dans le scheduler.
   - Ajouter une date de bail, la détection des runs orphelins et une reprise contrôlée.
3. **Paie multi-intervenants** : des calculs antérieurs à un échec restent en base, comme annoncé. Rien n'est validé ou payé automatiquement ; la présentation doit néanmoins afficher la progression et permettre une reprise précise.

### P1 — Livraison n8n, sécurité et exploitation

4. **Accusé de réception** : la recette documentée utilise une réponse Webhook « Immediately ». GCF peut alors noter l'envoi réussi avant que la signature ou les nœuds suivants échouent.
   - Le workflow de recette créé ici utilise `responseNode` et accuse le succès après signature et lecture API.
   - Pour des traitements longs, distinguer réception durable et succès métier, avec suivi/reprise côté n8n. Ne pas simplement prolonger indéfiniment le timeout GCF.
5. **Doublons et rejeu** : l'identifiant stable aide à dédupliquer, mais la recette Code de signature ne met pas en œuvre de registre durable d'événements traités. La fenêtre de cinq minutes ne bloque pas à elle seule les répétitions à l'intérieur de cette fenêtre.
   - Prévoir une déduplication durable avant toute action externe produisant un effet.
6. **Secrets** : les jetons ne sont stockés que sous forme d'empreinte ; les secrets HMAC des webhooks sont stockés en clair dans la base, ce que la documentation reconnaît.
   - Prévoir chiffrement des secrets avec clé séparée de la base, rotation et procédures d'exploitation.
7. **Périmètre des destinations** : la validation des URL accepte HTTP/HTTPS. Prévoir pour l'hébergement multi-clients une politique d'egress/destinations et de résolution DNS adaptée, avec exception explicite pour les connexions locales de développement.
8. **Pouvoirs d'un jeton** : ils sont définis par un rôle et une option lecture seule ; pas encore par des scopes métier fins. Le jeton dépend du statut de l'Admin créateur.
   - Ajouter comptes techniques/périmètres adaptés à l'organisation cible et décrire les changements de propriétaire.
9. **« Jamais perdu »** : garantie limitée à la mise en file transactionnelle des événements audités correspondants, lorsque le webhook est actif.
   - Les échecs définitifs ne sont plus retentés automatiquement après le maximum ; les envois terminés sont purgés selon la rétention ; désactiver un endpoint abandonne ses envois en attente.
   - Ajouter alertes, procédures de récupération et conservation adaptée aux clients avant une promesse de service.
10. **Environnement n8n** : le compose permet aux nœuds Code de lire les variables d'environnement. Cela convient au test local avec des éditeurs de confiance ; une offre multi-clients doit définir l'isolation des instances, projets, credentials et administrateurs.

### P2 — Généralisation produit

11. **Modes réellement supportés** : relances et paie proposent `off/propose/auto` ; programme quotidien et avis de courrier proposent `off/auto` seulement. Adapter le discours et les écrans à cette distinction.
12. **Catalogue fixe** : quatre clés sont définies dans le code et les contraintes SQL. Ajouter une tâche exige du développement ; ce n'est pas encore un studio configurable par les consultants.
13. **Contrats événementiels** : les événements sont liés aux actions d'audit et le payload ne contient pas encore de version de schéma explicite. Stabiliser un catalogue d'événements métier, ses droits et sa compatibilité avant de multiplier les connecteurs.
14. **Données et canaux** : n'envoyer que des identifiants réduit le contenu exposé, mais la relecture API par n8n et ses historiques doivent être inclus dans le périmètre des données traitées.

## Séquencement recommandé

1. Conserver cette recette locale et effectuer la recette fonctionnelle avec l'utilisateur.
2. Traiter les scénarios P0 et ajouter leurs tests de panne/reprise.
3. Compléter les recettes n8n avec accusé adapté et déduplication ; définir les mesures P1 correspondant au mode d'hébergement choisi.
4. Décider de la fusion de la PR #12 dans une étape distincte ; aucune fusion distante n'a été faite ici.
5. Réutiliser ces briques dans les étapes Socle/Intégrations de la roadmap, sans reconstruire un second dispatcher.
6. Poursuivre séparément le chantier contacts, facturation, achats/stock et comptabilité ; l'avancement n8n ne remplace pas ces lots.

## Références

- PR #12 : https://github.com/mohamedlahiani02/GCF/pull/12
- PR #13 : https://github.com/mohamedlahiani02/GCF/pull/13
- Guide de la branche testée : `gcf-n8n-review/docs/integrations-n8n.md`.
- Tests : `apps/api/test/integrations.test.ts`, `apps/api/test/automations.test.ts`, `packages/shared/src/automation.test.ts`.
- Reprise à renforcer : `apps/api/src/domain/automations/proposals.ts`, `scheduler.ts` et `runners.ts`.
- File et secret : `apps/api/src/domain/webhooks.ts`, `apps/api/src/db/migrations/0016_integrations.sql`.
- Administration n8n par CLI : https://docs.n8n.io/hosting/cli-commands/.
