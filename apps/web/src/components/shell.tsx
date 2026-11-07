import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Link, Navigate, Outlet, useLocation, useNavigate } from "react-router";
import { api } from "../api/client";
import { useSession } from "../auth/session";
import { setTimeZone } from "../lib/format";
import { ROLE } from "../lib/labels";
import { PasswordModal } from "../pages/admin";
import { CollectDrawer, type Payer } from "../pages/collect";
import { WalkInWizard } from "../pages/coworking/walkin";
import { MenuButton, type MenuAction } from "./menu";

interface NavItem {
  to: string;
  label: string;
  icon: string;
  permission: string | string[];
  /** Active only on this exact path (a section home whose sub-pages have their own entries). */
  end?: boolean;
  /** Other paths whose pages are reached through this entry (tabs of a grouped page). */
  also?: string[];
  /** Small counter shown next to the label (pending work). */
  badge?: "cwRequests";
}

interface NavSection {
  title: string;
  /** A collapsible section folds away unless one of its pages is open. */
  collapsible?: boolean;
  items: NavItem[];
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
  floorPlan: "M3 3h18v18H3zM3 12h8M11 3v18M15 8h2M15 15h2",
  inbox: "M22 12h-6l-2 3h-4l-2-3H2M5.5 5h13L22 12v7H2v-7z",
  members: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  stats: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  settings: "M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4",
  pages: "M14 3H6v18h12V7zM14 3v4h4",
  media: "M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6M15.5 9.5h0",
  leads: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
};

/** Every settings page of the back-office, gathered on one "Paramètres" page; each card shows only with its permission. */
export const SETTINGS_LINKS: { to: string; title: string; text: string; permission: string | string[] }[] = [
  {
    to: "/coworking/parametres",
    title: "Coworking",
    text: "Votre espace (étages, plans, places), les tarifs et abonnements, les règles de réservation et les fermetures.",
    permission: "coworking:manage",
  },
  {
    to: "/site/apparence",
    title: "Apparence du site",
    text: "Logo, couleurs, police et thème du site public.",
    permission: "website:edit",
  },
  {
    to: "/site/parametres",
    title: "Paramètres du site",
    text: "Adresse, langues, coordonnées, réseaux sociaux et menu du site public.",
    permission: "website:edit",
  },
  {
    to: "/administration",
    title: "Administration",
    text: "Informations du centre, utilisateurs et rôles, modules activés et journal d'audit.",
    permission: ["audit:read", "users:manage"],
  },
  {
    to: "/integrations",
    title: "Intégrations",
    text: "Jetons d'accès à l'API et webhooks pour relier GCF à n8n, à la messagerie ou à un agent.",
    permission: "centre:manage",
  },
];
const SETTINGS_PERMISSIONS = [...new Set(SETTINGS_LINKS.flatMap((l) => (Array.isArray(l.permission) ? l.permission : [l.permission])))];

