import type { TrainingDetail } from "../api/types";
import { frDate, percent, tnd } from "./format";

export type FormulaKind = TrainingDetail["plans"][number]["kind"];

export const FORMULA: Record<FormulaKind, string> = {
  full: "Paiement intégral",
  installments: "Échéancier personnalisé",
  monthly: "Mensuel",
  per_session: "À la séance",
};

export const FORMULA_HELP: Record<FormulaKind, string> = {
  full: "Une seule échéance à l'inscription.",
  installments: "Des tranches avec leurs montants et leurs dates, selon le prix convenu.",
  monthly: "Une échéance par mois, à la date prévue par la formule. Les mois futurs restent prévisionnels.",
  per_session: "Chaque séance validée sur la feuille de présence crée une échéance, comme un cours particulier à la séance.",
};

/** One line describing what a formula costs. */
export function formulaText(plan: TrainingDetail["plans"][number], price: number): string {
  switch (plan.kind) {
    case "full":
      return `${tnd(plan.amount ?? price)} TND en une fois`;
    case "monthly":
      return `${tnd(plan.amount)} TND par mois, ${MONTHLY_TIMING[plan.monthlyDueKind]}${plan.monthlyDueKind === "day_of_month" ? ` ${plan.monthlyDueDay}` : ""}${plan.dueOffsetDays ? ` + ${plan.dueOffsetDays} jour(s)` : ""}`;
    case "per_session":
      return `${tnd(plan.amount)} TND par séance, absences ${plan.absenceBilled ? "facturées" : "non facturées"}`;
    case "installments":
      return plan.items
        .map(
          (item, i) =>
            `${item.label} : ${tnd(plan.amounts[i])} TND (${item.valueKind === "percent" ? percent(item.value) : "montant"}), ${item.dueKind === "relative" ? `J+${item.dueOffsetDays}` : `le ${frDate(item.dueDate)}`}`,
        )
        .join(" · ");
  }
}

export const MONTHLY_TIMING = {
  anniversary: "à la date anniversaire",
  month_start: "en début de mois",
  month_end: "en fin de mois",
  day_of_month: "le jour",
} as const;
