import { createHash } from "node:crypto";
import {
  CW_CATEGORY_LABELS,
  formatTnd,
  type InlineText,
  type LinkTarget,
  type RichText,
  type SectionButton,
  type SiteLanguage,
  type SiteSection,
} from "@gcf/shared";
import type { SectionData } from "./dynamic.js";
import { esc, jsonForScript } from "./html.js";
import { featureIcon } from "./icons.js";
import type { SiteLabels } from "./labels.js";
import type { SiteSettings } from "./settings.js";
import { googleFontsHref, themeCss } from "./theme.js";

export interface MediaInfo {
  id: string;
  mime: string;
  width: number;
  height: number;
  alt: string | null;
}

/** Everything the sections of one page need, resolved before rendering so rendering itself never queries. */
export interface RenderContext {
  settings: SiteSettings;
  language: SiteLanguage;
  labels: SiteLabels;
  /** Address of a media file in the rendered document (public or back-office preview). */
  mediaUrl: (id: string) => string;
  media: ReadonlyMap<string, MediaInfo>;
  /** Client portal booking entry, when the portal is open. */
  bookingUrl: string | null;
  /** Public path of every published page in the rendered language. */
  pagePaths: ReadonlyMap<string, string>;
  data: SectionData;
  /** Path of the rendered page, where the lead forms come back after posting. */
  path: string;
  formStatus: "sent" | "error" | null;
  preview: boolean;
}

export interface MenuItem {
  label: string;
  path: string;
  current: boolean;
  children: MenuItem[];
}

export interface DocumentInput {
  ctx: RenderContext;
  centreName: string;
  documentTitle: string;
  description: string | null;
  canonical: string | null;
  alternates: { language: SiteLanguage | "x-default"; href: string }[];
  ogType: "website" | "article";
  ogImage: string | null;
  noindex: boolean;
  jsonLd: unknown[];
  menu: MenuItem[];
  footerLinks: MenuItem[];
  languageLinks: { language: SiteLanguage; href: string; current: boolean }[];
  homePath: string;
  main: string;
}

/*
 * The only script of the site, allowed by its hash in the Content-Security-Policy. It toggles the mobile menu and
 * improves the photo viewer, which works without it through `:target`: Escape, arrow keys and swipes move or close
 * it, a backdrop click closes it, moving between photos replaces the history entry so Back closes the viewer, and
 * focus goes to the viewer then back to the photo. It also scrolls carousels from their buttons.
 */
const SITE_SCRIPT = [
  'document.documentElement.classList.add("js");',
  "var opened=false,last=null,sx=null;",
  'function openBox(){return document.querySelector(".lb:target")}',
  'function go(a){if(a)location.replace(a.getAttribute("href"))}',
  'function closeBox(box){if(opened){opened=false;history.back()}else go(box.querySelector(".lb-close"))}',
  'document.addEventListener("click",function(e){var t=e.target;if(!t.closest)return;',
  'var b=t.closest(".nav-toggle");if(b){var o=b.getAttribute("aria-expanded")!=="true";b.setAttribute("aria-expanded",String(o));document.getElementById("site-nav").classList.toggle("open",o);return}',
  'if(t.closest(".g-open")){opened=true;return}',
  'var box=t.closest(".lb");if(box){var step=t.closest(".lb-prev,.lb-next");if(step){e.preventDefault();go(step);return}',
  'if(t.closest(".lb-close")||t===box){e.preventDefault();closeBox(box)}return}',
  'var c=t.closest(".car-prev,.car-next");if(c){var list=c.closest(".gallery-wrap").querySelector(".gallery-carousel");',
  'list.scrollBy({left:(c.classList.contains("car-next")?1:-1)*list.clientWidth*0.8,behavior:"smooth"})}});',
  'document.addEventListener("keydown",function(e){var box=openBox();if(!box)return;',
  'if(e.key==="Escape"){e.preventDefault();closeBox(box)}else if(e.key==="ArrowLeft")go(box.querySelector(".lb-prev"));',
  'else if(e.key==="ArrowRight")go(box.querySelector(".lb-next"))});',
  'document.addEventListener("touchstart",function(e){sx=openBox()&&e.touches.length===1?e.touches[0].clientX:null},{passive:true});',
  'document.addEventListener("touchend",function(e){if(sx===null)return;var dx=e.changedTouches[0].clientX-sx;sx=null;var box=openBox();',
  'if(box&&Math.abs(dx)>=50)go(box.querySelector(dx>0?".lb-prev":".lb-next"))});',
  'function focusBox(){var box=openBox();if(box){box.querySelector(".lb-close").focus({preventScroll:true});last=box.getAttribute("data-photo")}',
  'else if(last){var th=document.getElementById(last);last=null;if(th){var a=th.querySelector(".g-open");if(a)a.focus({preventScroll:true})}}}',
  'window.addEventListener("hashchange",focusBox);focusBox();',
].join("");
const SITE_SCRIPT_HASH = createHash("sha256").update(SITE_SCRIPT).digest("base64");

