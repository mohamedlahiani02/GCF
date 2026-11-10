export const ICONS = {
  home: "M3 10l9-7 9 7M5 9v12h5v-7h4v7h5V9",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5",
  plus: "M12 5v14M5 12h14",
  arrow: "M5 12h14M13 6l6 6-6 6",
  dashboard: "M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z",
  groups: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8",
  attendance: "M20 6 9 17l-5-5",
  payments: "M3 7h18v12H3zM3 7l3-4h12l3 4M16 13h2",
  payroll: "M12 6v12M16 9c0-1.5-1.8-2.5-4-2.5S8 7.5 8 9s1.8 2 4 2.5 4 1 4 2.5-1.8 2.5-4 2.5-4-1-4-2.5",
  referentials: "M4 4h16v4H4zM4 10h16v4H4zM4 16h16v4H4z",
  students: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  instructors: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  lessons: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5zM4 19.5V21h16",
  trainings: "M2 9l10-5 10 5-10 5zM6 11v5c3 2 9 2 12 0v-5",
  receipts: "M14 3H6v18h12V7zM14 3v4h4M9 12h6M9 16h6",
  rooms: "M4 21V5l8-2v18M12 9h8v12M7 9h2M7 13h2M7 17h2",
  planning: "M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14H3V6a2 2 0 0 1 2-2z",
  cash: "M2 6h20v12H2zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5",
  reports: "M3 3v18h18M7 15l4-4 3 3 5-6",
  floorPlan: "M3 3h18v18H3zM3 12h8M11 3v18M15 8h2M15 15h2",
  inbox: "M22 12h-6l-2 3h-4l-2-3H2M5.5 5h13L22 12v7H2v-7z",
  members: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  stats: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  settings: "M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4",
  pages: "M14 3H6v18h12V7zM14 3v4h4",
  media: "M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6M15.5 9.5h0",
  leads: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  proposals: "M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9",
};

/** Every settings page of the back-office, gathered on one "Paramètres" page; each card shows only with its permission. */
export const SETTINGS_LINKS: { to: string; title: string; text: string; permission: string | string[] }[] = [
  {
    to: "/coworking/parametres",
    title: "Coworking",
    text: "Votre espace (étages, plans, places), les tarifs et abonnements, les règles de réservation et les fermetures.",
    permission: "coworking:manage",
  },
  {
    to: "/site/apparence",
    title: "Apparence du site",
    text: "Logo, couleurs, police et thème du site public.",
    permission: "website:edit",
  },
  {
    to: "/site/parametres",
    title: "Paramètres du site",
    text: "Adresse, langues, coordonnées, réseaux sociaux et menu du site public.",
    permission: "website:edit",
  },
  {
    to: "/administration",
    title: "Administration",
    text: "Informations du centre, utilisateurs et rôles, modules activés et journal d'audit.",
    permission: ["audit:read", "users:manage"],
  },
  {
    to: "/automatisations",
    title: "Automatisations",
    text: "Relances hebdomadaires, paie du mois, programme du lendemain, avis de courrier : désactivé, à confirmer ou automatique.",
    permission: "centre:manage",
  },
  {
    to: "/integrations",
    title: "Intégrations",
    text: "Jetons d'accès à l'API et webhooks pour relier GCF à n8n, à la messagerie ou à un agent.",
    permission: "centre:manage",
  },
];
export const SETTINGS_PERMISSIONS = [...new Set(SETTINGS_LINKS.flatMap((l) => (Array.isArray(l.permission) ? l.permission : [l.permission])))];

export type Permission = string | string[];
export interface ActionLink {
  to: string;
  label: string;
  icon: string;
  permission: Permission;
  end?: boolean;
  also?: string[];
  badge?: "cwRequests" | "proposals";
}
export interface WorkspaceAction extends ActionLink {
  id: string;
  text: string;
  section: "Au quotidien" | "Dossiers et catalogue" | "Suivi et analyse";
  action?: "collect" | "walkIn";
}
export interface Workspace {
  id: string;
  to: string;
  label: string;
  title: string;
  text: string;
  icon: string;
  items: WorkspaceAction[];
}

/** The same permissions control the sidebar, workspace links, search and personal shortcuts. */
export const permitted = (permission: Permission, can: (p: string) => boolean): boolean =>
  Array.isArray(permission) ? permission.length === 0 || permission.some(can) : can(permission);

