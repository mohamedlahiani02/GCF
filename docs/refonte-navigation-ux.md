# Navigation et accueil — prototype local

Branche : `feat/ux-launchpad`, créée depuis `test/n8n-automations` au commit `82220bb` pour conserver les intégrations et automatisations en cours de test. Le checkout de `main` reste séparé.

## Intention

Le menu précédent affichait simultanément les tâches quotidiennes, les référentiels et les fonctions de chaque module. La navigation dépassait la hauteur de l’écran. L’accueil mélangeait indicateurs et opérations alors que l’utilisateur cherchait surtout une action.

La refonte reprend les raccourcis du lanceur SAP et la sobriété des références fournies : menu court, fond clair, actions nommées par leur résultat et détails accessibles dans un espace métier.

Une liste de sous-menus repliables aurait conservé une longue navigation une fois les sections ouvertes. Les espaces métier donnent un menu stable, avec une navigation contextuelle sur leurs pages.

## Structure

- Accueil : huit raccourcis personnalisables, recherche d’actions et accès aux espaces.
- Formation et cours : inscriptions, groupes, présences et planning ; dossiers des élèves, profs / formateurs, cours, formations et salles.
- Coworking : plan en direct, accueil client, demandes et planning ; clients, abonnements, courrier et statistiques.
- Finances : encaisser, suivre les échéances, paie, caisse, reçus, tableau de bord et rapports.
- Site web : pages, demandes et médiathèque.
- À traiter : propositions des automatisations, avec le compteur existant.
- Paramètres, en bas : administration, réglages des modules, automatisations et intégrations.

Les espaces, liens, résultats de recherche et raccourcis sont filtrés avec les permissions existantes. Les routes métier et leurs gardes sont conservées ; le tableau de bord historique est déplacé à `/tableau-de-bord`. Les identifiants, URL et paramètres techniques relatifs aux intervenants restent identiques. Seul leur affichage devient « Prof / Formateur ».

Les raccourcis sont stockés par identifiant utilisateur dans ce navigateur (`gcf.shortcuts.v1.<userId>`). Ils ne sont pas synchronisés entre appareils. Si le stockage est refusé, le choix reste valable pour la visite.

## Présentation

- Couleurs du produit conservées : fond `#f5f6f8`, surface `#ffffff`, texte `#1b2430`, texte secondaire `#566274`, accent `#0e5a8a`.
- IBM Plex Sans conservée ; titres plus lisibles, actions espacées et références présentées en lignes compactes.
- Barre latérale de 228 px, réductible à 76 px ; menu repliable sur mobile.
- Liens de navigation natifs, boutons pour ouvrir les assistants existants, focus visible et lien « Aller au contenu ».
- Échap ferme le menu mobile et la personnalisation des raccourcis.

## Plan coworking

Le plan en direct dispose de boutons − / +, d’un pourcentage, d’une « Vue d’ensemble » et d’une « Vue agrandie ». La zone du plan garde une hauteur stable, indépendante de sa position dans la page. Le niveau 100 % correspond à la vue d’ensemble ajustée à cette zone ; les boutons progressent par pas de 25 points, entre 50 % et 400 %. Le zoom conserve le point regardé au centre, y compris après déplacement du plan.

Un plan agrandi se parcourt en glissant à la souris, par défilement tactile, avec les barres de défilement ou avec les flèches lorsque sa zone a le focus. Glisser depuis une ressource ne déclenche pas sa réservation. « Agrandir la vue » ouvre le plan dans une fenêtre dédiée avec gestion native du focus et fermeture par Échap ; sélectionner une place ferme cette fenêtre et ouvre sa fiche habituelle.

Le zoom est propre à la consultation : coordonnées, réservations, plans publiés, portail public et éditeur ne sont pas modifiés. Changer d’étage rétablit la vue d’ensemble ; le rafraîchissement périodique conserve le zoom choisi. Dans la zone du plan, + et − zooment ; 0 rétablit la vue d’ensemble. Les raccourcis de zoom du navigateur restent disponibles avec Ctrl / Cmd.

## Vérification locale

Contrôles réalisés dans le navigateur connecté au centre de démonstration :

- Accueil, espaces Formation et Coworking et fiche Profs / Formateurs accessibles.
- Recherche « formateur » : fiche des profs / formateurs et paie retrouvées.
- Modification des favoris, conservation après rechargement et restauration des favoris conseillés.
- Ouverture du tiroir Encaisser et de l’assistant Accueil coworking, sans enregistrer d’opération.
- Paramètres : Automatisations et Intégrations accessibles.
- Barre latérale compacte : largeur de 76 px, liens nommés et sans débordement.
- Accueil à 390 px et 320 px : aucun débordement horizontal de la page.
- Menu mobile : ouverture, fermeture avec Échap et retour du focus au bouton Menu.
- Plan : zoom avant / arrière, taille réelle, ajustement et raccourcis clavier.
- À 100 %, sélectionner D-01 ouvre le tiroir de la bonne ressource.
- Carte d’occupation : les 13 ressources sont toujours affichées avec leur coloration.
- Plan à 390 px : dessin contenu dans la zone ajustée, sans débordement horizontal de la page.
- Correction après retour utilisateur : abandon de la hauteur calculée à partir du défilement de la page, qui rendait le plan trop petit et instable.
- Zoom en vue normale : hauteur intérieure stable à 474 px et défilement de page inchangé entre deux agrandissements (149 px).
- En vue agrandie, déplacement à la souris de 150 px horizontalement ; aucune fiche ne s’ouvre pendant le glissement.
- Le centre de la zone regardée reste aux mêmes coordonnées du plan après zoom, à moins de 0,1 % près sur le parcours vérifié.
- Raccourcis clavier : limites de 50 % et 400 % respectées, boutons correspondants désactivés ; 0 revient à 100 % et recentre.
- Vue agrandie à 390 × 844 px : fenêtre entièrement contenue dans l’écran ; Échap ferme et remet le focus sur son bouton.
- Sélection de D-01 depuis la vue agrandie : fiche habituelle accessible et focus dans son formulaire.

TypeScript et compilation du front vérifiés. Cette vérification ne constitue pas une certification WCAG ni un test avec lecteur d’écran. Les parcours authentifiés ont été essayés avec le compte administrateur de démonstration ; les permissions serveur ne sont pas modifiées.

## Guides utilisés

Skills installés à la demande depuis Anthropics, Vercel Labs, Bencium et AccessLint. Les principes de réduction, de divulgation progressive, de navigation au clavier et de contrôle du repli ont guidé cette version. Les composants et styles existants sont conservés pour éviter d’introduire une deuxième bibliothèque d’interface.

Référence de revue : [Web Interface Guidelines](https://github.com/vercel-labs/web-interface-guidelines).
