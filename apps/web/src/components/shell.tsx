import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate } from "react-router";
import { api } from "../api/client";
import { useSession } from "../auth/session";
import { setTimeZone } from "../lib/format";
import { ROLE } from "../lib/labels";
import { PasswordModal } from "../pages/admin";
import { CollectDrawer } from "../pages/collect";

interface NavItem {
  to: string;
  label: string;
  icon: string;
  permission: string | string[];
}

interface NavGroup {
  label: string;
  icon: string;
  children: NavItem[];
}

const ICONS = {
  dashboard: "M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z",
  groups: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8",
  attendance: "M20 6 9 17l-5-5",
  payments: "M3 7h18v12H3zM3 7l3-4h12l3 4M16 13h2",
  payroll: "M12 6v12M16 9c0-1.5-1.8-2.5-4-2.5S8 7.5 8 9s1.8 2 4 2.5 4 1 4 2.5-1.8 2.5-4 2.5-4-1-4-2.5",
  referentials: "M4 4h16v4H4zM4 10h16v4H4zM4 16h16v4H4z",
  students: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  instructors: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  lessons: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5zM4 19.5V21h16",
  trainings: "M2 9l10-5 10 5-10 5zM6 11v5c3 2 9 2 12 0v-5",
  receipts: "M14 3H6v18h12V7zM14 3v4h4M9 12h6M9 16h6",
  rooms: "M4 21V5l8-2v18M12 9h8v12M7 9h2M7 13h2M7 17h2",
  planning: "M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14H3V6a2 2 0 0 1 2-2z",
  cash: "M2 6h20v12H2zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5",
  reports: "M3 3v18h18M7 15l4-4 3 3 5-6",
  admin: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2",
};

/** Daily work first, reference data folded under "Référentiels", then the other modules. */
const NAV: (NavItem | NavGroup)[] = [
  { to: "/", label: "Tableau de bord", icon: ICONS.dashboard, permission: "students:read" },
  { to: "/groupes", label: "Gestion des groupes", icon: ICONS.groups, permission: "catalogue:read" },
  { to: "/presences", label: "Présences", icon: ICONS.attendance, permission: "attendance:read" },
  { to: "/encaissements", label: "Encaissements", icon: ICONS.payments, permission: "payments:read" },
  { to: "/paie", label: "Paie", icon: ICONS.payroll, permission: "payroll:read" },
  {
    label: "Référentiels",
    icon: ICONS.referentials,
    children: [
      { to: "/eleves", label: "Élèves", icon: ICONS.students, permission: "students:read" },
      { to: "/intervenants", label: "Intervenants", icon: ICONS.instructors, permission: "instructors:read" },
      { to: "/cours-particuliers", label: "Cours particuliers", icon: ICONS.lessons, permission: "catalogue:read" },
      { to: "/formations", label: "Formations", icon: ICONS.trainings, permission: "catalogue:read" },
    ],
  },
  { to: "/recus", label: "Reçus", icon: ICONS.receipts, permission: "payments:read" },
  { to: "/salles", label: "Salles et locations", icon: ICONS.rooms, permission: "catalogue:read" },
  { to: "/planning", label: "Planning", icon: ICONS.planning, permission: "catalogue:read" },
  { to: "/caisse", label: "Caisse", icon: ICONS.cash, permission: "cash:read" },
  { to: "/rapports", label: "Rapports", icon: ICONS.reports, permission: ["reports:operational", "reports:financial"] },
  { to: "/administration", label: "Administration", icon: ICONS.admin, permission: ["audit:read", "users:manage"] },
];

const Icon = ({ d }: { d: string }) => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={d} />
  </svg>
);

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

function NavEntry({ item }: { item: NavItem }) {
  return (
    <NavLink to={item.to} end={item.to === "/"} className={({ isActive }) => `navi${isActive ? " on" : ""}`} title={item.label}>
      <Icon d={item.icon} />
      <span>{item.label}</span>
    </NavLink>
  );
}

/* Page breadcrumb */

