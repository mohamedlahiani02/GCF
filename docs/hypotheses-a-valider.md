# Hypothèses à valider avec le client

Points où le cahier des charges laisse plusieurs lectures possibles. Chaque point a une valeur par défaut implémentée
et paramétrable ; aucun n'est figé tant que le client ne l'a pas confirmé.

## Élèves

1. **Âge de la majorité** : 18 ans par défaut, réglable par centre (`centres.majority_age`). Un élève mineur doit avoir
   un parent ou tuteur avec un nom et au moins un téléphone ou un e-mail.

## Présences

2. **Taux de présence** = présences comptées / (inscrits x séances tenues).
   Par défaut l'absence justifiée n'est pas comptée comme présente, le rattrapage dans un autre groupe l'est
   (pour le groupe d'origine). Un élève invité en rattrapage n'entre pas dans le taux du groupe d'accueil.

## Paie (`packages/shared/src/payroll.ts`)

3. **Pourcentage du tarif de séance** : calculé comme pourcentage de (tarif d'une séance x séances tenues).
   La définition du « tarif de séance » d'un groupe (par élève ou pour le groupe) reste à confirmer.
4. **« Ignorée » et « Séance due »** donnent aujourd'hui le même montant (facteur 100 %). Le client doit préciser la
   différence attendue entre ces deux effets.
5. **Seuil minimum** : sous le seuil, la paie est nulle, ou égale au plancher s'il est configuré. Au-dessus, la paie
   est complète par défaut, ou au prorata si l'option « prorata au-dessus du seuil » est activée.
6. **Arrondi** : un seul arrondi au millime, au demi supérieur, à l'application du facteur de présence.
7. **Statut de l'intervenant** : payer un salarié au prorata de la présence des élèves peut poser un problème en droit
   du travail tunisien. À faire valider par un juriste ; l'application ne bloque pas cette combinaison.

## Comptabilité et reçus

8. Le plan comptable (SCE tunisien supposé) et les mentions légales des reçus sont à fournir par le comptable du centre.
