import { useSearchParams } from "react-router";
import { usePage } from "../../components/shell";
import { PageHeader, Tabs } from "../../components/ui";
import { AttributesTab } from "./attributes";
import { ClosuresTab } from "./closures";
import { FloorsTab } from "./floors";
import { FormatsTab } from "./formats";
import { OffersTab } from "./offers";
import { ResourcesTab } from "./resources";
import { RulesTab } from "./rules";
import { SpaceTypesTab } from "./spaceTypes";
import { ZonesTab } from "./zones";

const TABS = [
  { value: "regles", label: "Règles" },
  { value: "etages", label: "Étages et plans" },
  { value: "zones", label: "Zones" },
  { value: "attributs", label: "Attributs" },
  { value: "types", label: "Types d'espaces" },
  { value: "ressources", label: "Ressources" },
  { value: "formules", label: "Formules et tarifs" },
  { value: "fermetures", label: "Fermetures" },
  { value: "abonnements", label: "Abonnements" },
] as const;
type Tab = (typeof TABS)[number]["value"];

/** Coworking configuration; the open tab is kept in the address so the plan editor can come back to it. */
export function CoworkingSettingsPage() {
  usePage(["Coworking", "Paramètres coworking"]);
  const [params, setParams] = useSearchParams();
  const requested = params.get("onglet");
  const tab: Tab = TABS.find((t) => t.value === requested)?.value ?? "regles";
  return (
    <>
      <PageHeader title="Paramètres coworking" subtitle="Règles de réservation, espaces, plans, tarifs et offres d'abonnement." />
      <Tabs value={tab} tabs={[...TABS]} onChange={(value) => setParams({ onglet: value }, { replace: true })} />
      {tab === "regles" ? <RulesTab /> : null}
      {tab === "etages" ? <FloorsTab /> : null}
      {tab === "zones" ? <ZonesTab /> : null}
      {tab === "attributs" ? <AttributesTab /> : null}
      {tab === "types" ? <SpaceTypesTab /> : null}
      {tab === "ressources" ? <ResourcesTab /> : null}
      {tab === "formules" ? <FormatsTab /> : null}
      {tab === "fermetures" ? <ClosuresTab /> : null}
      {tab === "abonnements" ? <OffersTab /> : null}
    </>
  );
}
