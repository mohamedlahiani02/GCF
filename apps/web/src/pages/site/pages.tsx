import type { SiteLanguage } from "@gcf/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { api } from "../../api/client";
import { useSession } from "../../auth/session";
import { usePage } from "../../components/shell";
import { useToast } from "../../components/toasts";
import { Badge, Card, Drawer, Empty, ErrorBanner, Field, Loading, Modal, PageHeader, Segmented } from "../../components/ui";
import { frDate, frDateTime, todayIso } from "../../lib/format";
import { fetchPages, fetchSettings, flattenPages, PAGE_STATUS, pageTitle, siteKeys, SLUG_PATTERN, slugify, subtreeIds, type PageNode } from "./api";
import { ConfirmDialog, MoveButtons, moveItem } from "./common";

const slugError = (slug: string) => (slug && !SLUG_PATTERN.test(slug) ? "Lettres minuscules sans accent, chiffres et tirets uniquement." : null);

/** Pages that may hold the given page: content pages other than the home page, outside the page's own subtree. */
function parentOptions(pages: PageNode[], excluded: string[]): { page: PageNode; depth: number }[] {
  return flattenPages(pages).filter(({ page }) => page.kind === "page" && !page.isHome && !excluded.includes(page.id));
}

function ParentSelect({
  pages,
  language,
  value,
  excluded,
  onChange,
}: {
  pages: PageNode[];
  language: SiteLanguage;
  value: string;
  excluded: string[];
  onChange: (v: string) => void;
}) {
  return (
    <Field label="Placée sous" hint="Une page vit au plus sur trois niveaux.">
      <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Premier niveau du site</option>
        {parentOptions(pages, excluded).map(({ page, depth }) => (
          <option key={page.id} value={page.id}>
            {"   ".repeat(depth)}
            {pageTitle(page, language)} ({page.path})
          </option>
        ))}
      </select>
    </Field>
  );
}

