import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { promoteScheduledPages } from "../src/site/scheduling.js";
import { createHarness, PUBLIC_ORIGIN, type Harness } from "./harness.js";

let h: Harness;
let admin: string;
let editor: string;
let secretariat: string;
const ids: Record<string, string> = {};

const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000010000000100802000000909168360000000049454e44ae426082", "hex");

async function loginAll() {
  admin = await h.login("admin@site.tn");
  editor = await h.login("editor@site.tn");
  secretariat = await h.login("sec@site.tn");
}

const hero = (title: string, extra: Record<string, unknown> = {}) => ({ id: "accueil", type: "hero", title, ...extra });

async function saveDraft(pageId: string, language: "fr" | "en", title: string, sections: unknown[] = []) {
  const res = await h.call("PUT", `/api/site/pages/${pageId}/drafts/${language}`, editor, { title, sections });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

beforeAll(async () => {
  h = await createHarness();
  await h.setModules(["training", "website"]);
  await h.createUser("admin", "admin@site.tn");
  await h.createUser("editor", "editor@site.tn");
  await h.createUser("secretariat", "sec@site.tn");
  await loginAll();
});

afterAll(async () => {
  await h.close();
});

describe("site settings", () => {
  it("creates the settings named after the centre on first read", async () => {
    const res = await h.call("GET", "/api/site/settings", editor);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ online: false, siteName: "Centre de test", languages: ["fr"], defaultLanguage: "fr", primaryColor: "#1d4ed8" });
  });

  it("refuses colours that white text cannot be read on", async () => {
    const res = await h.call("PUT", "/api/site/settings", editor, { primaryColor: "#FFCC00" });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("low_contrast");
    expect(res.body.details.field).toBe("primaryColor");
    expect(res.body.details.ratio).toBeLessThan(4.5);
    const secondary = await h.call("PUT", "/api/site/settings", editor, { secondaryColor: "#22c55e" });
    expect(secondary.body.details.field).toBe("secondaryColor");
    const ok = await h.call("PUT", "/api/site/settings", editor, { primaryColor: "#0F4C81" });
    expect(ok.body.primaryColor).toBe("#0f4c81");
  });

  it("validates languages and https addresses", async () => {
    expect((await h.call("PUT", "/api/site/settings", editor, { languages: ["de"] })).status).toBe(400);
    expect((await h.call("PUT", "/api/site/settings", editor, { languages: ["fr", "fr"] })).status).toBe(400);
    const badDefault = await h.call("PUT", "/api/site/settings", editor, { defaultLanguage: "en" });
    expect(badDefault.body.code).toBe("invalid_default_language");
    expect((await h.call("PUT", "/api/site/settings", editor, { mapUrl: "http://maps.example/x" })).status).toBe(400);
    const ok = await h.call("PUT", "/api/site/settings", editor, {
      mapUrl: "https://maps.example/x",
      contactEmail: "Contact@Cowork.TN",
      contactPhone: "+216 71 000 000",
      tagline: "Travaillez autrement",
    });
    expect(ok.body).toMatchObject({ mapUrl: "https://maps.example/x", contactEmail: "contact@cowork.tn" });
  });

  it("is limited to website roles", async () => {
    expect((await h.call("GET", "/api/site/settings", secretariat)).status).toBe(403);
    expect((await h.call("PUT", "/api/site/settings", secretariat, { tagline: "x" })).status).toBe(403);
  });
});

