import { SECTION_LIMITS, SECTION_TYPE_LABELS, SECTION_TYPES, type SectionType, type SiteLanguage, type SiteSection } from "@gcf/shared";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useBlocker, useParams } from "react-router";
import { api, ApiError } from "../../api/client";
import { useSession } from "../../auth/session";
import { usePage } from "../../components/shell";
import { useToast } from "../../components/toasts";
import { Badge, Card, Empty, ErrorBanner, Field, Loading, Modal, PageHeader, Tabs } from "../../components/ui";
import { frDateTime, todayIso, zonedIso, addDaysIso } from "../../lib/format";
import {
  fetchPages,
  fetchSettings,
  flattenPages,
  LANGUAGE_LABEL,
  PAGE_STATUS,
  pageTitle,
  siteKeys,
  type Draft,
  type PageNode,
  type PageVersion,
  type SiteSettings,
} from "./api";
import { CharCount, ConfirmDialog, MoveButtons, moveItem } from "./common";
import { ImageField } from "./media";
import { newSection, SECTION_HELP, SectionForm, type LinkContext } from "./sections";

/* Editing state */

interface SectionItem {
  uid: number;
  section: SiteSection;
}

interface LanguageForm {
  title: string;
  menuLabel: string;
  seoTitle: string;
  seoDescription: string;
  ogMediaId: string | null;
  sections: SectionItem[];
}

/** Problems the API found in one language's draft, attached to the field or section they concern. */
interface SaveErrors {
  fields: Partial<Record<"title" | "menuLabel" | "seoTitle" | "seoDescription" | "ogMediaId", string>>;
  sections: Record<number, string[]>;
  /** Problems of the page as a whole, already worded in French. */
  notes: string[];
  general: unknown;
}

const ANCHOR_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

let uidCounter = 0;
const nextUid = () => (uidCounter += 1);

function formOf(draft: Draft): LanguageForm {
  return {
    title: draft.title,
    menuLabel: draft.menuLabel ?? "",
    seoTitle: draft.seoTitle ?? "",
    seoDescription: draft.seoDescription ?? "",
    ogMediaId: draft.ogMediaId,
    sections: draft.sections.map((section) => ({ uid: nextUid(), section })),
  };
}

/** The PUT body of a draft; blank optional texts are left out. */
function bodyOf(form: LanguageForm) {
  return {
    title: form.title,
    ...(form.menuLabel.trim() ? { menuLabel: form.menuLabel } : {}),
    ...(form.seoTitle.trim() ? { seoTitle: form.seoTitle } : {}),
    ...(form.seoDescription.trim() ? { seoDescription: form.seoDescription } : {}),
    ogMediaId: form.ogMediaId,
    sections: form.sections.map((s) => s.section),
  };
}

const FIELD_WORDS: Record<string, string> = {
  title: "titre",
  subtitle: "texte",
  text: "texte",
  intro: "introduction",
  body: "contenu",
  content: "texte",
  items: "élément",
  button: "bouton",
  label: "libellé",
  target: "destination",
  url: "adresse",
  pageId: "page",
  anchor: "section visée",
  imageId: "image",
  caption: "légende",
  quote: "citation",
  author: "auteur",
  role: "fonction",
  question: "question",
  answer: "réponse",
  icon: "icône",
  submitLabel: "libellé du bouton",
  limit: "nombre d'articles",
  id: "ancre",
  typeId: "type d'espace",
  variant: "type de demande",
  href: "lien",
};

/** French reading of a zod path inside a section, e.g. "items.0.title" becomes "élément 1 › titre". */
function describePath(segments: string[]): string {
  const words: string[] = [];
  for (const segment of segments) {
    if (/^\d+$/.test(segment)) {
      if (words.length) words[words.length - 1] = `${words.at(-1)} ${Number(segment) + 1}`;
    } else words.push(FIELD_WORDS[segment] ?? segment);
  }
  return words.join(" › ") || "section";
}

function describeIssue(message: string): string {
  if (/https/i.test(message)) return "adresse https:// attendue";
  if (/too small/i.test(message)) return "obligatoire";
  if (/too big/i.test(message)) return "trop long";
  if (/uuid/i.test(message)) return "à choisir";
  return "valeur invalide";
}

const TOP_FIELDS = ["title", "menuLabel", "seoTitle", "seoDescription", "ogMediaId"] as const;

