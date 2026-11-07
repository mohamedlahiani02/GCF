/** French wording for the error codes of access tokens and webhooks. */
export const INTEGRATION_MESSAGES: Record<string, string> = {
  read_only_token: "Ce jeton est en lecture seule.",
  token_not_allowed: "Un jeton d'accès ne peut pas utiliser cette partie de l'application.",
  ambiguous_credentials: "Envoyez soit un cookie de session, soit un jeton, pas les deux.",
  expiry_in_past: "La date d'expiration doit être dans le futur.",
  already_revoked: "Ce jeton est déjà révoqué.",
  not_failed: "Seul un envoi en échec peut être renvoyé.",
  ping_not_retried: "Un test ne se renvoie pas : lancez un nouveau test.",
  endpoint_inactive: "Réactivez le webhook avant de renvoyer.",
};