/** Content-Security-Policy of a rendered page: self, inline styles, the site script by hash, Google Fonts when used, https images. */
export function contentSecurityPolicy(usesGoogleFonts: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'sha256-${SITE_SCRIPT_HASH}'`,
    `style-src 'self' 'unsafe-inline'${usesGoogleFonts ? " https://fonts.googleapis.com" : ""}`,
    `font-src 'self'${usesGoogleFonts ? " https://fonts.gstatic.com" : ""}`,
    "img-src 'self' https: data:",
    "form-action 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'self'",
  ].join("; ");
}

/** A calendar date (YYYY-MM-DD) written out in the site language. */
export function formatDate(iso: string, language: SiteLanguage): string {
  return new Intl.DateTimeFormat(language === "fr" ? "fr-FR" : "en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${iso}T00:00:00Z`),
  );
}

const money = (amount: number, language: SiteLanguage) => `${esc(formatTnd(amount, language))}&nbsp;TND`;

/** Plain text with blank lines as paragraphs and single line breaks kept. */
function paragraphs(text: string, className?: string): string {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== "")
    .map((p) => `<p${className ? ` class="${className}"` : ""}>${p.split("\n").map(esc).join("<br>")}</p>`)
    .join("");
}

function inline(node: InlineText): string {
  let html = esc(node.text);
  if (node.italic) html = `<em>${html}</em>`;
  if (node.bold) html = `<strong>${html}</strong>`;
  if (node.href) html = `<a href="${esc(node.href)}">${html}</a>`;
  return html;
}

const inlines = (nodes: readonly InlineText[]) => nodes.map(inline).join("");

function richText(blocks: RichText): string {
  return blocks
    .map((block) => {
      if (block.type === "paragraph") return `<p>${inlines(block.content)}</p>`;
      if (block.type === "heading") return `<h${block.level}>${inlines(block.content)}</h${block.level}>`;
      const tag = block.ordered ? "ol" : "ul";
      return `<${tag}>${block.items.map((item) => `<li>${inlines(item)}</li>`).join("")}</${tag}>`;
    })
    .join("");
}

function linkHref(target: LinkTarget, ctx: RenderContext): string | null {
  switch (target.kind) {
    case "booking":
      return ctx.bookingUrl;
    case "page":
      return ctx.pagePaths.get(target.pageId) ?? null;
    case "anchor":
      return `#${target.anchor}`;
    case "url":
      return target.url;
  }
}

/** A button whose target is unavailable (unpublished page, closed portal) is left out rather than broken. */
function button(value: SectionButton | undefined, ctx: RenderContext, className = "btn btn-primary"): string {
  if (!value) return "";
  const href = linkHref(value.target, ctx);
  return href ? `<p><a class="${className}" href="${esc(href)}">${esc(value.label)}</a></p>` : "";
}

function image(id: string | null | undefined, ctx: RenderContext, options: { alt?: string | null | undefined; eager?: boolean } = {}): string {
  if (!id) return "";
  const media = ctx.media.get(id);
  if (!media) return "";
  const alt = media.alt ?? options.alt ?? "";
  return `<img src="${esc(ctx.mediaUrl(id))}" alt="${esc(alt)}" width="${media.width}" height="${media.height}"${options.eager ? "" : ' loading="lazy"'} decoding="async">`;
}

function sectionHead(title: string | undefined, intro?: string): string {
  if (!title && !intro) return "";
  return `<div class="sec-head">${title ? `<h2>${esc(title)}</h2>` : ""}${intro ? paragraphs(intro) : ""}</div>`;
}

