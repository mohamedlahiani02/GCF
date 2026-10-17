import { ApiError } from "../api/client";
import type { Language } from "../i18n/i18n";

/** Stable error codes the portal API can answer (apps/api/src/routes/portal and the booking rules it applies). */
const CODES = [
  "portal_unavailable",
  "public_unavailable",
  "unauthenticated",
  "forbidden",
  "not_found",
  "invalid_input",
  "bad_origin",
  "bad_request",
  "internal_error",
  "duplicate",
  "constraint_violation",
  "schedule_conflict",
  "invalid_reference",
  "invalid_credentials",
  "account_locked",
  "account_pending",
  "signup_closed",
  "email_taken",
  "invalid_token",
  "member_inactive",
  "resource_not_bookable",
  "format_mismatch",
  "centre_closed",
  "invalid_slot",
  "invalid_duration",
  "slot_past",
  "slot_taken",
  "room_unavailable",
  "no_price",
  "promo_unknown",
  "promo_expired",
  "promo_not_applicable",
  "promo_exhausted",
  "beyond_horizon",
  "notice_too_short",
  "too_many_active_bookings",
  "daily_limit_exceeded",
  "limits_exceeded",
  "not_cancellable",
  "installment_paid",
  "not_confirmed",
  "already_ended",
] as const;
type ErrorCode = (typeof CODES)[number];

interface ErrorWording {
  codes: Record<ErrorCode, string>;
  invalidField: (field: string, message: string) => string;
  tooManyRequests: string;
  offline: string;
  unexpected: string;
}

