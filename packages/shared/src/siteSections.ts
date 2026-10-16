import { z } from "zod";

/**
 * Content of the public website pages: a page is an ordered list of typed sections, validated identically by the
 * API and the back-office editor. Texts are plain strings (escaped when rendered); rich text is a constrained
 * structure, never raw HTML, so editors cannot inject markup or scripts into the site.
 */
export const SITE_LANGUAGES = ["fr", "en"] as const;
export type SiteLanguage = (typeof SITE_LANGUAGES)[number];

export const SECTION_LIMITS = { sections: 40, items: 24, richBlocks: 100, inlines: 50, listItems: 50 } as const;

export const SECTION_TYPES = [
  "hero",
  "rich_text",
  "features",
  "spaces",
  "pricing",
  "availability",
  "gallery",
  "testimonials",
  "faq",
  "contact",
  "form",
  "cta",
  "articles",
] as const;
export type SectionType = (typeof SECTION_TYPES)[number];

/** Sections filled at render time from the coworking data; they render nothing when the module is off. */
export const COWORKING_SECTION_TYPES: readonly SectionType[] = ["spaces", "pricing", "availability"];

/** French names of the section types, for the back-office editor. */
export const SECTION_TYPE_LABELS: Record<SectionType, string> = {
  hero: "Bandeau principal",
  rich_text: "Texte",
  features: "Atouts",
  spaces: "Espaces (coworking)",
  pricing: "Tarifs (coworking)",
  availability: "Disponibilités (coworking)",
  gallery: "Galerie",
  testimonials: "Témoignages",
  faq: "Questions fréquentes",
  contact: "Contact et horaires",
  form: "Formulaire",
  cta: "Appel à l'action",
  articles: "Derniers articles",
};

/** Icons available in a features section; the site draws them, editors only choose a name. */
export const FEATURE_ICONS = ["wifi", "coffee", "printer", "meeting", "clock", "calendar", "lock", "parking", "phone", "mail", "location", "star", "check"] as const;
export type FeatureIcon = (typeof FEATURE_ICONS)[number];

export const LEAD_KINDS = ["contact", "visit", "quote"] as const;
export type LeadKind = (typeof LEAD_KINDS)[number];

export function isHttpsUrl(value: string): boolean {
  if (!/^https:\/\/[^\s]+$/.test(value)) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

const text = (max: number) => z.string().trim().max(max);
const requiredText = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => text(max).optional();
const mediaId = z.string().uuid();
const httpsUrl = z.string().trim().max(500).refine(isHttpsUrl, "expected an https:// address");

/** Section identifiers double as anchors in the page (#tarifs). */
export const sectionIdSchema = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "lowercase letters, digits and hyphens").max(40);

export const inlineSchema = z
  .object({
    text: z.string().min(1).max(2000),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    href: httpsUrl.optional(),
  })
  .strict();

const inlines = z.array(inlineSchema).min(1).max(SECTION_LIMITS.inlines);

export const richBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("paragraph"), content: inlines }).strict(),
  z.object({ type: z.literal("heading"), level: z.union([z.literal(2), z.literal(3)]), content: inlines }).strict(),
  z
    .object({
      type: z.literal("list"),
      ordered: z.boolean(),
      items: z.array(inlines).min(1).max(SECTION_LIMITS.listItems),
    })
    .strict(),
]);

export const richTextSchema = z.array(richBlockSchema).min(1).max(SECTION_LIMITS.richBlocks);

/** Where a button leads: the client portal booking, another page of the site, a section of this page or an https address. */
export const linkTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("booking") }).strict(),
  z.object({ kind: z.literal("page"), pageId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("anchor"), anchor: sectionIdSchema }).strict(),
  z.object({ kind: z.literal("url"), url: httpsUrl }).strict(),
]);

export const buttonSchema = z.object({ label: requiredText(60), target: linkTargetSchema }).strict();

const base = { id: sectionIdSchema };
const titled = { ...base, title: optionalText(200) };

export const heroSectionSchema = z
  .object({ ...base, type: z.literal("hero"), title: requiredText(200), subtitle: optionalText(500), imageId: mediaId.optional(), button: buttonSchema.optional() })
  .strict();

export const richTextSectionSchema = z.object({ ...titled, type: z.literal("rich_text"), body: richTextSchema }).strict();

export const featuresSectionSchema = z
  .object({
    ...titled,
    type: z.literal("features"),
    items: z
      .array(z.object({ icon: z.enum(FEATURE_ICONS), title: requiredText(120), text: optionalText(500) }).strict())
      .min(1)
      .max(SECTION_LIMITS.items),
  })
  .strict();

export const spacesSectionSchema = z.object({ ...titled, type: z.literal("spaces"), intro: optionalText(500) }).strict();

export const pricingSectionSchema = z
  .object({ ...titled, type: z.literal("pricing"), intro: optionalText(500), typeId: z.string().uuid().optional() })
  .strict();