const wrapSection = (section: SiteSection, alt: boolean, inner: string) =>
  `<section id="${esc(section.id)}" class="sec sec-${section.type.replace("_", "-")}${alt ? " sec-alt" : ""}"><div class="wrap">${inner}</div></section>`;

function lowestPrice(card: NonNullable<SectionData["spaces"]>[number], ctx: RenderContext): string {
  const lowest = card.lowest;
  if (!lowest) return "";
  const l = ctx.labels;
  const per = lowest.per === "booking" ? `(${lowest.label})` : lowest.per === "hour" ? l.perHour : l.perPeriod[lowest.per];
  return `<p class="price">${esc(l.from)} ${money(lowest.amount, ctx.language)} <span class="muted">${esc(per)}</span></p>`;
}

function renderSpaces(section: Extract<SiteSection, { type: "spaces" }>, ctx: RenderContext, alt: boolean): string {
  const spaces = ctx.data.spaces;
  if (!spaces || spaces.length === 0) return "";
  const l = ctx.labels;
  const cards = spaces
    .map((s) => {
      const capacity = s.capacityMin !== null && s.capacityMax !== null ? `<p class="muted">${esc(l.capacity(s.capacityMin, s.capacityMax))}</p>` : "";
      // A space sold only by subscription has no slot to book online: its card shows its price without a button.
      const bookable = ctx.bookingUrl !== null && s.lowest !== null && (s.lowest.per === "hour" || s.lowest.per === "booking");
      const book = bookable
        ? `<p class="card-action"><a class="btn btn-primary" href="${esc(`${ctx.bookingUrl}reserver?type=${encodeURIComponent(s.id)}`)}">${esc(l.book)}<span class="visually-hidden"> : ${esc(
            s.name,
          )}</span></a></p>`
        : "";
      const photo = image(s.photoId, ctx, { alt: s.name });
      return `<article class="card space-card">${photo ? `<div class="card-photo">${photo}</div>` : ""}<div class="card-body"><h3>${esc(s.name)}</h3><p class="muted">${esc(
        CW_CATEGORY_LABELS[ctx.language][s.category],
      )}</p>${s.description ? paragraphs(s.description) : ""}${capacity}${lowestPrice(s, ctx)}${book}</div></article>`;
    })
    .join("");
  return wrapSection(section, alt, `${sectionHead(section.title, section.intro)}<div class="grid">${cards}</div>`);
}

function renderPricing(section: Extract<SiteSection, { type: "pricing" }>, ctx: RenderContext, alt: boolean): string {
  const data = ctx.data.pricing.get(section.id);
  if (!data || data.plans.length + data.packs.length + data.formats.length === 0) return "";
  const l = ctx.labels;
  const lang = ctx.language;
  const parts: string[] = [sectionHead(section.title, section.intro)];
  if (data.plans.length) {
    const cards = data.plans
      .map(
        (p) =>
          `<article class="card"><h3>${esc(p.name)}</h3><p class="price">${money(p.price, lang)} <span class="muted">${esc(l.perPeriod[p.period])}</span></p>${
            p.billing === "monthly" ? `<p class="muted">${esc(l.billedMonthly)}</p>` : ""
          }${p.includesDomiciliation ? `<p>${esc(l.domiciliation)}</p>` : ""}${p.description ? paragraphs(p.description) : ""}</article>`,
      )
      .join("");
    parts.push(`<h3>${esc(l.plans)}</h3><div class="grid">${cards}</div>`);
  }
  if (data.formats.length) {
    const rows = data.formats
      .map(
        (f) =>
          `<tr><th scope="row">${esc(f.typeName)}</th><td>${esc(f.label)}${f.nature === "free" ? ` <span class="muted">(${esc(l.perHour)})</span>` : ""}</td><td class="num">${money(f.visitor, lang)}</td><td class="num">${money(f.member, lang)}</td></tr>`,
      )
      .join("");
    parts.push(
      `<h3>${esc(l.formats)}</h3><div class="table-scroll"><table class="tbl"><thead><tr><th scope="col">${esc(l.columnSpace)}</th><th scope="col">${esc(l.columnOption)}</th><th scope="col" class="num">${esc(l.visitor)}</th><th scope="col" class="num">${esc(l.member)}</th></tr></thead><tbody>${rows}</tbody></table></div>`,
    );
  }
  if (data.packs.length) {
    const rows = data.packs
      .map(
        (p) =>
          `<tr><th scope="row">${esc(p.name)}</th><td>${esc(p.typeName)}</td><td>${esc(p.quotaKind === "minutes" ? l.quotaMinutes(p.quota) : l.quotaBookings(p.quota))}, ${esc(l.validity(p.validityDays))}</td><td class="num">${money(p.price, lang)}</td></tr>`,
      )
      .join("");
    parts.push(
      `<h3>${esc(l.packs)}</h3><div class="table-scroll"><table class="tbl"><thead><tr><th scope="col">${esc(l.packs)}</th><th scope="col">${esc(l.columnSpace)}</th><th scope="col">${esc(l.columnIncludes)}</th><th scope="col" class="num">${esc(l.columnPrice)}</th></tr></thead><tbody>${rows}</tbody></table></div>`,
    );
  }
  return wrapSection(section, alt, parts.join(""));
}

