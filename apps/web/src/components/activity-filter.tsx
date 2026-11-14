import { useSession } from "../auth/session";
import { Field } from "./ui";

export const FINANCIAL_ACTIVITY = {
  training: "Formations",
  study: "Cours particuliers",
  coworking: "Coworking",
  rental: "Locations de salles",
} as const;

export type FinancialActivity = keyof typeof FINANCIAL_ACTIVITY;

export function ActivityFilter({ value, onChange }: { value: FinancialActivity | ""; onChange: (value: FinancialActivity | "") => void }) {
  const { session } = useSession();
  const activities = (Object.keys(FINANCIAL_ACTIVITY) as FinancialActivity[]).filter((activity) =>
    activity === "coworking" ? session?.modules.includes("coworking") : activity === "rental" || session?.modules.includes("training"),
  );
  return (
    <Field label="Activité">
      <select className="input" value={value} onChange={(event) => onChange(event.target.value as FinancialActivity | "")}>
        <option value="">Toutes les activités</option>
        {activities.map((activity) => (
          <option key={activity} value={activity}>
            {FINANCIAL_ACTIVITY[activity]}
          </option>
        ))}
      </select>
    </Field>
  );
}
