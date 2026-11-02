import { Link } from "react-router";
import { SETTINGS_LINKS, usePage } from "../components/shell";
import { Card, Empty, PageHeader } from "../components/ui";
import { useSession } from "../auth/session";

/** Every settings page the user may open, as one card each. */
export function SettingsPage() {
  usePage(["Paramètres"]);
  const { can } = useSession();
  const links = SETTINGS_LINKS.filter((l) => (Array.isArray(l.permission) ? l.permission.some(can) : can(l.permission)));
  return (
    <>
      <PageHeader title="Paramètres" subtitle="Les réglages se font une fois ; choisissez ce que vous voulez modifier." />
      {links.length ? (
        <div className="settings-grid">
          {links.map((l) => (
            <Link key={l.to} to={l.to} className="settings-card">
              <strong>{l.title}</strong>
              <span className="cap">{l.text}</span>
              <span className="go">Ouvrir</span>
            </Link>
          ))}
        </div>
      ) : (
        <Card>
          <Empty title="Aucun réglage" text="Votre rôle ne permet pas de modifier les réglages du centre." />
        </Card>
      )}
    </>
  );
}
