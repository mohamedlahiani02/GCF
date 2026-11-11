import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { useSession } from "../auth/session";
import { NavIcon } from "../components/nav-icon";
import { useCollect, usePage, useWalkIn } from "../components/shell";
import { ACTIONS, DEFAULT_SHORTCUTS, ICONS, WORKSPACES, permitted, type WorkspaceAction } from "../lib/navigation";

const normalize = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("fr");

function ActionTile({ item }: { item: WorkspaceAction }) {
  const collect = useCollect();
  const walkIn = useWalkIn();
  const content = (
    <>
      <span className="action-icon">
        <NavIcon d={item.icon} />
      </span>
      <span className="action-copy">
        <strong>{item.label}</strong>
        <span>{item.text}</span>
      </span>
      <span className="action-arrow">
        <NavIcon d={ICONS.arrow} />
      </span>
    </>
  );
  return item.action ? (
    <button type="button" className="action-tile" onClick={() => (item.action === "collect" ? collect() : walkIn())}>
      {content}
    </button>
  ) : (
    <Link to={item.to} className="action-tile">
      {content}
    </Link>
  );
}

const storageKeyOf = (userId: string) => `gcf.shortcuts.v1.${userId}`;
export const longDate = () => new Intl.DateTimeFormat("fr-TN", { weekday: "long", day: "numeric", month: "long" }).format(new Date());

/** The shortcuts a user may see, and the ones they chose (or the advised ones while they chose nothing). */
function shortcutChoice(userId: string, can: (permission: string) => boolean) {
  const available = ACTIONS.filter((i) => permitted(i.permission, can));
  const defaults = DEFAULT_SHORTCUTS.filter((id) => available.some((i) => i.id === id));
  const fallback = defaults.length ? defaults : available.slice(0, 8).map((i) => i.id);
  let ids = fallback;
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(storageKeyOf(userId)) ?? "null");
    if (Array.isArray(saved) && saved.every((id) => typeof id === "string")) ids = [...new Set(saved as string[])].slice(0, 8);
  } catch {
    /* Storage unavailable: keep the advised shortcuts for this visit. */
  }
  return { available, fallback, ids };
}

/** The user's shortcuts on the home page, in a compact row; the full page lets them choose and search. */
export function HomeShortcuts({ userId }: { userId: string }) {
  const { can } = useSession();
  const { available, ids } = shortcutChoice(userId, can);
  const selected = ids.map((id) => available.find((i) => i.id === id)).filter((i) => i !== undefined);
  if (selected.length === 0) return null;
  return (
    <section className="home-shortcuts" aria-labelledby="home-shortcuts-title">
      <div className="home-shortcuts-head">
        <h2 id="home-shortcuts-title">Mes raccourcis</h2>
        <Link to="/raccourcis">Toutes les actions et personnalisation</Link>
      </div>
      <div className="home-shortcuts-grid">
        {selected.map((i) => (
          <ActionTile key={i.id} item={i} />
        ))}
      </div>
    </section>
  );
}