export const WORKSPACES: Workspace[] = [
  {
    id: "training",
    to: "/espaces/formation",
    label: "Formation et cours",
    title: "Formation et cours particuliers",
    text: "Inscriptions, groupes et séances : tout pour accompagner vos élèves.",
    icon: ICONS.trainings,
    items: [
      {
        id: "enrol",
        to: "/inscriptions/nouvelle",
        label: "Inscrire un élève",
        text: "Choisir un groupe et une formule",
        icon: ICONS.plus,
        permission: "enrolments:write",
        section: "Au quotidien",
      },
      {
        id: "groups",
        to: "/groupes",
        label: "Gérer les groupes",
        text: "Élèves, séances et prochaines dates",
        icon: ICONS.groups,
        permission: "catalogue:read",
        section: "Au quotidien",
      },
      {
        id: "attendance",
        to: "/presences",
        label: "Saisir les présences",
        text: "Ouvrir les feuilles de présence",
        icon: ICONS.attendance,
        permission: "attendance:read",
        section: "Au quotidien",
      },
      {
        id: "planning",
        to: "/planning",
        label: "Voir le planning",
        text: "Consulter les séances et les salles",
        icon: ICONS.planning,
        permission: "catalogue:read",
        section: "Au quotidien",
      },
      {
        id: "new-group",
        to: "/groupes/nouveau",
        label: "Créer un groupe",
        text: "Préparer un nouveau groupe",
        icon: ICONS.plus,
        permission: "groups:write",
        section: "Au quotidien",
      },
      {
        id: "students",
        to: "/eleves",
        label: "Élèves",
        text: "Fiches, inscriptions et historique",
        icon: ICONS.students,
        permission: "students:read",
        section: "Dossiers et catalogue",
      },
      {
        id: "instructors",
        to: "/intervenants",
        label: "Profs / Formateurs",
        text: "Coordonnées et groupes associés",
        icon: ICONS.instructors,
        permission: "instructors:read",
        section: "Dossiers et catalogue",
      },
      {
        id: "lessons",
        to: "/cours-particuliers",
        label: "Cours particuliers",
        text: "Matières, niveaux et tarifs",
        icon: ICONS.lessons,
        permission: "catalogue:read",
        section: "Dossiers et catalogue",
      },
      {
        id: "trainings",
        to: "/formations",
        label: "Formations",
        text: "Catalogue et formules de paiement",
        icon: ICONS.trainings,
        permission: "catalogue:read",
        section: "Dossiers et catalogue",
      },
      {
        id: "rooms",
        to: "/salles",
        label: "Salles et locations",
        also: ["/locations"],
        text: "Espaces disponibles et locations",
        icon: ICONS.rooms,
        permission: "catalogue:read",
        section: "Dossiers et catalogue",
      },
      {
        id: "rental",
        to: "/locations/nouvelle",
        label: "Louer une salle",
        text: "Créer une nouvelle location",
        icon: ICONS.rooms,
        permission: "rooms:write",
        section: "Au quotidien",
      },
    ],
  },
  {
    id: "coworking",
    to: "/espaces/coworking",
    label: "Coworking",
    title: "Votre espace coworking",
    text: "Accueillir vos clients, organiser les réservations et suivre votre espace.",
    icon: ICONS.floorPlan,
    items: [
      {
        id: "live-plan",
        to: "/coworking",
        label: "Ouvrir le plan en direct",
        text: "Disponibilités et réservations",
        icon: ICONS.floorPlan,
        permission: "coworking:read",
        section: "Au quotidien",
        end: true,
      },
      {
        id: "walk-in",
        to: "/coworking",
        label: "Accueillir un client",
        text: "Installer un client sans réservation",
        icon: ICONS.plus,
        permission: "coworking:write",
        section: "Au quotidien",
        action: "walkIn",
      },
      {
        id: "requests",
        to: "/coworking/demandes",
        label: "Demandes et inscriptions",
        text: "Valider les comptes et les réservations",
        icon: ICONS.inbox,
        permission: "coworking:write",
        section: "Au quotidien",
        badge: "cwRequests",
      },
      {
        id: "cw-planning",
        to: "/coworking/planning",
        label: "Planning coworking",
        text: "Préparer les prochaines réservations",
        icon: ICONS.planning,
        permission: "coworking:read",
        section: "Au quotidien",
      },
      {
        id: "members",
        to: "/coworking/membres",
        label: "Clients coworking",
        text: "Fiches et historique des clients",
        icon: ICONS.members,
        permission: "coworking:read",
        section: "Dossiers et catalogue",
      },
      {
        id: "subscriptions",
        to: "/coworking/abonnements",
        label: "Abonnements",
        text: "Contrats et renouvellements",
        icon: ICONS.receipts,
        permission: "coworking:read",
        section: "Dossiers et catalogue",
      },
      {
        id: "mail",
        to: "/coworking/courrier",
        label: "Courrier reçu",
        text: "Suivre le courrier des clients domiciliés",
        icon: ICONS.inbox,
        permission: "coworking:read",
        section: "Dossiers et catalogue",
      },
      {
        id: "cw-stats",
        to: "/coworking/statistiques",
        label: "Statistiques coworking",
        text: "Occupation et revenus de l’espace",
        icon: ICONS.stats,
        permission: "coworking:reports",
        section: "Suivi et analyse",
      },
    ],
  },
  {
    id: "finance",
    to: "/espaces/finances",
    label: "Finances",
    title: "Finances",
    text: "Encaissements, paie et caisse, réunis dans un même espace.",
    icon: ICONS.payments,
    items: [
      {
        id: "collect",
        to: "/encaissements",
        label: "Encaisser un paiement",
        text: "Enregistrer un règlement et son reçu",
        icon: ICONS.payments,
        permission: "payments:write",
        section: "Au quotidien",
        action: "collect",
      },
      {
        id: "payments",
        to: "/encaissements",
        label: "Suivre les encaissements",
        text: "Échéances, impayés et relances",
        icon: ICONS.cash,
        permission: "payments:read",
        section: "Au quotidien",
      },
      {
        id: "payroll",
        to: "/paie",
        also: ["/paie/intervenants"],
        label: "Régler une paie",
        text: "Calculer et régler les profs / formateurs",
        icon: ICONS.payroll,
        permission: "payroll:read",
        section: "Au quotidien",
      },
      {
        id: "cash",
        to: "/caisse",
        label: "Gérer la caisse",
        text: "Mouvements et clôture de caisse",
        icon: ICONS.cash,
        permission: "cash:read",
        section: "Au quotidien",
      },
      {
        id: "receipts",
        to: "/recus",
        label: "Retrouver un reçu",
        text: "Consulter et télécharger les reçus",
        icon: ICONS.receipts,
        permission: "payments:read",
        section: "Dossiers et catalogue",
      },
      {
        id: "dashboard",
        to: "/tableau-de-bord",
        label: "Tableau de bord",
        text: "Indicateurs, alertes et activité du centre",
        icon: ICONS.dashboard,
        permission: ["dashboard:operational", "dashboard:financial"],
        section: "Suivi et analyse",
      },
      {
        id: "reports",
        to: "/rapports",
        label: "Rapports et exports",
        text: "Suivi opérationnel et financier",
        icon: ICONS.reports,
        permission: ["reports:operational", "reports:financial"],
        section: "Suivi et analyse",
      },
    ],
  },
  {
    id: "website",
    to: "/espaces/site-web",
    label: "Site web",
    title: "Votre site web",
    text: "Publier vos pages et retrouver les demandes envoyées depuis votre site.",
    icon: ICONS.pages,
    items: [
      {
        id: "pages",
        to: "/site",
        label: "Modifier les pages",
        text: "Contenu et publication du site",
        icon: ICONS.pages,
        permission: "website:edit",
        section: "Au quotidien",
        end: true,
        also: ["/site/pages"],
      },
      {
        id: "leads",
        to: "/site/demandes",
        label: "Demandes du site",
        text: "Retrouver les contacts et demandes",
        icon: ICONS.leads,
        permission: "website:leads",
        section: "Au quotidien",
      },
      {
        id: "media",
        to: "/site/medias",
        label: "Médiathèque",
        text: "Images et documents à publier",
        icon: ICONS.media,
        permission: "website:edit",
        section: "Dossiers et catalogue",
      },
    ],
  },
];

export const ACTIONS = WORKSPACES.flatMap((w) => w.items);
export const DEFAULT_SHORTCUTS = ["enrol", "groups", "attendance", "collect", "planning", "payroll", "live-plan", "requests"];

export function actionActive(item: ActionLink, pathname: string): boolean {
  const under = (to: string) => pathname === to || pathname.startsWith(`${to}/`);
  return pathname === item.to || (item.to !== "/" && !item.end && under(item.to)) || (item.also ?? []).some(under);
}

/** Settings win over module prefixes, including nested coworking settings routes. */
export function workspaceFor(pathname: string): Workspace | undefined {
  if (pathname === "/parametres" || SETTINGS_LINKS.some((l) => pathname === l.to || pathname.startsWith(`${l.to}/`))) return undefined;
  return WORKSPACES.find((w) => pathname === w.to || w.items.some((i) => !i.action && actionActive(i, pathname)));
}
