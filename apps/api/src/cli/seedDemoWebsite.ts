/**
 * Website part of the demonstration dataset: identity and theme in French and English, the logo and the interior
 * illustrations of `demo-media/` (drawn for the demonstration, to be replaced by the centre's own photos), a home
 * page, an offers page, a photo gallery page with three albums, a contact page and two articles built from the typed
 * sections, photos on the coworking space types, published versions, one scheduled publication, a manual and an
 * automatic redirect, and visitor requests sent through the public form endpoint.
 */
import { readFile } from "node:fs/promises";
import { addDays, type CwCategory, type SiteSection } from "@gcf/shared";
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

const DEMO_MEDIA = new URL("../../demo-media/", import.meta.url);

/** Illustration shown on the public cards of each coworking category. */
const CATEGORY_PHOTO: Record<CwCategory, keyof typeof ILLUSTRATIONS> = {
  hot_desk: "openSpace",
  dedicated_desk: "openSpace",
  private_office: "office",
  meeting_room: "meeting",
  phone_booth: "booth",
  event_space: "events",
};

const ILLUSTRATIONS = {
  openSpace: { file: "open-space.jpg", alt: "Open space lumineux avec trois postes de travail" },
  meeting: { file: "meeting.jpg", alt: "Salle de réunion avec écran et grande table" },
  booth: { file: "booth.jpg", alt: "Cabine téléphonique insonorisée" },
  office: { file: "office.jpg", alt: "Bureau privé avec bibliothèque" },
  lounge: { file: "lounge.jpg", alt: "Espace détente avec canapé" },
  events: { file: "events.jpg", alt: "Espace événement avec rangées de chaises face à l'écran" },
  terrace: { file: "terrace.jpg", alt: "Terrasse avec vue sur la ville" },
  training: { file: "training.jpg", alt: "Salle de formation avec tableau et postes" },
  reception: { file: "reception.jpg", alt: "Accueil du centre" },
} as const;

export async function seedWebsite({ call, publicCall, db, centreId, today, coworking }: Context): Promise<void> {
  const existing = await db.selectFrom("site_pages").select("id").where("centre_id", "=", centreId).executeTakeFirst();
  if (existing) throw new Error("this centre already has website pages: demonstration data only goes into an empty website");

  const upload = async (file: string, alt: string, folder: string) => {
    const bytes = await readFile(new URL(file, DEMO_MEDIA));
    const mime = file.endsWith(".png") ? "image/png" : "image/jpeg";
    return (await call<{ id: string }>("POST", "/media", { image: `data:${mime};base64,${bytes.toString("base64")}`, alt, folder })).id;
  };
  const images = {} as Record<keyof typeof ILLUSTRATIONS, string>;
  for (const [key, { file, alt }] of Object.entries(ILLUSTRATIONS) as [keyof typeof ILLUSTRATIONS, (typeof ILLUSTRATIONS)[keyof typeof ILLUSTRATIONS]][])
    images[key] = await upload(file, alt, "site");
  const logo = await upload("logo.png", "Centre Avenir", "identite");
  const favicon = await upload("logo-mark.png", "Monogramme du Centre Avenir", "identite");

  await call("PUT", "/site/settings", {
    theme: "corporate",
    primaryColor: "#1d4ed8",
    secondaryColor: "#0f766e",
    font: "inter",
    radius: "small",
    colorScheme: "light",
    logoMediaId: logo,
    faviconMediaId: favicon,
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
    gallery: await page({ title: "Galerie", slug: "galerie", showInMenu: true, showInFooter: true }),
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
  for (const type of resourceTypes)
    await call("PATCH", `/coworking/resource-types/${type.id}`, { photoMediaId: images[CATEGORY_PHOTO[type.category as CwCategory]] });

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
        imageId: images.openSpace,
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
        intro: "Un aperçu du centre ; toutes les photos sont sur la page Galerie.",
        layout: "mosaic",
        items: [
          { imageId: images.openSpace, caption: "L'open space" },
          { imageId: images.meeting, caption: "Salle Kairouan, jusqu'à 10 personnes" },
          { imageId: images.lounge, caption: "L'espace détente" },
          { imageId: images.terrace, caption: "La terrasse" },
          { imageId: images.booth, caption: "Les cabines téléphoniques" },
          { imageId: images.office, caption: "Un bureau privé" },
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
        imageId: images.openSpace,
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
        intro: "A glimpse of the centre; every photo is on the Gallery page.",
        layout: "mosaic",
        items: [
          { imageId: images.openSpace, caption: "The open space" },
          { imageId: images.meeting, caption: "Kairouan room, up to 10 people" },
          { imageId: images.lounge, caption: "The lounge" },
          { imageId: images.terrace, caption: "The terrace" },
          { imageId: images.booth, caption: "The phone booths" },
          { imageId: images.office, caption: "A private office" },
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

  const albums = (language: "fr" | "en"): SiteSection[] => {
    const fr = language === "fr";
    return [
      {
        id: "espaces-de-travail",
        type: "gallery",
        title: fr ? "Les espaces de travail" : "Workspaces",
        intro: fr ? "Open space, salles de réunion, cabines et bureaux privés." : "Open space, meeting rooms, booths and private offices.",
        layout: "grid",
        items: [
          { imageId: images.openSpace, caption: fr ? "L'open space" : "The open space" },
          { imageId: images.meeting, caption: fr ? "Salle Kairouan" : "Kairouan room" },
          { imageId: images.booth, caption: fr ? "Cabine téléphonique" : "Phone booth" },
          { imageId: images.office, caption: fr ? "Bureau privé" : "Private office" },
          { imageId: images.reception, caption: fr ? "L'accueil" : "The front desk" },
        ],
      },
      {
        id: "detente",
        type: "gallery",
        title: fr ? "Se détendre" : "Taking a break",
        layout: "carousel",
        items: [
          { imageId: images.lounge, caption: fr ? "Le salon" : "The lounge" },
          { imageId: images.terrace, caption: fr ? "La terrasse" : "The terrace" },
          { imageId: images.reception, caption: fr ? "Café à l'accueil" : "Coffee at the front desk" },
        ],
      },
      {
        id: "evenements",
        type: "gallery",
        title: fr ? "Événements et formations" : "Events and training",
        layout: "mosaic",
        items: [
          { imageId: images.events, caption: fr ? "Conférence des membres" : "Members' talk" },
          { imageId: images.training, caption: fr ? "Salle de formation" : "Training room" },
          { imageId: images.meeting, caption: fr ? "Atelier en petit groupe" : "Small-group workshop" },
        ],
      },
    ];
  };
  await draft(pages.gallery, "fr", {
    title: "Galerie",
    seoDescription: "Les photos du Centre Avenir : espaces de travail, détente, événements.",
    sections: albums("fr"),
  });
  await draft(pages.gallery, "en", {
    title: "Gallery",
    seoDescription: "Photos of Centre Avenir: workspaces, lounge and events.",
    sections: albums("en"),
  });

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
    article("Ouverture de l'espace", "Notre espace de coworking ouvre ses portes avec 8 postes, 2 salles de réunion et 2 bureaux privés.", images.openSpace),
  );
  await draft(
    pages.opening,
    "en",
    article("Our space opens", "Our coworking space opens with 8 desks, 2 meeting rooms and 2 private offices.", images.openSpace),
  );
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

  for (const id of [pages.home, pages.offers, pages.gallery, pages.contact, pages.opening]) await call("POST", `/site/pages/${id}/publish`, {});
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
