import { isBookableCategory, OCCUPYING_STATUSES, type SiteLanguage, type SiteSection } from "@gcf/shared";
import { sql, type Kysely } from "kysely";
import type { CwCategory, CwFormatNature, CwPeriod, CwQuotaKind } from "../db/types.coworking.js";
import type { Database } from "../db/types.js";
import { loadVersionContents, publicPath, slugChain, type PageRow } from "./pages.js";

/** Lowest public price of a space: a booking format (per booking or per hour) or, for assigned spaces, a plan. */
export interface LowestPrice {
  amount: number;
  per: "booking" | "hour" | CwPeriod;
  label: string;
}

export interface SpaceCard {
  id: string;
  name: string;
  category: CwCategory;
  description: string | null;
  photoId: string | null;
  capacityMin: number | null;
  capacityMax: number | null;
  lowest: LowestPrice | null;
}

export interface PricingData {
  plans: {
    id: string;
    name: string;
    description: string | null;
    price: number;
    period: CwPeriod;
    billing: "upfront" | "monthly";
    includesDomiciliation: boolean;
  }[];
  packs: { id: string; name: string; typeName: string; quotaKind: Exclude<CwQuotaKind, "unlimited">; quota: number; validityDays: number; price: number }[];
  formats: { id: string; typeName: string; label: string; nature: CwFormatNature; visitor: number; member: number }[];
}

/** Free bookable resources of a public type; null when the centre is closed at that moment or for the rest of the day. */
export interface AvailabilityRow {
  typeId: string;
  name: string;
  category: CwCategory;
  freeNow: number | null;
  freeRestOfDay: number | null;
}

export interface ContactData {
  openFrom: string;
  openTo: string;
  openWeekdays: number[];
  closures: { startsOn: string; endsOn: string; label: string; openFrom: string | null; openTo: string | null }[];
}

export interface ArticleCard {
  path: string;
  title: string;
  summary: string | null;
  date: string;
}

/** Data the dynamic sections of a page show, loaded once per rendering. */
export interface SectionData {
  spaces: SpaceCard[] | null;
  pricing: Map<string, PricingData>;
  availability: AvailabilityRow[] | null;
  contact: ContactData | null;
  articles: ArticleCard[];
}

interface LoadOptions {
  centreId: string;
  coworking: boolean;
  language: SiteLanguage;
  defaultLanguage: SiteLanguage;
  pages: readonly PageRow[];
  now: Date;
}

async function loadSpaces(db: Kysely<Database>, centreId: string): Promise<SpaceCard[]> {
  const types = await db
    .selectFrom("cw_resource_types")
    .select(["id", "name", "category", "description", "photo_media_id"])
    .where("centre_id", "=", centreId)
    .where("status", "=", "active")
    .where("public", "=", true)
    .orderBy("position")
    .orderBy("name")
    .execute();
  if (types.length === 0) return [];
  const typeIds = types.map((t) => t.id);
  const capacities = await db
    .selectFrom("cw_resources")
    .select(["type_id", (eb) => eb.fn.min<number>("capacity").as("min"), (eb) => eb.fn.max<number>("capacity").as("max")])
    .where("type_id", "in", typeIds)
    .where("status", "<>", "archived")
    .groupBy("type_id")
    .execute();
  const formatPrices = await db
    .selectFrom("cw_booking_formats")
    .innerJoin("cw_prices", "cw_prices.format_id", "cw_booking_formats.id")
    .select(["cw_booking_formats.type_id", "cw_booking_formats.label", "cw_booking_formats.nature", "cw_prices.amount"])
    .where("cw_booking_formats.type_id", "in", typeIds)
    .where("cw_booking_formats.status", "=", "active")
    .where("cw_prices.profile", "=", "visitor")
    .execute();
  const planPrices = await db
    .selectFrom("cw_plans")
    .select(["assigned_type_id", "name", "price", "period"])
    .where("centre_id", "=", centreId)
    .where("assigned_type_id", "in", typeIds)
    .where("status", "=", "active")
    .where("public", "=", true)
    .execute();

  const lowest = new Map<string, LowestPrice>();
  const keep = (typeId: string, candidate: LowestPrice) => {
    const current = lowest.get(typeId);
    if (!current || candidate.amount < current.amount) lowest.set(typeId, candidate);
  };
  for (const f of formatPrices) keep(f.type_id, { amount: f.amount, per: f.nature === "free" ? "hour" : "booking", label: f.label });
  for (const p of planPrices) keep(p.assigned_type_id!, { amount: p.price, per: p.period, label: p.name });
  const capacity = new Map(capacities.map((c) => [c.type_id, c]));
  return types.map((t) => ({
    id: t.id,
    name: t.name,
    category: t.category,
    description: t.description,
    photoId: t.photo_media_id,
    capacityMin: capacity.get(t.id)?.min ?? null,
    capacityMax: capacity.get(t.id)?.max ?? null,
    lowest: lowest.get(t.id) ?? null,
  }));
}

