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
   paiement, annulation, remboursement, chèque impayé, élément de paie validé, réglé ou annulé, clôture de caisse) est déjà enregistré
   dans le journal `financial_events`, en ajout seul et avec ses axes (élève, loueur, groupe, cours particulier,
   formation, intervenant). Les écritures au plan comptable tunisien pourront en être produites sans reprise des données.

## Valeurs par défaut (paramétrables)

| Réglage                                    | Défaut                                                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Reports par échéance                       | 2 au maximum ; ceux du secrétariat attendent la validation d'un administrateur                                                  |
| Délai de grâce avant retard                | 0 jour                                                                                                                          |
| Heures d'ouverture (occupation des salles) | 08:00 à 20:00, du lundi au samedi                                                                                               |
| Changement de groupe                       | Conserver le plan, ou recalculer au tarif du nouveau groupe les mois non payés à partir du mois d'effet (facturation mensuelle) |
| Abandon                                    | Les échéances non payées dues après la date d'abandon sont annulées ; aucun remboursement automatique                           |

## Hypothèses retenues pour cette version (à confirmer)

10. **Vocabulaire** : « Cours particulier » remplace « Étude » dans tout l'affichage (écrans, PDF, rapports,
    exports). Les identifiants techniques (`study`, `studies`) ne changent pas. Un cours particulier a un ou plusieurs
    groupes ; chaque groupe a ses élèves et ses séances.
11. **Formules d'une formation** : une formation se vend par une ou plusieurs formules, chacune avec son nom :
    - paiement intégral : une échéance à l'inscription, au prix de la formation ou à un prix propre à la formule ;
    - par tranches : pourcentages ou montants dont le total égale le prix de la formation ;
    - mensuel : un montant par mois jusqu'à la fin du groupe, comme un cours particulier mensuel ;
    - à la séance : un tarif par séance validée, absences facturées ou non, comme un cours particulier à la séance.
      Le tarif est figé à l'inscription : modifier la formule ne change pas le prix des élèves déjà inscrits.

    Une inscription à une formation choisit toujours une formule. À la migration, chaque formation qui acceptait le
    paiement intégral reçoit une formule « Paiement intégral » ; les plans de tranches existants deviennent des
    formules « par tranches ».

12. **Paie par élément** : chaque règle produit des éléments de rémunération à son rythme, calculés, validés et réglés
    intervenant par intervenant, sans validation globale du mois :
    - à la séance : un élément par séance tenue, validable dès que la feuille de présence est validée (par défaut
      pour le forfait par séance et le pourcentage du tarif, en option pour le taux horaire) ;
    - au mois : un élément par mois, validable à partir du dernier jour du mois (forfait mensuel, pourcentage des
      encaissements ou du facturé, taux horaire par défaut, et en option les règles à la séance) ;
    - à la formation (forfait formation) : un élément pour le groupe, calculé le mois où le groupe se termine et
      validable à partir de sa date de fin.

    Plusieurs règles d'un même intervenant donnent des éléments distincts. Une séance n'est payée qu'une fois : un
    élément validé n'est jamais recalculé, et une nouvelle règle plus précise ne reprend pas une séance déjà payée.

13. **Corrections** : un élément calculé est remplacé au recalcul si son montant change (motif « Recalculé »). Un
    élément validé se corrige par une annulation motivée tant que rien n'a été réglé dessus, ou par une prime ou une
    retenue. Rien n'est supprimé.
14. **Règlement** : un règlement paie un ou plusieurs éléments validés d'un même intervenant, en totalité ou en partie
    (dû, déjà payé, reste). Une retenue est imputée en totalité dans le règlement qui l'inclut, et un règlement est
    toujours positif. Chaque règlement a un justificatif PDF numéroté `REG-AAAA-000001` ; son annulation est motivée et
    rouvre les montants.
15. **Reprise de l'ancienne paie** : les mois déjà validés ou payés deviennent des éléments validés ; les bulletins
    payés restent comme justificatifs (numéros `PAIE-AAAA-MM-…`). Les mois encore en brouillon sont recalculés.

## Point encore ouvert

16. **Statut de l'intervenant** : payer un salarié au prorata de la présence des élèves peut poser un problème en droit
    du travail tunisien. À faire valider par un juriste ; l'application ne bloque pas cette combinaison.
