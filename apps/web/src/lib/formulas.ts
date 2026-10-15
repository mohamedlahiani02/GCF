import type { TrainingDetail } from "../api/types";
import { frDate, percent, tnd } from "./format";

export type FormulaKind = TrainingDetail["plans"][number]["kind"];

export const FORMULA: Record<FormulaKind, string> = {
  full: "Paiement intégral",
  installments: "Par tranches",
  monthly: "Mensuel",
  per_session: "À la séance",
};

export const FORMULA_HELP: Record<FormulaKind, string> = {
  full: "Une seule échéance à l'inscription.",
  installments: "Des tranches dont le total égale le prix de la formation.",
  monthly: "Une échéance par mois jusqu'à la fin du groupe, comme un cours particulier mensuel.",
  per_session: "Chaque séance validée sur la feuille de présence crée une échéance, comme un cours particulier à la séance.",
};

/** One line describing what a formula costs. */
export function formulaText(plan: TrainingDetail["plans"][number], price: number): string {
  switch (plan.kind) {
    case "full":
      return `${tnd(plan.amount ?? price)} TND en une fois`;
    case "monthly":
      return `${tnd(plan.amount)} TND par mois`;
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