function Shortcuts({ userId }: { userId: string }) {
  const { can } = useSession();
  const choice = shortcutChoice(userId, can);
  const { available } = choice;
  const defaults = choice.fallback;
  const storageKey = storageKeyOf(userId);
  const [ids, setIds] = useState<string[]>(choice.ids);
  const [notice, setNotice] = useState("");
  const [params, setParams] = useSearchParams();
  const search = params.get("q") ?? "";
  const scope = params.get("espace") ?? "favorites";
  const selected = ids.map((id) => available.find((i) => i.id === id)).filter((i) => i !== undefined);
  const workspace = WORKSPACES.find((w) => w.id === scope);
  const source = search.trim()
    ? available
    : scope === "favorites"
      ? selected
      : workspace
        ? workspace.items.filter((i) => permitted(i.permission, can))
        : available;
  const filtered = source.filter((i) => normalize(`${i.label} ${i.text}`).includes(normalize(search.trim())));
  const update = (next: string[]) => {
    setIds(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
      setNotice("Raccourcis enregistrés pour ce navigateur.");
    } catch {
      setNotice("Raccourcis conservés pour cette visite. Le stockage du navigateur est indisponible.");
    }
  };
  const visibleSpaces = WORKSPACES.filter((w) => w.items.some((i) => permitted(i.permission, can)));
  return (
    <>
      <section className="launch-actions" aria-labelledby="shortcuts-title">
        <div className="launch-section-head">
          <div>
            <h2 id="shortcuts-title">Mes raccourcis</h2>
            <p>Vos actions courantes, à portée de main.</p>
          </div>
          <details
            className="shortcut-personalize"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.currentTarget.open = false;
                e.currentTarget.querySelector("summary")?.focus();
              }
            }}
          >
            <summary>Personnaliser</summary>
            <div className="shortcut-picker">
              <h3>Choisir mes raccourcis</h3>
              <p>Jusqu’à 8 actions sur votre accueil. Votre choix est conservé dans ce navigateur.</p>
              <p role="status">{selected.length} raccourci(s) sélectionné(s) sur 8</p>
              {visibleSpaces.map((w) => (
                <fieldset key={w.id}>
                  <legend>{w.label}</legend>
                  {w.items
                    .filter((i) => permitted(i.permission, can))
                    .map((i) => (
                      <label key={i.id}>
                        <input
                          type="checkbox"
                          checked={ids.includes(i.id)}
                          disabled={!ids.includes(i.id) && selected.length >= 8}
                          onChange={(e) => update(e.target.checked ? [...selected.map((i) => i.id), i.id] : ids.filter((id) => id !== i.id))}
                        />
                        <span>{i.label}</span>
                      </label>
                    ))}
                </fieldset>
              ))}
              <button type="button" className="btn" onClick={() => update(defaults)}>
                Rétablir les raccourcis conseillés
              </button>
            </div>
          </details>
        </div>
        <div className="launch-toolbar">
          <div className="launch-filters" role="group" aria-label="Filtrer les raccourcis">
            {[{ id: "favorites", label: "Mes raccourcis" }, ...visibleSpaces].map((s) => (
              <button type="button" key={s.id} aria-pressed={scope === s.id} onClick={() => setParams({ espace: s.id })}>
                {s.label}
              </button>
            ))}
          </div>
          <label className="action-search">
            <NavIcon d={ICONS.search} />
            <span className="visually-hidden">Trouver une action</span>
            <input
              type="search"
              name="action"
              autoComplete="off"
              placeholder="Trouver une action…"
              value={search}
              onChange={(e) => setParams({ espace: scope, q: e.target.value }, { replace: true })}
            />
          </label>
        </div>
        <p className="visually-hidden" role="status">
          {notice || (search ? `${filtered.length} action(s) trouvée(s)` : "")}
        </p>
        {filtered.length ? (
          <div className="action-grid">
            {filtered.map((i) => (
              <ActionTile key={i.id} item={i} />
            ))}
          </div>
        ) : (
          <div className="launch-empty">
            <h3>{search ? "Aucune action trouvée" : "Votre accueil vous ressemble"}</h3>
            <p>
              {search
                ? "Essayez « groupe », « paie » ou le nom de l’action."
                : "Ouvrez Personnaliser pour choisir vos raccourcis, ou explorez un espace ci-dessous."}
            </p>
            {search ? (
              <button type="button" className="btn" onClick={() => setParams({ espace: scope })}>
                Effacer la recherche
              </button>
            ) : null}
          </div>
        )}
      </section>
      <section className="launch-spaces" aria-labelledby="spaces-title">
        <div className="launch-section-head">
          <div>
            <h2 id="spaces-title">Vos espaces</h2>
            <p>Retrouvez toutes les fonctionnalités par activité.</p>
          </div>
        </div>
        <div className="workspace-grid">
          {visibleSpaces.map((w) => (
            <Link key={w.id} to={w.to} className={`workspace-link workspace-${w.id}`}>
              <span className="workspace-icon">
                <NavIcon d={w.icon} />
              </span>
              <span>
                <strong>{w.label}</strong>
                <span>
                  {w.id === "training"
                    ? "Élèves, groupes et séances"
                    : w.id === "coworking"
                      ? "Clients, réservations et espace"
                      : w.id === "finance"
                        ? "Encaissements, paie et suivi"
                        : "Pages, médias et demandes"}
                </span>
              </span>
              <NavIcon d={ICONS.arrow} />
            </Link>
          ))}
        </div>
      </section>
    </>
  );
}

export function LaunchpadPage() {
  usePage(["Mes raccourcis"]);
  const { session } = useSession();
  return (
    <div className="launchpad">
      <header className="launch-heading">
        <div>
          <h1>Bonjour{session?.user.fullName.trim() ? `, ${session.user.fullName.trim().split(/\s+/)[0]}` : ""}.</h1>
          <p>Que souhaitez-vous faire aujourd’hui ?</p>
        </div>
        <span className="launch-date">{longDate()}</span>
      </header>
      {session ? <Shortcuts key={session.user.id} userId={session.user.id} /> : null}
    </div>
  );
}

export function WorkspacePage() {
  const { slug } = useParams();
  const { can } = useSession();
  const workspace = WORKSPACES.find((w) => w.to === `/espaces/${slug}`);
  usePage([workspace?.label ?? "Espaces"]);
  if (!workspace)
    return (
      <p>
        Espace introuvable. <Link to="/">Retour à l’accueil</Link>
      </p>
    );
  const items = workspace.items.filter((i) => permitted(i.permission, can));
  return (
    <div className="launchpad workspace-page">
      <Link to="/raccourcis" className="launch-back">
        ‹ Tous les espaces
      </Link>
      <header className="launch-heading">
        <div>
          <h1>{workspace.title}</h1>
          <p>{workspace.text}</p>
        </div>
        <span className={`workspace-emblem workspace-${workspace.id}`}>
          <NavIcon d={workspace.icon} />
        </span>
      </header>
      {items.length ? (
        (["Au quotidien", "Dossiers et catalogue", "Suivi et analyse"] as const).map((section) => {
          const links = items.filter((i) => i.section === section);
          return links.length ? (
            <section className="launch-actions" key={section} aria-label={section}>
              <div className="launch-section-head">
                <h2>{section}</h2>
              </div>
              <div className={`action-grid${section === "Au quotidien" ? "" : " reference-grid"}`}>
                {links.map((i) => (
                  <ActionTile key={i.id} item={i} />
                ))}
              </div>
            </section>
          ) : null;
        })
      ) : (
        <div className="launch-empty">
          <h2>Accès réservé</h2>
          <p>Votre rôle ne permet pas d’ouvrir cet espace. Retrouvez vos actions disponibles sur l’accueil.</p>
          <Link className="btn" to="/">
            Retour à l’accueil
          </Link>
        </div>
      )}
    </div>
  );
}