function CreatePageModal({ kind, pages, language, onClose }: { kind: "page" | "article"; pages: PageNode[]; language: SiteLanguage; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [type, setType] = useState(kind);
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [parentId, setParentId] = useState("");
  const [showInMenu, setShowInMenu] = useState(kind === "page");
  const [showInFooter, setShowInFooter] = useState(false);
  const [articleDate, setArticleDate] = useState(todayIso());
  const effectiveSlug = slugEdited ? slug : slugify(title);
  const create = useMutation({
    mutationFn: () =>
      api.post<PageNode>("/site/pages", {
        kind: type,
        title: title.trim(),
        slug: effectiveSlug,
        parentId: parentId || null,
        showInMenu,
        showInFooter,
        ...(type === "article" ? { articleDate } : {}),
      }),
    onSuccess: async (page) => {
      await client.invalidateQueries({ queryKey: siteKeys.pages });
      toast(type === "article" ? "Article créé." : "Page créée.");
      onClose();
      navigate(`/site/pages/${page.id}`);
    },
  });
  return (
    <Modal
      title={type === "article" ? "Nouvel article" : "Nouvelle page"}
      onClose={onClose}
      footer={
        <>
          <span className="cap">La page est créée en brouillon</span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button
              type="button"
              className="btn btn-p"
              disabled={!title.trim() || !effectiveSlug || !!slugError(effectiveSlug) || (type === "article" && !articleDate) || create.isPending}
              onClick={() => create.mutate()}
            >
              Créer et modifier
            </button>
          </div>
        </>
      }
    >
      <Segmented
        label="Type de contenu"
        value={type}
        onChange={(v) => (setType(v), setShowInMenu(v === "page"))}
        options={[
          { value: "page", label: "Page" },
          { value: "article", label: "Article" },
        ]}
      />
      <Field label="Titre *" hint="Le même titre est repris dans chaque langue ; traduisez-le ensuite dans l'éditeur.">
        <input className="input" value={title} maxLength={200} autoFocus onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="Adresse *" hint={`Segment d'adresse : /${effectiveSlug || "..."}`} error={slugError(effectiveSlug)}>
        <input
          className="input"
          value={effectiveSlug}
          maxLength={80}
          onChange={(e) => {
            setSlugEdited(true);
            setSlug(e.target.value);
          }}
        />
      </Field>
      <ParentSelect pages={pages} language={language} value={parentId} excluded={[]} onChange={setParentId} />
      {type === "article" ? (
        <Field label="Date de l'article *">
          <input className="input" type="date" value={articleDate} onChange={(e) => setArticleDate(e.target.value)} />
        </Field>
      ) : null}
      <div className="row" style={{ gap: 16 }}>
        <label className="row center" style={{ gap: 6 }}>
          <input type="checkbox" className="chk" checked={showInMenu} onChange={(e) => setShowInMenu(e.target.checked)} />
          Dans le menu
        </label>
        <label className="row center" style={{ gap: 6 }}>
          <input type="checkbox" className="chk" checked={showInFooter} onChange={(e) => setShowInFooter(e.target.checked)} />
          Dans le pied de page
        </label>
      </div>
      <ErrorBanner error={create.error} />
    </Modal>
  );
}

type PageAction = "home" | "unpublish" | "archive";

function PageDrawer({ page, pages, language, onClose }: { page: PageNode; pages: PageNode[]; language: SiteLanguage; onClose: () => void }) {
  const { can } = useSession();
  const client = useQueryClient();
  const toast = useToast();
  const [slug, setSlug] = useState(page.slug);
  const [parentId, setParentId] = useState(page.parentId ?? "");
  const [showInMenu, setShowInMenu] = useState(page.showInMenu);
  const [showInFooter, setShowInFooter] = useState(page.showInFooter);
  const [articleDate, setArticleDate] = useState(page.articleDate ?? "");
  const [action, setAction] = useState<PageAction | null>(null);
  const moved = slug !== page.slug || parentId !== (page.parentId ?? "");
  const save = useMutation({
    mutationFn: () =>
      api.patch<PageNode>(`/site/pages/${page.id}`, {
        ...(slug !== page.slug ? { slug } : {}),
        ...(parentId !== (page.parentId ?? "") ? { parentId: parentId || null } : {}),
        showInMenu,
        showInFooter,
        ...(page.kind === "article" && articleDate !== page.articleDate ? { articleDate } : {}),
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: siteKeys.pages });
      if (moved) await client.invalidateQueries({ queryKey: siteKeys.redirects });
      toast("Propriétés enregistrées.");
      onClose();
    },
  });
  const publish = can("website:publish");
  const archivable = page.status !== "published" || publish;
  const canBeHome = page.kind === "page" && page.parentId === null && !page.isHome && page.children.length === 0;
  const run = async (path: string, message: string) => {
    await api.post(`/site/pages/${page.id}/${path}`);
    await client.invalidateQueries({ queryKey: siteKeys.pages });
    toast(message);
    onClose();
  };
  return (
    <Drawer
      title={pageTitle(page, language)}
      onClose={onClose}
      footer={
        <>
          <span className="cap">{moved && page.status === "published" ? "L'ancienne adresse sera redirigée vers la nouvelle." : ""}</span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button type="button" className="btn btn-p" disabled={!slug || !!slugError(slug) || save.isPending} onClick={() => save.mutate()}>
              Enregistrer
            </button>
          </div>
        </>
      }
    >
      <div className="row center" style={{ gap: 6 }}>
        <Badge tone={PAGE_STATUS[page.status].tone}>{PAGE_STATUS[page.status].label}</Badge>
        {page.isHome ? <Badge tone="violet">Accueil</Badge> : null}
        {page.kind === "article" ? <Badge tone="teal">Article</Badge> : null}
        <span className="cap">{page.path}</span>
      </div>
      <Field label="Adresse *" hint={page.isHome ? "La page d'accueil est servie à la racine du site." : undefined} error={slugError(slug)}>
        <input className="input" value={slug} maxLength={80} onChange={(e) => setSlug(e.target.value)} />
      </Field>
      {page.isHome ? null : <ParentSelect pages={pages} language={language} value={parentId} excluded={subtreeIds(page)} onChange={setParentId} />}
      {page.kind === "article" ? (
        <Field label="Date de l'article">
          <input className="input" type="date" value={articleDate} onChange={(e) => setArticleDate(e.target.value)} />
        </Field>
      ) : null}
      <label className="row center" style={{ gap: 6 }}>
        <input type="checkbox" className="chk" checked={showInMenu} onChange={(e) => setShowInMenu(e.target.checked)} />
        Afficher dans le menu
      </label>
      <label className="row center" style={{ gap: 6 }}>
        <input type="checkbox" className="chk" checked={showInFooter} onChange={(e) => setShowInFooter(e.target.checked)} />
        Afficher dans le pied de page
      </label>
      <ErrorBanner error={save.error} />
      <hr className="sep" />
      <div className="stack" style={{ gap: 8 }}>
        <span className="lab">Actions</span>
        <Link to={`/site/pages/${page.id}`} className="btn">
          Modifier le contenu
        </Link>
        {publish && canBeHome ? (
          <button type="button" className="btn" onClick={() => setAction("home")}>
            Définir comme page d'accueil
          </button>
        ) : null}
        {publish && page.status === "published" ? (
          <button type="button" className="btn" onClick={() => setAction("unpublish")}>
            Dépublier
          </button>
        ) : null}
        {page.isHome ? (
          <span className="cap">La page d'accueil ne peut pas être archivée : choisissez d'abord une autre page d'accueil.</span>
        ) : archivable ? (
          <button type="button" className="btn btn-d" onClick={() => setAction("archive")}>
            Archiver
          </button>
        ) : (
          <span className="cap">Une page publiée ne peut être archivée que par un éditeur du site ou un administrateur.</span>
        )}
      </div>
      {action === "home" ? (
        <ConfirmDialog
          title="Changer la page d'accueil"
          confirmLabel="Définir comme accueil"
          onClose={() => setAction(null)}
          onConfirm={() => run("home", "Page d'accueil modifiée.")}
        >
          « {pageTitle(page, language)} » devient la page affichée à la racine du site. L'ancienne page d'accueil redevient une page ordinaire.
        </ConfirmDialog>
      ) : null}
      {action === "unpublish" ? (
        <ConfirmDialog
          title="Dépublier la page"
          confirmLabel="Dépublier"
          danger
          onClose={() => setAction(null)}
          onConfirm={() => run("unpublish", "Page dépubliée.")}
        >
          La page disparaît du site public et repasse en brouillon. Son contenu et ses versions sont conservés.
        </ConfirmDialog>
      ) : null}
      {action === "archive" ? (
        <ConfirmDialog
          title="Archiver la page"
          confirmLabel="Archiver"
          danger
          onClose={() => setAction(null)}
          onConfirm={() => run("archive", "Page archivée.")}
        >
          La page quitte la liste et le site public, sans redirection : son adresse cessera d'exister. Une publication programmée est annulée.
        </ConfirmDialog>
      ) : null}
    </Drawer>
  );
}