describe("pages", () => {
  it("creates pages with a draft per language and builds the tree", async () => {
    const home = await h.call("POST", "/api/site/pages", editor, { title: "Accueil", slug: "accueil", showInMenu: false });
    expect(home.status).toBe(201);
    ids.home = home.body.id;
    expect((await h.call("POST", `/api/site/pages/${ids.home}/home`, editor)).body.isHome).toBe(true);
    ids.offers = (await h.call("POST", "/api/site/pages", editor, { title: "Tarifs", slug: "tarifs", showInMenu: true })).body.id;
    ids.child = (await h.call("POST", "/api/site/pages", editor, { title: "Salles", slug: "salles", parentId: ids.offers, showInMenu: true })).body.id;
    const draft = await h.call("GET", `/api/site/pages/${ids.offers}/drafts/fr`, editor);
    expect(draft.body).toMatchObject({ title: "Tarifs", sections: [] });

    const tree = await h.call("GET", "/api/site/pages", editor);
    expect(tree.body.map((p: { slug: string }) => p.slug)).toEqual(["accueil", "tarifs"]);
    expect(tree.body[1].children[0]).toMatchObject({
      slug: "salles",
      path: "/tarifs/salles",
      status: "draft",
      publishedVersion: null,
      titles: { fr: "Salles" },
    });
    expect(tree.body[0].path).toBe("/");
  });

  it("enforces the slug and tree rules", async () => {
    expect((await h.call("POST", "/api/site/pages", editor, { title: "X", slug: "espace" })).body.code).toBe("reserved_slug");
    expect((await h.call("POST", "/api/site/pages", editor, { title: "X", slug: "Tarifs" })).status).toBe(400);
    expect((await h.call("POST", "/api/site/pages", editor, { title: "X", slug: "tarifs" })).body.code).toBe("slug_taken");
    expect((await h.call("POST", "/api/site/pages", editor, { title: "X", slug: "x", parentId: ids.home })).body.code).toBe("invalid_parent");
    expect((await h.call("POST", "/api/site/pages", editor, { title: "X", slug: "x", kind: "article" })).body.code).toBe("article_date_required");
    const third = (await h.call("POST", "/api/site/pages", editor, { title: "Niveau 3", slug: "n3", parentId: ids.child })).body.id;
    expect((await h.call("POST", "/api/site/pages", editor, { title: "Niveau 4", slug: "n4", parentId: third })).body.code).toBe("too_deep");
    expect((await h.call("PATCH", `/api/site/pages/${ids.offers}`, editor, { parentId: third })).body.code).toBe("invalid_parent");
    expect((await h.call("POST", `/api/site/pages/${third}/archive`, editor)).status).toBe(200);
    expect((await h.call("POST", `/api/site/pages/${ids.home}/archive`, editor)).body.code).toBe("home_page");
    expect((await h.call("POST", `/api/site/pages/${ids.offers}/archive`, editor)).body.code).toBe("page_has_children");
  });

  it("reorders the pages of one level", async () => {
    expect((await h.call("POST", "/api/site/pages/reorder", editor, { parentId: null, pageIds: [ids.offers] })).body.code).toBe("invalid_order");
    const res = await h.call("POST", "/api/site/pages/reorder", editor, { parentId: null, pageIds: [ids.offers, ids.home] });
    expect(res.status).toBe(200);
    const tree = await h.call("GET", "/api/site/pages", editor);
    expect(tree.body.map((p: { slug: string }) => p.slug)).toEqual(["tarifs", "accueil"]);
  });
});

