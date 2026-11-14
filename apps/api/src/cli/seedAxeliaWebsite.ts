import { readFile } from "node:fs/promises";
import { addDays, type SiteSection } from "@gcf/shared";
import type { Kysely } from "kysely";
import type { Database } from "../db/types.js";
import type { Call } from "./seedDemo.js";

interface Context {
  call: Call;
  publicCall: Call | null;
  db: Kysely<Database>;
  centreId: string;
  today: string;
  coworking: boolean;
}

const MEDIA = new URL("../../demo-media/axelia/", import.meta.url);
const PHOTOS = {
  openSpace: ["open-space.jpg", "Open space lumineux et postes de travail"],
  desk: ["individual-desk.jpg", "Poste de travail individuel près des fenêtres"],
  centre: ["centre.jpg", "Vue d’ensemble d’un espace de travail partagé"],
  shared: ["shared-workspace.jpg", "Espaces de travail partagés avec cloisons vitrées"],
  community: ["community.jpg", "Personnes travaillant autour de grandes tables"],
  workshop: ["workshop.jpg", "Ambiance de travail dans un espace partagé"],
  portrait: ["community-portrait.jpg", "Détail d’une table de coworking"],
} as const;

/** AXELIA's demonstration website, using the photographs supplied for this demonstration. */
export async function seedAxeliaWebsite({ call, publicCall, db, centreId, today }: Context): Promise<void> {
  const existing = await db.selectFrom("site_pages").select("id").where("centre_id", "=", centreId).executeTakeFirst();
  if (existing) throw new Error("the AXELIA website requires a centre without website pages");

  const upload = async (file: string, alt: string, folder: string) => {
    const bytes = await readFile(new URL(file, MEDIA));
    const mime = file.endsWith(".png") ? "image/png" : "image/jpeg";
    return (await call("POST", "/media", { image: `data:${mime};base64,${bytes.toString("base64")}`, alt, folder })).id;
  };
  const images = {} as Record<keyof typeof PHOTOS, string>;
  for (const [key, [file, alt]] of Object.entries(PHOTOS) as [keyof typeof PHOTOS, (typeof PHOTOS)[keyof typeof PHOTOS]][]) {
    images[key] = await upload(file, alt, "axelia/espaces");
  }
  const logo = await upload("symbol.png", "AXELIA", "axelia/identite");
  await upload("symbol-inverse.png", "Symbole AXELIA sur fond bleu nuit", "axelia/identite");
  await call("PUT", "/site/settings", {
    theme: "corporate",
    primaryColor: "#0E1A36",
    secondaryColor: "#243F63",
    font: "inter",
    radius: "small",
    colorScheme: "light",
    logoMediaId: logo,
    faviconMediaId: logo,
    languages: ["fr", "en"],
    defaultLanguage: "fr",
    siteName: "AXELIA",
    tagline: "Formation, coworking et rencontres",
    contactEmail: "contact@axelia.demo.test",
    contactPhone: "71 000 000",
    address: "Tunis — centre de démonstration AXELIA",
    mapUrl: "https://www.openstreetmap.org/?mlat=36.8008&mlon=10.1800#map=15/36.8008/10.1800",
    seoDescription: "Découvrez les formations, les cours particuliers et les espaces de coworking AXELIA. Réservez votre place en ligne.",
    footerText: "AXELIA · Centre de démonstration · Formation, coworking et café",
  });

  const page = async (title: string, slug: string, extra: Record<string, unknown> = {}) =>
    (await call("POST", "/site/pages", { title, slug, showInMenu: true, ...extra })).id;
  const pages = {
    home: await page("Accueil", "accueil"),
    training: await page("Formations et cours", "formations-cours", { showInFooter: true }),
    coworking: await page("Coworking", "coworking", { showInFooter: true }),
    centre: await page("Le centre", "le-centre", { showInFooter: true }),
    contact: await page("Contact", "contact", { showInFooter: true }),
  };
  const gallery = await page("Galerie", "galerie", { parentId: pages.centre });
  const cafe = await page("Café", "cafe", { parentId: pages.centre });
  const article = await page("Bien choisir son espace de travail", "choisir-son-espace", {
    kind: "article",
    showInMenu: false,
    articleDate: addDays(today, -3),
  });
  const scheduled = await page("Atelier découverte de l’IA", "atelier-ia", {
    kind: "article",
    showInMenu: false,
    articleDate: addDays(today, 3),
  });
  await call("POST", `/site/pages/${pages.home}/home`);

  const paragraph = (text: string) => ({ type: "paragraph" as const, content: [{ text }] });
  const content = (title: string, text: string, id = "presentation"): SiteSection => ({ type: "rich_text", id, title, body: [paragraph(text)] });
  const form = (title: string, variant: "visit" | "quote" | "contact"): SiteSection => ({ id: "demande", type: "form", title, variant });
  const publish = async (id: string, frTitle: string, enTitle: string, fr: SiteSection[], en: SiteSection[], at?: string) => {
    for (const [language, title, sections] of [
      ["fr", frTitle, fr],
      ["en", enTitle, en],
    ] as const) {
      await call("PUT", `/site/pages/${id}/drafts/${language}`, { title, menuLabel: title, sections });
    }
    await call("POST", `/site/pages/${id}/publish`, at ? { at } : {});
  };

  const home = (en: boolean): SiteSection[] => [
    {
      id: "bienvenue",
      type: "hero",
      imageId: images.openSpace,
      title: en ? "AXELIA. Learn, work and move forward." : "AXELIA. Un lieu pour apprendre, travailler et avancer.",
      subtitle: en
        ? "Courses, shared workspaces and a place to meet. Find the space that fits your day."
        : "Des formations, des espaces de travail et un lieu de rencontre. Trouvez votre place pour la journée.",
      button: { label: en ? "Book a workspace" : "Réserver un espace", target: { kind: "booking" } },
    },
    {
      id: "activites",
      type: "features",
      title: en ? "Your day at AXELIA" : "Votre journée chez AXELIA",
      items: [
        {
          icon: "calendar",
          title: en ? "Training and private lessons" : "Formations et cours particuliers",
          text: en ? "Small groups, regular sessions and clear learning paths." : "Des groupes à taille humaine, des séances régulières et un parcours suivi.",
        },
        {
          icon: "wifi",
          title: "Coworking",
          text: en ? "Choose your workspace on the floor plan and book your time." : "Choisissez votre place sur le plan et réservez votre créneau.",
        },
        {
          icon: "meeting",
          title: en ? "Meetings and workshops" : "Réunions et ateliers",
          text: en ? "Bring your team together in a suitable space." : "Réunissez votre équipe dans un espace adapté.",
        },
        {
          icon: "coffee",
          title: en ? "Coffee breaks" : "Pause café",
          text: en ? "A counter for a drink and a break during the day." : "Un comptoir pour une boisson et une pause dans la journée.",
        },
      ],
    },
    { id: "espaces", type: "spaces", title: en ? "Find your workspace" : "Choisissez votre espace" },
    { id: "disponibilites", type: "availability", title: en ? "Workspace availability" : "Disponibilités des espaces" },
    {
      id: "lieu",
      type: "gallery",
      title: en ? "Inside AXELIA" : "Découvrez le lieu",
      layout: "mosaic",
      items: [{ imageId: images.desk }, { imageId: images.centre }, { imageId: images.shared }, { imageId: images.community }],
    },
    { id: "actualites", type: "articles", title: en ? "News and workshops" : "Actualités et ateliers", limit: 3 },
    {
      id: "visiter",
      type: "cta",
      title: en ? "Come and meet us" : "Venez découvrir AXELIA",
      text: en ? "Ask for a visit and tell us what you need." : "Demandez une visite et présentez-nous votre projet.",
      button: { label: en ? "Arrange a visit" : "Demander une visite", target: { kind: "page", pageId: pages.contact } },
    },
  ];
  await publish(pages.home, "Accueil", "Home", home(false), home(true));

  await publish(
    pages.training,
    "Formations et cours",
    "Training and lessons",
    [
      {
        id: "apprendre",
        type: "hero",
        title: "Développez vos compétences avec AXELIA",
        subtitle: "Intelligence artificielle, cybersécurité, développement web et cours particuliers.",
        button: { label: "Demander des renseignements", target: { kind: "anchor", anchor: "demande" } },
      },
      content(
        "Formations professionnelles",
        "Intelligence artificielle, Cybersécurité et Développement web. Choisissez une formule adaptée, en paiement intégral, par tranches, au mois ou à la séance.",
      ),
      content(
        "Cours particuliers",
        "Mathématiques – Bac, Mathématiques – 3e année secondaire, Physique – Bac et Anglais – Conversation. L’accueil vous accompagne pour choisir votre groupe et votre formule.",
        "cours",
      ),
      form("Parlons de votre parcours", "quote"),
    ],
    [
      {
        id: "apprendre",
        type: "hero",
        title: "Build your skills with AXELIA",
        subtitle: "Artificial intelligence, cybersecurity, web development and private lessons.",
        button: { label: "Ask about our courses", target: { kind: "anchor", anchor: "demande" } },
      },
      content("Professional training", "Artificial intelligence, cybersecurity and web development. Ask the team about available groups and payment plans."),
      content("Private lessons", "Mathematics, physics and conversational English. The front desk helps you choose your group and schedule.", "cours"),
      form("Tell us about your learning goals", "quote"),
    ],
  );

  const coworking = (en: boolean): SiteSection[] => [
    {
      id: "travailler",
      type: "hero",
      imageId: images.desk,
      imageLayout: "split",
      title: en ? "A workspace for your day" : "Un espace pour votre journée",
      subtitle: en
        ? "A desk, a meeting room or a private office, with a clear booking schedule."
        : "Un poste, une salle de réunion ou un bureau privé, avec un créneau clairement réservé.",
      button: { label: en ? "Choose on the floor plan" : "Choisir sur le plan", target: { kind: "booking" } },
    },
    { id: "espaces", type: "spaces", title: en ? "Our workspaces" : "Nos espaces" },
    { id: "tarifs", type: "pricing", title: en ? "Plans and prices" : "Formules et tarifs" },
    { id: "disponibilites", type: "availability", title: en ? "Availability" : "Disponibilités" },
    {
      id: "questions",
      type: "faq",
      title: en ? "Before your visit" : "Avant votre visite",
      items: [
        {
          question: en ? "How do I choose a seat?" : "Comment choisir ma place ?",
          answer: en
            ? "Open the booking portal, choose a time and select a free resource on the floor plan."
            : "Ouvrez le portail, choisissez votre créneau puis sélectionnez une ressource libre sur le plan.",
        },
        {
          question: en ? "Can I book for my team?" : "Puis-je venir avec mon équipe ?",
          answer: en
            ? "Ask the front desk about meeting rooms, private offices and company accounts."
            : "L’accueil vous renseigne sur les salles de réunion, bureaux privés et comptes entreprise.",
        },
      ],
    },
  ];
  await publish(pages.coworking, "Coworking", "Coworking", coworking(false), coworking(true));

  await publish(
    pages.centre,
    "Le centre",
    "The centre",
    [
      {
        id: "centre",
        type: "hero",
        title: "Bienvenue chez AXELIA",
        subtitle: "Formation, travail partagé et rencontres dans un même lieu.",
        imageId: images.centre,
        imageLayout: "split",
      },
      content(
        "Un centre, plusieurs usages",
        "Rejoignez un cours, installez-vous pour travailler, réunissez votre équipe ou prenez une pause. L’accueil vous accompagne tout au long de votre journée.",
      ),
      { id: "galerie", type: "cta", title: "Découvrez les espaces", button: { label: "Voir la galerie", target: { kind: "page", pageId: gallery } } },
      { id: "cafe", type: "cta", title: "Une pause au café", button: { label: "Le café AXELIA", target: { kind: "page", pageId: cafe } } },
    ],
    [
      {
        id: "centre",
        type: "hero",
        title: "Welcome to AXELIA",
        subtitle: "Learning, shared work and meetings in one place.",
        imageId: images.centre,
        imageLayout: "split",
      },
      content("One centre, many uses", "Join a course, settle in to work, meet your team or take a break. The front desk helps you throughout your day."),
      { id: "galerie", type: "cta", title: "Explore the spaces", button: { label: "View the gallery", target: { kind: "page", pageId: gallery } } },
      { id: "cafe", type: "cta", title: "Take a coffee break", button: { label: "AXELIA café", target: { kind: "page", pageId: cafe } } },
    ],
  );

  const gallerySections = (en: boolean): SiteSection[] => [
    {
      id: "espaces",
      type: "gallery",
      title: en ? "Workspaces" : "Les espaces",
      layout: "mosaic",
      items: [{ imageId: images.openSpace }, { imageId: images.desk }, { imageId: images.centre }],
    },
    {
      id: "communaute",
      type: "gallery",
      title: en ? "Life at the centre" : "La vie du centre",
      layout: "grid",
      items: [{ imageId: images.shared }, { imageId: images.community }, { imageId: images.workshop }],
    },
  ];
  await publish(gallery, "Galerie", "Gallery", gallerySections(false), gallerySections(true));
  await publish(
    cafe,
    "Café",
    "Café",
    [
      content("Le café AXELIA", "Une pause entre deux séances ou pendant votre journée de travail. Retrouvez le comptoir à l’accueil."),
      content(
        "La carte",
        "Café express 2,500 TND · Capucin 3,000 TND · Thé à la menthe 2,000 TND · Eau 1,000 TND · Jus d’orange 4,500 TND · Croissant 1,800 TND · Sandwich thon 6,500 TND.",
        "carte",
      ),
    ],
    [
      content("AXELIA café", "Take a break between sessions or during your working day. Find the counter at the front desk."),
      content(
        "Menu",
        "Espresso 2.500 TND · Capucin 3.000 TND · Mint tea 2.000 TND · Water 1.000 TND · Orange juice 4.500 TND · Croissant 1.800 TND · Tuna sandwich 6.500 TND.",
        "carte",
      ),
    ],
  );
  await publish(
    pages.contact,
    "Contact",
    "Contact",
    [{ id: "coordonnees", type: "contact", title: "Rencontrons-nous", showMap: true }, form("Organiser une visite", "visit")],
    [{ id: "coordonnees", type: "contact", title: "Meet the team", showMap: true }, form("Arrange a visit", "visit")],
  );
  await publish(
    article,
    "Bien choisir son espace de travail",
    "Choose the right workspace",
    [
      content(
        "Un espace adapté à votre journée",
        "Un poste individuel pour se concentrer, une table partagée pour échanger ou une salle pour réunir son équipe. Choisissez votre créneau puis consultez les disponibilités sur le plan.",
      ),
    ],
    [
      content(
        "A space that fits your day",
        "Choose an individual desk to focus, a shared table to exchange ideas or a room to meet your team. Select a time and check availability on the floor plan.",
      ),
    ],
  );
  await publish(
    scheduled,
    "Atelier découverte de l’IA",
    "Introduction to AI workshop",
    [
      content(
        "Découvrir l’intelligence artificielle",
        "Un atelier de démonstration pour explorer des usages de l’IA et poser ses questions. Contactez l’accueil pour connaître les modalités.",
      ),
    ],
    [
      content(
        "Explore artificial intelligence",
        "A demonstration workshop to explore practical uses of AI and ask questions. Contact the front desk for details.",
      ),
    ],
    new Date(Date.now() + 3 * 86_400_000).toISOString(),
  );

  const types = await call<{ id: string; category: string }[]>("GET", "/coworking/resource-types");
  for (const type of types) {
    if (type.category === "hot_desk" || type.category === "dedicated_desk")
      await call("PATCH", `/coworking/resource-types/${type.id}`, { photoMediaId: images.desk });
  }
  await call("PUT", "/site/settings", { online: true });
  if (publicCall) {
    await publicCall("POST", "/public/leads", {
      kind: "visit",
      name: "Nadia Solvane",
      email: "nadia@axelia.demo.test",
      phone: "21 100 201",
      message: "Je souhaite visiter les espaces pour installer mon équipe.",
      preferredDate: addDays(today, 2),
      language: "fr",
      page: "/contact",
      section: "demande",
    });
    await publicCall("POST", "/public/leads", {
      kind: "quote",
      name: "Adam Verlane",
      email: "adam@axelia.demo.test",
      message: "Je souhaite des renseignements sur la formation Intelligence artificielle.",
      language: "fr",
      page: "/formations-cours",
      section: "demande",
    });
  }
}
