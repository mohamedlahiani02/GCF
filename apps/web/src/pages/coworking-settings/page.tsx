import { useSearchParams } from "react-router";
import { usePage } from "../../components/shell";
import { PageHeader, Segmented, Tabs } from "../../components/ui";
import { AttributesTab } from "./attributes";
import { ClosuresTab } from "./closures";
import { FloorsTab } from "./floors";
import { FormatsTab } from "./formats";
import { OffersTab } from "./offers";
import { ResourcesTab } from "./resources";
import { RulesTab } from "./rules";
import { SpaceTypesTab } from "./spaceTypes";
import { ZonesTab } from "./zones";

/** The nine settings screens, gathered in three groups so a manager first picks what they want to change. */
const GROUPS = [
  {
    value: "espace",
    label: "Mon espace",
    tabs: [
      { value: "etages", label: "Étages et plans" },
      { value: "ressources", label: "Places et salles" },
      { value: "types", label: "Types d'espaces" },
      { value: "zones", label: "Zones" },
      { value: "attributs", label: "Équipements" },
    ],
  },
  {
    value: "tarifs",
    label: "Tarifs et abonnements",
    tabs: [
      { value: "formules", label: "Formules et tarifs" },
      { value: "abonnements", label: "Abonnements" },
    ],
  },
  {
    value: "regles",
    label: "Règles et fermetures",
    tabs: [
      { value: "regles", label: "Règles de réservation" },
      { value: "fermetures", label: "Fermetures" },
    ],
  },
] as const;
type Group = (typeof GROUPS)[number];
type Tab = Group["tabs"][number]["value"];

const groupOf = (tab: string | null): { group: Group; tab: Tab } | null => {
  for (const group of GROUPS) {
    const found = group.tabs.find((t) => t.value === tab);
    if (found) return { group, tab: found.value };
  }
  return null;
};

/** Coworking configuration; the open tab is kept in the address (`onglet`) so the plan editor can come back to it. */
export function CoworkingSettingsPage() {
  usePage(["Paramètres", "Coworking"]);
  const [params, setParams] = useSearchParams();
  const current = groupOf(params.get("onglet")) ?? { group: GROUPS[0], tab: GROUPS[0].tabs[0].value };
  const open = (tab: Tab) => setParams({ onglet: tab }, { replace: true });
  return (
    <>
      <PageHeader title="Paramètres du coworking" subtitle="Choisissez d'abord ce que vous voulez régler." />
      <Segmented
        label="Rubrique"
        value={current.group.value}
        onChange={(value) => open(GROUPS.find((g) => g.value === value)!.tabs[0].value)}
        options={GROUPS.map((g) => ({ value: g.value, label: g.label }))}
      />
      {current.group.tabs.length > 1 ? <Tabs value={current.tab} tabs={[...current.group.tabs]} onChange={open} /> : null}
      {current.tab === "regles" ? <RulesTab /> : null}
      {current.tab === "etages" ? <FloorsTab /> : null}
      {current.tab === "zones" ? <ZonesTab /> : null}
      {current.tab === "attributs" ? <AttributesTab /> : null}
      {current.tab === "types" ? <SpaceTypesTab /> : null}
      {current.tab === "ressources" ? <ResourcesTab /> : null}
      {current.tab === "formules" ? <FormatsTab /> : null}
      {current.tab === "fermetures" ? <ClosuresTab /> : null}
      {current.tab === "abonnements" ? <OffersTab /> : null}
    </>
  );
}
