# Décisions et points ouverts

Chaque règle ci-dessous est implémentée telle qu'écrite. Les réglages marqués « paramétrable » se changent dans
Administration, sans intervention technique.

## Décisions validées par le client

### Élèves

1. **Âge** : aucune règle d'âge. La fiche porte une case « élève mineur » ; un mineur doit avoir un parent ou tuteur
   avec un nom et au moins un téléphone ou un e-mail. La date de naissance est facultative et sert d'information.

### Présences

2. **Taux de présence** = présences comptées / présences attendues, sur les feuilles validées uniquement.
   Par défaut l'absence justifiée n'est pas comptée comme présente et le rattrapage dans un autre groupe l'est,
   pour le groupe d'origine (paramétrable par centre et par groupe). Un élève invité en rattrapage n'entre pas dans le
   taux du groupe d'accueil.

### Paie

3. **Séance annulée** : une séance annulée n'est jamais due ni payée, quel que soit l'effet de présence. Seules les
   séances tenues dont la feuille est validée entrent dans la paie.
4. **« Ignorée » et « Séance due »** paient toutes les deux chaque séance tenue à 100 %, même sans élève présent.
5. **Seuil minimum** : sous le seuil, rien n'est payé, ou le plancher s'il est renseigné. Au-dessus, la paie est
   complète, ou au prorata si l'option « au-dessus du seuil, payer au prorata » est cochée sur la règle.
6. **Tarif de séance** : c'est un montant saisi sur la règle de rémunération. La base vaut
   pourcentage x tarif de séance x séances tenues.
7. **Arrondi** : un seul arrondi au millime, au demi supérieur, à l'application du facteur de présence.

### Reçus

8. **Mentions des reçus** : un texte par défaut est imprimé en pied de reçu (numérotation continue, archivage, document
   non modifiable, correction par reçu d'annulation). Il se remplace dans Administration, ainsi que le préfixe de
   numérotation (`REC` par défaut).

### Comptabilité

9. **Écritures comptables légales** : prévues en phase 2. Tout mouvement d'argent (échéance émise ou annulée,
   paiement, annulation, remboursement, chèque impayé, paie validée et payée, clôture de caisse) est déjà enregistré
   dans le journal `financial_events`, en ajout seul et avec ses axes (élève, loueur, groupe, étude, formation,
   intervenant). Les écritures au plan comptable tunisien pourront en être produites sans reprise des données.

## Valeurs par défaut (paramétrables)

| Réglage                                    | Défaut                                                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Reports par échéance                       | 2 au maximum ; ceux du secrétariat attendent la validation d'un administrateur                                                  |
| Délai de grâce avant retard                | 0 jour                                                                                                                          |
| Heures d'ouverture (occupation des salles) | 08:00 à 20:00, du lundi au samedi                                                                                               |
| Changement de groupe                       | Conserver le plan, ou recalculer au tarif du nouveau groupe les mois non payés à partir du mois d'effet (facturation mensuelle) |
| Abandon                                    | Les échéances non payées dues après la date d'abandon sont annulées ; aucun remboursement automatique                           |

## Point encore ouvert

10. **Statut de l'intervenant** : payer un salarié au prorata de la présence des élèves peut poser un problème en droit
    du travail tunisien. À faire valider par un juriste ; l'application ne bloque pas cette combinaison.
