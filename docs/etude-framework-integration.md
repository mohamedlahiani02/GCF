# Étude : un framework d'intégration pour les consultants

Contexte : la plateforme sera livrée à des tiers (consultants, intégrateurs) qui la déploient chez des centres. Cette étude
reprend le cadre déjà écrit dans `docs/roadmap-mini-erp.md` (section 8 « Framework d'implémentation pour consultants »,
section 19.4 « Première tranche consultant ») et dans `docs/audit-metier-produit-2026-11-10.md` (constat A09), et le confronte
à l'état réel du dépôt. Elle recommande un ordre de construction.

Deux sens du mot « intégration » sont à séparer :

- **Implémentation** : installer, paramétrer et mettre en service la plateforme chez un centre (le travail du consultant).
- **Interconnexion** : relier la plateforme à d'autres systèmes (n8n, comptabilité, Slack, assistants IA).

## 1. Ce que le cadre déjà écrit demande

Parcours cible : `Qualification, choix du pack, configuration, reprise, recette, formation, mise en service, suivi`.

Onze fonctions sont listées en section 8 de la roadmap : portefeuille de clients, fiche de cadrage, packs, assistant
d'installation, import CSV/Excel, reprise des soldes, environnement de recette, comparaison de configurations, documentation
générée, checklist de recette, historique des interventions. La section 19.4 fixe la première tranche : un pack versionné,
un import simulé puis chargé, une recette, une publication avec différences. Elle interdit tout SQL ou JavaScript arbitraire
dans un champ de configuration.

## 2. Ce qui existe aujourd'hui (vérifié dans le dépôt)

| Brique                                  | État                                                                                        | Preuve                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Règles métier paramétrables sans code   | Oui, par centre, par groupe et par règle de paie, avec valeurs par défaut                   | `docs/guide-parametrage.md`                       |
| Modules activables par centre           | Oui, par une commande réservée à l'éditeur (formation, coworking, site, café, QR, factures) | `apps/api/src/cli/modules.ts`, `modules.ts`       |
| Journal d'audit de chaque modification  | Oui                                                                                         | `audit_log`, `writeAudit`                         |
| Jeux de démonstration                   | Oui, un seul jeu cohérent, chargé par un script                                             | `apps/api/src/cli/seedDemo*.ts`                   |
| Création du premier administrateur      | Oui                                                                                         | `apps/api/src/cli/bootstrap.ts`                   |
| Jetons d'accès, webhooks signés, MCP    | Oui : file de livraison avec reprise, événements, jetons à rôle limité, serveur MCP         | `docs/integrations-n8n.md`, `docs/serveur-mcp.md` |
| Automatisations avec validation humaine | Oui (relances, paie, programme du lendemain, avis de courrier)                              | `docs/guide-parametrage.md`, section 5            |
| Exports de tableaux                     | Oui, rapports seulement                                                                     | `domain/tableExport.ts`                           |
| Migrations de base de données           | Oui, numérotées, appliquées par une commande                                                | `pnpm --filter @gcf/api migrate`                  |

## 3. Ce qui manque (écart avec le cadre écrit)

