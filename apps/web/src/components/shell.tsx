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
import {
  ICONS,
  SETTINGS_LINKS,
  SETTINGS_PERMISSIONS,
  WORKSPACES,
  permitted,
  workspaceFor,
  actionActive as entryActive,
  type ActionLink,
} from "../lib/navigation";
import { NavIcon } from "./nav-icon";
import { NotificationBell } from "./notifications";
import { useActionQueue } from "../lib/action-queue";
export { SETTINGS_LINKS } from "../lib/navigation";

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

function NavEntry({ item, active, count }: { item: ActionLink; active: boolean; count: number }) {
  return (
    <Link to={item.to} className={`navi${active ? " on" : ""}`} aria-current={active ? "page" : undefined} title={item.label}>
      <NavIcon d={item.icon} />
      <span>{item.label}</span>
      {count > 0 ? (
        <span className="nav-count" aria-label={`${count} en attente`}>
          {count}
        </span>
      ) : null}
    </Link>
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

const WalkInContext = createContext<() => void>(() => undefined);
export const useWalkIn = () => useContext(WalkInContext);

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
        <NavIcon d="M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5" />
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
              {i.lastName} {i.firstName} <span className="cap">prof / formateur</span>
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [fullScreen, setFullScreen] = useState(false);
  const [walkIn, setWalkIn] = useState(false);
  const [largeText, setLargeText] = useLargeText();
  const queue = useActionQueue();
  const { requestCount, proposalCount } = queue;
  useEffect(() => {
    document.documentElement.classList.toggle("large-text", largeText && !fullScreen);
  }, [largeText, fullScreen]);
  const allowed = (n: ActionLink) => permitted(n.permission, can);
  const location = useLocation();
  const workspace = workspaceFor(location.pathname);
  const spaces = WORKSPACES.filter((w) => w.items.some(allowed));
  const inSettings = location.pathname === "/parametres" || SETTINGS_LINKS.some((l) => isUnder(location.pathname, l.to));
  const sidebar: ActionLink[] = [
    { to: "/", label: "Tableau de bord", icon: ICONS.dashboard, permission: [] },
    { to: "/raccourcis", label: "Mes raccourcis", icon: ICONS.home, permission: [] },
    ...spaces.map((w) => ({ to: w.to, label: w.label, icon: w.icon, permission: [], also: w.items.filter(allowed).flatMap((i) => [i.to, ...(i.also ?? [])]) })),
    { to: "/propositions", label: "À valider", icon: ICONS.proposals, permission: ["reminders:send", "payroll:calculate"], badge: "proposals" },
  ];
  const client = useQueryClient();
  const navigate = useNavigate();
  useEffect(() => setMenuOpen(false), [location.pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenuOpen(false);
        document.querySelector<HTMLButtonElement>(".nav-toggle")?.focus();
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [menuOpen]);
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
          <WalkInContext.Provider value={() => setWalkIn(true)}>
            <a className="skip-content" href="#main-content">
              Aller au contenu
            </a>
            <div className={`app workspace-shell${fullScreen ? " full" : ""}`}>
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
                      aria-controls="main-navigation"
                      onClick={() => {
                        setCollapsed(false);
                        setMenuOpen((o) => !o);
                      }}
                    >
                      {menuOpen ? "Fermer" : "Menu"}
                    </button>
                  </div>
                  <nav id="main-navigation" className="side-nav" aria-label="Espaces de travail">
                    {sidebar.filter(allowed).map((item) => (
                      <NavEntry
                        key={item.to}
                        item={item}
                        active={!inSettings && entryActive(item, location.pathname)}
                        count={item.badge === "proposals" ? proposalCount : item.to === "/espaces/coworking" ? requestCount + queue.memberCount : 0}
                      />
                    ))}
                  </nav>
                  {permitted(SETTINGS_PERMISSIONS, can) ? (
                    <div className="side-settings">
                      <NavEntry
                        item={{ to: "/parametres", label: "Paramètres", icon: ICONS.settings, permission: SETTINGS_PERMISSIONS }}
                        active={inSettings}
                        count={0}
                      />
                    </div>
                  ) : null}
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
                    <GlobalSearch />
                    <nav className="crumbs" aria-label="Fil d'Ariane">
                      {/* A single crumb only repeats the page title below; the trail shows once there is a path to follow. */}
                      {crumbs.length > 1 ? crumbs.map((c, i) => (i === crumbs.length - 1 ? <strong key={i}>{c}</strong> : <span key={i}>{c} ›</span>)) : null}
                    </nav>
                    <div className="row center" style={{ gap: 8 }}>
                      {can("payments:write") ? (
                        <button type="button" className="btn btn-p" onClick={() => setCollect({})}>
                          + Encaisser
                        </button>
                      ) : null}
                      {createActions.length ? <MenuButton label="+ Nouveau" items={createActions} /> : null}
                      <NotificationBell key={session.user.id} queue={queue} />
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
                {workspace && location.pathname !== workspace.to && !inSettings ? (
                  <nav className="workspace-trail" aria-label={`Navigation ${workspace.label}`}>
                    <Link to={workspace.to} className="workspace-return">
                      <NavIcon d={workspace.icon} />
                      {workspace.label}
                    </Link>
                    <span className="workspace-divider" aria-hidden="true" />
                    {workspace.items
                      .filter((i) => allowed(i) && i.section === "Au quotidien" && !i.action)
                      .slice(0, 4)
                      .map((i) => (
                        <Link key={i.id} to={i.to} aria-current={entryActive(i, location.pathname) ? "page" : undefined}>
                          {i.label}
                        </Link>
                      ))}
                  </nav>
                ) : null}
                <main id="main-content" tabIndex={-1} className="page">
                  <Outlet />
                </main>
              </div>
            </div>
            {collect ? <CollectDrawer payer={collect} onClose={() => setCollect(null)} /> : null}
            {can("coworking:write") ? <WalkInWizard open={walkIn} onClose={() => setWalkIn(false)} /> : null}
            {changingPassword ? <PasswordModal onClose={() => setChangingPassword(false)} /> : null}
          </WalkInContext.Provider>
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