async function loadPricing(db: Kysely<Database>, centreId: string, typeId: string | undefined): Promise<PricingData> {
  let plansQuery = db
    .selectFrom("cw_plans")
    .select(["id", "name", "description", "price", "period", "billing", "includes_domiciliation"])
    .where("centre_id", "=", centreId)
    .where("status", "=", "active")
    .where("public", "=", true);
  if (typeId) {
    plansQuery = plansQuery.where((eb) =>
      eb.or([
        eb("assigned_type_id", "=", typeId),
        eb.exists(
          eb.selectFrom("cw_plan_entitlements").select("plan_id").whereRef("cw_plan_entitlements.plan_id", "=", "cw_plans.id").where("type_id", "=", typeId),
        ),
      ]),
    );
  }
  const plans = await plansQuery.orderBy("position").orderBy("price").execute();

  let packsQuery = db
    .selectFrom("cw_pack_products")
    .innerJoin("cw_resource_types", "cw_resource_types.id", "cw_pack_products.type_id")
    .select([
      "cw_pack_products.id",
      "cw_pack_products.name",
      "cw_resource_types.name as typeName",
      "cw_pack_products.quota_kind",
      "cw_pack_products.quota",
      "cw_pack_products.validity_days",
      "cw_pack_products.price",
    ])
    .where("cw_pack_products.centre_id", "=", centreId)
    .where("cw_pack_products.status", "=", "active")
    .where("cw_pack_products.public", "=", true)
    .where("cw_resource_types.status", "=", "active")
    .where("cw_resource_types.public", "=", true);
  if (typeId) packsQuery = packsQuery.where("cw_pack_products.type_id", "=", typeId);
  const packs = await packsQuery.orderBy("cw_pack_products.price").execute();

  let formatsQuery = db
    .selectFrom("cw_booking_formats")
    .innerJoin("cw_resource_types", "cw_resource_types.id", "cw_booking_formats.type_id")
    .select([
      "cw_booking_formats.id",
      "cw_booking_formats.label",
      "cw_booking_formats.nature",
      "cw_resource_types.name as typeName",
      "cw_resource_types.category",
      (eb) =>
        eb
          .selectFrom("cw_prices")
          .select("amount")
          .whereRef("cw_prices.format_id", "=", "cw_booking_formats.id")
          .where("profile", "=", "visitor")
          .as("visitor"),
      (eb) =>
        eb.selectFrom("cw_prices").select("amount").whereRef("cw_prices.format_id", "=", "cw_booking_formats.id").where("profile", "=", "member").as("member"),
    ])
    .where("cw_booking_formats.centre_id", "=", centreId)
    .where("cw_booking_formats.status", "=", "active")
    .where("cw_resource_types.status", "=", "active")
    .where("cw_resource_types.public", "=", true);
  if (typeId) formatsQuery = formatsQuery.where("cw_booking_formats.type_id", "=", typeId);
  const formats = await formatsQuery.orderBy("cw_resource_types.position").orderBy("cw_resource_types.name").orderBy("cw_booking_formats.position").execute();

  return {
    plans: plans.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      price: p.price,
      period: p.period,
      billing: p.billing,
      includesDomiciliation: p.includes_domiciliation,
    })),
    packs: packs.map((p) => ({
      id: p.id,
      name: p.name,
      typeName: p.typeName,
      quotaKind: p.quota_kind,
      quota: p.quota,
      validityDays: p.validity_days,
      price: p.price,
    })),
    // A format without a visitor price is not for sale; a missing member price falls back to the visitor price.
    formats: formats
      .filter((f) => isBookableCategory(f.category) && f.visitor !== null)
      .map((f) => ({ id: f.id, typeName: f.typeName, label: f.label, nature: f.nature, visitor: Number(f.visitor), member: Number(f.member ?? f.visitor) })),
  };
}