const CrumbContext = createContext<(crumbs: string[]) => void>(() => undefined);

export function usePage(crumbs: string[]) {
  const set = useContext(CrumbContext);
  const key = crumbs.join("|");
  useEffect(() => {
    set(key.split("|"));
    document.title = `${key.split("|").at(-1)} · Gestion du centre`;
  }, [key, set]);
}

/* Collect drawer opened from anywhere */

const CollectContext = createContext<(payer?: { studentId?: string; renterId?: string }) => void>(() => undefined);
export const useCollect = () => useContext(CollectContext);

interface SearchResults {
  students: { id: string; firstName: string; lastName: string; phone: string | null }[];
  instructors: { id: string; firstName: string; lastName: string }[];
  receipts: { id: string; number: string }[];
}

function GlobalSearch() {
  const [text, setText] = useState("");
  const [debounced, setDebounced] = useState("");
  const navigate = useNavigate();
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(text.trim()), 250);
    return () => window.clearTimeout(t);
  }, [text]);
  const { data } = useQuery({
    queryKey: ["search", debounced],
    queryFn: () => api.get<SearchResults>("/search", { q: debounced }),
    enabled: debounced.length >= 2,
  });
  const go = (to: string) => {
    setText("");
    navigate(to);
  };
  const empty = data && !data.students.length && !data.instructors.length && !data.receipts.length;
  return (
    <div className="gsearch" style={{ position: "relative" }}>
      <label className="visually-hidden" htmlFor="global-search">
        Recherche globale
      </label>
      <input
        id="global-search"
        className="input"
        type="search"
        placeholder="Élève, intervenant, reçu REC-…"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {debounced.length >= 2 && data ? (
        <div className="search-results">
          {data.students.map((s) => (
            <a key={s.id} href={`/eleves/${s.id}`} onClick={(e) => (e.preventDefault(), go(`/eleves/${s.id}`))}>
              {s.lastName} {s.firstName} <span className="cap">élève{s.phone ? ` · ${s.phone}` : ""}</span>
            </a>
          ))}
          {data.instructors.map((i) => (
            <a key={i.id} href={`/intervenants/${i.id}`} onClick={(e) => (e.preventDefault(), go(`/intervenants/${i.id}`))}>
              {i.lastName} {i.firstName} <span className="cap">intervenant</span>
            </a>
          ))}
          {data.receipts.map((r) => (
            <a key={r.id} href={`/recus/${r.id}`} onClick={(e) => (e.preventDefault(), go(`/recus/${r.id}`))}>
              {r.number} <span className="cap">reçu</span>
            </a>
          ))}
          {empty ? (
            <div className="cap" style={{ padding: "8px 12px" }}>
              Aucun résultat
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function Shell() {
  const { session, loading, can } = useSession();
  const [crumbs, setCrumbs] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [collect, setCollect] = useState<{ studentId?: string; renterId?: string } | null>(null);
  const [changingPassword, setChangingPassword] = useState(false);
  const [referentialsOpen, setReferentialsOpen] = useState(false);
  const allowed = (n: NavItem) => (Array.isArray(n.permission) ? n.permission.some(can) : can(n.permission));
  const location = useLocation();
  const client = useQueryClient();
  const navigate = useNavigate();
  const centre = useQuery({ queryKey: ["centre"], queryFn: () => api.get<{ name: string; timezone: string }>("/centre"), enabled: !!session });
  if (centre.data) setTimeZone(centre.data.timezone);
  const logout = useMutation({
    mutationFn: () => api.post("/auth/logout"),
    onSettled: async () => {
      client.clear();
      navigate("/connexion");
    },
  });

  if (loading)
    return (
      <div className="login">
        <span className="spinner" aria-label="Chargement" />
      </div>
    );
  if (!session) return <Navigate to="/connexion" replace state={{ from: location.pathname }} />;

  return (
    <CrumbContext.Provider value={setCrumbs}>
      <CollectContext.Provider value={(payer) => setCollect(payer ?? {})}>
        <div className="app">
          <aside className={`side${collapsed ? " collapsed" : ""}`} aria-label="Navigation principale">
            <div className="brand">
              <span className="logo" aria-hidden="true">
                {initials(centre.data?.name ?? "Gestion du centre")}
              </span>
              <span className="lbl">{centre.data?.name ?? "Gestion du centre"}</span>
            </div>
            <GlobalSearch />
            <nav style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {NAV.map((entry) => {
                if (!("children" in entry)) return allowed(entry) ? <NavEntry key={entry.to} item={entry} /> : null;
                const children = entry.children.filter(allowed);
                if (!children.length) return null;
                const open = referentialsOpen || children.some((c) => location.pathname.startsWith(c.to));
                return (
                  <div key={entry.label}>
                    <button
                      type="button"
                      className="navi"
                      aria-expanded={open}
                      title={entry.label}
                      onClick={() => setReferentialsOpen(!open)}
                      style={{ width: "100%", border: 0, background: "transparent", cursor: "pointer", font: "inherit" }}
                    >
                      <Icon d={entry.icon} />
                      <span style={{ flex: 1, textAlign: "start" }}>{entry.label}</span>
                      <span className="lbl" aria-hidden="true">
                        {open ? "▾" : "▸"}
                      </span>
                    </button>
                    {open ? (
                      <div className="nav-children">
                        {children.map((c) => (
                          <NavEntry key={c.to} item={c} />
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
              <span className="navi off" aria-disabled="true" title="Coworking : phase 2" style={{ marginTop: 8, justifyContent: "space-between" }}>
                <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <Icon d="M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4" />
                  <span>Coworking</span>
                </span>
                <span className="b b-gray lbl">Phase 2</span>
              </span>
            </nav>
            <div className="side-foot">
              <span className="cap">
                {ROLE[session.user.role]} · {session.user.fullName}
              </span>
              <button
                type="button"
                className="btn btn-g"
                aria-label={collapsed ? "Déplier la barre latérale" : "Réduire la barre latérale"}
                onClick={() => setCollapsed((c) => !c)}
                style={{ minHeight: 30, padding: "0 6px" }}
              >
                <span className="rtl-flip">{collapsed ? "›" : "‹"}</span>
              </button>
            </div>
          </aside>
          <div className="col">
            <header className="top">
              <nav className="crumbs" aria-label="Fil d'Ariane">
                {crumbs.map((c, i) => (i === crumbs.length - 1 ? <strong key={i}>{c}</strong> : <span key={i}>{c} ›</span>))}
              </nav>
              <div className="row center" style={{ gap: 8 }}>
                {can("payments:write") ? (
                  <button type="button" className="btn btn-p" onClick={() => setCollect({})}>
                    + Encaisser
                  </button>
                ) : null}
                {can("enrolments:write") ? (
                  <Link to="/inscriptions/nouvelle" className="btn">
                    + Inscrire un élève
                  </Link>
                ) : null}
                {can("rooms:write") ? (
                  <Link to="/locations/nouvelle" className="btn">
                    + Nouvelle location
                  </Link>
                ) : null}
                <button type="button" className="btn btn-g" onClick={() => setChangingPassword(true)}>
                  Mot de passe
                </button>
                <button type="button" className="btn btn-g" onClick={() => logout.mutate()}>
                  Déconnexion
                </button>
              </div>
            </header>
            <main className="page">
              <Outlet />
            </main>
          </div>
        </div>
        {collect ? <CollectDrawer payer={collect} onClose={() => setCollect(null)} /> : null}
        {changingPassword ? <PasswordModal onClose={() => setChangingPassword(false)} /> : null}
      </CollectContext.Provider>
    </CrumbContext.Provider>
  );
}

export function RequirePermission({ permission, children }: { permission: string; children: ReactNode }) {
  const { can } = useSession();
  if (!can(permission)) {
    return (
      <div className="card">
        <div className="empty">
          <strong style={{ color: "var(--ink)" }}>Accès réservé</strong>
          <span>Votre rôle ne permet pas d'ouvrir cette page.</span>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}
