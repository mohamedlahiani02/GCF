/** Status wording and badge colours from the design system. A status is never shown by colour alone. */

export type Tone = "green" | "red" | "amber" | "blue" | "violet" | "teal" | "orange" | "gray" | "neutral";

export const INSTALLMENT_STATE: Record<string, { label: string; tone: Tone; strike?: boolean }> = {
  paid: { label: "Payé", tone: "green" },
  partial: { label: "Partiel", tone: "amber" },
  overdue: { label: "En retard", tone: "red" },
  postponed: { label: "Reporté", tone: "violet" },
  upcoming: { label: "À venir", tone: "neutral" },
  cancelled: { label: "Annulé", tone: "gray", strike: true },
  pending_discount: { label: "Remise à valider", tone: "amber" },
  discount: { label: "Remise", tone: "teal" },
  rejected_discount: { label: "Remise refusée", tone: "gray", strike: true },
};

export const ATTENDANCE: Record<string, { label: string; short: string; tone: Tone }> = {
  present: { label: "Présent", short: "P", tone: "green" },
  absent: { label: "Absent", short: "A", tone: "red" },
  absent_justified: { label: "Absent justifié", short: "J", tone: "amber" },
  present_other_group: { label: "Présent dans un autre groupe", short: "R", tone: "blue" },
};

export const SHEET: Record<string, { label: string; tone: Tone }> = {
  none: { label: "Non faite", tone: "red" },
  in_progress: { label: "En cours", tone: "amber" },
  validated: { label: "Validée", tone: "green" },
};

export const METHOD: Record<string, string> = { cash: "Espèces", transfer: "Virement", cheque: "Chèque", card: "Carte" };
export const CHEQUE: Record<string, string> = { received: "Reçu", deposited: "Déposé", cashed: "Encaissé", bounced: "Impayé" };
export const ROLE: Record<string, string> = { admin: "Admin", secretariat: "Secrétariat", accountant: "Comptable" };
export const EMPLOYMENT: Record<string, string> = { salaried: "Salarié", freelance: "Freelance", contractor: "Vacataire" };
export const KIND_INSTRUCTOR: Record<string, string> = { teacher: "Professeur", trainer: "Formateur" };
export const RENTAL_UNIT: Record<string, string> = { hour: "Heure", half_day: "Demi-journée", day: "Journée", month: "Mois", year: "Année" };
export const PAY_BASE: Record<string, string> = {
  pct_collections: "% des encaissements du groupe",
  pct_session_tariff: "% du tarif de séance",
  fixed_per_session: "Montant fixe par séance",
  monthly_flat: "Forfait mensuel",
  hourly: "Horaire",
  training_flat: "Forfait de formation",
};
export const PRESENCE_EFFECT: Record<string, string> = {
  ignore: "Ignorée (100 %)",
  prorata: "Au prorata du taux de présence",
  session_due: "Séance due (payée même sans élève)",
  threshold: "Seuil minimum",
};
export const PAYMENT_MODE: Record<string, string> = { full: "Intégral", installments: "Tranches", monthly: "Mensuel", per_session: "À la séance" };