function renderAvailability(section: Extract<SiteSection, { type: "availability" }>, ctx: RenderContext, alt: boolean): string {
  const rows = ctx.data.availability;
  if (!rows || rows.length === 0) return "";
  const l = ctx.labels;
  const cards = rows
    .map((r) => {
      const now = r.freeNow === null ? `<p class="avail-num avail-closed">${esc(l.closedNow)}</p>` : `<p class="avail-num">${r.freeNow}</p>`;
      const later = r.freeRestOfDay === null ? "" : `<p class="muted">${esc(l.freeRestOfDay)} : ${r.freeRestOfDay}</p>`;
      return `<li class="card avail-card${r.freeNow === 0 ? " avail-full" : ""}"><h3>${esc(r.name)}</h3>${now}<p class="avail-label">${esc(l.freeNow)}</p>${later}</li>`;
    })
    .join("");
  return wrapSection(section, alt, `${sectionHead(section.title)}<ul class="avail grid">${cards}</ul>`);
}

function renderContact(section: Extract<SiteSection, { type: "contact" }>, ctx: RenderContext, alt: boolean, centreAddress: string | null): string {
  const s = ctx.settings;
  const l = ctx.labels;
  const lang = ctx.language;
  const address = s.address ?? centreAddress;
  const details: string[] = [];
  if (address) details.push(`<dt>${esc(l.address)}</dt><dd>${address.split("\n").map(esc).join("<br>")}</dd>`);
  if (s.contact_phone)
    details.push(`<dt>${esc(l.phone)}</dt><dd><a href="tel:${esc(s.contact_phone.replace(/[^+\d]/g, ""))}">${esc(s.contact_phone)}</a></dd>`);
  if (s.contact_email) details.push(`<dt>${esc(l.email)}</dt><dd><a href="mailto:${esc(s.contact_email)}">${esc(s.contact_email)}</a></dd>`);
  if (section.showMap && s.map_url) details.push(`<dd><a href="${esc(s.map_url)}">${esc(l.viewMap)}</a></dd>`);
  const columns = [details.length ? `<div><dl>${details.join("")}</dl></div>` : ""];
  const contact = ctx.data.contact;
  if (contact) {
    const days = l.weekdays
      .map((name, index) => {
        const open = contact.openWeekdays.includes(index + 1);
        return `<li>${esc(name)} : ${open ? esc(l.openRange(contact.openFrom, contact.openTo)) : esc(l.closed)}</li>`;
      })
      .join("");
    let closures = "";
    if (contact.closures.length) {
      const items = contact.closures
        .map((c) => {
          const when = l.dateRange(formatDate(c.startsOn, lang), formatDate(c.endsOn, lang));
          const hours = c.openFrom && c.openTo ? l.reducedHours(c.openFrom, c.openTo) : l.closed;
          return `<li>${esc(c.label)} : ${esc(when)}, ${esc(hours)}</li>`;
        })
        .join("");
      closures = `<h3>${esc(l.closures)}</h3><ul class="hours">${items}</ul>`;
    }
    columns.push(`<div><h3>${esc(l.openingHours)}</h3><ul class="hours">${days}</ul>${closures}</div>`);
  }
  return wrapSection(section, alt, `${sectionHead(section.title)}<div class="contact-grid">${columns.join("")}</div>`);
}