| Fonction du cadre                       | État                        | Conséquence pour un consultant                                                                         |
| --------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------ |
| Fiche de cadrage et questionnaire       | Absent du produit           | Traité par le guide `docs/guide-cadrage-client.md` (papier, pas dans l'application)                    |
| Import CSV/Excel avec contrôles         | Absent                      | Chaque fiche (élève, intervenant, produit, client) se saisit à la main, ou par script sur mesure       |
| Reprise des soldes et pièces ouvertes   | Absent                      | Les impayés historiques ne se chargent pas sans développement                                          |
| Pack de configuration exportable        | Absent                      | Les réglages sont dispersés dans une vingtaine de tables ; impossible de les cloner ou de les comparer |
| Comparaison et publication datée        | Absent                      | Aucune preuve des différences entre recette et production                                              |
| Environnement de recette, anonymisation | Absent                      | Recette sur le jeu de démonstration uniquement                                                         |
| Scénarios de recette exécutables        | Partiel : tests automatisés | Les tests protègent le code, pas la configuration d'un client                                          |
| Portefeuille de clients, accès délégués | Absent                      | Une installation par client (voir 5), sans console commune                                             |
| Rôles personnalisés par client          | Absent                      | Les quatre rôles sont fixes dans le code (constat A09)                                                 |

Conclusion d'état : la plateforme est **paramétrable**, mais le **framework consultant n'est pas livré**. Le consultant peut
déployer et régler un centre avec le guide, pas encore le reprendre et le recetter de façon reproductible.

## 4. Options

| Option | Contenu                                                                                                                           | Avantage                                        | Limite                                                                   |
| ------ | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------ |
| A      | Méthode et documents seulement : guide de cadrage, checklist de recette, modèles de fichiers à remplir                            | Immédiat, aucun risque                          | Reprise de données manuelle, donc lente et sujette aux erreurs           |
| B      | A, plus outillage en ligne de commande : import de fichiers CSV avec simulation, export et import d'un pack de configuration JSON | Reproductible, testable, pas d'interface lourde | Réservé à un consultant à l'aise avec une console                        |
| C      | B, plus un assistant dans l'application : progression, import par écrans, recette guidée, publication avec différences            | Autonomie complète du consultant                | Chantier le plus long ; à justifier par au moins deux déploiements réels |

## 5. Recommandation

Livrer **A tout de suite**, puis **B par petites tranches**, et n'envisager **C** qu'après deux déploiements réels. C'est
l'ordre déjà écrit dans l'audit (« packs et simulation d'abord, pas d'extensions arbitraires avant deux besoins réels »).

Tranche 1, ce dépôt (fait avec cette étude) : le guide de cadrage client et la liste exacte des données à collecter.

Tranche 2, import de la reprise de données (taille moyenne). Dans cet ordre, car chaque étape dépend de la précédente :
salles, intervenants, matières, formations et études, élèves, entreprises et clients coworking, produits du café, puis groupes
et inscriptions. Chaque import : modèle de fichier, aperçu sans écriture, rapport d'erreurs par ligne, clé de rapprochement
pour ne pas créer de doublon au second passage, une transaction par lot, aucune suppression.

Tranche 3, pack de configuration (taille moyenne). Export JSON versionné des réglages (centre, coworking, café, plans de
paiement, règles de paie, automatisations), sans aucune donnée opérationnelle ni personnelle ; import avec comparaison des
différences avant application ; tout passe par les mêmes routes et contrôles que l'interface, donc par le journal d'audit.

Tranche 4, recette (taille moyenne). Jeu de scénarios métier par module (inscrire, encaisser, réserver, clôturer la caisse),
exécutable sur une base de recette, avec résultat attendu par scénario et preuve conservée. Les cas chiffrés de
`docs/audit-metier-produit-2026-11-10.md` (section 4) en sont le point de départ.

Les tailles sont des ordres de grandeur relatifs, pas des estimations en jours : aucune mesure de vitesse n'existe sur ce
dépôt.

## 6. Contraintes à respecter

1. **Aucun code dans la configuration.** Un pack contient des valeurs, jamais de SQL ni de script.
2. **Une installation par client.** La surface publique et les jetons supposent une organisation par déploiement
   (constat A10). Promettre plusieurs clients sur une installation commune demande un travail d'isolation distinct.
3. **Les pièces émises ne se réécrivent pas.** Reçus, factures et paies validées sont numérotés sans trou : une reprise charge
   des soldes d'ouverture, elle ne crée pas de faux historique numéroté.
4. **Les obligations fiscales ne se déduisent pas d'un document.** Le taux de TVA, le timbre, les mentions légales et les
   remises sont à valider par l'expert-comptable du client (`docs/hypotheses-a-valider.md`, point 17).
5. **Les données personnelles de recette sont anonymisées.** Une copie de production vers la recette passe par une
   anonymisation, jamais en clair.

## 7. Décisions à prendre

1. Confirmer l'option B comme cible, avec C reportée.
2. Choisir le premier client réel qui servira de pilote pour la tranche 2 (volumes et formats de fichiers réels).
3. Décider du lieu de la recette : base séparée sur le même hébergement, ou installation distincte.
4. Décider qui détient les accès aux installations des clients (consultant, éditeur, client) et comment ils sont révoqués.
