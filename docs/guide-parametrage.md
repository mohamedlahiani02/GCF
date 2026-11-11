# Guide de paramétrage

Ce guide s'adresse au consultant qui installe l'application chez un centre. Règle de conception : **une règle métier
est un réglage, pas du code**. Chaque réglage ci-dessous a une valeur par défaut. Il se change dans l'application,
sans intervention technique, et chaque modification est tracée au journal d'audit.

Les réglages s'appliquent à trois niveaux. Le niveau le plus précis l'emporte :

| Niveau | Où                                                               | Exemple                                |
| ------ | ---------------------------------------------------------------- | -------------------------------------- |
| Centre | Paramètres > Administration                                      | Compter les absences justifiées        |
| Groupe | Gestion des groupes > fiche du groupe                            | Même réglage, pour ce groupe seulement |
| Règle  | Paie > Règles de rémunération > Nouvelle règle (par intervenant) | Payer les séances annulées             |

## 1. Centre (Paramètres > Administration)

| Réglage                                                     | Défaut                     | Effet                                                                                                                           |
| ----------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Exiger un parent ou tuteur joignable pour un élève mineur   | Non                        | Oui : un élève mineur ne s'enregistre qu'avec le nom du tuteur et un téléphone ou un e-mail. Non : ces champs sont facultatifs. |
| Compter les absences justifiées comme présentes             | Non                        | Entre dans le taux de présence, donc dans la paie au prorata ou au seuil.                                                       |
| Compter les rattrapages dans un autre groupe comme présents | Oui                        | Le rattrapage compte pour le groupe d'origine ; l'élève invité n'entre jamais dans le taux du groupe d'accueil.                 |
| Reports maximum par échéance                                | 2                          | Au-delà, le report est refusé.                                                                                                  |
| Reports du secrétariat soumis à validation                  | Oui                        | Un administrateur doit approuver les reports demandés par le secrétariat.                                                       |
| Délai de grâce avant retard                                 | 0 jour                     | Une échéance n'est en retard qu'après ce délai.                                                                                 |
| Préfixe des reçus                                           | `REC`                      | Numérotation `REC-AAAA-000001`, continue.                                                                                       |
| Mentions en pied de reçu                                    | Texte par défaut           | Remplace le texte imprimé sous chaque reçu.                                                                                     |
| Heures et jours d'ouverture                                 | 08:00 à 20:00, lun. à sam. | Sert au calcul de l'occupation des salles.                                                                                      |

**Exemple.** Un centre de soutien scolaire veut toujours pouvoir joindre un parent : cochez « Exiger un parent ou
tuteur joignable ». Les fiches déjà enregistrées ne changent pas. La règle s'applique à la prochaine création ou
modification d'une fiche.

## 2. Groupe (Gestion des groupes > fiche du groupe > Modifier)

Chaque réglage laissé sur « Réglage du centre » ou « Réglage du cours particulier » (tarif vide pour le prix) reprend
la valeur héritée. « Absences facturées » n'existe que pour un groupe de cours particulier.

| Réglage                      | Hérite de                      |
| ---------------------------- | ------------------------------ |
| Prix                         | Cours particulier ou formation |
| Absences facturées           | Cours particulier              |
| Absences justifiées comptées | Centre                         |
| Rattrapages comptés          | Centre                         |

## 3. Paie (Paie > Règles de rémunération)

Une règle se définit par intervenant. Elle s'applique au niveau le plus précis disponible : le groupe, puis le cours
particulier ou la formation, puis la règle par défaut de l'intervenant. Une règle n'est jamais modifiée : pour
changer les conditions, créez une nouvelle règle avec sa date d'effet. Les éléments de paie déjà validés ne sont
jamais recalculés.

**Paie = Base × facteur de présence**, plus les séances annulées payées, le cas échéant.

