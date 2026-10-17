import {
  FEATURE_ICONS,
  isHttpsUrl,
  LEAD_KINDS,
  SECTION_LIMITS,
  type FeatureIcon,
  type LeadKind,
  type LinkTarget,
  type SectionButton,
  type SectionType,
  type SiteLanguage,
  type SiteSection,
} from "@gcf/shared";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode } from "react";
import { api } from "../../api/client";
import { useSession } from "../../auth/session";
import { Field } from "../../components/ui";
import { flattenPages, LEAD_KIND, pageTitle, type PageNode } from "./api";
import { MoveButtons, moveItem } from "./common";
import { ImageField } from "./media";
import { emptyRichText, RichTextEditor } from "./richtext";

/** Anchor proposed for a new section of each type; numbered when the page already has one. */
const ANCHOR_BASE: Record<SectionType, string> = {
  hero: "bandeau",
  rich_text: "texte",
  features: "atouts",
  spaces: "espaces",
  pricing: "tarifs",
  availability: "disponibilites",
  gallery: "galerie",
  testimonials: "temoignages",
  faq: "faq",
  contact: "contact",
  form: "formulaire",
  cta: "action",
  articles: "articles",
};

/** What each section type shows, in the section picker and at the top of its form. */
export const SECTION_HELP: Record<SectionType, string> = {
  hero: "Grand titre en haut de page, avec un texte, une image et un bouton facultatifs.",
  rich_text: "Paragraphes, titres et listes mis en forme.",
  features: "Liste d'atouts avec une icône, un titre et un texte court.",
  spaces:
    "Rempli automatiquement : les types d'espaces publics du coworking avec leur photo, leur capacité et leur prix de départ. N'affiche rien si le module coworking n'est pas actif.",
  pricing:
    "Rempli automatiquement : les formules d'abonnement, les carnets et les tarifs de réservation publics du coworking, pour tous les types d'espaces ou un seul.",
  availability: "Rempli automatiquement : le nombre de places libres maintenant et pour le reste de la journée, par type d'espace public du coworking.",
  gallery: "Grille de photos avec une légende facultative.",
  testimonials: "Citations de clients avec leur nom et leur fonction.",
  faq: "Questions et réponses dépliables.",
  contact:
    "Rempli automatiquement : l'adresse, le téléphone et l'e-mail des paramètres du site, les horaires d'ouverture du centre et les fermetures exceptionnelles à venir.",
  form: "Formulaire de demande (nom, e-mail ou téléphone, message). Les envois arrivent dans « Demandes du site ».",
  cta: "Encadré coloré avec un titre, un texte et un bouton.",
  articles: "Rempli automatiquement : les derniers articles publiés, avec leur date et leur résumé (la description SEO de l'article).",
};

const ICON_LABEL: Record<FeatureIcon, string> = {
  wifi: "Wi-Fi",
  coffee: "Café",
  printer: "Imprimante",
  meeting: "Réunion",
  clock: "Horloge",
  calendar: "Calendrier",
  lock: "Cadenas",
  parking: "Parking",
  phone: "Téléphone",
  mail: "Courrier",
  location: "Adresse",
  star: "Étoile",
  check: "Coche",
};

/** A new section of the type, with an anchor not used by the page yet. */
export function newSection(type: SectionType, usedIds: readonly string[]): SiteSection {
  const base = ANCHOR_BASE[type];
  let id = base;
  for (let n = 2; usedIds.includes(id); n += 1) id = `${base}-${n}`;
  switch (type) {
    case "hero":
      return { id, type, title: "" };
    case "rich_text":
      return { id, type, body: emptyRichText() };
    case "features":
      return { id, type, items: [{ icon: "check", title: "" }] };
    case "gallery":
      return { id, type, items: [] };
    case "testimonials":
      return { id, type, items: [{ quote: "", author: "" }] };
    case "faq":
      return { id, type, items: [{ question: "", answer: "" }] };
    case "contact":
      return { id, type, showMap: true };
    case "form":
      return { id, type, variant: "contact" };
    case "cta":
      return { id, type, title: "", button: { label: "", target: { kind: "booking" } } };
    case "articles":
      return { id, type, limit: 3 };
    case "spaces":
    case "pricing":
    case "availability":
      return { id, type };
  }
}

/** The object with an optional text set, or removed when blank (the API stores no empty optional text). */
function withText<T extends object, K extends string>(object: T, key: K, value: string): T {
  const next = { ...object } as Record<string, unknown>;
  if (value.trim() === "") delete next[key];
  else next[key] = value;
  return next as T;
}

/* Shared inputs */