function StatusBadges({ page }: { page: PageNode }) {
  return (
    <span className="row center" style={{ gap: 4 }}>
      <Badge tone={PAGE_STATUS[page.status].tone}>
        {PAGE_STATUS[page.status].label}
        {page.publishedVersion ? ` (v${page.publishedVersion})` : ""}
      </Badge>
      {page.scheduledAt ? (
        <span title={`Programmée le ${frDateTime(page.scheduledAt)}`}>
          <Badge tone="blue">Programmée</Badge>
        </span>
      ) : null}
    </span>
  );
}

export function PagesPage() {
  usePage(["Site web", "Pages"]);
  const client = useQueryClient();
  const toast = useToast();
  const settings = useQuery({ queryKey: siteKeys.settings, queryFn: fetchSettings });
  const pages = useQuery({ queryKey: siteKeys.pages, queryFn: fetchPages });
  const [creating, setCreating] = useState<"page" | "article" | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const language = settings.data?.defaultLanguage ?? "fr";
  const reorder = useMutation({
    mutationFn: (body: { parentId: string | null; pageIds: string[] }) => api.post("/site/pages/reorder", body),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: siteKeys.pages });
      toast("Ordre enregistré.");
    },
  });
  const tree = pages.data ?? [];
  const rows = flattenPages(tree);
  const siblingsOf = (page: PageNode) => (page.parentId ? (rows.find((r) => r.page.id === page.parentId)?.page.children ?? []) : tree);
  const selectedPage = rows.find((r) => r.page.id === selected)?.page;
  return (
    <>
      <PageHeader
        title="Pages du site"
        subtitle="Pages et articles, dans l'ordre du menu. Le contenu se modifie dans l'éditeur de chaque page."
        actions={
          <>
            <button type="button" className="btn" onClick={() => setCreating("article")}>
              + Nouvel article
            </button>
            <button type="button" className="btn btn-p" onClick={() => setCreating("page")}>
              + Nouvelle page
            </button>
          </>
        }
      />
      {settings.data && !settings.data.online ? (
        <div className="ban ban-amber">
          <span>Le site est hors ligne : les visiteurs ne voient aucune page.</span>
          <Link to="/site/parametres" className="btn">
            Paramètres du site
          </Link>
        </div>
      ) : null}
      <ErrorBanner error={pages.error ?? settings.error} retry={() => (pages.refetch(), settings.refetch())} />
      <ErrorBanner error={reorder.error} />
      {pages.isPending ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Card>
          <Empty
            title="Aucune page"
            text="Commencez par la page d'accueil."
            action={
              <button type="button" className="btn btn-p" onClick={() => setCreating("page")}>
                + Nouvelle page
              </button>
            }
          />
        </Card>
      ) : (
        <Card>
          <div className="xs">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Titre</th>
                  <th>Adresse</th>
                  <th>Menu</th>
                  <th>Pied de page</th>
                  <th>Statut</th>
                  <th>Ordre</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map(({ page, depth }) => {
                  const siblings = siblingsOf(page);
                  const index = siblings.findIndex((s) => s.id === page.id);
                  const title = pageTitle(page, language);
                  return (
                    <tr key={page.id}>
                      <td>
                        <div className="site-tree-cell" style={{ paddingInlineStart: depth * 22 }}>
                          {depth > 0 ? (
                            <span className="site-tree-mark" aria-hidden="true">
                              └
                            </span>
                          ) : null}
                          <Link to={`/site/pages/${page.id}`}>
                            <strong>{title}</strong>
                          </Link>
                          {page.isHome ? <Badge tone="violet">Accueil</Badge> : null}
                          {page.kind === "article" ? <Badge tone="teal">Article{page.articleDate ? ` du ${frDate(page.articleDate)}` : ""}</Badge> : null}
                        </div>
                      </td>
                      <td>
                        <code className="site-path">{page.path}</code>
                      </td>
                      <td>{page.showInMenu ? "Oui" : <span className="cap">Non</span>}</td>
                      <td>{page.showInFooter ? "Oui" : <span className="cap">Non</span>}</td>
                      <td>
                        <StatusBadges page={page} />
                      </td>
                      <td>
                        <MoveButtons
                          label={`la page ${title}`}
                          index={index}
                          count={siblings.length}
                          onMove={(to) => reorder.mutate({ parentId: page.parentId, pageIds: moveItem(siblings, index, to).map((s) => s.id) })}
                        />
                      </td>
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                        <Link to={`/site/pages/${page.id}`} className="btn btn-g" aria-label={`Modifier le contenu de ${title}`}>
                          Modifier
                        </Link>
                        <button type="button" className="btn btn-g" aria-label={`Propriétés de ${title}`} onClick={() => setSelected(page.id)}>
                          Propriétés
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {creating ? <CreatePageModal kind={creating} pages={tree} language={language} onClose={() => setCreating(null)} /> : null}
      {selectedPage ? <PageDrawer key={selectedPage.id} page={selectedPage} pages={tree} language={language} onClose={() => setSelected(null)} /> : null}
    </>
  );
}