function renderForm(section: Extract<SiteSection, { type: "form" }>, ctx: RenderContext, alt: boolean): string {
  const l = ctx.labels;
  const id = (name: string) => esc(`${section.id}-${name}`);
  const field = (name: string, label: string, input: string) => `<div class="field"><label for="${id(name)}">${esc(label)}</label>${input}</div>`;
  const notice =
    ctx.formStatus === "sent"
      ? `<p class="notice" role="status">${esc(l.formSent)}</p>`
      : ctx.formStatus === "error"
        ? `<p class="notice" role="alert">${esc(l.formError)}</p>`
        : "";
  const fields = [
    field("name", l.formName, `<input id="${id("name")}" name="name" required maxlength="150" autocomplete="name">`),
    field("email", l.formEmail, `<input id="${id("email")}" name="email" type="email" maxlength="254" autocomplete="email" aria-describedby="${id("hint")}">`),
    field("phone", l.formPhone, `<input id="${id("phone")}" name="phone" type="tel" maxlength="40" autocomplete="tel" aria-describedby="${id("hint")}">`),
    `<p class="hint" id="${id("hint")}">${esc(l.formContactHint)}</p>`,
    section.variant === "quote"
      ? field("company", l.formCompany, `<input id="${id("company")}" name="company" maxlength="150" autocomplete="organization">`)
      : "",
    section.variant === "visit" ? field("date", l.formPreferredDate, `<input id="${id("date")}" name="preferredDate" type="date">`) : "",
    field("message", l.formMessage, `<textarea id="${id("message")}" name="message" maxlength="3000"></textarea>`),
  ].join("");
  const hidden = [
    ["kind", section.variant],
    ["language", ctx.language],
    ["page", ctx.path],
    ["section", section.id],
  ]
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${esc(value!)}">`)
    .join("");
  const honeypot = `<div class="hp" aria-hidden="true"><label for="${id("website")}">${esc(l.formHoneypot)}</label><input id="${id("website")}" name="website" tabindex="-1" autocomplete="off"></div>`;
  const submit = `<p><button class="btn btn-primary" type="submit">${esc(section.submitLabel ?? l.formSubmit[section.variant])}</button></p>`;
  return wrapSection(
    section,
    alt,
    `${sectionHead(section.title, section.intro)}${notice}<form class="lead-form" method="post" action="/api/public/leads"><fieldset${ctx.preview ? " disabled" : ""}>${hidden}${honeypot}${fields}${submit}</fieldset></form>`,
  );
}

/**
 * Tile sizes of a mosaic, so every row of its four columns is full: blocks of five photos (a large one, then four
 * small), and the photos left over sized to close the last rows. On two columns every size but `m-1` is full width.
 */
function mosaicTiles(total: number): string[] {
  // One photo left over after a block would stretch across the whole width: the last block and it share two rows.
  const blocks = total % 5 === 1 && total > 5 ? Math.floor(total / 5) - 1 : Math.floor(total / 5);
  const tiles: string[] = [];
  for (let i = 0; i < blocks; i += 1) tiles.push("m-big", "m-1", "m-1", "m-1", "m-1");
  const rest = total - blocks * 5;
  const closing: Record<number, string[]> = {
    0: [],
    1: ["m-4"],
    2: ["m-2", "m-2"],
    3: ["m-big", "m-2", "m-2"],
    4: ["m-big", "m-2", "m-1", "m-1"],
    6: ["m-big", "m-2", "m-1", "m-1", "m-2", "m-2"],
  };
  return [...tiles, ...closing[rest]!];
}

/**
 * A photo gallery in its layout, followed by one full-screen viewer per photo. Each viewer is shown by `:target`,
 * so it opens, moves and closes through plain links; ids use an underscore, which section anchors cannot contain.
 */
