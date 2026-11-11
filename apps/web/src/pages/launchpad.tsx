import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { api } from "../api/client";
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

export const longDate = () => new Intl.DateTimeFormat("fr-TN", { weekday: "long", day: "numeric", month: "long" }).format(new Date());

const MAX_SHORTCUTS = 12;

/** Shortcuts chosen in this browser before they were saved on the account; read once, as a starting point. */
function legacyShortcuts(userId: string): string[] | null {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(`gcf.shortcuts.v1.${userId}`) ?? "null");
    return Array.isArray(saved) && saved.every((id) => typeof id === "string") ? (saved as string[]) : null;
  } catch {
    return null;
  }
}

function Shortcuts({ userId, saved }: { userId: string; saved: string[] | null }) {
  const { can, refresh } = useSession();
  const available = ACTIONS.filter((i) => permitted(i.permission, can));
  const advised = DEFAULT_SHORTCUTS.filter((id) => available.some((i) => i.id === id)).slice(0, 8);
  const [ids, setIds] = useState<string[]>(() => saved ?? legacyShortcuts(userId) ?? advised);
  const [editing, setEditing] = useState(false);
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
  const save = useMutation({
    mutationFn: (next: string[] | null) => api.put("/auth/shortcuts", { ids: next }),
    onSuccess: async () => {
      setNotice("Raccourcis enregistrés sur votre compte.");
      await refresh();
    },
    onError: () => setNotice("Les raccourcis n'ont pas pu être enregistrés. Réessayez."),
  });
  const update = (next: string[]) => {
    setIds(next);
    save.mutate(next);
  };
  const move = (index: number, by: -1 | 1) => {
    const next = selected.map((i) => i.id);
    const [moved] = next.splice(index, 1);
    next.splice(index + by, 0, moved!);
    update(next);
  };
  const visibleSpaces = WORKSPACES.filter((w) => w.items.some((i) => permitted(i.permission, can)));
  const full = selected.length >= MAX_SHORTCUTS;
  return (
    <>
      <section className="launch-actions" aria-labelledby="shortcuts-title">
        <div className="launch-section-head">
          <div>
            <h2 id="shortcuts-title">{editing ? "Personnaliser mes raccourcis" : "Mes raccourcis"}</h2>
            <p>
              {editing
                ? `Choisissez jusqu'à ${MAX_SHORTCUTS} actions et rangez-les dans l'ordre qui vous convient.`
                : "Vos actions courantes, à portée de main."}
            </p>
          </div>
          <button type="button" className={editing ? "btn btn-p" : "btn"} aria-pressed={editing} onClick={() => setEditing(!editing)}>
            {editing ? "Terminer" : "Personnaliser"}
          </button>
        </div>
        <p className={editing ? "cap" : "visually-hidden"} role="status">
          {notice || (search ? `${filtered.length} action(s) trouvée(s)` : "")}
        </p>
        {editing ? (
          <div className="shortcut-editor">
            <div>
              <h3>Mes raccourcis, dans l'ordre</h3>
              {selected.length === 0 ? <p className="cap">Aucun raccourci. Ajoutez une action depuis la liste.</p> : null}
              <ol className="shortcut-order">
                {selected.map((item, index) => (
                  <li key={item.id}>
                    <span className="shortcut-rank">{index + 1}</span>
                    <span className="action-icon">
                      <NavIcon d={item.icon} />
                    </span>
                    <span className="shortcut-name">{item.label}</span>
                    <button type="button" className="btn btn-g" disabled={index === 0} aria-label={`Monter ${item.label}`} onClick={() => move(index, -1)}>
                      ↑
                    </button>
                    <button
                      type="button"
                      className="btn btn-g"
                      disabled={index === selected.length - 1}
                      aria-label={`Descendre ${item.label}`}
                      onClick={() => move(index, 1)}
                    >
                      ↓
                    </button>
                    <button type="button" className="btn btn-l" onClick={() => update(ids.filter((id) => id !== item.id))}>
                      Retirer
                    </button>
                  </li>
                ))}
              </ol>
              <button type="button" className="btn" onClick={() => update(advised)}>
                Rétablir les raccourcis conseillés
              </button>
            </div>
            <div>
              <h3>Ajouter une action</h3>
              {full ? <p className="cap">{MAX_SHORTCUTS} raccourcis au maximum : retirez-en un pour en ajouter un autre.</p> : null}
              {visibleSpaces.map((w) => {
                const rest = w.items.filter((i) => permitted(i.permission, can) && !ids.includes(i.id));
                return rest.length ? (
                  <fieldset key={w.id} className="shortcut-add">
                    <legend>{w.label}</legend>
                    {rest.map((i) => (
                      <button key={i.id} type="button" className="btn" disabled={full} onClick={() => update([...selected.map((s) => s.id), i.id])}>
                        + {i.label}
                      </button>
                    ))}
                  </fieldset>
                ) : null;
              })}
            </div>
          </div>
        ) : (
          <>
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
            {filtered.length ? (
              <div className="action-grid">
                {filtered.map((i) => (
                  <ActionTile key={i.id} item={i} />
                ))}
              </div>
            ) : (
              <div className="launch-empty">
                <h3>{search ? "Aucune action trouvée" : "Aucun raccourci pour l'instant"}</h3>
                <p>{search ? "Essayez « groupe », « paie » ou le nom de l’action." : "Choisissez vos actions courantes avec Personnaliser."}</p>
                {search ? (
                  <button type="button" className="btn" onClick={() => setParams({ espace: scope })}>
                    Effacer la recherche
                  </button>
                ) : (
                  <button type="button" className="btn btn-p" onClick={() => setEditing(true)}>
                    Personnaliser
                  </button>
                )}
              </div>
            )}
          </>
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
                <span>{w.summary}</span>
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
      {session ? <Shortcuts key={session.user.id} userId={session.user.id} saved={session.shortcuts} /> : null}
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
