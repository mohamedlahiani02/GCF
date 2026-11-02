import { Link, useLocation } from "react-router";

const TABS = [
  { to: "/coworking/membres", label: "Membres" },
  { to: "/coworking/abonnements", label: "Abonnements" },
  { to: "/coworking/courrier", label: "Courrier" },
] as const;

/** The three client pages of the coworking module, reached from one "Clients" menu entry. */
export function ClientsTabs() {
  const { pathname } = useLocation();
  return (
    <nav className="tabs" aria-label="Clients">
      {TABS.map((t) => (
        <Link key={t.to} to={t.to} className="tab" aria-current={pathname === t.to ? "page" : undefined}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
