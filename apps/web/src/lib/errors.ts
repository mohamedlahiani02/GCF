import { ApiError } from "../api/client";

/** French wording for the API's stable error codes. Unknown codes fall back to a generic sentence. */
const MESSAGES: Record<string, string> = {
  invalid_credentials: "E-mail ou mot de passe incorrect.",
  account_locked: "Trop d'essais : le compte est bloqué pour quelques minutes.",
  unauthenticated: "Votre session a expiré. Reconnectez-vous.",
  forbidden: "Vous n'avez pas accès à cette action.",
  bad_origin: "Requête refusée pour des raisons de sécurité. Rechargez la page.",
  invalid_input: "Certains champs sont invalides.",
  not_found: "Élément introuvable.",
  duplicate: "Cette valeur existe déjà.",
  constraint_violation: "Cette opération enfreint une règle de gestion.",
  guardian_required: "Un élève mineur doit avoir un parent ou tuteur avec un téléphone ou un e-mail.",
  last_admin: "Le centre doit garder au moins un administrateur actif.",
  schedule_conflict: "Conflit de planning : le créneau est déjà pris.",
  group_full: "Le groupe est complet.",
  payment_mode_not_allowed: "Ce mode de paiement n'est pas autorisé pour cette offre.",
  plan_required: "Choisissez un plan de tranches.",
  plan_total_mismatch: "Le total des tranches doit être égal au prix.",
  invalid_discount: "La remise doit être positive et ne peut pas dépasser le total.",
  discount_not_applicable: "Aucune remise possible : il n'y a pas d'échéancier à l'avance.",
  installment_paid: "Cette échéance a déjà reçu un paiement : annulez d'abord le paiement.",
  already_paid: "Cette échéance est déjà payée.",
  too_many_postponements: "Nombre maximal de reports atteint pour cette échéance.",
  postponement_pending: "Un report de cette échéance attend déjà une validation.",
  date_not_later: "La nouvelle date doit être postérieure à l'échéance actuelle.",
  insufficient_credit: "Le solde créditeur est insuffisant.",
  credit_refunded: "Une partie de ce paiement a été remboursée : annulez d'abord le remboursement.",
  already_cancelled: "Déjà annulé.",
  cash_closed: "La caisse du jour est clôturée : aucun mouvement d'argent jusqu'à demain.",
  already_closed: "Cette journée est déjà clôturée.",
  comment_required: "Un commentaire est obligatoire en cas d'écart.",
  sheet_validated: "La feuille est validée : seul l'administrateur peut la corriger, avec un motif.",
  session_not_started: "La feuille peut être validée une fois la séance commencée.",
  host_sheet_validated: "La feuille de la séance d'accueil est déjà validée.",
  period_locked: "Cette période de paie est validée et ne peut plus changer.",
  not_calculated: "Calculez la période avant de la valider.",
  mail_not_configured: "L'envoi d'e-mails n'est pas configuré sur ce serveur.",
  no_recipient: "Aucune adresse e-mail connue pour ce destinataire.",
  no_tariff: "La salle n'a pas de tarif pour cette durée.",
  different_offer: "Un changement de groupe reste dans la même étude ou formation.",
  reprice_not_applicable: "Le recalcul s'applique uniquement à la facturation mensuelle.",
  capacity_below_enrolment: "La capacité ne peut pas être inférieure au nombre d'inscrits.",
  has_active_enrolments: "Transférez ou clôturez d'abord les inscriptions du groupe.",
  has_active_groups: "Archivez ou réaffectez d'abord les groupes actifs.",
  session_has_attendance: "Une séance avec des présences ne peut pas être annulée.",
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "invalid_input" && Array.isArray(error.details) && error.details.length) {
      const first = error.details[0] as { path?: string; message?: string };
      return `${MESSAGES.invalid_input} (${first.path || "formulaire"} : ${first.message ?? ""})`;
    }
    return MESSAGES[error.code] ?? error.message;
  }
  if (error instanceof TypeError) return "Le serveur ne répond pas. Vérifiez la connexion.";
  return "Une erreur inattendue est survenue.";
}

export interface ConflictItem {
  type: "room" | "instructor" | "group";
  startsAt?: string;
  endsAt?: string;
  groupName?: string;
  weekday?: number;
  startTime?: string;
  endTime?: string;
  description?: string;
}

export function conflictsOf(error: unknown): ConflictItem[] {
  if (error instanceof ApiError && error.code === "schedule_conflict") {
    const details = error.details as { conflicts?: ConflictItem[] } | undefined;
    return details?.conflicts ?? [];
  }
  return [];
}
