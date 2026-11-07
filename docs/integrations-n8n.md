# Intégrations : n8n, webhooks et jetons d'accès

GCF reste le seul endroit où vivent les règles métier, les droits et le journal d'audit. Un outil externe comme n8n
ne décide de rien : il **reçoit** les événements de GCF et **agit** sur les canaux (Telegram, Gmail, Google Calendar,
WhatsApp) ou rappelle l'API de GCF, avec les droits d'un rôle et sous les mêmes contrôles qu'un utilisateur.

Deux briques, réglées par un administrateur dans **Paramètres > Intégrations** :

| Brique        | Sens        | Usage                                                                                           |
| ------------- | ----------- | ----------------------------------------------------------------------------------------------- |
| Jeton d'accès | outil → GCF | Appeler l'API (lire un élève, une séance…) avec les droits d'un rôle, en lecture seule ou non.  |
| Webhook       | GCF → outil | Recevoir, signé, chaque changement inscrit au journal d'audit (inscription, paiement, séance…). |

## 1. Jetons d'accès

- Un jeton porte un **rôle** : Secrétariat, Comptable ou Éditeur du site. Le rôle Admin n'est jamais proposé.
- Par défaut un jeton est en **lecture seule** : toute requête qui modifie (POST, PUT, PATCH, DELETE) est refusée
  (`403 read_only_token`).
- Le jeton agit **au nom de l'administrateur qui l'a créé**. Il cesse de fonctionner si cet administrateur est
  désactivé ou perd son rôle d'administrateur, s'il est révoqué, ou à sa date d'expiration.
- Un jeton n'accède jamais à la connexion et aux mots de passe (`/api/auth`, sauf `GET /api/auth/session`), aux
  comptes utilisateurs (`/api/users`) ni aux intégrations elles-mêmes (`/api/integrations`) : `403 token_not_allowed`.
- Chaque modification faite avec un jeton est inscrite au journal d'audit avec l'administrateur **et** le nom du
  jeton (« via le jeton n8n relances »).
- Le jeton n'est affiché qu'une fois, à sa création. Seule son empreinte SHA-256 est enregistrée.

Utilisation : en-tête `Authorization: Bearer gcf_…` sur chaque appel à `/api/…`. Aucun cookie ni en-tête `Origin`
n'est nécessaire. Envoyer à la fois un cookie de session et un jeton est refusé (`400 ambiguous_credentials`).

## 2. Webhooks

### Ce qui est envoyé

Chaque ligne écrite au journal d'audit est comparée aux événements de chaque webhook actif. La mise en file se fait
**dans la même transaction** que la modification : un événement n'est jamais perdu, et jamais envoyé pour une
modification annulée.

Un événement se désigne par :

| Forme         | Exemple           | Reçoit                                |
| ------------- | ----------------- | ------------------------------------- |
| Action exacte | `payment.created` | ce seul événement                     |
| Famille       | `payment.*`       | toutes les actions sur les paiements  |
| Tout          | `*`               | toutes les actions du journal d'audit |

La fenêtre du webhook propose les actions déjà survenues dans le centre. Les principales familles : `student`,
`enrolment`, `payment`, `receipt`, `installment`, `postponement`, `reminders`, `session`, `attendance`, `group`,
`pay_items`, `pay_settlement`, `cash`, `rental`, `cw_booking`, `cw_subscription`, `cw_mail_item`, `member`,
`site_lead`, `site_page`.

Requête envoyée : `POST` JSON vers l'adresse du webhook.

| En-tête           | Contenu                                                                  |
| ----------------- | ------------------------------------------------------------------------ |
| `x-gcf-event`     | L'action, par exemple `student.created` (`ping` pour un test)            |
| `x-gcf-delivery`  | Identifiant de l'envoi (le même à chaque nouvel essai)                   |
| `x-gcf-timestamp` | Heure d'envoi, en secondes depuis 1970 (UTC)                             |
| `x-gcf-signature` | `sha256=` suivi du HMAC-SHA256 hexadécimal de `<timestamp>.<corps brut>` |

```json
{
  "id": "evt_1842",
  "type": "student.created",
  "occurredAt": "2026-10-20T08:14:03.512Z",
  "centreId": "6f1c…",
  "object": { "type": "student", "id": "0b7e…" }
}
```

**Aucune donnée personnelle n'est envoyée** : seulement des identifiants. L'outil relit le détail avec un jeton
d'accès (section 4), sous les droits de son rôle. Ainsi, ce que n8n peut lire est décidé dans GCF, pas dans le
webhook.

### Garanties et nouvelles tentatives

- **Au moins une fois.** Un envoi est réussi si le destinataire répond `2xx` en moins de 10 secondes
  (`WEBHOOK_TIMEOUT_SECONDS`). Sinon, nouvel essai après 1 min, puis 2, 4, 8… et au plus 6 h entre deux essais,
  jusqu'au nombre maximum d'essais du webhook (10 par défaut). Ensuite l'envoi passe en « Échec » et peut être
  renvoyé à la main depuis le journal des envois.
- Un même événement peut donc arriver deux fois (par exemple si n8n a traité la requête mais que sa réponse s'est
  perdue). **Dédoublonnez sur `id`** si l'action ne doit pas être répétée.
- **L'ordre n'est pas garanti** entre deux événements quand l'un a dû être réessayé. `occurredAt` et le numéro dans
  `id` (croissant) donnent l'ordre réel.
