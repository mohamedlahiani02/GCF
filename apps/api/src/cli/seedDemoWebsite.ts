/**
 * Website part of the demonstration dataset: identity and theme in French and English, a few illustrations
 * generated here (no external files), a home page, an offers page, a contact page and two articles built from the
 * typed sections, published versions, one scheduled publication, a manual and an automatic redirect, and visitor
 * requests sent through the public form endpoint.
 */
import { deflateSync, crc32 } from "node:zlib";
import { addDays, type SiteSection } from "@gcf/shared";
import type { Kysely } from "kysely";
import type { Database } from "../db/types.js";
import type { Call } from "./seedDemo.js";

interface Context {
  call: Call;
  /** Posts to the public API as a visitor of the site; null when PUBLIC_ORIGIN is not configured. */
  publicCall: Call | null;
  db: Kysely<Database>;
  centreId: string;
  today: string;
  coworking: boolean;
}

type Rgb = [number, number, number];

export async function seedWebsite({ call, publicCall, db, centreId, today, coworking }: Context): Promise<void> {
  const existing = await db.selectFrom("site_pages").select("id").where("centre_id", "=", centreId).executeTakeFirst();
  if (existing) throw new Error("this centre already has website pages: demonstration data only goes into an empty website");

  const upload = async (alt: string, width: number, height: number, from: Rgb, to: Rgb) =>
    (await call("POST", "/media", { image: `data:image/png;base64,${gradientPng(width, height, from, to).toString("base64")}`, alt, folder: "site" })).id;
  const images = {
    hero: await upload("Open space lumineux du centre", 1600, 900, [29, 78, 216], [15, 118, 110]),
    meeting: await upload("Salle de réunion équipée", 1200, 800, [15, 118, 110], [224, 242, 254]),
    terrace: await upload("Espace détente et cuisine", 1200, 800, [180, 83, 9], [254, 243, 199]),
    logo: await upload("Logo du centre", 256, 256, [29, 78, 216], [29, 78, 216]),
  };

  await call("PUT", "/site/settings", {
    theme: "corporate",
    primaryColor: "#1d4ed8",
    secondaryColor: "#0f766e",
    font: "inter",
    radius: "small",
    colorScheme: "light",
    logoMediaId: images.logo,
    faviconMediaId: images.logo,
    languages: ["fr", "en"],
    defaultLanguage: "fr",
    siteName: "Centre Avenir",
    tagline: "Formation et coworking au cœur de Tunis",
    contactEmail: "contact@centre-avenir.example.com",
    contactPhone: "71 234 567",
    address: "12, rue de Carthage, 1000 Tunis",
    mapUrl: "https://www.openstreetmap.org/?mlat=36.8008&mlon=10.1800#map=17/36.8008/10.1800",
    facebookUrl: "https://www.facebook.com/centre.avenir.example",
    linkedinUrl: "https://www.linkedin.com/company/centre-avenir-example",
    seoDescription: "Postes en open space, salles de réunion, bureaux privés et domiciliation à Tunis.",
    footerText: "Centre Avenir, formation professionnelle et espace de coworking.",
  });

  const page = async (body: Record<string, unknown>) => (await call("POST", "/site/pages", body)).id;
  const pages = {
    home: await page({ title: "Accueil", slug: "accueil", showInMenu: true }),
    offers: await page({ title: "Nos offres", slug: "nos-offres", showInMenu: true, showInFooter: true }),
    contact: await page({ title: "Contact", slug: "contact", showInMenu: true, showInFooter: true }),
    opening: await page({ kind: "article", title: "Ouverture de l'espace", slug: "ouverture", articleDate: addDays(today, -20) }),
    event: await page({ kind: "article", title: "Petit-déjeuner des membres", slug: "petit-dejeuner", articleDate: today }),
  };
  await call("POST", `/site/pages/${pages.home}/home`);

  const paragraph = (text: string) => ({ type: "paragraph" as const, content: [{ text }] });
  const draft = (
    id: string,
    language: "fr" | "en",
    body: { title: string; menuLabel?: string; seoTitle?: string; seoDescription?: string; sections: SiteSection[] },
  ) => call("PUT", `/site/pages/${id}/drafts/${language}`, body);

  const resourceTypes = coworking ? await call<{ id: string; category: string }[]>("GET", "/coworking/resource-types") : [];
  const deskType = resourceTypes.find((t) => t.category === "hot_desk");

  await draft(pages.home, "fr", {
    title: "Accueil",
    seoTitle: "Coworking et formation à Tunis",
    seoDescription: "Réservez un poste, une salle de réunion ou un bureau privé au Centre Avenir.",
    sections: [
      {
        id: "bienvenue",
        type: "hero",
        title: "Travaillez au cœur de Tunis",
        subtitle: "Postes en open space, salles de réunion et bureaux privés, réservables en ligne.",
        imageId: images.hero,
        button: { label: "Réserver un poste", target: { kind: "booking" } },
      },
      {
        id: "atouts",
        type: "features",
        title: "Tout est compris",
        items: [
          { icon: "wifi", title: "Fibre très haut débit", text: "Connexion stable et réseau invité séparé." },
          { icon: "coffee", title: "Café et thé à volonté", text: "Une cuisine équipée ouverte à tous les membres." },
          { icon: "printer", title: "Impression", text: "Imprimante et scanner en libre-service." },
          { icon: "clock", title: "Horaires étendus", text: "Ouvert tous les jours, en soirée aux tarifs heures creuses." },
        ],
      },
      ...(coworking
        ? [
            { id: "espaces", type: "spaces" as const, title: "Nos espaces" },
            { id: "disponibilites", type: "availability" as const, title: "Disponible maintenant" },
          ]
        : []),
      {
        id: "galerie",
        type: "gallery",
        title: "Le lieu",
        items: [
          { imageId: images.meeting, caption: "Salle Kairouan, jusqu'à 10 personnes" },
          { imageId: images.terrace, caption: "L'espace détente" },
        ],
      },
      {
        id: "temoignages",
        type: "testimonials",
        title: "Ils travaillent ici",
        items: [
          { quote: "Un cadre calme et une équipe toujours disponible.", author: "Meriem J.", role: "Développeuse, Atlas Digital" },
          { quote: "La domiciliation et le courrier sont gérés sans souci.", author: "Anis K.", role: "Consultant, Medina Conseil" },
        ],
      },
      { id: "actualites", type: "articles", title: "Actualités", limit: 3 },
      {
        id: "visite",
        type: "cta",
        title: "Envie de visiter ?",
        text: "Passez nous voir ou demandez une visite guidée.",
        button: { label: "Nous contacter", target: { kind: "page", pageId: pages.contact } },
      },
    ],
  });
  await draft(pages.home, "en", {
    title: "Home",
    seoTitle: "Coworking and training in Tunis",
    seoDescription: "Book a desk, a meeting room or a private office at Centre Avenir.",
    sections: [
      {
        id: "bienvenue",
        type: "hero",
        title: "Work in the heart of Tunis",
        subtitle: "Open-space desks, meeting rooms and private offices, bookable online.",
        imageId: images.hero,
        button: { label: "Book a desk", target: { kind: "booking" } },
      },
      {
        id: "atouts",
        type: "features",
        title: "Everything included",
        items: [
          { icon: "wifi", title: "High-speed fibre", text: "A stable connection and a separate guest network." },
          { icon: "coffee", title: "Free coffee and tea", text: "A fitted kitchen open to every member." },
          { icon: "printer", title: "Printing", text: "Self-service printer and scanner." },
          { icon: "clock", title: "Long opening hours", text: "Open every day, with off-peak prices in the evening." },
        ],
      },
      ...(coworking
        ? [
            { id: "espaces", type: "spaces" as const, title: "Our spaces" },
            { id: "disponibilites", type: "availability" as const, title: "Available now" },
          ]
        : []),
      {
        id: "galerie",
        type: "gallery",
        title: "The place",
        items: [
          { imageId: images.meeting, caption: "Kairouan room, up to 10 people" },
          { imageId: images.terrace, caption: "The lounge" },
        ],
      },
      {
        id: "temoignages",
        type: "testimonials",
        title: "They work here",
        items: [
          { quote: "A quiet place and a team that is always there to help.", author: "Meriem J.", role: "Developer, Atlas Digital" },
          { quote: "Registered address and mail handled without a hitch.", author: "Anis K.", role: "Consultant, Medina Conseil" },
        ],
      },
      { id: "actualites", type: "articles", title: "News", limit: 3 },
      {
        id: "visite",
        type: "cta",
        title: "Want to visit?",
        text: "Drop by or ask for a guided tour.",
        button: { label: "Contact us", target: { kind: "page", pageId: pages.contact } },
      },
    ],
  });

  const offers = (language: "fr" | "en"): SiteSection[] => {
    const fr = language === "fr";
    return [
      {
        id: "offres",
        type: "rich_text",
        title: fr ? "Des formules pour chaque usage" : "Plans for every need",
        body: [
          paragraph(
            fr
              ? "Venez à l'heure, à la demi-journée ou à la journée, ou devenez résident avec un abonnement mensuel ou annuel."
              : "Come by the hour, the half day or the day, or become a resident with a monthly or yearly plan.",
          ),
          {
            type: "list",
            ordered: false,
            items: fr
              ? [
                  [{ text: "Open space dès 5 TND de l'heure" }],
                  [{ text: "Salles de réunion de 6 à 10 personnes" }],
                  [{ text: "Bureaux privés et domiciliation" }],
                ]
              : [
                  [{ text: "Open space from 5 TND per hour" }],
                  [{ text: "Meeting rooms for 6 to 10 people" }],
                  [{ text: "Private offices and registered address" }],
                ],
          },
        ],
      },
      ...(coworking ? [{ id: "tarifs", type: "pricing" as const, title: fr ? "Tarifs" : "Prices", ...(deskType ? { typeId: deskType.id } : {}) }] : []),
      {
        id: "questions",
        type: "faq",
        title: fr ? "Questions fréquentes" : "Frequently asked questions",
        items: fr
          ? [
              { question: "Comment réserver ?", answer: "Créez votre compte dans l'espace client, choisissez un créneau et une place sur le plan." },
              { question: "Comment payer ?", answer: "Le règlement se fait à l'accueil, en espèces, par carte, chèque ou virement." },
              { question: "Puis-je annuler ?", answer: "L'annulation est gratuite jusqu'à 24 heures avant le début ; au-delà, la moitié du montant est due." },
            ]
          : [
              { question: "How do I book?", answer: "Create your account in the client area, then choose a time slot and a place on the floor plan." },
              { question: "How do I pay?", answer: "Payment is made at the front desk, in cash, by card, cheque or bank transfer." },
              { question: "Can I cancel?", answer: "Cancelling is free up to 24 hours before the start; after that, half of the price is due." },
            ],
      },
      {
        id: "devis",
        type: "form",
        title: fr ? "Une demande pour votre équipe ?" : "A request for your team?",
        intro: fr ? "Décrivez votre besoin, nous vous répondons sous 24 heures." : "Tell us what you need and we will answer within 24 hours.",
        variant: "quote",
      },
    ];
  };
  await draft(pages.offers, "fr", { title: "Nos offres", sections: offers("fr") });
  await draft(pages.offers, "en", { title: "Our plans", menuLabel: "Plans", sections: offers("en") });

  const contact = (language: "fr" | "en"): SiteSection[] => [
    { id: "coordonnees", type: "contact", title: language === "fr" ? "Nous trouver" : "Find us", showMap: true },
    {
      id: "visite",
      type: "form",
      title: language === "fr" ? "Demander une visite" : "Book a visit",
      variant: "visit",
      submitLabel: language === "fr" ? "Envoyer la demande" : "Send the request",
    },
  ];
  await draft(pages.contact, "fr", { title: "Contact", sections: contact("fr") });
  await draft(pages.contact, "en", { title: "Contact", sections: contact("en") });

  const article = (title: string, text: string, imageId: string): { title: string; sections: SiteSection[] } => ({
    title,
    sections: [
      { id: "article", type: "rich_text", body: [paragraph(text)] },
      { id: "photos", type: "gallery", items: [{ imageId }] },
    ],
  });
  await draft(
    pages.opening,
    "fr",
    article("Ouverture de l'espace", "Notre espace de coworking ouvre ses portes avec 8 postes, 2 salles de réunion et 2 bureaux privés.", images.hero),
  );
  await draft(pages.opening, "en", article("Our space opens", "Our coworking space opens with 8 desks, 2 meeting rooms and 2 private offices.", images.hero));
  await draft(
    pages.event,
    "fr",
    article("Petit-déjeuner des membres", "Rendez-vous le premier vendredi du mois pour rencontrer les autres membres autour d'un café.", images.terrace),
  );
  await draft(
    pages.event,
    "en",
    article("Members' breakfast", "Join us on the first Friday of the month to meet the other members over coffee.", images.terrace),
  );

  for (const id of [pages.home, pages.offers, pages.contact, pages.opening]) await call("POST", `/site/pages/${id}/publish`, {});
  await call("POST", `/site/pages/${pages.event}/publish`, { at: new Date(Date.now() + 3 * 24 * 3_600_000).toISOString() });

  // A page that moves keeps its old address through an automatic redirect; the manual one covers an old site.
  await call("PATCH", `/site/pages/${pages.offers}`, { slug: "offres" });
  await call("POST", "/site/redirects", { fromPath: "/tarifs", toPath: "/offres" });
  await call("PUT", "/site/settings", { online: true });

  if (publicCall) {
    await publicCall("POST", "/public/leads", {
      kind: "visit",
      name: "Yassine Gharbi",
      email: "yassine.gharbi@example.com",
      phone: "23 778 410",
      message: "Je souhaite visiter l'espace avec mon associé.",
      preferredDate: addDays(today, 2),
      language: "fr",
      page: "/contact",
      section: "visite",
    });
    await publicCall("POST", "/public/leads", {
      kind: "quote",
      name: "Sarah Miller",
      email: "sarah.miller@example.com",
      company: "Northwind",
      message: "We need four desks for three months from next month.",
      language: "en",
      page: "/en/offres",
      section: "devis",
    });
  }
}

/** A horizontal gradient as a PNG file (8-bit RGB, no interlacing), small enough to stay well under the upload limit. */
function gradientPng(width: number, height: number, from: Rgb, to: Rgb): Buffer {
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) {
    const t = width === 1 ? 0 : x / (width - 1);
    for (let c = 0; c < 3; c++) row[1 + x * 3 + c] = Math.round(from[c]! + (to[c]! - from[c]!) * t);
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const chunk = (kind: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(kind, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(2, 9);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