const MESSAGES: Record<Language, ErrorWording> = {
  fr: {
    codes: {
      portal_unavailable: "L'espace client n'est pas disponible pour le moment.",
      public_unavailable: "Le service n'est pas disponible pour le moment.",
      unauthenticated: "Votre session a expiré. Reconnectez-vous.",
      forbidden: "Vous n'avez pas accès à cette page.",
      not_found: "Élément introuvable.",
      invalid_input: "Certains champs sont invalides.",
      bad_origin: "Requête refusée pour des raisons de sécurité. Rechargez la page.",
      bad_request: "La demande n'a pas pu être traitée.",
      internal_error: "Une erreur est survenue sur le serveur. Réessayez dans un instant.",
      duplicate: "Cette valeur existe déjà.",
      constraint_violation: "Cette opération enfreint une règle de réservation.",
      schedule_conflict: "Ce créneau chevauche une autre réservation.",
      invalid_reference: "Un élément choisi n'existe plus.",
      invalid_credentials: "E-mail ou mot de passe incorrect.",
      account_locked: "Trop d'essais : le compte est bloqué pour quelques minutes.",
      account_pending: "Votre compte attend la validation de l'accueil.",
      signup_closed: "Les inscriptions en ligne sont fermées : demandez une invitation à l'accueil.",
      email_taken: "Un compte existe déjà avec cette adresse e-mail.",
      invalid_token: "Ce lien n'est plus valable : il a expiré ou a déjà servi. Demandez-en un nouveau.",
      member_inactive: "Votre compte n'est pas actif.",
      resource_not_bookable: "Cette place ne peut pas être réservée.",
      format_mismatch: "Cette formule ne s'applique pas à cette place.",
      centre_closed: "L'espace est fermé ce jour-là.",
      invalid_slot: "Cette heure de début ne correspond à aucun créneau ce jour-là.",
      invalid_duration: "Cette durée n'est pas proposée pour cette formule.",
      slot_past: "Ce créneau est déjà passé.",
      slot_taken: "Cette place vient d'être réservée sur ce créneau. Choisissez une autre place ou un autre créneau.",
      room_unavailable: "Cette salle est occupée sur ce créneau.",
      no_price: "Cette formule n'est pas proposée à la réservation.",
      promo_unknown: "Ce code promotionnel n'existe pas.",
      promo_expired: "Ce code promotionnel n'est pas valable aujourd'hui.",
      promo_not_applicable: "Ce code promotionnel ne s'applique pas à votre compte.",
      promo_exhausted: "Ce code promotionnel a déjà été utilisé le nombre maximal de fois.",
      beyond_horizon: "Cette date est trop éloignée : les réservations ne sont pas encore ouvertes.",
      notice_too_short: "Ce créneau commence trop tôt : le délai minimal de réservation n'est pas respecté.",
      too_many_active_bookings: "Vous avez atteint le nombre maximal de réservations à venir.",
      daily_limit_exceeded: "Vous dépassez la durée maximale réservable par jour pour cet espace.",
      limits_exceeded: "Cette réservation dépasse les limites de l'espace client.",
      not_cancellable: "Cette réservation ne peut plus être annulée.",
      installment_paid: "Un paiement a été enregistré pour cette réservation : adressez-vous à l'accueil.",
      not_confirmed: "Seule une réservation confirmée a un code d'accès.",
      already_ended: "Cette réservation est terminée.",
    },
    invalidField: (field, message) => `Certains champs sont invalides (${field} : ${message}).`,
    tooManyRequests: "Trop de tentatives. Patientez une minute avant de réessayer.",
    offline: "Le serveur ne répond pas. Vérifiez votre connexion.",
    unexpected: "Une erreur inattendue est survenue.",
  },
  en: {
    codes: {
      portal_unavailable: "The client area is not available at the moment.",
      public_unavailable: "The service is not available at the moment.",
      unauthenticated: "Your session has expired. Please sign in again.",
      forbidden: "You do not have access to this page.",
      not_found: "Not found.",
      invalid_input: "Some fields are invalid.",
      bad_origin: "Request refused for security reasons. Reload the page.",
      bad_request: "The request could not be processed.",
      internal_error: "A server error occurred. Try again in a moment.",
      duplicate: "This value already exists.",
      constraint_violation: "This operation breaks a booking rule.",
      schedule_conflict: "This time slot overlaps another booking.",
      invalid_reference: "Something you chose no longer exists.",
      invalid_credentials: "Wrong e-mail address or password.",
      account_locked: "Too many attempts: the account is locked for a few minutes.",
      account_pending: "Your account is waiting for approval by the front desk.",
      signup_closed: "Online sign-up is closed: ask the front desk for an invitation.",
      email_taken: "An account already uses this e-mail address.",
      invalid_token: "This link is no longer valid: it has expired or was already used. Ask for a new one.",
      member_inactive: "Your account is not active.",
      resource_not_bookable: "This seat or room cannot be booked.",
      format_mismatch: "This format does not apply to this seat or room.",
      centre_closed: "The space is closed that day.",
      invalid_slot: "This start time is not a time slot that day.",
      invalid_duration: "This duration is not offered for this format.",
      slot_past: "This time slot is over.",
      slot_taken: "This seat or room has just been booked for this time slot. Choose another one or another time.",
      room_unavailable: "This room is in use during this time slot.",
      no_price: "This format is not open for booking.",
      promo_unknown: "This promotion code does not exist.",
      promo_expired: "This promotion code is not valid today.",
      promo_not_applicable: "This promotion code does not apply to your account.",
      promo_exhausted: "This promotion code has no use left.",
      beyond_horizon: "This date is too far ahead: bookings are not open yet.",
      notice_too_short: "This time slot starts too soon: the minimum notice is not met.",
      too_many_active_bookings: "You have reached the maximum number of upcoming bookings.",
      daily_limit_exceeded: "This exceeds the maximum time you can book per day for this space.",
      limits_exceeded: "This booking exceeds the client area limits.",
      not_cancellable: "This booking can no longer be cancelled.",
      installment_paid: "A payment was recorded for this booking: please ask the front desk.",
      not_confirmed: "Only a confirmed booking has a check-in code.",
      already_ended: "This booking is over.",
    },
    invalidField: (field, message) => `Some fields are invalid (${field}: ${message}).`,
    tooManyRequests: "Too many attempts. Wait a minute before trying again.",
    offline: "The server does not answer. Check your connection.",
    unexpected: "An unexpected error occurred.",
  },
};

const isCode = (code: string): code is ErrorCode => (CODES as readonly string[]).includes(code);

/** The message to show for an error of the portal API, in the chosen language. */
export function errorMessage(error: unknown, language: Language): string {
  const wording = MESSAGES[language];
  if (error instanceof ApiError) {
    if (error.status === 429) return wording.tooManyRequests;
    if (error.code === "invalid_input" && Array.isArray(error.details) && error.details.length) {
      const first = error.details[0] as { path?: string; message?: string };
      return wording.invalidField(first.path ?? "", first.message ?? "");
    }
    return isCode(error.code) ? wording.codes[error.code] : wording.unexpected;
  }
  if (error instanceof TypeError) return wording.offline;
  return wording.unexpected;
}