function TextInput({
  label,
  value,
  onChange,
  max,
  required,
  multiline,
}: {
  label: string;
  value: string | undefined;
  onChange: (v: string) => void;
  max: number;
  required?: boolean;
  multiline?: boolean;
}) {
  const error = required && (value ?? "").trim() === "" ? "Obligatoire." : null;
  return (
    <Field label={required ? `${label} *` : label} error={error}>
      {multiline ? (
        <textarea className="input" value={value ?? ""} maxLength={max} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input className="input" value={value ?? ""} maxLength={max} onChange={(e) => onChange(e.target.value)} />
      )}
    </Field>
  );
}

/** A list of items with add, remove and reorder, between the schema's minimum and maximum. */
function ItemsEditor<T>({
  items,
  onChange,
  noun,
  min,
  create,
  render,
}: {
  items: T[];
  onChange: (items: T[]) => void;
  noun: string;
  min: number;
  create: () => T;
  render: (item: T, update: (item: T) => void, index: number) => ReactNode;
}) {
  return (
    <div className="stack" style={{ gap: 8 }}>
      {items.map((item, index) => (
        <fieldset key={index} className="site-item">
          <legend className="visually-hidden">
            {noun} {index + 1}
          </legend>
          <div className="row center between">
            <span className="lab">
              {noun} {index + 1}
            </span>
            <span className="row center" style={{ gap: 2, flexWrap: "nowrap" }}>
              <MoveButtons
                label={`${noun.toLowerCase()} ${index + 1}`}
                index={index}
                count={items.length}
                onMove={(to) => onChange(moveItem(items, index, to))}
              />
              <button
                type="button"
                className="btn btn-g"
                aria-label={`Supprimer ${noun.toLowerCase()} ${index + 1}`}
                disabled={items.length <= min}
                onClick={() => onChange(items.filter((_, i) => i !== index))}
              >
                Supprimer
              </button>
            </span>
          </div>
          {render(item, (next) => onChange(items.map((it, i) => (i === index ? next : it))), index)}
        </fieldset>
      ))}
      <div className="row center" style={{ gap: 8 }}>
        <button type="button" className="btn" disabled={items.length >= SECTION_LIMITS.items} onClick={() => onChange([...items, create()])}>
          + {noun}
        </button>
        <span className="cap">
          {items.length} / {SECTION_LIMITS.items}
        </span>
      </div>
    </div>
  );
}

/** Context the button target picker needs: the pages of the site and the anchors of the edited page. */
export interface LinkContext {
  pages: PageNode[];
  language: SiteLanguage;
  anchors: string[];
}

const TARGET_LABEL: Record<LinkTarget["kind"], string> = {
  booking: "Réservation (espace client)",
  page: "Page du site",
  anchor: "Section de cette page",
  url: "Adresse https externe",
};

function defaultTarget(kind: LinkTarget["kind"], links: LinkContext): LinkTarget {
  if (kind === "page") return { kind, pageId: flattenPages(links.pages)[0]?.page.id ?? "" };
  if (kind === "anchor") return { kind, anchor: links.anchors[0] ?? "" };
  if (kind === "url") return { kind, url: "https://" };
  return { kind };
}