function renderGallery(section: Extract<SiteSection, { type: "gallery" }>, ctx: RenderContext, alt: boolean): string {
  const l = ctx.labels;
  const layout = section.layout ?? "grid";
  const photos = section.items
    .map((item) => ({ item, media: ctx.media.get(item.imageId) }))
    .filter((p): p is { item: (typeof section.items)[number]; media: NonNullable<typeof p.media> } => p.media !== undefined);
  if (photos.length === 0) return "";
  const total = photos.length;
  const thumbId = (n: number) => `${section.id}_p${n}`;
  const tiles = layout === "mosaic" ? mosaicTiles(total) : [];
  const viewId = (n: number) => `${section.id}_v${n}`;
  const items = photos
    .map(({ item, media }, i) => {
      const n = i + 1;
      const label = item.caption ?? media.alt ?? l.photoPosition(n, total);
      const tile = tiles[i] ? ` class="${tiles[i]}"` : "";
      return `<li id="${thumbId(n)}"${tile}><figure><a class="g-open" href="#${viewId(n)}" aria-label="${esc(l.enlargePhoto(label))}">${image(
        item.imageId,
        ctx,
        {
          alt: item.caption,
        },
      )}</a>${item.caption ? `<figcaption>${esc(item.caption)}</figcaption>` : ""}</figure></li>`;
    })
    .join("");
  const viewers = photos
    .map(({ item, media }, i) => {
      const n = i + 1;
      const label = item.caption ?? media.alt ?? section.title ?? l.photoPosition(n, total);
      const prev = n > 1 ? `<a class="lb-prev" href="#${viewId(n - 1)}" aria-label="${esc(l.previousPhoto)}">&lsaquo;</a>` : "";
      const next = n < total ? `<a class="lb-next" href="#${viewId(n + 1)}" aria-label="${esc(l.nextPhoto)}">&rsaquo;</a>` : "";
      return `<div class="lb" id="${viewId(n)}" data-photo="${thumbId(n)}" role="dialog" aria-label="${esc(label)}"><a class="lb-close" href="#${thumbId(
        n,
      )}" aria-label="${esc(l.closePhoto)}">&times;</a>${prev}<figure>${image(item.imageId, ctx, { alt: item.caption })}<figcaption>${
        item.caption ? `${esc(item.caption)} ` : ""
      }<span class="lb-count">${esc(l.photoPosition(n, total))}</span></figcaption></figure>${next}</div>`;
    })
    .join("");
  const carouselNav =
    layout === "carousel" && total > 1
      ? `<div class="car-nav"><button class="car-prev" type="button" aria-label="${esc(l.previousPhoto)}">&lsaquo;</button><button class="car-next" type="button" aria-label="${esc(
          l.nextPhoto,
        )}">&rsaquo;</button></div>`
      : "";
  const head = `<div class="gallery-head">${sectionHead(section.title, section.intro)}<p class="gallery-count muted">${esc(l.photoCount(total))}</p>${carouselNav}</div>`;
  return wrapSection(section, alt, `<div class="gallery-wrap">${head}<ul class="gallery gallery-${layout}">${items}</ul></div>${viewers}`);
}