describe("drafts, publication and versions", () => {
  it("validates sections and the media and pages they reference", async () => {
    const unknownType = await h.call("PUT", `/api/site/pages/${ids.home}/drafts/fr`, editor, { title: "Accueil", sections: [{ id: "a", type: "marquee" }] });
    expect(unknownType.status).toBe(400);
    const rawHtml = await h.call("PUT", `/api/site/pages/${ids.home}/drafts/fr`, editor, {
      title: "Accueil",
      sections: [{ id: "a", type: "rich_text", body: [{ type: "html", html: "<b>x</b>" }] }],
    });
    expect(rawHtml.status).toBe(400);
    const duplicateIds = await h.call("PUT", `/api/site/pages/${ids.home}/drafts/fr`, editor, {
      title: "Accueil",
      sections: [hero("A"), hero("B")],
    });
    expect(duplicateIds.status).toBe(400);
    const missingMedia = await h.call("PUT", `/api/site/pages/${ids.home}/drafts/fr`, editor, {
      title: "Accueil",
      sections: [hero("Bienvenue", { imageId: "00000000-0000-4000-8000-000000000000" })],
    });
    expect(missingMedia.body.code).toBe("unknown_media");
    const missingPage = await h.call("PUT", `/api/site/pages/${ids.home}/drafts/fr`, editor, {
      title: "Accueil",
      sections: [hero("Bienvenue", { button: { label: "Voir", target: { kind: "page", pageId: "00000000-0000-4000-8000-000000000000" } } })],
    });
    expect(missingPage.body.code).toBe("unknown_page");
    expect((await h.call("PUT", `/api/site/pages/${ids.home}/drafts/en`, editor, { title: "Home", sections: [] })).body.code).toBe("language_not_enabled");
  });

  it("publishes only when every language has a title, and keeps immutable versions", async () => {
    const media = await h.call("POST", "/api/media", editor, { image: `data:image/png;base64,${PNG.toString("base64")}`, alt: "Open space lumineux" });
    expect(media.status).toBe(201);
    ids.media = media.body.id;
    await saveDraft(ids.home, "fr", "Accueil", [
      hero("Bienvenue au centre", {
        subtitle: "Des bureaux au cœur de Tunis",
        imageId: ids.media,
        button: { label: "Voir les tarifs", target: { kind: "page", pageId: ids.offers } },
      }),
      {
        id: "atouts",
        type: "features",
        title: "Nos atouts",
        items: [
          { icon: "wifi", title: "Fibre", text: "1 Gb/s" },
          { icon: "coffee", title: "Café offert" },
        ],
      },
      { id: "faq", type: "faq", title: "Questions", items: [{ question: "Peut-on visiter ?", answer: "Oui, sur rendez-vous." }] },
      {
        id: "texte",
        type: "rich_text",
        body: [{ type: "paragraph", content: [{ text: "Lire " }, { text: "la charte", bold: true, href: "https://example.tn/charte" }] }],
      },
    ]);
    await h.call("PUT", "/api/site/settings", editor, { languages: ["fr", "en"] });
    const missing = await h.call("POST", `/api/site/pages/${ids.home}/publish`, editor);
    expect(missing.status).toBe(422);
    expect(missing.body).toMatchObject({ code: "missing_translation", details: { languages: ["en"] } });

    await saveDraft(ids.home, "en", "Home", [hero("Welcome to the centre", { imageId: ids.media })]);
    const v1 = await h.call("POST", `/api/site/pages/${ids.home}/publish`, editor);
    expect(v1.status).toBe(200);
    expect(v1.body).toMatchObject({ status: "published", version: { number: 1 } });

    await saveDraft(ids.home, "fr", "Accueil modifié", [hero("Nouveau titre")]);
    const v2 = await h.call("POST", `/api/site/pages/${ids.home}/publish`, editor);
    expect(v2.body.version.number).toBe(2);
    await expect(sql`update site_page_versions set number = 9 where page_id = ${ids.home}`.execute(h.db)).rejects.toThrow(/immutable/);

    const versions = await h.call("GET", `/api/site/pages/${ids.home}/versions`, editor);
    expect(versions.body.map((v: { number: number; published: boolean }) => [v.number, v.published])).toEqual([
      [2, true],
      [1, false],
    ]);
    expect(versions.body[1].titles).toEqual({ fr: "Accueil", en: "Home" });

    const restored = await h.call("POST", `/api/site/pages/${ids.home}/versions/${versions.body[1].id}/restore`, editor);
    expect(restored.body.languages.sort()).toEqual(["en", "fr"]);
    const draft = await h.call("GET", `/api/site/pages/${ids.home}/drafts/fr`, editor);
    expect(draft.body.title).toBe("Accueil");
    expect(draft.body.sections).toHaveLength(4);
    expect((await h.call("POST", `/api/site/pages/${ids.home}/publish`, editor)).body.version.number).toBe(3);
  });

  it("renders the draft as a preview for staff", async () => {
    await saveDraft(ids.offers, "fr", "Tarifs brouillon", [
      { id: "intro", type: "rich_text", body: [{ type: "paragraph", content: [{ text: "Texte non publié" }] }] },
    ]);
    const res = await h.app.inject({ method: "GET", url: `/api/site/pages/${ids.offers}/preview?language=fr`, headers: { cookie: editor } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(res.headers["x-robots-tag"]).toBe("noindex");
    expect(res.body).toContain("Aperçu");
    expect(res.body).toContain("Texte non publié");
    expect(res.body).toContain('<meta name="robots" content="noindex">');
    expect((await h.app.inject({ method: "GET", url: `/api/site/pages/${ids.offers}/preview`, headers: { cookie: secretariat } })).statusCode).toBe(403);
  });

  it("publishes at a scheduled time through the background job", async () => {
    await saveDraft(ids.offers, "en", "Prices", [{ id: "intro", type: "rich_text", body: [{ type: "paragraph", content: [{ text: "Our prices" }] }] }]);
    expect((await h.call("POST", `/api/site/pages/${ids.offers}/publish`, editor, { at: "2020-01-01T10:00:00Z" })).body.code).toBe("schedule_in_past");
    const at = new Date(Date.now() + 3_600_000);
    const scheduled = await h.call("POST", `/api/site/pages/${ids.offers}/publish`, editor, { at: at.toISOString() });
    expect(scheduled.body).toMatchObject({ status: "draft", version: { number: 1 } });
    expect(new Date(scheduled.body.scheduledAt).getTime()).toBe(at.getTime());

    expect(await promoteScheduledPages(h.db, new Date(at.getTime() - 60_000))).toBe(0);
    expect(await promoteScheduledPages(h.db, new Date(at.getTime() + 60_000))).toBe(1);
    expect(await promoteScheduledPages(h.db, new Date(at.getTime() + 120_000))).toBe(0);
    const tree = await h.call("GET", "/api/site/pages", editor);
    const offers = tree.body.find((p: { id: string }) => p.id === ids.offers);
    expect(offers).toMatchObject({ status: "published", publishedVersion: 1, scheduledVersion: null, scheduledAt: null });
  });
});

describe("public website", () => {
  it("answers 404 while the site is offline and redirects to nothing without the portal", async () => {
    const robots = await h.getPublic("/robots.txt");
    expect(robots.body).toContain("Disallow: /");
    const home = await h.getPublic("/");
    expect(home.status).toBe(404);
    expect(home.body).toContain('content="noindex"');
    expect((await h.getPublic("/sitemap.xml")).status).toBe(404);
  });

  it("renders the published home page with SEO tags once online", async () => {
    await h.call("PUT", "/api/site/settings", editor, { online: true, seoDescription: "Coworking à Tunis" });
    const res = await h.getPublic("/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(res.headers["cache-control"]).toMatch(/^public, max-age=\d+$/);
    expect(res.headers["content-security-policy"]).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect(res.body).toMatch(/^<!doctype html><html lang="fr">/);
    expect(res.body).toContain("<title>Centre de test</title>");
    expect(res.body).toContain('<meta name="description" content="Coworking à Tunis">');
    expect(res.body).toContain(`<link rel="canonical" href="${PUBLIC_ORIGIN}/">`);
    expect(res.body).toContain(`<link rel="alternate" hreflang="en" href="${PUBLIC_ORIGIN}/en">`);
    expect(res.body).toContain(`<link rel="alternate" hreflang="x-default" href="${PUBLIC_ORIGIN}/">`);
    expect(res.body).toContain(`<meta property="og:image" content="${PUBLIC_ORIGIN}/media/${ids.media}">`);
    expect(res.body).toContain('"@type":"LocalBusiness"');
    expect(res.body).toContain('"@type":"FAQPage"');
    expect(res.body).toContain("<h1>Bienvenue au centre</h1>");
    expect(res.body).toContain('alt="Open space lumineux"');
    expect(res.body).toContain('href="/tarifs"');
    expect(res.body).toContain('<a href="https://example.tn/charte"><strong>la charte</strong></a>');
    expect(res.body).toContain('class="skip"');
    expect(res.body).not.toContain("/espace/");

    const en = await h.getPublic("/en");
    expect(en.body).toContain('<html lang="en">');
    expect(en.body).toContain("Welcome to the centre");
    expect((await h.getPublic("/en/")).headers.location).toBe("/en");
    expect((await h.getPublic("/fr/tarifs")).headers.location).toBe("/tarifs");
    expect((await h.getPublic("/accueil")).headers.location).toBe("/");
  });

  it("escapes every text, including a hostile title", async () => {
    const page = await h.call("POST", "/api/site/pages", editor, { title: "x", slug: "piege", showInMenu: true });
    ids.trap = page.body.id;
    const hostile = '<script>alert("x")</script>';
    await saveDraft(ids.trap, "fr", hostile, [{ id: "faq", type: "faq", items: [{ question: "</script><script>alert(1)</script>", answer: "a & b" }] }]);
    await saveDraft(ids.trap, "en", "Trap", []);
    await h.call("POST", `/api/site/pages/${ids.trap}/publish`, editor);
    const res = await h.getPublic("/piege");
    expect(res.status).toBe(200);
    expect(res.body).not.toContain(hostile);
    expect(res.body).not.toContain("<script>alert");
    expect(res.body).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(res.body).toContain("a &amp; b");
    expect(res.body).toContain("\\u003c/script>");
    const home = await h.getPublic("/");
    expect(home.body).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</a>");
  });

  it("answers a real 404 page and lists published pages in robots and the sitemap", async () => {
    const missing = await h.getPublic("/nulle-part");
    expect(missing.status).toBe(404);
    expect(missing.headers["x-robots-tag"]).toBe("noindex");
    expect(missing.body).toContain("Page introuvable");
    expect(missing.body).toContain('href="/tarifs"');
    expect((await h.getPublic("/tarifs/salles")).status).toBe(404);

    const robots = await h.getPublic("/robots.txt");
    expect(robots.body).toContain("Allow: /");
    expect(robots.body).toContain(`Sitemap: ${PUBLIC_ORIGIN}/sitemap.xml`);
    const sitemap = await h.getPublic("/sitemap.xml");
    expect(sitemap.status).toBe(200);
    expect(sitemap.body).toContain(`<loc>${PUBLIC_ORIGIN}/</loc>`);
    expect(sitemap.body).toContain(`<loc>${PUBLIC_ORIGIN}/en/tarifs</loc>`);
    expect(sitemap.body).toContain(`<xhtml:link rel="alternate" hreflang="en" href="${PUBLIC_ORIGIN}/en/tarifs"/>`);
    expect(sitemap.body).toMatch(/<lastmod>\d{4}-\d{2}-\d{2}T/);
    expect(sitemap.body).not.toContain("salles");
  });

  it("redirects every old address of a moved page without chains", async () => {
    expect((await h.call("PATCH", `/api/site/pages/${ids.offers}`, editor, { slug: "prix" })).status).toBe(200);
    expect((await h.call("PATCH", `/api/site/pages/${ids.offers}`, editor, { slug: "offres" })).status).toBe(200);
    const redirects = await h.call("GET", "/api/site/redirects", editor);
    const map = Object.fromEntries(redirects.body.map((r: { fromPath: string; toPath: string }) => [r.fromPath, r.toPath]));
    expect(map).toEqual({ "/tarifs": "/offres", "/prix": "/offres", "/en/tarifs": "/en/offres", "/en/prix": "/en/offres" });
    const moved = await h.getPublic("/tarifs");
    expect(moved.status).toBe(301);
    expect(moved.headers.location).toBe("/offres");
    expect((await h.getPublic("/offres")).status).toBe(200);

    await h.call("PATCH", `/api/site/pages/${ids.offers}`, editor, { slug: "tarifs" });
    const back = await h.call("GET", "/api/site/redirects", editor);
    const backMap = Object.fromEntries(back.body.map((r: { fromPath: string; toPath: string }) => [r.fromPath, r.toPath]));
    expect(backMap["/tarifs"]).toBeUndefined();
    expect(backMap["/offres"]).toBe("/tarifs");
    expect(backMap["/prix"]).toBe("/tarifs");
    expect((await h.getPublic("/tarifs")).status).toBe(200);
  });

  it("manages manual redirects and takes archived pages off the site without redirect", async () => {
    const created = await h.call("POST", "/api/site/redirects", editor, { fromPath: "/ancien-site/", toPath: "/prix" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ fromPath: "/ancien-site", toPath: "/tarifs", automatic: false });
    expect((await h.getPublic("/ancien-site")).headers.location).toBe("/tarifs");
    expect((await h.call("DELETE", `/api/site/redirects/${created.body.id}`, editor)).status).toBe(204);

    const before = (await h.call("GET", "/api/site/redirects", editor)).body.length;
    expect((await h.call("POST", `/api/site/pages/${ids.trap}/archive`, editor)).body.status).toBe("archived");
    expect((await h.getPublic("/piege")).status).toBe(404);
    expect((await h.call("GET", "/api/site/redirects", editor)).body).toHaveLength(before);
  });

  it("unpublishes a page and keeps its versions", async () => {
    const res = await h.call("POST", `/api/site/pages/${ids.offers}/unpublish`, editor);
    expect(res.body.status).toBe("draft");
    expect((await h.getPublic("/tarifs")).status).toBe(404);
    expect((await h.call("GET", `/api/site/pages/${ids.offers}/versions`, editor)).body).toHaveLength(1);
    await h.call("POST", `/api/site/pages/${ids.offers}/publish`, editor);
  });
});

describe("dynamic sections", () => {
  it("shows the coworking spaces, prices, availability and closures, and nothing when the module is off", async () => {
    await h.setModules(["training", "coworking", "website"]);
    await loginAll();
    const centreId = h.centreId;
    await h.db
      .updateTable("centres")
      .set({ open_from: "00:00", open_to: "23:59", open_weekdays: [1, 2, 3, 4, 5, 6, 7] })
      .where("id", "=", centreId)
      .execute();
    await h.db.insertInto("cw_settings").values({ centre_id: centreId, portal_enabled: true }).execute();
    const floor = await h.db.insertInto("cw_floors").values({ centre_id: centreId, name: "RDC" }).returning("id").executeTakeFirstOrThrow();
    const type = await h.db
      .insertInto("cw_resource_types")
      .values({ centre_id: centreId, name: "Open space Jasmin", category: "hot_desk", description: "Postes en lumière naturelle", photo_media_id: ids.media })
      .returning("id")
      .executeTakeFirstOrThrow();
    await h.db.insertInto("cw_resource_types").values({ centre_id: centreId, name: "Salle cachée", category: "meeting_room", public: false }).execute();
    const resources = await h.db
      .insertInto("cw_resources")
      .values(["A-1", "A-2", "A-3"].map((code, i) => ({ centre_id: centreId, type_id: type.id, floor_id: floor.id, code, capacity: i + 1 })))
      .returning("id")
      .execute();
    const format = await h.db
      .insertInto("cw_booking_formats")
      .values({ centre_id: centreId, type_id: type.id, label: "Demi-journée", nature: "named", start_time: "08:00", end_time: "13:00" })
      .returning("id")
      .executeTakeFirstOrThrow();
    await h.db.insertInto("cw_prices").values({ format_id: format.id, profile: "visitor", amount: 12_000 }).execute();
    await h.db.insertInto("cw_plans").values({ centre_id: centreId, name: "Résident", period: "month", price: 250_000, billing: "upfront" }).execute();
    await h.db
      .insertInto("cw_pack_products")
      .values({ centre_id: centreId, name: "Carnet 10 demi-journées", type_id: type.id, quota_kind: "bookings", quota: 10, validity_days: 90, price: 100_000 })
      .execute();
    await h.db.insertInto("cw_closures").values({ centre_id: centreId, starts_on: "2099-08-13", ends_on: "2099-08-13", label: "Fête de la femme" }).execute();
    const now = Date.now();
    await h.db
      .insertInto("cw_bookings")
      .values({
        centre_id: centreId,
        kind: "block",
        resource_id: resources[0]!.id,
        starts_at: new Date(now - 60_000),
        ends_at: new Date(now + 60_000),
        blocked_until: new Date(now + 60_000),
        status: "confirmed",
        source: "staff",
        notes: "Maintenance",
      })
      .execute();

    ids.spaces = (await h.call("POST", "/api/site/pages", editor, { title: "Espaces", slug: "espaces", showInFooter: true })).body.id;
    const sections = [
      { id: "espaces", type: "spaces", title: "Nos espaces" },
      { id: "tarifs", type: "pricing", title: "Tarifs" },
      { id: "dispo", type: "availability", title: "Disponibilités" },
      { id: "contact", type: "contact", title: "Nous trouver", showMap: true },
      { id: "cta", type: "cta", title: "Prêt ?", button: { label: "Réserver un poste", target: { kind: "booking" } } },
    ];
    await saveDraft(ids.spaces, "fr", "Espaces", sections);
    await saveDraft(ids.spaces, "en", "Spaces", sections);
    await h.call("POST", `/api/site/pages/${ids.spaces}/publish`, editor);

    const res = await h.getPublic("/espaces");
    expect(res.status).toBe(200);
    expect(res.body).toContain("Open space Jasmin");
    expect(res.body).not.toContain("Salle cachée");
    expect(res.body).toContain("Postes en lumière naturelle");
    expect(res.body).toContain("1 à 3 personnes");
    expect(res.body).toContain("À partir de 12,000&nbsp;TND");
    expect(res.body).toContain("Résident");
    expect(res.body).toContain("250,000&nbsp;TND");
    expect(res.body).toContain("Carnet 10 demi-journées");
    expect(res.body).toMatch(/<th scope="row">Open space Jasmin<\/th><td class="num">2<\/td><td class="num">2<\/td>/);
    expect(res.body).toContain("Fête de la femme");
    expect(res.body).toContain('href="https://maps.example/x"');
    expect(res.body).toContain('<a class="btn btn-primary" href="/espace/">Réserver</a>');
    expect(res.body).toContain('href="/espace/">Réserver un poste</a>');
    expect(res.body).toContain(`src="/media/${ids.media}"`);

    const en = await h.getPublic("/en/espaces");
    expect(en.body).toContain("From 12.000&nbsp;TND");
    expect(en.body).toContain("Free now");

    await h.setModules(["training", "website"]);
    const off = await h.getPublic("/espaces");
    expect(off.status).toBe(200);
    expect(off.body).not.toContain("Open space Jasmin");
    expect(off.body).not.toContain("Disponibilités");
    expect(off.body).not.toContain("/espace/");
    expect(off.body).toContain("Nous trouver");
    expect(off.body).not.toContain("Fête de la femme");
    await h.setModules(["training", "coworking", "website"]);
  });
});

describe("visitor requests", () => {
  it("renders the lead form and stores JSON and form-encoded requests", async () => {
    ids.contact = (await h.call("POST", "/api/site/pages", editor, { title: "Contact", slug: "contact" })).body.id;
    const form = [{ id: "demande", type: "form", title: "Demander une visite", variant: "visit" }];
    await saveDraft(ids.contact, "fr", "Contact", form);
    await saveDraft(ids.contact, "en", "Contact", form);
    await h.call("POST", `/api/site/pages/${ids.contact}/publish`, editor);
    const page = await h.getPublic("/contact");
    expect(page.body).toContain('<form class="lead-form" method="post" action="/api/public/leads">');
    expect(page.body).toContain('name="preferredDate"');
    expect(page.body).toContain('name="website"');

    const json = await h.callPublic("POST", "/api/public/leads", undefined, {
      kind: "visit",
      name: "Sami Ben Ali",
      email: "Sami@Example.tn",
      preferredDate: "2026-11-02",
      language: "fr",
      page: "/contact",
    });
    expect(json.status).toBe(201);

    const encoded = new URLSearchParams({
      kind: "visit",
      name: "Leila",
      phone: "22 333 444",
      language: "fr",
      page: "/contact",
      section: "demande",
      website: "",
    });
    const formPost = await h.app.inject({
      method: "POST",
      url: "/api/public/leads",
      headers: { host: new URL(PUBLIC_ORIGIN).host, origin: PUBLIC_ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      payload: encoded.toString(),
    });
    expect(formPost.statusCode).toBe(303);
    expect(formPost.headers.location).toBe("/contact?envoye=1#demande");
    const thanks = await h.getPublic("/contact?envoye=1");
    expect(thanks.body).toContain("votre demande a bien été envoyée");

    const invalid = await h.app.inject({
      method: "POST",
      url: "/api/public/leads",
      headers: { host: new URL(PUBLIC_ORIGIN).host, origin: PUBLIC_ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ kind: "visit", name: "Sans contact", language: "fr", page: "/contact", section: "demande" }).toString(),
    });
    expect(invalid.headers.location).toBe("/contact?erreur=1#demande");
    const noContact = await h.callPublic("POST", "/api/public/leads", undefined, { kind: "contact", name: "X", language: "fr" });
    expect(noContact.body.code).toBe("contact_required");

    const bot = await h.callPublic("POST", "/api/public/leads", undefined, {
      kind: "contact",
      name: "Bot",
      email: "bot@spam.example",
      language: "en",
      website: "https://spam.example",
    });
    expect(bot.status).toBe(201);
    const wrongOrigin = await h.app.inject({
      method: "POST",
      url: "/api/public/leads",
      headers: { host: new URL(PUBLIC_ORIGIN).host, origin: "https://evil.example" },
      payload: { kind: "contact", name: "X", email: "x@x.tn", language: "fr" },
    });
    expect(wrongOrigin.statusCode).toBe(403);

    const stored = await h.db.selectFrom("site_leads").select(["name", "email", "phone", "preferred_date", "kind"]).orderBy("created_at").execute();
    expect(stored).toEqual([
      { name: "Sami Ben Ali", email: "sami@example.tn", phone: null, preferred_date: "2026-11-02", kind: "visit" },
      { name: "Leila", email: null, phone: "22 333 444", preferred_date: null, kind: "visit" },
    ]);
  });

  it("lets the secretariat handle the leads, and nothing else of the website", async () => {
    const list = await h.call("GET", "/api/site/leads?status=new&kind=visit", secretariat);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(2);
    const handled = await h.call("PATCH", `/api/site/leads/${list.body.items[0].id}`, secretariat, { status: "handled" });
    expect(handled.body.status).toBe("handled");
    const spam = await h.call("PATCH", `/api/site/leads/${list.body.items[1].id}`, secretariat, { status: "spam" });
    expect(spam.body.status).toBe("spam");
    expect((await h.call("GET", "/api/site/leads?status=new", secretariat)).body.items).toHaveLength(0);
    expect((await h.call("GET", "/api/site/pages", secretariat)).status).toBe(403);
    expect((await h.call("POST", `/api/site/pages/${ids.home}/publish`, secretariat)).status).toBe(403);
  });
});

describe("permissions and module gating", () => {
  it("lets the editor edit and publish but not read payments", async () => {
    expect((await h.call("GET", "/api/site/pages", editor)).status).toBe(200);
    expect((await h.call("GET", "/api/site/leads", editor)).status).toBe(200);
    expect((await h.call("GET", "/api/payments", editor)).status).toBe(403);
  });

  it("closes the website routes and pages when the module is off, sending visitors to the portal", async () => {
    await h.setModules(["training", "coworking"]);
    const editorOff = await h.login("editor@site.tn");
    expect((await h.call("GET", "/api/site/pages", editorOff)).status).toBe(403);
    const home = await h.getPublic("/");
    expect(home.status).toBe(302);
    expect(home.headers.location).toBe("/espace/");
    expect((await h.getPublic("/tarifs")).status).toBe(404);
    expect((await h.getPublic("/robots.txt")).body).toContain("Disallow: /");
    const lead = await h.callPublic("POST", "/api/public/leads", undefined, { kind: "contact", name: "X", email: "x@x.tn", language: "fr" });
    expect(lead.status).toBe(404);
    expect((await h.getPublic("/espace/")).status).toBe(404);
  });
});

describe("client portal files", () => {
  it("serves the built portal under /espace/ without escaping its directory", async () => {
    await h.setModules(["coworking", "website"]);
    const dir = await mkdtemp(path.join(tmpdir(), "gcf-portal-"));
    await mkdir(path.join(dir, "assets"));
    await writeFile(path.join(dir, "index.html"), "<!doctype html><title>Portail</title>");
    await writeFile(path.join(dir, "assets", "app-abc.js"), "console.log(1)");
    await writeFile(path.join(path.dirname(dir), "secret.txt"), "secret");
    const app = await buildApp({ config: { ...h.app.config, portalDistDir: dir }, db: h.db, rateLimit: false, mailer: null });
    const get = (url: string) => app.inject({ method: "GET", url, headers: { host: new URL(PUBLIC_ORIGIN).host } });
    try {
      expect((await get("/espace")).headers.location).toBe("/espace/");
      const index = await get("/espace/reservations/nouvelle");
      expect(index.statusCode).toBe(200);
      expect(index.headers["cache-control"]).toBe("no-cache");
      expect(index.body).toContain("Portail");
      const asset = await get("/espace/assets/app-abc.js");
      expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
      expect(asset.headers["content-type"]).toBe("text/javascript; charset=utf-8");
      expect((await get("/espace/assets/missing.js")).statusCode).toBe(404);
      for (const url of ["/espace/../secret.txt", "/espace/%2e%2e/secret.txt", "/espace/..%2fsecret.txt", "/espace/assets/..%2f..%2fsecret.txt"]) {
        const res = await get(url);
        expect(res.body, url).not.toContain("secret");
      }
      await h.setModules(["website"]);
      expect((await get("/espace/")).statusCode).toBe(404);
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
      await rm(path.join(path.dirname(dir), "secret.txt"), { force: true });
    }
  });
});