| Réglage                              | Choix                                                                                                                                   | Défaut                       |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Base de calcul                       | % des encaissements ou du facturé du groupe, % du tarif de séance, montant fixe par séance, forfait mensuel, horaire, forfait formation | % des encaissements          |
| Rythme                               | Par séance, par mois ou à la fin de la formation, selon la base                                                                         | Le premier rythme de la base |
| Effet de la présence                 | Sans effet (100 %), au prorata du taux de présence, ou seuil minimum                                                                    | Au prorata                   |
| Seuil : taux minimum                 | De 0,01 % à 100 %                                                                                                                       | 50 %                         |
| Seuil : plancher sous le seuil       | Un montant, ou vide (rien n'est payé sous le seuil)                                                                                     | Vide                         |
| Seuil : au-dessus du seuil           | 100 %, ou au prorata                                                                                                                    | 100 %                        |
| Payer les séances annulées           | Oui ou non (bases par séance ou horaire uniquement)                                                                                     | Non                          |
| Payer les séances sans élève présent | Oui ou non (bases par séance ou horaire uniquement)                                                                                     | Oui                          |

Précisions de calcul :

- **Séance annulée payée** : elle compte comme une séance tenue dans la base (sa durée prévue pour le taux horaire),
  à 100 %. La présence ne s'y applique pas et elle n'entre pas dans le taux de présence. Si la séance est déplacée
  plutôt qu'annulée, utilisez « Déplacer » dans le planning : la séance n'est alors payée qu'une fois.
- **Séance sans élève présent** : aucun élève, invité en rattrapage compris, n'est marqué présent sur la feuille
  validée. Si la règle ne la paie pas, la séance est retirée de l'élément et du taux de présence.
- **Contrôle conservé** : une séance tenue n'est payée qu'une fois sa feuille de présence validée. Ce contrôle n'est pas
  un réglage.
- **Arrondi** : au millime, au demi supérieur.
- L'ancienne option « Séance due » donnait exactement le même résultat que « Sans effet ». Elle n'est plus proposée.
  Les règles déjà créées avec elle continuent de fonctionner à l'identique.

**Exemples.**

| Besoin du centre                                                        | Règle à créer                                                                               |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Un vacataire payé 40 TND par séance, même si le centre annule           | Montant fixe par séance 40 TND, sans effet de la présence, payer les séances annulées : oui |
| Un enseignant payé seulement si des élèves sont venus                   | Montant fixe par séance, payer les séances sans élève présent : non                         |
| 60 % des encaissements, au prorata de la présence                       | % des encaissements 60 %, au prorata                                                        |
| Rien sous 50 % de présence, un plancher de 50 TND, au prorata au-dessus | Seuil 50 %, plancher 50 TND, au-dessus au prorata                                           |

Le simulateur de la fenêtre « Nouvelle règle » applique le même calcul que la paie. Essayez-y la règle avant de
l'enregistrer.

## 4. Coworking (Paramètres > Coworking)

Les réglages et leurs valeurs par défaut sont décrits dans `docs/hypotheses-a-valider.md`, section « Valeurs par
défaut du coworking ».

## 5. Automatisations (Paramètres > Automatisations)

Chaque tâche répétitive a trois modes au plus : **Désactivé** (défaut), **À confirmer** (le travail est préparé et
attend dans **Propositions**, une personne le confirme ou le refuse) et **Automatique** (fait sans confirmation, tracé
au journal d'audit sans nom d'utilisateur). Les heures sont celles du centre. Activer une tâche ne la lance jamais tout
de suite : si son heure est déjà passée dans la période en cours, elle part à la période suivante.

| Tâche                     | Modes                        | Réglages et défauts                                                                           |
| ------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------- |
| Relances d'impayés        | Désactivé, À confirmer, Auto | Lundi 09:00 ; pas de nouvelle relance avant 7 jours ; montant dû minimum 0                    |
| Paie du mois              | Désactivé, À confirmer, Auto | Le 2 du mois à 07:00, pour le mois précédent ; résumé par e-mail aux rôles Admin et Comptable |
| Programme du lendemain    | Désactivé, Auto              | 18:00 ; envoyé aux rôles Admin et Secrétariat                                                 |
| Avis de courrier (cowork) | Désactivé, Auto              | Aucun : l'avis part à l'enregistrement du courrier                                            |

Précisions :

- **Relances** : un élève est relancé s'il a une échéance en retard au-delà du délai de grâce, une adresse e-mail
  (reçu, tuteur d'un mineur ou élève), et s'il n'a pas reçu de relance depuis le nombre de jours choisi. Les montants
  sont relus au moment de l'envoi : un élève qui a payé entre la proposition et la confirmation ne reçoit rien. Seul
  un rôle qui peut envoyer des relances (Secrétariat, Admin) voit et confirme la proposition.
- **Paie** : à confirmer, rien n'est enregistré avant la confirmation par la comptabilité ; en automatique, les
  éléments sont calculés. Dans les deux cas, la **validation** des éléments reste une décision de la comptabilité.
  Le résumé signale l'intervenant sans règle et la séance tenue dont la feuille n'est pas validée.
- **Propositions** : une proposition expire au bout de 7 jours ; une nouvelle proposition du même type remplace celle
  qui attend encore.
- **Acceptation des réservations du coworking** : ce n'est pas une automatisation, c'est déjà un réglage du coworking
  (mode d'approbation : aucune, visiteurs seulement, toutes ; et « approbation requise » par type de ressource).
  Une demande qui respecte les règles et n'exige pas d'approbation est confirmée d'office.
- Les e-mails exigent un serveur d'envoi configuré (`SMTP_HOST`). Sans lui, une exécution qui doit envoyer est
  marquée « Échec » avec la raison, visible sous la tâche.
- Chaque exécution figure sous sa tâche, avec son résultat. Les événements `reminders.sent`, `proposal.*`,
  `automation.*` et `cw_mail_item.notified` peuvent être relayés vers n8n (voir `docs/integrations-n8n.md`).

## 6. Café et point de vente (Café > Produits et stock > Réglages du café)

Le café a sa propre caisse, séparée de la caisse du centre : ses ventes n'entrent pas dans le journal de caisse
des encaissements, et sa clôture est indépendante.

| Réglage                   | Effet                                                                                                                                   | Défaut  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Fond de caisse            | Espèces laissées chaque matin ; espèces attendues à la clôture = fond + ventes en espèces                                               | 0       |
| Vente en rupture de stock | Autorisée : la vente passe et le stock devient négatif. Refusée : la vente est bloquée                                                  | Refusée |
| Préfixe des tickets       | Début du numéro de ticket (`CAF-2026-000001`), numérotation par année                                                                   | `CAF`   |
| Impression du ticket      | Aucune (centre sans imprimante), imprimante de bureau, ou imprimante à tickets 58 / 80 mm                                               | Aucune  |
| Achats                    | Réception simple ; réception avec fournisseur obligatoire ; ou bons de commande (brouillon, envoyé, reçu) seuls à faire entrer du stock | Simple  |
| Produit : suivre le stock | Décoché pour ce qui se prépare sur place (café express) : aucune quantité n'est décomptée                                               | Coché   |
| Produit : seuil d'alerte  | Le produit est signalé « stock bas » quand la quantité atteint ce nombre                                                                | Aucun   |

Règles fixes : le prix d'une vente est lu sur le serveur au moment de la vente ; un mouvement de stock n'est jamais
modifié (une erreur se corrige par un inventaire, avec motif) ; une journée clôturée n'accepte plus ni vente ni
annulation ; un écart de caisse exige un commentaire. Chaque opération est tracée au journal d'audit
(`cafe.*`), donc disponible pour les webhooks.

Droits : le secrétariat vend et consulte ; la comptabilité consulte et clôture ; l'administrateur gère les produits,
le stock, les réglages et annule une vente.

## 7. Modules

Les modules formation, coworking, site web et café s'activent avec la commande `modules`, réservée à l'éditeur du
logiciel et journalisée.