function renderSection(section: SiteSection, ctx: RenderContext, alt: boolean, headingLevel: 1 | 2, centreAddress: string | null): string {
  switch (section.type) {
    case "hero": {
      const img = image(section.imageId, ctx, { eager: true });
      const cover = img !== "" && section.imageLayout !== "split";
      const h = `h${headingLevel}`;
      const text = `<div><${h}>${esc(section.title)}</${h}>${section.subtitle ? paragraphs(section.subtitle) : ""}${button(section.button, ctx)}</div>`;
      if (cover)
        return `<section id="${esc(section.id)}" class="hero hero-cover"><div class="hero-bg">${img}</div><div class="wrap hero-inner">${text}</div></section>`;
      return `<section id="${esc(section.id)}" class="hero"><div class="wrap hero-inner${img ? " has-image" : ""}">${text}${img}</div></section>`;
    }
    case "rich_text":
      return wrapSection(section, alt, `<div class="prose">${sectionHead(section.title)}${richText(section.body)}</div>`);
    case "features": {
      const cards = section.items
        .map((item) => `<div class="card">${featureIcon(item.icon)}<h3>${esc(item.title)}</h3>${item.text ? paragraphs(item.text) : ""}</div>`)
        .join("");
      return wrapSection(section, alt, `${sectionHead(section.title)}<div class="grid">${cards}</div>`);
    }
    case "spaces":
      return renderSpaces(section, ctx, alt);
    case "pricing":
      return renderPricing(section, ctx, alt);
    case "availability":
      return renderAvailability(section, ctx, alt);
    case "gallery":
      return renderGallery(section, ctx, alt);
    case "testimonials": {
      const items = section.items
        .map(
          (item) =>
            `<figure class="card quote"><blockquote>${paragraphs(item.quote)}</blockquote><figcaption><strong>${esc(item.author)}</strong>${
              item.role ? `<br><span class="muted">${esc(item.role)}</span>` : ""
            }</figcaption></figure>`,
        )
        .join("");
      return wrapSection(section, alt, `${sectionHead(section.title)}<div class="grid">${items}</div>`);
    }
    case "faq": {
      const items = section.items.map((item) => `<details><summary>${esc(item.question)}</summary><div>${paragraphs(item.answer)}</div></details>`).join("");
      return wrapSection(section, alt, `${sectionHead(section.title)}<div class="faq">${items}</div>`);
    }
    case "contact":
      return renderContact(section, ctx, alt, centreAddress);
    case "form":
      return renderForm(section, ctx, alt);
    case "cta":
      return wrapSection(
        section,
        alt,
        `<div class="cta"><h2>${esc(section.title)}</h2>${section.text ? paragraphs(section.text) : ""}${button(section.button, ctx)}</div>`,
      );
    case "articles": {
      const articles = ctx.data.articles.slice(0, section.limit);
      if (articles.length === 0) return "";
      const items = articles
        .map(
          (a) =>
            `<li class="card"><h3><a href="${esc(a.path)}">${esc(a.title)}</a></h3><p class="muted"><time datetime="${esc(a.date)}">${esc(formatDate(a.date, ctx.language))}</time></p>${
              a.summary ? paragraphs(a.summary) : ""
            }</li>`,
        )
        .join("");
      return wrapSection(section, alt, `${sectionHead(section.title)}<ul class="articles grid">${items}</ul>`);
    }
  }
}

/**
 * Renders the sections of a page. When the page opens with a hero, the hero title is the page heading (h1);
 * otherwise the caller renders the title itself.
 */
export function renderSections(sections: readonly SiteSection[], ctx: RenderContext, centreAddress: string | null): string {
  let alt = false;
  return sections
    .map((section, index) => {
      const html = renderSection(section, ctx, alt, index === 0 && section.type === "hero" ? 1 : 2, centreAddress);
      if (html && section.type !== "hero") alt = !alt;
      return html;
    })
    .join("");
}

function menuList(items: readonly MenuItem[], className: string): string {
  if (items.length === 0) return "";
  return `<ul class="${className}">${items
    .map(
      (item) => `<li><a href="${esc(item.path)}"${item.current ? ' aria-current="page"' : ""}>${esc(item.label)}</a>${menuList(item.children, "submenu")}</li>`,
    )
    .join("")}</ul>`;
}

function socialLinks(settings: SiteSettings): { label: string; href: string }[] {
  return [
    { label: "Facebook", href: settings.facebook_url },
    { label: "Instagram", href: settings.instagram_url },
    { label: "LinkedIn", href: settings.linkedin_url },
  ].filter((s): s is { label: string; href: string } => s.href !== null);
}

/** URLs of the social profiles, for the sameAs property of the JSON-LD. */
export const socialUrls = (settings: SiteSettings) => socialLinks(settings).map((s) => s.href);