/** Spreads an API error over the fields and sections of the form that was sent. */
function mapErrors(error: unknown, form: LanguageForm): SaveErrors {
  const result: SaveErrors = { fields: {}, sections: {}, notes: [], general: null };
  const addToSection = (uid: number, text: string) => (result.sections[uid] = [...(result.sections[uid] ?? []), text]);
  if (error instanceof ApiError && error.code === "invalid_input" && Array.isArray(error.details)) {
    let unplaced = false;
    for (const issue of error.details as { path?: string; message?: string }[]) {
      const segments = (issue.path ?? "").split(".").filter(Boolean);
      const [head, index, ...rest] = segments;
      const top = TOP_FIELDS.find((f) => f === head);
      if (top) result.fields[top] = describeIssue(issue.message ?? "");
      else if (head === "sections" && index !== undefined && form.sections[Number(index)])
        addToSection(form.sections[Number(index)]!.uid, `${describePath(rest)} : ${describeIssue(issue.message ?? "")}`);
      else if (head === "sections" && /once/.test(issue.message ?? "")) result.notes.push("Chaque ancre de section doit être unique sur la page.");
      else unplaced = true;
    }
    if (unplaced && !result.general) result.general = error;
    return result;
  }
  if (error instanceof ApiError && (error.code === "unknown_media" || error.code === "unknown_page")) {
    const ids = ((error.details as { ids?: string[] } | undefined)?.ids ?? []) as string[];
    let placed = false;
    for (const item of form.sections) {
      const s = item.section;
      const used =
        error.code === "unknown_media"
          ? [...(s.type === "hero" && s.imageId ? [s.imageId] : []), ...(s.type === "gallery" ? s.items.map((i) => i.imageId) : [])]
          : (s.type === "hero" || s.type === "cta") && s.button?.target.kind === "page"
            ? [s.button.target.pageId]
            : [];
      if (used.some((u) => ids.includes(u))) {
        addToSection(item.uid, error.code === "unknown_media" ? "une image n'existe plus ou a été archivée" : "la page liée n'existe plus ou a été archivée");
        placed = true;
      }
    }
    if (error.code === "unknown_media" && form.ogMediaId && ids.includes(form.ogMediaId)) {
      result.fields.ogMediaId = "image archivée ou supprimée";
      placed = true;
    }
    if (!placed) result.general = error;
    return result;
  }
  result.general = error;
  return result;
}

/** Public path of the page in a language: the default language at the root, the other under its prefix. */
function languagePath(page: PageNode, language: SiteLanguage, defaultLanguage: SiteLanguage): string {
  if (language === defaultLanguage) return page.path;
  return page.path === "/" ? `/${language}` : `/${language}${page.path}`;
}

/* Components */

function SnippetPreview({ form, page, language, settings }: { form: LanguageForm; page: PageNode; language: SiteLanguage; settings: SiteSettings }) {
  const siteName = settings.siteName ?? "";
  const title = form.seoTitle.trim() || (page.isHome ? siteName : `${form.title.trim()}${siteName ? ` | ${siteName}` : ""}`);
  const description = form.seoDescription.trim() || settings.seoDescription || settings.tagline || "";
  return (
    <div className="site-snippet" aria-label="Aperçu dans les résultats de recherche">
      <div className="cap">
        {siteName || "Site"} › {languagePath(page, language, settings.defaultLanguage)}
      </div>
      <div className="site-snippet-title">{title || "Titre de la page"}</div>
      <div className="site-snippet-text">{description || "Ajoutez une description pour donner envie de cliquer."}</div>
    </div>
  );
}

