import type { CwPeriod } from "../db/types.coworking.js";

/** Fixed wording of the public website, in both site languages. */
export interface SiteLabels {
  languageName: string;
  ogLocale: string;
  skipToContent: string;
  mainMenu: string;
  menu: string;
  languages: string;
  book: string;
  preview: string;
  notFoundTitle: string;
  notFoundText: string;
  backHome: string;
  footerPages: string;
  contact: string;
  followUs: string;
  address: string;
  phone: string;
  email: string;
  openingHours: string;
  closures: string;
  closed: string;
  reducedHours: (from: string, to: string) => string;
  openRange: (from: string, to: string) => string;
  viewMap: string;
  weekdays: readonly string[];
  capacity: (min: number, max: number) => string;
  from: string;
  perHour: string;
  perPeriod: Record<CwPeriod, string>;
  billedMonthly: string;
  domiciliation: string;
  plans: string;
  packs: string;
  formats: string;
  visitor: string;
  member: string;
  columnSpace: string;
  columnOption: string;
  columnIncludes: string;
  columnPrice: string;
  validity: (days: number) => string;
  quotaMinutes: (minutes: number) => string;
  quotaBookings: (count: number) => string;
  freeNow: string;
  freeRestOfDay: string;
  closedNow: string;
  formName: string;
  formEmail: string;
  formPhone: string;
  formCompany: string;
  formMessage: string;
  formPreferredDate: string;
  formContactHint: string;
  formHoneypot: string;
  formSubmit: Record<"contact" | "visit" | "quote", string>;
  formSent: string;
  formError: string;
  readArticle: string;
  dateRange: (from: string, to: string) => string;
}

const hours = (minutes: number) => (minutes % 60 === 0 ? String(minutes / 60) : (minutes / 60).toFixed(1));

export const SITE_LABELS: Record<"fr" | "en", SiteLabels> = {
  fr: {
    languageName: "Français",
    ogLocale: "fr_FR",
    skipToContent: "Aller au contenu",
    mainMenu: "Menu principal",
    menu: "Menu",
    languages: "Langues",
    book: "Réserver",
    preview: "Aperçu : cette version n'est pas publiée",
    notFoundTitle: "Page introuvable",
    notFoundText: "La page demandée n'existe pas ou a été déplacée.",
    backHome: "Retour à l'accueil",
    footerPages: "Informations",
    contact: "Contact",
    followUs: "Suivez-nous",
    address: "Adresse",
    phone: "Téléphone",
    email: "E-mail",
    openingHours: "Horaires",
    closures: "Fermetures à venir",
    closed: "Fermé",
    reducedHours: (from, to) => `ouvert de ${from} à ${to}`,
    openRange: (from, to) => `${from} - ${to}`,
    viewMap: "Voir sur la carte",
    weekdays: ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"],
    capacity: (min, max) => (min === max ? `${min} personne${min > 1 ? "s" : ""}` : `${min} à ${max} personnes`),
    from: "À partir de",
    perHour: "par heure",
    perPeriod: { month: "par mois", quarter: "par trimestre", year: "par an" },
    billedMonthly: "payable chaque mois",
    domiciliation: "Domiciliation incluse",
    plans: "Abonnements",
    packs: "Packs",
    formats: "Réservations à l'unité",
    visitor: "Visiteur",
    member: "Membre",
    columnSpace: "Espace",
    columnOption: "Formule",
    columnIncludes: "Contenu",
    columnPrice: "Prix",
    validity: (days) => `valable ${days} jours`,
    quotaMinutes: (minutes) => `${hours(minutes)} h`,
    quotaBookings: (count) => `${count} réservation${count > 1 ? "s" : ""}`,
    freeNow: "Libres maintenant",
    freeRestOfDay: "Libres jusqu'à la fermeture",
    closedNow: "Fermé",
    formName: "Nom",
    formEmail: "E-mail",
    formPhone: "Téléphone",
    formCompany: "Société",
    formMessage: "Message",
    formPreferredDate: "Date souhaitée",
    formContactHint: "Indiquez au moins un e-mail ou un téléphone.",
    formHoneypot: "Laissez ce champ vide",
    formSubmit: { contact: "Envoyer", visit: "Demander une visite", quote: "Demander un devis" },
    formSent: "Merci, votre demande a bien été envoyée. Nous vous répondrons rapidement.",
    formError: "Votre demande n'a pas pu être envoyée. Vérifiez votre nom et indiquez un e-mail ou un téléphone valide.",
    readArticle: "Lire l'article",
    dateRange: (from, to) => (from === to ? from : `du ${from} au ${to}`),
  },
  en: {
    languageName: "English",
    ogLocale: "en_GB",
    skipToContent: "Skip to content",
    mainMenu: "Main menu",
    menu: "Menu",
    languages: "Languages",
    book: "Book",
    preview: "Preview: this version is not published",
    notFoundTitle: "Page not found",
    notFoundText: "The page you are looking for does not exist or has moved.",
    backHome: "Back to the home page",
    footerPages: "Information",
    contact: "Contact",
    followUs: "Follow us",
    address: "Address",
    phone: "Phone",
    email: "E-mail",
    openingHours: "Opening hours",
    closures: "Upcoming closures",
    closed: "Closed",
    reducedHours: (from, to) => `open from ${from} to ${to}`,
    openRange: (from, to) => `${from} - ${to}`,
    viewMap: "View on the map",
    weekdays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
    capacity: (min, max) => (min === max ? `${min} ${min > 1 ? "people" : "person"}` : `${min} to ${max} people`),
    from: "From",
    perHour: "per hour",
    perPeriod: { month: "per month", quarter: "per quarter", year: "per year" },
    billedMonthly: "paid monthly",
    domiciliation: "Business address included",
    plans: "Memberships",
    packs: "Packs",
    formats: "Pay as you go",
    visitor: "Visitor",
    member: "Member",
    columnSpace: "Space",
    columnOption: "Option",
    columnIncludes: "Includes",
    columnPrice: "Price",
    validity: (days) => `valid ${days} days`,
    quotaMinutes: (minutes) => `${hours(minutes)} h`,
    quotaBookings: (count) => `${count} booking${count > 1 ? "s" : ""}`,
    freeNow: "Free now",
    freeRestOfDay: "Free until closing",
    closedNow: "Closed",
    formName: "Name",
    formEmail: "E-mail",
    formPhone: "Phone",
    formCompany: "Company",
    formMessage: "Message",
    formPreferredDate: "Preferred date",
    formContactHint: "Give at least an e-mail address or a phone number.",
    formHoneypot: "Leave this field empty",
    formSubmit: { contact: "Send", visit: "Request a visit", quote: "Request a quote" },
    formSent: "Thank you, your request has been sent. We will get back to you shortly.",
    formError: "Your request could not be sent. Check your name and give a valid e-mail address or phone number.",
    readArticle: "Read the article",
    dateRange: (from, to) => (from === to ? from : `${from} to ${to}`),
  },
};