/** Daily work first, reference data folded under "Référentiels", then the other modules. */
const NAV: NavSection[] = [
  {
    title: "Quotidien",
    items: [
      { to: "/", label: "Tableau de bord", icon: ICONS.dashboard, permission: "students:read" },
      { to: "/groupes", label: "Gestion des groupes", icon: ICONS.groups, permission: "catalogue:read" },
      { to: "/presences", label: "Présences", icon: ICONS.attendance, permission: "attendance:read" },
      { to: "/encaissements", label: "Encaissements", icon: ICONS.payments, permission: "payments:read" },
      { to: "/paie", label: "Paie", icon: ICONS.payroll, permission: "payroll:read" },
    ],
  },
  {
    title: "Référentiels",
    collapsible: true,
    items: [
      { to: "/eleves", label: "Élèves", icon: ICONS.students, permission: "students:read" },
      { to: "/intervenants", label: "Intervenants", icon: ICONS.instructors, permission: "instructors:read" },
      { to: "/cours-particuliers", label: "Cours particuliers", icon: ICONS.lessons, permission: "catalogue:read" },
      { to: "/formations", label: "Formations", icon: ICONS.trainings, permission: "catalogue:read" },
    ],
  },
  {
    title: "Coworking",
    items: [
      { to: "/coworking", label: "Plan en direct", icon: ICONS.floorPlan, permission: "coworking:read", end: true },
      { to: "/coworking/demandes", label: "Demandes", icon: ICONS.inbox, permission: "coworking:write", badge: "cwRequests" },
      { to: "/coworking/planning", label: "Planning coworking", icon: ICONS.planning, permission: "coworking:read" },
      {
        to: "/coworking/membres",
        label: "Clients",
        icon: ICONS.members,
        permission: "coworking:read",
        also: ["/coworking/abonnements", "/coworking/courrier"],
      },
      { to: "/coworking/statistiques", label: "Statistiques", icon: ICONS.stats, permission: "coworking:reports" },
    ],
  },
  {
    title: "Site web",
    collapsible: true,
    items: [
      { to: "/site", label: "Pages", icon: ICONS.pages, permission: "website:edit", end: true },
      { to: "/site/medias", label: "Médiathèque", icon: ICONS.media, permission: "website:edit" },
      { to: "/site/demandes", label: "Demandes du site", icon: ICONS.leads, permission: "website:leads" },
    ],
  },
  {
    title: "Gestion",
    items: [
      { to: "/recus", label: "Reçus", icon: ICONS.receipts, permission: "payments:read" },
      { to: "/salles", label: "Salles et locations", icon: ICONS.rooms, permission: "catalogue:read" },
      { to: "/planning", label: "Planning", icon: ICONS.planning, permission: "catalogue:read" },
      { to: "/caisse", label: "Caisse", icon: ICONS.cash, permission: "cash:read" },
      { to: "/rapports", label: "Rapports", icon: ICONS.reports, permission: ["reports:operational", "reports:financial"] },
      {
        to: "/parametres",
        label: "Paramètres",
        icon: ICONS.settings,
        permission: SETTINGS_PERMISSIONS,
        also: SETTINGS_LINKS.map((l) => l.to),
      },
    ],
  },
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

const LARGE_TEXT_KEY = "gcf.largeText";

/** "Grand texte" preference, kept in this browser only; storage may be unavailable (private window), then it lasts the visit. */
function useLargeText(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => {
    try {
      return window.localStorage.getItem(LARGE_TEXT_KEY) === "1";
    } catch {
      return false;
    }
  });
  const set = (value: boolean) => {
    setOn(value);
    try {
      if (value) window.localStorage.setItem(LARGE_TEXT_KEY, "1");
      else window.localStorage.removeItem(LARGE_TEXT_KEY);
    } catch {
      // Storage refused: the choice still applies until the page is reloaded.
    }
  };
  return [on, set];
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

const personInitials = (fullName: string) =>
  fullName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

const isUnder = (pathname: string, to: string) => pathname === to || pathname.startsWith(`${to}/`);

/** Whether the page open at `pathname` belongs to this menu entry. */
function entryActive(item: NavItem, pathname: string): boolean {
  if (item.to === "/" || item.end === true) return pathname === item.to;
  return [item.to, ...(item.also ?? [])].some((to) => isUnder(pathname, to));
}

function NavEntry({ item, active, count }: { item: NavItem; active: boolean; count: number }) {
  return (
    <Link to={item.to} className={`navi${active ? " on" : ""}`} aria-current={active ? "page" : undefined} title={item.label}>
      <Icon d={item.icon} />
      <span>{item.label}</span>
      {count > 0 ? (
        <span className="nav-count" aria-label={`${count} en attente`}>
          {count}
        </span>
      ) : null}
    </Link>
  );
}

/** Pending coworking requests, shared with the requests page through its query key. */
function useRequestCount(enabled: boolean): number {
  const { data } = useQuery({
    queryKey: ["cw-requests"],
    queryFn: () => api.get<{ items: unknown[] }>("/coworking/requests"),
    enabled,
    refetchInterval: 60_000,
  });
  return data?.items.length ?? 0;
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

/* Full-screen pages */

const FullScreenContext = createContext<(on: boolean) => void>(() => undefined);

/** A page that needs the whole window (the floor plan editor) hides the sidebar and the top bar while it is open. */
export function useFullScreenPage() {
  const set = useContext(FullScreenContext);
  useEffect(() => {
    set(true);
    return () => set(false);
  }, [set]);
}

/* Collect drawer opened from anywhere */

const CollectContext = createContext<(payer?: Payer) => void>(() => undefined);
export const useCollect = () => useContext(CollectContext);

interface SearchResults {
  students: { id: string; firstName: string; lastName: string; phone: string | null }[];
  instructors: { id: string; firstName: string; lastName: string }[];
  receipts: { id: string; number: string }[];
  members: { id: string; firstName: string; lastName: string | null; email: string | null; phone: string | null }[];
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
  const empty = data && !data.students.length && !data.instructors.length && !data.receipts.length && !data.members.length;
  return (
    <div className="gsearch" style={{ position: "relative" }}>
      <span className="gsearch-icon">
        <Icon d="M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5" />
      </span>
      <label className="visually-hidden" htmlFor="global-search">
        Recherche globale
      </label>
      <input id="global-search" className="input" type="search" placeholder="Rechercher…" value={text} onChange={(e) => setText(e.target.value)} />
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
          {data.members.map((m) => (
            <a key={m.id} href={`/coworking/membres/${m.id}`} onClick={(e) => (e.preventDefault(), go(`/coworking/membres/${m.id}`))}>
              {[m.firstName, m.lastName].filter(Boolean).join(" ")} <span className="cap">membre coworking{m.phone ? ` · ${m.phone}` : ""}</span>
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
  const [collect, setCollect] = useState<Payer | null>(null);
  const [changingPassword, setChangingPassword] = useState(false);
  const [openSections, setOpenSections] = useState<string[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [fullScreen, setFullScreen] = useState(false);
  const [walkIn, setWalkIn] = useState(false);
  const [largeText, setLargeText] = useLargeText();
  const requestCount = useRequestCount(!!session && can("coworking:write"));
  useEffect(() => {
    document.documentElement.classList.toggle("large-text", largeText && !fullScreen);
  }, [largeText, fullScreen]);
  const allowed = (n: NavItem) => (Array.isArray(n.permission) ? n.permission.some(can) : can(n.permission));
  const location = useLocation();
  const client = useQueryClient();
  const navigate = useNavigate();
  useEffect(() => setMenuOpen(false), [location.pathname]);
  const centre = useQuery({
    queryKey: ["centre"],
    queryFn: () => api.get<{ name: string; timezone: string; logoVersion: number | null }>("/centre"),
    enabled: !!session,
  });
  if (centre.data) setTimeZone(centre.data.timezone);
  const logout = useMutation({
    mutationFn: () => api.post("/auth/logout"),
    onSettled: async () => {
      client.clear();
      navigate("/connexion");
    },
  });

  const createActions: MenuAction[] = [
    ...(can("enrolments:write")
      ? [{ label: "Inscrire un élève", hint: "Inscription à une formation ou un groupe", onSelect: () => navigate("/inscriptions/nouvelle") }]
      : []),
    ...(can("rooms:write") ? [{ label: "Nouvelle location", hint: "Louer une salle à un client", onSelect: () => navigate("/locations/nouvelle") }] : []),
    ...(can("coworking:write")
      ? [{ label: "Accueil coworking", hint: "Installer un client qui arrive sans réservation", onSelect: () => setWalkIn(true) }]
      : []),
  ];

  if (loading)
    return (
      <div className="login">
        <span className="spinner" aria-label="Chargement" />
      </div>
    );
  if (!session) return <Navigate to="/connexion" replace state={{ from: location.pathname }} />;

  return (
    <CrumbContext.Provider value={setCrumbs}>
      <FullScreenContext.Provider value={setFullScreen}>
        <CollectContext.Provider value={(payer) => setCollect(payer ?? {})}>
          <div className={`app${fullScreen ? " full" : ""}`}>
            {fullScreen ? null : (
              <aside className={`side${collapsed ? " collapsed" : ""}${menuOpen ? " menu-open" : ""}`} aria-label="Navigation principale">
                <div className={`side-brand${centre.data?.logoVersion ? " has-logo" : ""}`}>
                  {centre.data?.logoVersion ? (
                    <span className="brand-logo">
                      <img src={api.fileUrl("/centre/logo", { v: centre.data.logoVersion })} alt="" />
                    </span>
                  ) : (
                    <span className="logo" aria-hidden="true">
                      {initials(centre.data?.name ?? "Gestion du centre")}
                    </span>
                  )}
                  <span className="lbl brand-text">
                    <strong>{centre.data?.name ?? "Gestion du centre"}</strong>
                    <span className="cap">Back-office</span>
                  </span>
                  <button
                    type="button"
                    className="btn nav-toggle"
                    aria-expanded={menuOpen}
                    onClick={() => {
                      setCollapsed(false);
                      setMenuOpen((o) => !o);
                    }}
                  >
                    {menuOpen ? "Fermer" : "Menu"}
                  </button>
                </div>
                <GlobalSearch />
                <nav className="side-nav">
                  {NAV.map((section) => {
                    const items = section.items.filter(allowed);
                    if (!items.length) return null;
                    const active = items.some((c) => entryActive(c, location.pathname));
                    const open = !section.collapsible || collapsed || active || openSections.includes(section.title);
                    const id = `nav-${section.title}`;
                    return (
                      <div key={section.title} className="nav-section">
                        {section.collapsible ? (
                          <button
                            type="button"
                            className="nav-title"
                            aria-expanded={open}
                            aria-controls={id}
                            onClick={() => setOpenSections((list) => (open ? list.filter((t) => t !== section.title) : [...list, section.title]))}
                          >
                            <span>{section.title}</span>
                            <span aria-hidden="true">{open ? "▾" : "▸"}</span>
                          </button>
                        ) : (
                          <span className="nav-title">{section.title}</span>
                        )}
                        {open ? (
                          <div id={id} className="nav-items">
                            {items.map((item) => (
                              <NavEntry
                                key={item.to}
                                item={item}
                                active={entryActive(item, location.pathname)}
                                count={item.badge === "cwRequests" ? requestCount : 0}
                              />
                            ))}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </nav>
                <div className="side-foot">
                  <span className="avatar" aria-hidden="true">
                    {personInitials(session.user.fullName)}
                  </span>
                  <span className="lbl user-text">
                    <strong>{session.user.fullName}</strong>
                    <span className="cap">{ROLE[session.user.role]}</span>
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
            )}
            <div className="col">
              {fullScreen ? null : (
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
                    {createActions.length ? <MenuButton label="+ Nouveau" items={createActions} /> : null}
                    <MenuButton
                      label={session.user.fullName}
                      className="btn btn-g account-btn"
                      items={[
                        { label: "Changer mon mot de passe", onSelect: () => setChangingPassword(true) },
                        {
                          label: largeText ? "Texte normal" : "Grand texte",
                          hint: largeText ? "Revenir à la taille habituelle" : "Texte et boutons plus grands",
                          onSelect: () => setLargeText(!largeText),
                        },
                        { label: "Se déconnecter", onSelect: () => logout.mutate() },
                      ]}
                    />
                  </div>
                </header>
              )}
              <main className="page">
                <Outlet />
              </main>
            </div>
          </div>
          {collect ? <CollectDrawer payer={collect} onClose={() => setCollect(null)} /> : null}
          {can("coworking:write") ? <WalkInWizard open={walkIn} onClose={() => setWalkIn(false)} /> : null}
          {changingPassword ? <PasswordModal onClose={() => setChangingPassword(false)} /> : null}
        </CollectContext.Provider>
      </FullScreenContext.Provider>
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