function SectionPicker({ onPick, onClose }: { onPick: (type: SectionType) => void; onClose: () => void }) {
  return (
    <Modal
      title="Ajouter une section"
      wide
      onClose={onClose}
      footer={
        <>
          <span />
          <button type="button" className="btn" onClick={onClose}>
            Annuler
          </button>
        </>
      }
    >
      <ul className="site-picker">
        {SECTION_TYPES.map((type) => (
          <li key={type}>
            <button type="button" className="site-picker-item" onClick={() => (onPick(type), onClose())}>
              <strong>{SECTION_TYPE_LABELS[type]}</strong>
              <span className="cap">{SECTION_HELP[type]}</span>
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

function SectionCard({
  item,
  index,
  count,
  open,
  errors,
  anchors,
  links,
  onToggle,
  onChange,
  onMove,
  onDuplicate,
  onRemove,
  canDuplicate,
}: {
  item: SectionItem;
  index: number;
  count: number;
  open: boolean;
  errors: string[];
  anchors: string[];
  links: LinkContext;
  onToggle: () => void;
  onChange: (section: SiteSection) => void;
  onMove: (to: number) => void;
  onDuplicate: () => void;
  onRemove: () => void;
  canDuplicate: boolean;
}) {
  const s = item.section;
  const label = SECTION_TYPE_LABELS[s.type];
  const name = `la section ${index + 1} (${label})`;
  const anchorError = !ANCHOR_PATTERN.test(s.id)
    ? "Lettres minuscules sans accent, chiffres et tirets uniquement."
    : anchors.filter((a) => a === s.id).length > 1
      ? "Une autre section utilise déjà cette ancre."
      : null;
  const bodyId = `section-body-${item.uid}`;
  const heading = "title" in s && s.title ? s.title : null;
  return (
    <section className={`card site-section${errors.length || anchorError ? " site-section-err" : ""}`} aria-label={`Section ${index + 1} : ${label}`}>
      <div className="card-h">
        <button type="button" className="site-section-toggle" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
          <span aria-hidden="true">{open ? "▾" : "▸"}</span>
          <span>
            <strong>
              {index + 1}. {label}
            </strong>
            <span className="cap">
              {" "}
              #{s.id}
              {heading ? ` · ${heading}` : ""}
            </span>
          </span>
          {errors.length || anchorError ? <Badge tone="red">À corriger</Badge> : null}
        </button>
        <div className="row center" style={{ gap: 2, flexWrap: "nowrap" }}>
          <MoveButtons label={name} index={index} count={count} onMove={onMove} />
          <button type="button" className="btn btn-g" aria-label={`Dupliquer ${name}`} disabled={!canDuplicate} onClick={onDuplicate}>
            Dupliquer
          </button>
          <button type="button" className="btn btn-g" aria-label={`Supprimer ${name}`} onClick={onRemove}>
            Supprimer
          </button>
        </div>
      </div>
      {open ? (
        <div className="card-b stack" id={bodyId}>
          {errors.length ? (
            <div className="ban ban-red" role="alert" style={{ flexDirection: "column", alignItems: "flex-start" }}>
              <strong>Cette section n'a pas pu être enregistrée</strong>
              <ul>
                {errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <span className="cap">{SECTION_HELP[s.type]}</span>
          <SectionForm section={s} onChange={onChange} links={links} editorKey={String(item.uid)} />
          <Field label="Ancre de la section" hint={`Adresse directe de la section : #${s.id}`} error={anchorError}>
            <input className="input" value={s.id} maxLength={40} onChange={(e) => onChange({ ...s, id: e.target.value })} style={{ maxWidth: 320 }} />
          </Field>
        </div>
      ) : null}
    </section>
  );
}

function PublishCard({ page, dirty }: { page: PageNode; dirty: boolean }) {
  const { can } = useSession();
  const client = useQueryClient();
  const toast = useToast();
  const [date, setDate] = useState(addDaysIso(todayIso(), 1));
  const [time, setTime] = useState("08:00");
  const [confirming, setConfirming] = useState<"now" | "schedule" | "cancel" | null>(null);
  const publishable = can("website:publish");
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: siteKeys.pages });
    await client.invalidateQueries({ queryKey: siteKeys.versions(page.id) });
  };
  const scheduledLabel = page.scheduledAt ? frDateTime(page.scheduledAt) : null;
  return (
    <Card title="Publication">
      <div className="card-b stack">
        <div className="row center" style={{ gap: 6 }}>
          <Badge tone={PAGE_STATUS[page.status].tone}>{PAGE_STATUS[page.status].label}</Badge>
          {page.publishedVersion ? <span className="cap">Version {page.publishedVersion} en ligne</span> : null}
        </div>
        {scheduledLabel ? (
          <div className="ban ban-blue">
            <span>
              Version {page.scheduledVersion} programmée le {scheduledLabel}.
            </span>
            {publishable ? (
              <button type="button" className="btn" onClick={() => setConfirming("cancel")}>
                Annuler la programmation
              </button>
            ) : null}
          </div>
        ) : null}
        {!publishable ? (
          <span className="cap">La publication est réservée aux éditeurs du site et aux administrateurs.</span>
        ) : (
          <>
            {dirty ? (
              <div className="ban ban-amber" role="status">
                Enregistrez d'abord le brouillon : la publication reprend le dernier brouillon enregistré de chaque langue.
              </div>
            ) : null}
            <button type="button" className="btn btn-p" disabled={dirty} onClick={() => setConfirming("now")}>
              Publier maintenant
            </button>
            <hr className="sep" />
            <div className="lab">Programmer la publication</div>
            <div className="grid2">
              <Field label="Date">
                <input className="input" type="date" value={date} min={todayIso()} onChange={(e) => setDate(e.target.value)} />
              </Field>
              <Field label="Heure">
                <input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
              </Field>
            </div>
            <span className="cap">Heure du centre. Une nouvelle programmation remplace la précédente.</span>
            <button type="button" className="btn" disabled={dirty || !date || !time} onClick={() => setConfirming("schedule")}>
              Programmer
            </button>
          </>
        )}
      </div>
      {confirming === "now" ? (
        <ConfirmDialog
          title="Publier la page"
          confirmLabel="Publier"
          onClose={() => setConfirming(null)}
          onConfirm={async () => {
            await api.post(`/site/pages/${page.id}/publish`, {});
            await refresh();
            toast("Page publiée.");
          }}
        >
          Le dernier brouillon enregistré de chaque langue devient la version en ligne. Une nouvelle version est ajoutée à l'historique.
        </ConfirmDialog>
      ) : null}
      {confirming === "schedule" ? (
        <ConfirmDialog
          title="Programmer la publication"
          confirmLabel="Programmer"
          onClose={() => setConfirming(null)}
          onConfirm={async () => {
            await api.post(`/site/pages/${page.id}/publish`, { at: zonedIso(date, time) });
            await refresh();
            toast(`Publication programmée le ${date.split("-").reverse().join("/")} à ${time}.`);
          }}
        >
          Le brouillon enregistré est figé maintenant dans une nouvelle version, qui sera mise en ligne le {date.split("-").reverse().join("/")} à {time}{" "}
          (heure du centre). Les modifications faites ensuite ne seront pas incluses.
        </ConfirmDialog>
      ) : null}
      {confirming === "cancel" ? (
        <ConfirmDialog
          title="Annuler la programmation"
          confirmLabel="Annuler la programmation"
          danger
          onClose={() => setConfirming(null)}
          onConfirm={async () => {
            await api.del(`/site/pages/${page.id}/schedule`);
            await refresh();
            toast("Programmation annulée.");
          }}
        >
          La version programmée le {scheduledLabel} ne sera pas mise en ligne. Elle reste dans l'historique des versions.
        </ConfirmDialog>
      ) : null}
    </Card>
  );
}

function VersionsCard({ pageId, languages, onRestored }: { pageId: string; languages: SiteLanguage[]; onRestored: () => void }) {
  const toast = useToast();
  const versions = useQuery({ queryKey: siteKeys.versions(pageId), queryFn: () => api.get<PageVersion[]>(`/site/pages/${pageId}/versions`) });
  const [restoring, setRestoring] = useState<PageVersion | null>(null);
  return (
    <Card title="Versions publiées">
      <ErrorBanner error={versions.error} retry={() => versions.refetch()} />
      {versions.isPending ? (
        <Loading />
      ) : versions.data?.length === 0 ? (
        <Empty title="Aucune version" text="Chaque publication crée une version." />
      ) : (
        <div className="xs" style={{ maxHeight: 360, overflowY: "auto" }}>
          <table className="tbl">
            <tbody>
              {versions.data?.map((v) => (
                <tr key={v.id}>
                  <td>
                    <strong>Version {v.number}</strong> {v.published ? <Badge tone="green">En ligne</Badge> : null}
                    {v.scheduled ? <Badge tone="blue">Programmée</Badge> : null}
                    <div className="cap">
                      {frDateTime(v.createdAt)}
                      {v.createdBy ? ` · ${v.createdBy}` : ""}
                    </div>
                    <div className="cap">{languages.map((l) => v.titles[l]).filter(Boolean).join(" / ")}</div>
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <button type="button" className="btn btn-g" aria-label={`Restaurer la version ${v.number}`} onClick={() => setRestoring(v)}>
                      Restaurer
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {restoring ? (
        <ConfirmDialog
          title={`Restaurer la version ${restoring.number}`}
          confirmLabel="Restaurer"
          danger
          onClose={() => setRestoring(null)}
          onConfirm={async () => {
            await api.post(`/site/pages/${pageId}/versions/${restoring.id}/restore`);
            onRestored();
            toast(`Version ${restoring.number} restaurée dans le brouillon.`);
          }}
        >
          Le brouillon de chaque langue de cette version est remplacé par son contenu, y compris les modifications non enregistrées. La page en ligne ne
          change pas tant que vous ne publiez pas.
        </ConfirmDialog>
      ) : null}
    </Card>
  );
}

export function PageEditorPage() {
  const { id = "" } = useParams();
  const client = useQueryClient();
  const toast = useToast();
  const settings = useQuery({ queryKey: siteKeys.settings, queryFn: fetchSettings });
  const pages = useQuery({ queryKey: siteKeys.pages, queryFn: fetchPages });
  const languages = settings.data?.languages ?? [];
  const defaultLanguage = settings.data?.defaultLanguage ?? "fr";
  const page = flattenPages(pages.data ?? []).find((p) => p.page.id === id)?.page;
  const [language, setLanguage] = useState<SiteLanguage | null>(null);
  const active = language && languages.includes(language) ? language : defaultLanguage;
  const drafts = useQueries({
    queries: languages.map((l) => ({
      queryKey: siteKeys.draft(id, l),
      queryFn: () => api.get<Draft>(`/site/pages/${id}/drafts/${l}`),
      staleTime: Infinity,
    })),
  });
  const [forms, setForms] = useState<Partial<Record<SiteLanguage, LanguageForm>>>({});
  const [baselines, setBaselines] = useState<Partial<Record<SiteLanguage, string>>>({});
  const [errors, setErrors] = useState<Partial<Record<SiteLanguage, SaveErrors>>>({});
  const [openSections, setOpenSections] = useState<number[]>([]);
  const [picking, setPicking] = useState(false);
  usePage(["Site web", "Pages", page ? pageTitle(page, defaultLanguage) : "Page"]);

  const loadedKey = drafts.map((d) => d.dataUpdatedAt).join(",");
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  useEffect(() => {
    languages.forEach((l, i) => {
      const data = draftsRef.current[i]?.data;
      if (!data) return;
      setForms((current) => (current[l] ? current : { ...current, [l]: formOf(data) }));
      setBaselines((current) => (current[l] !== undefined ? current : { ...current, [l]: JSON.stringify(bodyOf(formOf(data))) }));
    });
  }, [loadedKey, languages.join(",")]);

  const dirtyLanguages = languages.filter((l) => forms[l] && baselines[l] !== undefined && JSON.stringify(bodyOf(forms[l]!)) !== baselines[l]);
  const dirty = dirtyLanguages.length > 0;

  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  /** Drops the local copies so every language is read again from the API (after a restore). */
  const reload = async () => {
    setForms({});
    setBaselines({});
    setErrors({});
    setOpenSections([]);
    await client.invalidateQueries({ queryKey: ["site", "draft", id] });
  };

  const save = useMutation({
    mutationFn: async () => {
      const next = { ...errors };
      let failed = 0;
      for (const l of dirtyLanguages) {
        const form = forms[l]!;
        const body = bodyOf(form);
        try {
          await api.put<Draft>(`/site/pages/${id}/drafts/${l}`, body);
          setBaselines((current) => ({ ...current, [l]: JSON.stringify(body) }));
          delete next[l];
        } catch (error) {
          next[l] = mapErrors(error, form);
          failed += 1;
          setOpenSections((current) => [...new Set([...current, ...Object.keys(next[l]!.sections).map(Number)])]);
        }
      }
      setErrors(next);
      await client.invalidateQueries({ queryKey: siteKeys.pages });
      return failed;
    },
    onSuccess: (failed) => {
      if (failed === 0) toast("Brouillon enregistré.");
      else toast("Certaines modifications n'ont pas été enregistrées : corrigez les erreurs indiquées.", "error");
    },
  });

  if (settings.isPending || pages.isPending) return <Loading />;
  if (settings.error || pages.error)
    return <ErrorBanner error={settings.error ?? pages.error} retry={() => (settings.refetch(), pages.refetch())} />;
  if (!page)
    return (
      <Card>
        <Empty
          title="Page introuvable"
          text="Cette page n'existe pas ou a été archivée."
          action={
            <Link to="/site" className="btn">
              Retour aux pages
            </Link>
          }
        />
      </Card>
    );

  const form = forms[active];
  const draftQuery = drafts[languages.indexOf(active)];
  const langErrors = errors[active];
  const update = (patch: Partial<LanguageForm>) => setForms((current) => ({ ...current, [active]: { ...current[active]!, ...patch } }));
  const setSections = (sections: SectionItem[]) => update({ sections });
  const anchors = form?.sections.map((s) => s.section.id) ?? [];
  const links: LinkContext = { pages: pages.data ?? [], language: active, anchors };
  const toggle = (uid: number) => setOpenSections((current) => (current.includes(uid) ? current.filter((u) => u !== uid) : [...current, uid]));
  const full = (form?.sections.length ?? 0) >= SECTION_LIMITS.sections;

  return (
    <>
      <PageHeader
        title={pageTitle(page, defaultLanguage)}
        subtitle={
          <span className="row center" style={{ gap: 8 }}>
            <Badge tone={PAGE_STATUS[page.status].tone}>{PAGE_STATUS[page.status].label}</Badge>
            {page.scheduledAt ? <Badge tone="blue">Programmée</Badge> : null}
            {page.isHome ? <Badge tone="violet">Accueil</Badge> : null}
            {page.kind === "article" ? <Badge tone="teal">Article</Badge> : null}
            <span>{languagePath(page, active, defaultLanguage)}</span>
            {dirty ? <Badge tone="amber">Modifications non enregistrées</Badge> : null}
          </span>
        }
        actions={
          <>
            <Link to="/site" className="btn btn-g">
              Retour aux pages
            </Link>
            <a className="btn" href={api.fileUrl(`/site/pages/${id}/preview`, { language: active })} target="_blank" rel="noreferrer">
              Aperçu
              <span className="visually-hidden"> (nouvel onglet)</span>
            </a>
            <button type="button" className="btn btn-p" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? <span className="spinner" aria-label="Enregistrement" /> : "Enregistrer le brouillon"}
            </button>
          </>
        }
      />
      {languages.length > 1 ? (
        <Tabs
          value={active}
          onChange={setLanguage}
          tabs={languages.map((l) => ({
            value: l,
            label: `${LANGUAGE_LABEL[l]}${errors[l] ? " (erreurs)" : dirtyLanguages.includes(l) ? " (modifié)" : ""}`,
          }))}
        />
      ) : null}
      {dirty ? <span className="cap">L'aperçu montre le dernier brouillon enregistré.</span> : null}
      <ErrorBanner error={save.error} />
      {langErrors?.general ? <ErrorBanner error={langErrors.general} /> : null}
      {langErrors?.notes.map((note) => (
        <div key={note} className="ban ban-red" role="alert">
          {note}
        </div>
      ))}
      {draftQuery?.error ? <ErrorBanner error={draftQuery.error} retry={() => draftQuery.refetch()} /> : null}
      {!form ? (
        <Loading />
      ) : (
        <div className="grid2 site-editor" style={{ gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)", alignItems: "start" }}>
          <div className="stack" style={{ gap: 20 }}>
            <Card title={`Titre et référencement (${LANGUAGE_LABEL[active].toLowerCase()})`}>
              <div className="card-b stack">
                <div className="grid2">
                  <Field label="Titre de la page *" error={langErrors?.fields.title ?? (form.title.trim() ? null : "Obligatoire.")}>
                    <input className="input" value={form.title} maxLength={200} onChange={(e) => update({ title: e.target.value })} />
                  </Field>
                  <Field label="Libellé dans le menu" hint="Par défaut, le titre de la page." error={langErrors?.fields.menuLabel}>
                    <input className="input" value={form.menuLabel} maxLength={60} onChange={(e) => update({ menuLabel: e.target.value })} />
                  </Field>
                </div>
                <Field label="Titre pour les moteurs de recherche" error={langErrors?.fields.seoTitle}>
                  <input className="input" value={form.seoTitle} maxLength={70} onChange={(e) => update({ seoTitle: e.target.value })} />
                  <CharCount value={form.seoTitle} recommended={60} max={70} />
                </Field>
                <Field label="Description pour les moteurs de recherche" error={langErrors?.fields.seoDescription}>
                  <textarea className="input" value={form.seoDescription} maxLength={300} onChange={(e) => update({ seoDescription: e.target.value })} />
                  <CharCount value={form.seoDescription} recommended={160} max={300} />
                </Field>
                <SnippetPreview form={form} page={page} language={active} settings={settings.data} />
                <ImageField
                  label="Image de partage (réseaux sociaux)"
                  hint="Par défaut, l'image du bandeau principal ou le logo."
                  value={form.ogMediaId}
                  error={langErrors?.fields.ogMediaId}
                  onChange={(ogMediaId) => update({ ogMediaId })}
                />
              </div>
            </Card>
            <div className="row between center">
              <h2 className="h2">
                Sections <span className="cap">({form.sections.length} / {SECTION_LIMITS.sections})</span>
              </h2>
              <div className="row" style={{ gap: 8 }}>
                <button type="button" className="btn btn-g" onClick={() => setOpenSections(form.sections.map((s) => s.uid))}>
                  Tout déplier
                </button>
                <button type="button" className="btn btn-g" onClick={() => setOpenSections([])}>
                  Tout replier
                </button>
              </div>
            </div>
            {form.sections.length === 0 ? (
              <Card>
                <Empty title="Aucune section" text="Une page est une suite de sections : bandeau, texte, tarifs, formulaire…" />
              </Card>
            ) : null}
            {form.sections.map((item, index) => (
              <SectionCard
                key={item.uid}
                item={item}
                index={index}
                count={form.sections.length}
                open={openSections.includes(item.uid)}
                errors={langErrors?.sections[item.uid] ?? []}
                anchors={anchors}
                links={links}
                canDuplicate={!full}
                onToggle={() => toggle(item.uid)}
                onChange={(section) => setSections(form.sections.map((s) => (s.uid === item.uid ? { uid: s.uid, section } : s)))}
                onMove={(to) => setSections(moveItem(form.sections, index, to))}
                onDuplicate={() => {
                  const copy = structuredClone(item.section);
                  let anchor = `${copy.id}-copie`.slice(0, 40);
                  for (let n = 2; anchors.includes(anchor); n += 1) anchor = `${copy.id}-copie-${n}`.slice(0, 40);
                  const uid = nextUid();
                  setOpenSections((current) => [...current, uid]);
                  setSections([...form.sections.slice(0, index + 1), { uid, section: { ...copy, id: anchor } }, ...form.sections.slice(index + 1)]);
                }}
                onRemove={() => setSections(form.sections.filter((s) => s.uid !== item.uid))}
              />
            ))}
            <div>
              <button type="button" className="btn" disabled={full} onClick={() => setPicking(true)}>
                + Ajouter une section
              </button>
            </div>
          </div>
          <div className="stack" style={{ gap: 20 }}>
            <PublishCard page={page} dirty={dirty} />
            <VersionsCard pageId={id} languages={languages} onRestored={reload} />
          </div>
        </div>
      )}
      {picking && form ? (
        <SectionPicker
          onClose={() => setPicking(false)}
          onPick={(type) => {
            const uid = nextUid();
            setOpenSections((current) => [...current, uid]);
            setSections([...form.sections, { uid, section: newSection(type, anchors) }]);
          }}
        />
      ) : null}
      {blocker.state === "blocked" ? (
        <Modal
          title="Modifications non enregistrées"
          onClose={() => blocker.reset()}
          footer={
            <>
              <span />
              <div className="row" style={{ gap: 8 }}>
                <button type="button" className="btn" onClick={() => blocker.reset()}>
                  Rester sur la page
                </button>
                <button type="button" className="btn btn-d" onClick={() => blocker.proceed()}>
                  Quitter sans enregistrer
                </button>
              </div>
            </>
          }
        >
          <div>
            Les modifications en {dirtyLanguages.map((l) => LANGUAGE_LABEL[l].toLowerCase()).join(" et ")} ne sont pas enregistrées. Elles seront perdues si
            vous quittez cette page.
          </div>
        </Modal>
      ) : null}
    </>
  );
}
