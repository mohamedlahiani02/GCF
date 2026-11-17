# Chantiers décidés, pas encore construits

Ce fichier garde la trace des chantiers validés dans leur principe. Rien ici n'est dans le produit aujourd'hui.

## 1. AXÉLIA comme client MCP (en plus du serveur MCP)

Décision du porteur : AXÉLIA doit pouvoir appeler les serveurs MCP d'autres services (Slack, agenda, etc.), en plus d'exposer
son propre serveur (`docs/serveur-mcp.md`). Plan proposé, en attente de « go » :

1. **Connexions MCP** (Paramètres > Intégrations) : le consultant ajoute un serveur externe (adresse https et jeton), puis le
   teste (`initialize`, puis `tools/list`). Le jeton est stocké sans jamais être réaffiché. Les adresses internes ou privées
   sont refusées (protection SSRF).
2. **Règles « quand... alors... »** : quand un événement d'AXÉLIA se produit (mêmes événements que les webhooks), appeler un
   outil d'une connexion avec des arguments à trous (`#finance`, « Paiement reçu : {{montant}} TND »). Envois journalisés et
   réessayés avec la file des webhooks.
3. **Données personnelles** : par défaut seuls les identifiants, le montant et le type d'événement sortent. Noms, e-mails et
   téléphones ne partent que si la règle le demande explicitement.

Limites annoncées : transport HTTP « streamable » seulement ; les serveurs qui exigent OAuth ne fonctionnent que s'ils
acceptent un jeton fixe (sinon passer par n8n ou Zapier) ; mode automatique seulement dans une première version.
Question ouverte : limiter le « alors » aux outils MCP, ou ajouter un appel HTTP libre. Recommandation : MCP seul.

## 2. Autres chantiers reportés

| Chantier                         | Condition préalable                                                              |
| -------------------------------- | -------------------------------------------------------------------------------- |
| Agent WhatsApp ELIA              | Vérification Meta Business, décision INPDP, jeton personnel lié à un utilisateur |
| Paiement en ligne (Flouci, etc.) | Contrat avec un prestataire, décision sur les frais et le rapprochement          |
| Événements (version simple)      | Cadrage du besoin avec un client réel                                            |
| Framework d'implémentation       | Voir `docs/etude-framework-integration.md`                                       |