export const availabilitySectionSchema = z.object({ ...titled, type: z.literal("availability") }).strict();

export const gallerySectionSchema = z
  .object({
    ...titled,
    type: z.literal("gallery"),
    items: z
      .array(z.object({ imageId: mediaId, caption: optionalText(200) }).strict())
      .min(1)
      .max(SECTION_LIMITS.items),
  })
  .strict();

export const testimonialsSectionSchema = z
  .object({
    ...titled,
    type: z.literal("testimonials"),
    items: z
      .array(z.object({ quote: requiredText(1000), author: requiredText(120), role: optionalText(120) }).strict())
      .min(1)
      .max(SECTION_LIMITS.items),
  })
  .strict();

export const faqSectionSchema = z
  .object({
    ...titled,
    type: z.literal("faq"),
    items: z
      .array(z.object({ question: requiredText(300), answer: requiredText(3000) }).strict())
      .min(1)
      .max(SECTION_LIMITS.items),
  })
  .strict();

export const contactSectionSchema = z.object({ ...titled, type: z.literal("contact"), showMap: z.boolean() }).strict();

export const formSectionSchema = z
  .object({ ...titled, type: z.literal("form"), intro: optionalText(500), variant: z.enum(LEAD_KINDS), submitLabel: optionalText(60) })
  .strict();

export const ctaSectionSchema = z.object({ ...base, type: z.literal("cta"), title: requiredText(200), text: optionalText(500), button: buttonSchema }).strict();

export const articlesSectionSchema = z.object({ ...titled, type: z.literal("articles"), limit: z.number().int().min(1).max(12) }).strict();

export const siteSectionSchema = z.discriminatedUnion("type", [
  heroSectionSchema,
  richTextSectionSchema,
  featuresSectionSchema,
  spacesSectionSchema,
  pricingSectionSchema,
  availabilitySectionSchema,
  gallerySectionSchema,
  testimonialsSectionSchema,
  faqSectionSchema,
  contactSectionSchema,
  formSectionSchema,
  ctaSectionSchema,
  articlesSectionSchema,
]);

export const siteSectionsSchema = z
  .array(siteSectionSchema)
  .max(SECTION_LIMITS.sections)
  .refine((sections) => new Set(sections.map((s) => s.id)).size === sections.length, "each section id appears once per page");

export type InlineText = z.infer<typeof inlineSchema>;
export type RichBlock = z.infer<typeof richBlockSchema>;
export type RichText = z.infer<typeof richTextSchema>;
export type LinkTarget = z.infer<typeof linkTargetSchema>;
export type SectionButton = z.infer<typeof buttonSchema>;
export type HeroSection = z.infer<typeof heroSectionSchema>;
export type RichTextSection = z.infer<typeof richTextSectionSchema>;
export type FeaturesSection = z.infer<typeof featuresSectionSchema>;
export type SpacesSection = z.infer<typeof spacesSectionSchema>;
export type PricingSection = z.infer<typeof pricingSectionSchema>;
export type AvailabilitySection = z.infer<typeof availabilitySectionSchema>;
export type GallerySection = z.infer<typeof gallerySectionSchema>;
export type TestimonialsSection = z.infer<typeof testimonialsSectionSchema>;
export type FaqSection = z.infer<typeof faqSectionSchema>;
export type ContactSection = z.infer<typeof contactSectionSchema>;
export type FormSection = z.infer<typeof formSectionSchema>;
export type CtaSection = z.infer<typeof ctaSectionSchema>;
export type ArticlesSection = z.infer<typeof articlesSectionSchema>;
export type SiteSection = z.infer<typeof siteSectionSchema>;

/** Media files a list of sections shows, so the API can check they exist before saving. */
export function sectionMediaIds(sections: readonly SiteSection[]): string[] {
  const ids = new Set<string>();
  for (const section of sections) {
    if (section.type === "hero" && section.imageId) ids.add(section.imageId);
    if (section.type === "gallery") for (const item of section.items) ids.add(item.imageId);
  }
  return [...ids];
}

/** Pages the buttons of a list of sections link to. */
export function sectionPageIds(sections: readonly SiteSection[]): string[] {
  const ids = new Set<string>();
  for (const section of sections) {
    const button = section.type === "hero" || section.type === "cta" ? section.button : undefined;
    if (button?.target.kind === "page") ids.add(button.target.pageId);
  }
  return [...ids];
}

/** Reads stored sections, dropping the ones a later schema no longer accepts instead of failing the whole page. */
export function parseSections(value: unknown): SiteSection[] {
  if (!Array.isArray(value)) return [];
  const sections: SiteSection[] = [];
  for (const item of value) {
    const parsed = siteSectionSchema.safeParse(item);
    if (parsed.success) sections.push(parsed.data);
  }
  return sections;
}