/**
 * Opening window of the current local day: the closure of the day replaces the usual hours (a full closure
 * closes the day, overlapping reduced hours keep their intersection), otherwise the centre hours on its weekdays.
 */
async function openingWindow(db: Kysely<Database>, centreId: string, now: Date): Promise<{ start: Date; end: Date } | null> {
  const result = await sql<{ open_start: Date | null; open_end: Date | null }>`
    with c as (
      select timezone, open_from, open_to, open_weekdays, (${now}::timestamptz at time zone timezone)::date as today
      from centres where id = ${centreId}
    ),
    cl as (
      select count(*) as n, bool_or(cw_closures.open_from is null) as closed, max(cw_closures.open_from) as f, min(cw_closures.open_to) as t
      from cw_closures, c
      where cw_closures.centre_id = ${centreId} and cw_closures.starts_on <= c.today and cw_closures.ends_on >= c.today
    ),
    h as (
      select c.timezone, c.today,
        case when cl.n = 0 then (case when extract(isodow from c.today)::int = any (c.open_weekdays) then c.open_from end)
             when cl.closed then null else cl.f end as f,
        case when cl.n = 0 then (case when extract(isodow from c.today)::int = any (c.open_weekdays) then c.open_to end)
             when cl.closed then null else cl.t end as t
      from c, cl
    )
    select (h.today + h.f) at time zone h.timezone as open_start, (h.today + h.t) at time zone h.timezone as open_end from h
  `.execute(db);
  const row = result.rows[0];
  if (!row?.open_start || !row.open_end || row.open_end <= row.open_start) return null;
  return { start: new Date(row.open_start), end: new Date(row.open_end) };
}

async function countFree(db: Kysely<Database>, typeIds: string[], from: Date, to: Date): Promise<Map<string, number>> {
  const rows = await db
    .selectFrom("cw_resources")
    .select(["type_id", (eb) => eb.fn.countAll<string>().as("free")])
    .where("type_id", "in", typeIds)
    .where("status", "=", "active")
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom("cw_bookings")
            .select("cw_bookings.id")
            .whereRef("cw_bookings.resource_id", "=", "cw_resources.id")
            .where("cw_bookings.status", "in", [...OCCUPYING_STATUSES])
            .where("cw_bookings.starts_at", "<", to)
            .where("cw_bookings.blocked_until", ">", from),
        ),
      ),
    )
    .groupBy("type_id")
    .execute();
  return new Map(rows.map((r) => [r.type_id, Number(r.free)]));
}

async function loadAvailability(db: Kysely<Database>, centreId: string, now: Date): Promise<AvailabilityRow[]> {
  const types = (
    await db
      .selectFrom("cw_resource_types")
      .select(["id", "name", "category"])
      .where("centre_id", "=", centreId)
      .where("status", "=", "active")
      .where("public", "=", true)
      .orderBy("position")
      .orderBy("name")
      .execute()
  ).filter((t) => isBookableCategory(t.category));
  if (types.length === 0) return [];
  const typeIds = types.map((t) => t.id);
  const window = await openingWindow(db, centreId, now);
  const openNow = window !== null && window.start <= now && now < window.end;
  const restStart = window && window.start > now ? window.start : now;
  const restOpen = window !== null && restStart < window.end;
  const freeNow = openNow ? await countFree(db, typeIds, now, new Date(now.getTime() + 1)) : null;
  const freeRest = restOpen ? await countFree(db, typeIds, restStart, window.end) : null;
  return types.map((t) => ({
    typeId: t.id,
    name: t.name,
    category: t.category,
    freeNow: freeNow ? (freeNow.get(t.id) ?? 0) : null,
    freeRestOfDay: freeRest ? (freeRest.get(t.id) ?? 0) : null,
  }));
}