function ButtonEditor({ value, onChange, links }: { value: SectionButton; onChange: (b: SectionButton) => void; links: LinkContext }) {
  const target = value.target;
  const pages = flattenPages(links.pages);
  return (
    <div className="grid2">
      <TextInput label="Libellé du bouton" required max={60} value={value.label} onChange={(label) => onChange({ ...value, label })} />
      <Field label="Le bouton mène à">
        <select
          className="input"
          value={target.kind}
          onChange={(e) => onChange({ ...value, target: defaultTarget(e.target.value as LinkTarget["kind"], links) })}
        >
          {(Object.keys(TARGET_LABEL) as LinkTarget["kind"][]).map((k) => (
            <option key={k} value={k}>
              {TARGET_LABEL[k]}
            </option>
          ))}
        </select>
      </Field>
      {target.kind === "page" ? (
        <Field label="Page *" error={target.pageId ? null : "Choisissez une page."}>
          <select className="input" value={target.pageId} onChange={(e) => onChange({ ...value, target: { kind: "page", pageId: e.target.value } })}>
            {target.pageId && !pages.some((p) => p.page.id === target.pageId) ? <option value={target.pageId}>Page archivée ou supprimée</option> : null}
            {!target.pageId ? <option value="">Choisir</option> : null}
            {pages.map(({ page, depth }) => (
              <option key={page.id} value={page.id}>
                {"  ".repeat(depth)}
                {pageTitle(page, links.language)} ({page.path})
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {target.kind === "anchor" ? (
        <Field label="Section *" error={target.anchor ? null : "Ajoutez d'abord la section visée."}>
          <select className="input" value={target.anchor} onChange={(e) => onChange({ ...value, target: { kind: "anchor", anchor: e.target.value } })}>
            {target.anchor && !links.anchors.includes(target.anchor) ? <option value={target.anchor}>#{target.anchor} (introuvable)</option> : null}
            {!target.anchor ? <option value="">Choisir</option> : null}
            {links.anchors.map((a) => (
              <option key={a} value={a}>
                #{a}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {target.kind === "url" ? (
        <Field label="Adresse *" error={target.url && target.url !== "https://" && !isHttpsUrl(target.url.trim()) ? "Adresse https:// attendue." : null}>
          <input
            className="input"
            type="url"
            maxLength={500}
            value={target.url}
            onChange={(e) => onChange({ ...value, target: { kind: "url", url: e.target.value } })}
          />
        </Field>
      ) : null}
      {target.kind === "booking" ? <span className="cap site-grid-note">Ouvre la réservation de l'espace client (portail coworking).</span> : null}
    </div>
  );
}

interface CoworkingType {
  id: string;
  name: string;
  public: boolean;
  status: "active" | "archived";
}

/** Limits the pricing section to one type of space; listed only for users who can read the coworking setup. */
function PricingTypeField({ value, onChange }: { value: string | undefined; onChange: (id: string | undefined) => void }) {
  const { can } = useSession();
  const readable = can("coworking:read");
  const types = useQuery({
    queryKey: ["coworking", "resource-types", "site-pricing"],
    queryFn: () => api.get<CoworkingType[]>("/coworking/resource-types", { status: "active" }),
    enabled: readable,
  });
  if (!readable) return <span className="cap">{value ? "Limité à un type d'espace." : "Tous les types d'espaces publics."}</span>;
  const listed = (types.data ?? []).filter((t) => t.public);
  return (
    <Field label="Types d'espaces" hint="Seuls les types publics apparaissent sur le site.">
      <select className="input" value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">Tous les types publics</option>
        {value && types.data && !listed.some((t) => t.id === value) ? <option value={value}>Type non public ou archivé</option> : null}
        {listed.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** The form of one section, dedicated to its type. */
export function SectionForm({
  section,
  onChange,
  links,
  editorKey,
}: {
  section: SiteSection;
  onChange: (s: SiteSection) => void;
  links: LinkContext;
  /** Changes when the content is reloaded, so the rich text editor starts again from the new value. */
  editorKey: string;
}) {
  const titleField = <S extends SiteSection>(s: S & { title?: string | undefined }) => (
    <TextInput label="Titre de la section" max={200} value={s.title} onChange={(v) => onChange(withText(s, "title", v))} />
  );
  switch (section.type) {
    case "hero":
      return (
        <div className="stack">
          <TextInput label="Titre" required max={200} value={section.title} onChange={(title) => onChange({ ...section, title })} />
          <TextInput label="Texte" multiline max={500} value={section.subtitle} onChange={(v) => onChange(withText(section, "subtitle", v))} />
          <ImageField
            label="Image du bandeau"
            value={section.imageId}
            onChange={(id) => {
              const { imageId: _, ...rest } = section;
              onChange(id ? { ...rest, imageId: id } : rest);
            }}
          />
          <label className="row center" style={{ gap: 6 }}>
            <input
              type="checkbox"
              className="chk"
              checked={!!section.button}
              onChange={(e) => {
                const { button: _, ...rest } = section;
                onChange(e.target.checked ? { ...rest, button: { label: "", target: { kind: "booking" } } } : rest);
              }}
            />
            Afficher un bouton
          </label>
          {section.button ? <ButtonEditor value={section.button} links={links} onChange={(button) => onChange({ ...section, button })} /> : null}
        </div>
      );
    case "rich_text":
      return (
        <div className="stack">
          {titleField(section)}
          <RichTextEditor key={editorKey} label="Contenu" value={section.body} onChange={(body) => onChange({ ...section, body })} />
        </div>
      );
    case "features":
      return (
        <div className="stack">
          {titleField(section)}
          <ItemsEditor<(typeof section.items)[number]>
            items={section.items}
            noun="Atout"
            min={1}
            create={() => ({ icon: "check", title: "" })}
            onChange={(items) => onChange({ ...section, items })}
            render={(item, update) => (
              <div className="grid2">
                <Field label="Icône">
                  <select className="input" value={item.icon} onChange={(e) => update({ ...item, icon: e.target.value as FeatureIcon })}>
                    {FEATURE_ICONS.map((icon) => (
                      <option key={icon} value={icon}>
                        {ICON_LABEL[icon]}
                      </option>
                    ))}
                  </select>
                </Field>
                <TextInput label="Titre" required max={120} value={item.title} onChange={(title) => update({ ...item, title })} />
                <div className="site-span2">
                  <TextInput label="Texte" multiline max={500} value={item.text} onChange={(v) => update(withText(item, "text", v))} />
                </div>
              </div>
            )}
          />
        </div>
      );
    case "spaces":
      return (
        <div className="stack">
          {titleField(section)}
          <TextInput label="Introduction" multiline max={500} value={section.intro} onChange={(v) => onChange(withText(section, "intro", v))} />
        </div>
      );
    case "pricing":
      return (
        <div className="stack">
          {titleField(section)}
          <TextInput label="Introduction" multiline max={500} value={section.intro} onChange={(v) => onChange(withText(section, "intro", v))} />
          <PricingTypeField
            value={section.typeId}
            onChange={(id) => {
              const { typeId: _, ...rest } = section;
              onChange(id ? { ...rest, typeId: id } : rest);
            }}
          />
        </div>
      );
    case "availability":
      return <div className="stack">{titleField(section)}</div>;
    case "gallery":
      return (
        <div className="stack">
          {titleField(section)}
          <ItemsEditor<(typeof section.items)[number]>
            items={section.items}
            noun="Image"
            min={0}
            create={() => ({ imageId: "" })}
            onChange={(items) => onChange({ ...section, items })}
            render={(item, update) => (
              <div className="grid2">
                <ImageField
                  label="Photo *"
                  value={item.imageId || null}
                  error={item.imageId ? null : "Choisissez une image."}
                  onChange={(id) => update({ ...item, imageId: id ?? "" })}
                />
                <TextInput label="Légende" max={200} value={item.caption} onChange={(v) => update(withText(item, "caption", v))} />
              </div>
            )}
          />
          {section.items.length === 0 ? <span className="err-text">Ajoutez au moins une image.</span> : null}
        </div>
      );
    case "testimonials":
      return (
        <div className="stack">
          {titleField(section)}
          <ItemsEditor<(typeof section.items)[number]>
            items={section.items}
            noun="Témoignage"
            min={1}
            create={() => ({ quote: "", author: "" })}
            onChange={(items) => onChange({ ...section, items })}
            render={(item, update) => (
              <div className="grid2">
                <div className="site-span2">
                  <TextInput label="Citation" required multiline max={1000} value={item.quote} onChange={(quote) => update({ ...item, quote })} />
                </div>
                <TextInput label="Auteur" required max={120} value={item.author} onChange={(author) => update({ ...item, author })} />
                <TextInput label="Fonction ou entreprise" max={120} value={item.role} onChange={(v) => update(withText(item, "role", v))} />
              </div>
            )}
          />
        </div>
      );
    case "faq":
      return (
        <div className="stack">
          {titleField(section)}
          <ItemsEditor<(typeof section.items)[number]>
            items={section.items}
            noun="Question"
            min={1}
            create={() => ({ question: "", answer: "" })}
            onChange={(items) => onChange({ ...section, items })}
            render={(item, update) => (
              <div className="stack">
                <TextInput label="Question" required max={300} value={item.question} onChange={(question) => update({ ...item, question })} />
                <TextInput label="Réponse" required multiline max={3000} value={item.answer} onChange={(answer) => update({ ...item, answer })} />
              </div>
            )}
          />
        </div>
      );
    case "contact":
      return (
        <div className="stack">
          {titleField(section)}
          <label className="row center" style={{ gap: 6 }}>
            <input type="checkbox" className="chk" checked={section.showMap} onChange={(e) => onChange({ ...section, showMap: e.target.checked })} />
            Afficher le lien vers la carte (adresse de carte des paramètres du site)
          </label>
        </div>
      );
    case "form":
      return (
        <div className="stack">
          {titleField(section)}
          <TextInput label="Introduction" multiline max={500} value={section.intro} onChange={(v) => onChange(withText(section, "intro", v))} />
          <div className="grid2">
            <Field
              label="Type de demande"
              hint={section.variant === "visit" ? "Ajoute une date souhaitée." : section.variant === "quote" ? "Ajoute l'entreprise." : undefined}
            >
              <select className="input" value={section.variant} onChange={(e) => onChange({ ...section, variant: e.target.value as LeadKind })}>
                {LEAD_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {LEAD_KIND[k]}
                  </option>
                ))}
              </select>
            </Field>
            <TextInput label="Libellé du bouton d'envoi" max={60} value={section.submitLabel} onChange={(v) => onChange(withText(section, "submitLabel", v))} />
          </div>
        </div>
      );
    case "cta":
      return (
        <div className="stack">
          <TextInput label="Titre" required max={200} value={section.title} onChange={(title) => onChange({ ...section, title })} />
          <TextInput label="Texte" multiline max={500} value={section.text} onChange={(v) => onChange(withText(section, "text", v))} />
          <ButtonEditor value={section.button} links={links} onChange={(button) => onChange({ ...section, button })} />
        </div>
      );
    case "articles":
      return (
        <div className="stack">
          {titleField(section)}
          <Field label="Nombre d'articles">
            <select className="input" value={section.limit} onChange={(e) => onChange({ ...section, limit: Number(e.target.value) })}>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
        </div>
      );
  }
}
