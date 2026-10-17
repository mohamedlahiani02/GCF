import { ApiError } from "../api/client";
import { COWORKING_MESSAGES } from "./errors.coworking";
import { SITE_MESSAGES } from "./errors.site";

/** French wording for the API's stable error codes. Unknown codes fall back to a generic sentence. */
const MESSAGES: Record<string, string> = {
  ...COWORKING_MESSAGES,
  ...SITE_MESSAGES,
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
  plan_required: "Choisissez une formule.",
  invalid_logo: "Le logo doit être une image PNG, JPEG ou WebP.",
  logo_too_large: "Le logo ne doit pas dépasser 512 Ko.",
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
  different_offer: "Un changement de groupe reste dans le même cours particulier ou la même formation.",
  reprice_not_applicable: "Le recalcul s'applique uniquement à la facturation mensuelle.",
  capacity_below_enrolment: "La capacité ne peut pas être inférieure au nombre d'inscrits.",
  has_active_enrolments: "Transférez ou clôturez d'abord les inscriptions du groupe.",
  has_active_groups: "Archivez ou réaffectez d'abord les groupes actifs.",
  session_has_attendance: "Une séance avec des présences ne peut pas être annulée.",
  after_group_end: "La date d'effet tombe après la fin du groupe.",
  already_decided: "Cette demande a déjà été traitée.",
  already_enrolled: "L'élève est déjà inscrit dans ce groupe.",
  billing_mode_locked: "Le mode de facturation ne peut plus changer : des élèves sont inscrits.",
  due_date_changed: "L'échéance a changé depuis la demande de report : refusez-la puis refaites-la.",
  duplicate_unit: "Chaque durée de location n'a qu'un tarif.",
  enrolment_closed: "Cette inscription n'est plus active.",
  filter_required: "Précisez un élève ou un groupe.",
  future_day: "Une journée ne peut être clôturée qu'une fois commencée.",
  group_archived: "Le groupe est archivé.",
  host_cancelled: "La séance de rattrapage choisie est annulée.",
  host_session_required: "Choisissez la séance suivie en rattrapage.",
  installments_not_allowed: "Cette formation se paie uniquement en intégralité.",
  invalid_base: "Un forfait de formation ne s'applique pas à un cours particulier.",
  invalid_cheque: "Un chèque demande son numéro et sa banque.",
  invalid_date: "La date d'effet doit suivre le début de l'inscription.",
  invalid_dates: "La date de fin ne peut pas précéder la date de début.",
  invalid_deposit: "L'acompte doit être positif et inférieur au total.",
  invalid_range: "La date de fin ne peut pas précéder la date de début.",
  invalid_reference: "Un élément référencé n'existe pas ou plus.",
  invalid_times: "La fin de la séance doit suivre son début.",
  invalid_transition: "Ce changement de statut du chèque n'est pas possible.",
  no_slot: "Une location demande au moins un créneau.",
  no_slots: "Le groupe n'a aucun créneau hebdomadaire.",
  not_enrolled: "Un élève de la feuille n'est pas inscrit dans ce groupe à cette date.",
  not_validated: "Seule une période validée peut être payée.",
  overlapping_slots: "Deux créneaux de la location se chevauchent.",
  payment_cancelled: "Ce paiement est annulé.",
  periods_required: "Indiquez le nombre de mois ou d'années.",
  range_too_long: "Générez au plus deux ans de séances à la fois.",
  reason_required: "Un motif est obligatoire.",
  recurring_not_applicable: "Le paiement par période s'applique aux locations au mois ou à l'année.",
  same_group: "Choisissez un autre groupe.",
  session_cancelled: "La séance est annulée.",
  session_locked: "Seule une séance planifiée peut être déplacée.",
  sheet_not_validated: "Utilisez la feuille normale tant qu'elle n'est pas validée.",
  student_archived: "L'élève est archivé.",
  too_many_slots: "Une location compte au plus 400 créneaux.",
  unknown_installment: "Une échéance choisie n'est pas une échéance ouverte de ce payeur.",
  unknown_instructor: "L'intervenant n'existe pas ou est archivé.",
  unknown_plan: "La formule n'appartient pas à cette formation ou est archivée.",
  unknown_room: "La salle n'existe pas ou est archivée.",
  unknown_study: "Le cours particulier n'existe pas ou est archivé.",
  unknown_subject: "Une matière choisie n'existe pas.",
  unknown_training_session: "La session de formation n'existe pas ou est fermée.",
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