/** A complete HTML5 document with the site header, the given main content and the footer. */
export function renderDocument(input: DocumentInput): string {
  const { ctx } = input;
  const s = ctx.settings;
  const l = ctx.labels;
  const siteName = s.site_name ?? input.centreName;
  const fontsHref = googleFontsHref(s.font);
  const favicon = s.favicon_media_id ? ctx.media.get(s.favicon_media_id) : undefined;
  const logo = s.logo_media_id ? ctx.media.get(s.logo_media_id) : undefined;

  const head = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(input.documentTitle)}</title>`,
    input.description ? `<meta name="description" content="${esc(input.description)}">` : "",
    input.noindex ? '<meta name="robots" content="noindex">' : "",
    input.canonical ? `<link rel="canonical" href="${esc(input.canonical)}">` : "",
    ...input.alternates.map((a) => `<link rel="alternate" hreflang="${a.language}" href="${esc(a.href)}">`),
    `<meta property="og:type" content="${input.ogType}">`,
    `<meta property="og:title" content="${esc(input.documentTitle)}">`,
    input.description ? `<meta property="og:description" content="${esc(input.description)}">` : "",
    input.canonical ? `<meta property="og:url" content="${esc(input.canonical)}">` : "",
    `<meta property="og:site_name" content="${esc(siteName)}">`,
    `<meta property="og:locale" content="${l.ogLocale}">`,
    input.ogImage ? `<meta property="og:image" content="${esc(input.ogImage)}">` : "",
    favicon ? `<link rel="icon" href="${esc(ctx.mediaUrl(favicon.id))}" type="${esc(favicon.mime)}">` : "",
    fontsHref ? `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="${esc(fontsHref)}">` : "",
    `<style>${themeCss(s)}</style>`,
    `<script>${SITE_SCRIPT}</script>`,
    ...input.jsonLd.map((data) => `<script type="application/ld+json">${jsonForScript(data)}</script>`),
  ].join("");

  const languageSwitch =
    input.languageLinks.length > 1
      ? `<ul class="lang-switch" aria-label="${esc(l.languages)}">${input.languageLinks
          .map(
            (link) =>
              `<li><a href="${esc(link.href)}" lang="${link.language}" hreflang="${link.language}"${link.current ? ' aria-current="true"' : ""}>${esc(
                link.language.toUpperCase(),
              )}</a></li>`,
          )
          .join("")}</ul>`
      : "";
  const book = ctx.bookingUrl ? `<a class="btn btn-primary" href="${esc(ctx.bookingUrl)}">${esc(l.book)}</a>` : "";
  const brand = logo ? `<img src="${esc(ctx.mediaUrl(logo.id))}" alt="${esc(siteName)}" width="${logo.width}" height="${logo.height}">` : esc(siteName);
  const header = `<header class="site-header"><div class="wrap header-inner"><a class="brand" href="${esc(input.homePath)}">${brand}</a><button class="nav-toggle" type="button" aria-expanded="false" aria-controls="site-nav">${esc(
    l.menu,
  )}</button><nav id="site-nav" class="site-nav" aria-label="${esc(l.mainMenu)}">${menuList(input.menu, "menu")}${languageSwitch}${book}</nav></div></header>`;

  const footerColumns: string[] = [
    `<div><h2>${esc(siteName)}</h2>${s.tagline ? paragraphs(s.tagline) : ""}${s.footer_text ? paragraphs(s.footer_text, "muted") : ""}</div>`,
  ];
  if (input.footerLinks.length) footerColumns.push(`<div><h2>${esc(l.footerPages)}</h2>${menuList(input.footerLinks, "footer-links")}</div>`);
  const contact: string[] = [];
  if (s.address) contact.push(`<li>${s.address.split("\n").map(esc).join("<br>")}</li>`);
  if (s.contact_phone) contact.push(`<li><a href="tel:${esc(s.contact_phone.replace(/[^+\d]/g, ""))}">${esc(s.contact_phone)}</a></li>`);
  if (s.contact_email) contact.push(`<li><a href="mailto:${esc(s.contact_email)}">${esc(s.contact_email)}</a></li>`);
  if (contact.length) footerColumns.push(`<div><h2>${esc(l.contact)}</h2><ul>${contact.join("")}</ul></div>`);
  const social = socialLinks(s);
  if (social.length)
    footerColumns.push(
      `<div><h2>${esc(l.followUs)}</h2><ul>${social.map((x) => `<li><a href="${esc(x.href)}" rel="me">${esc(x.label)}</a></li>`).join("")}</ul></div>`,
    );
  const footer = `<footer class="site-footer"><div class="wrap"><div class="footer-grid">${footerColumns.join("")}</div><p class="copyright">&copy; ${new Date().getUTCFullYear()} ${esc(siteName)}</p></div></footer>`;

  const banner = ctx.preview ? `<div class="preview-banner" role="note">${esc(l.preview)}</div>` : "";
  return `<!doctype html><html lang="${ctx.language}"><head>${head}</head><body><a class="skip" href="#contenu">${esc(l.skipToContent)}</a>${banner}${header}<main id="contenu" tabindex="-1">${input.main}</main>${footer}</body></html>`;
}