- Les redirections ne sont pas suivies : donnez l'adresse finale.
- Désactiver un webhook abandonne ses envois en attente ; le réactiver ne rejoue pas ce qui s'est passé entre-temps.
- Le journal des envois garde 30 jours (`WEBHOOK_RETENTION_DAYS`). Les envois sont traités toutes les 15 secondes
  (`WEBHOOK_DISPATCH_SECONDS`).
- Plusieurs serveurs GCF peuvent tourner en même temps : un envoi n'est jamais traité par deux serveurs à la fois.

### Le secret de signature

Il est affiché une seule fois, à la création du webhook et à chaque régénération. Il est stocké en clair dans la base
de GCF, car il faut pouvoir signer avec. Quiconque lit la base peut donc fabriquer un envoi signé. Régénérez-le en
cas de doute, puis mettez le nouveau dans n8n aussitôt.

## 3. Mettre n8n en place

`deploy/n8n/` contient un `docker-compose.yml` et un `.env.example`.

```bash
cd deploy/n8n
cp .env.example .env      # renseigner N8N_VERSION, N8N_ENCRYPTION_KEY, GCF_API_URL et, plus tard, GCF_WEBHOOK_SECRET
docker compose up -d
curl -s http://localhost:5678/healthz
```

Puis, dans l'ordre :

1. **GCF > Paramètres > Intégrations > Jetons d'accès** : créer un jeton « n8n », rôle Secrétariat, lecture seule.
2. **n8n > Credentials > Header Auth** : nom `Authorization`, valeur `Bearer gcf_…`.
3. **n8n** : créer un workflow avec un nœud **Webhook** (méthode POST, chemin `gcf`, réponse « Immediately »).
   L'adresse de production s'affiche dans le nœud, par exemple `http://localhost:5678/webhook/gcf`.
4. **GCF > Intégrations > Webhooks** : créer le webhook avec cette adresse. Depuis le serveur de GCF, l'adresse doit
   être joignable : `http://localhost:5678/…` si GCF tourne sur le même poste hors Docker.
5. Copier le secret affiché dans `GCF_WEBHOOK_SECRET` du `.env` de n8n, puis `docker compose up -d` pour l'appliquer.
6. Publier le workflow dans n8n (bouton « Publish » ; un workflow non publié ne reçoit que sur l'adresse de test), puis
   **Tester** dans GCF : le journal des envois doit montrer « Envoyé ».

### Vérifier la signature dans n8n

Juste après le nœud Webhook, un nœud **Code** (JavaScript, « Run Once for All Items ») rejette tout envoi qui ne
vient pas de GCF ou qui a plus de 5 minutes :

```js
const crypto = require("crypto");
const secret = $env.GCF_WEBHOOK_SECRET;
const MAX_AGE_SECONDS = 300;

return $input.all().map((item) => {
  const headers = item.json.headers;
  const timestamp = String(headers["x-gcf-timestamp"] ?? "");
  const received = String(headers["x-gcf-signature"] ?? "");
  // GCF sends compact JSON whose re-serialisation is identical, so the parsed body can be signed again.
  const body = JSON.stringify(item.json.body);
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  const fresh = Math.abs(Date.now() / 1000 - Number(timestamp)) <= MAX_AGE_SECONDS;
  const valid = received.length === expected.length && crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
  if (!fresh || !valid) throw new Error("GCF signature rejected");
  return { json: item.json.body };
});
```

Le `docker-compose.yml` autorise pour cela le module `crypto` (`NODE_FUNCTION_ALLOW_BUILTIN`) et la lecture des
variables d'environnement (`N8N_BLOCK_ENV_ACCESS_IN_NODE=false`, bloquée par défaut dans n8n).

Vérifié avec n8n 2.46.6 : un envoi réel de GCF passe le contrôle, un envoi au secret faux est rejeté (l'exécution
s'arrête en erreur et rien n'est transmis aux nœuds suivants).

## 4. Recettes

Chaque recette part du nœud Webhook et du nœud Code ci-dessus, puis d'un nœud **Switch** sur `{{ $json.type }}`.

### Nouvel élève → message Telegram au secrétariat

- Webhook GCF : événement `student.created`.
- **HTTP Request** : GET `{{ $env.GCF_API_URL }}/api/students/{{ $json.object.id }}`, authentification « Header Auth »
  (le jeton n8n).
- **Telegram** (Send Message) : `Nouvel élève : {{ $json.firstName }} {{ $json.lastName }}`.

### Séance annulée ou déplacée → message Telegram

- Webhook GCF : événements `session.cancelled` et `session.moved`.
- **HTTP Request** : GET `{{ $env.GCF_API_URL }}/api/sessions/{{ $json.object.id }}/sheet` (le jeton doit avoir un rôle
  qui lit les présences : Secrétariat ou Comptable).
- **Telegram** : groupe `{{ $json.session.groupName }}`, le `{{ $json.session.localDate }}`, statut
  `{{ $json.session.status }}`.

Gmail se branche de la même façon, à la place de Telegram.

## 5. Sécurité, en résumé

- Un jeton par outil, avec le rôle le plus limité, en lecture seule tant que c'est possible, avec une date
  d'expiration si l'usage est temporaire.
- n8n exposé sur Internet seulement derrière un proxy HTTPS ; en local, le `docker-compose.yml` ne l'ouvre que sur
  `127.0.0.1`.
- Les identifiants Google, Telegram ou WhatsApp sont enregistrés dans n8n, jamais dans GCF ni dans ce dépôt.
- Toute modification passe par l'API de GCF : mêmes contrôles, mêmes refus, même journal d'audit qu'à l'écran.