async function loadContact(db: Kysely<Database>, centreId: string, coworking: boolean, now: Date): Promise<ContactData> {
  const centre = await db
    .selectFrom("centres")
    .select(["open_from", "open_to", "open_weekdays", sql<string>`to_char(${now}::timestamptz at time zone timezone, 'YYYY-MM-DD')`.as("today")])
    .where("id", "=", centreId)
    .executeTakeFirstOrThrow();
  const closures = coworking
    ? await db
        .selectFrom("cw_closures")
        .select(["starts_on", "ends_on", "label", "open_from", "open_to"])
        .where("centre_id", "=", centreId)
        .where("ends_on", ">=", centre.today)
        .orderBy("starts_on")
        .limit(5)
        .execute()
    : [];
  return {
    openFrom: centre.open_from.slice(0, 5),
    openTo: centre.open_to.slice(0, 5),
    openWeekdays: [...centre.open_weekdays].sort(),
    closures: closures.map((c) => ({
      startsOn: c.starts_on,
      endsOn: c.ends_on,
      label: c.label,
      openFrom: c.open_from?.slice(0, 5) ?? null,
      openTo: c.open_to?.slice(0, 5) ?? null,
    })),
  };
}

async function loadArticles(db: Kysely<Database>, options: LoadOptions, limit: number): Promise<ArticleCard[]> {
  const byId = new Map(options.pages.map((p) => [p.id, p]));
  const articles = options.pages
    .filter((p) => p.kind === "article" && p.status === "published" && p.published_version_id)
    .sort((a, b) => (b.article_date ?? "").localeCompare(a.article_date ?? "") || b.created_at.getTime() - a.created_at.getTime());
  const contents = await loadVersionContents(
    db,
    articles.map((a) => a.published_version_id!),
  );
  const cards: ArticleCard[] = [];
  for (const article of articles) {
    const content = contents.get(article.published_version_id!)?.[options.language];
    if (!content) continue;
    cards.push({
      path: publicPath(slugChain(byId, article), options.language, options.defaultLanguage),
      title: content.title,
      summary: content.seoDescription,
      date: article.article_date!,
    });
    if (cards.length >= limit) break;
  }
  return cards;
}

/**
 * Loads what the dynamic sections of a page need. Coworking sections get no data when the module is off, so
 * they render nothing; the contact section then shows the centre without the coworking closures.
 */
export async function loadSectionData(db: Kysely<Database>, sections: readonly SiteSection[], options: LoadOptions): Promise<SectionData> {
  const has = (type: SiteSection["type"]) => sections.some((s) => s.type === type);
  const data: SectionData = { spaces: null, pricing: new Map(), availability: null, contact: null, articles: [] };
  if (options.coworking) {
    if (has("spaces")) data.spaces = await loadSpaces(db, options.centreId);
    if (has("availability")) data.availability = await loadAvailability(db, options.centreId, options.now);
    for (const section of sections) {
      if (section.type === "pricing") data.pricing.set(section.id, await loadPricing(db, options.centreId, section.typeId));
    }
  }
  if (has("contact")) data.contact = await loadContact(db, options.centreId, options.coworking, options.now);
  const articleLimit = Math.max(0, ...sections.map((s) => (s.type === "articles" ? s.limit : 0)));
  if (articleLimit > 0) data.articles = await loadArticles(db, options, articleLimit);
  return data;
}
