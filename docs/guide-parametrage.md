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

## 5. Modules

Les modules formation, coworking et site web s'activent avec la commande `modules`, réservée à l'éditeur du
logiciel et journalisée.
