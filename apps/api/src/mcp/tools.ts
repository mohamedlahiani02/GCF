import type { Permission } from "../auth/permissions.js";

/** JSON Schema of a tool's arguments, as MCP clients read it. */
export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
}

/** A call into the application's own REST API, made with the caller's access token. */
export interface ApiCall {
  method: "GET" | "POST" | "PATCH";
  url: string;
  body?: unknown;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  /** Changes data: hidden from read-only tokens, and announced to clients so they ask the user first. */
  writes: boolean;
  /** Without one of these the tool is not listed; the REST API checks again on every call. */
  permissions: Permission[];
  /** Turns validated arguments into the API calls to make; the last response is the result. */
  plan(args: Record<string, unknown>): ApiCall[] | "occupancy";
}

/** A kind of record the generic tools can list and read, and the REST routes behind it. */
export interface Entity {
  name: string;
  description: string;
  permission: Permission;
  listUrl: string;
  /** Query parameters accepted by the list route, with what they mean. */
  filters: Record<string, string>;
  /** Filters the list route cannot do without. */
  requiredFilters?: string[];
  getUrl?: (id: string) => string;
}

export const ENTITIES: Entity[] = [
  {
    name: "students",
    description: "Élèves de la formation et du soutien scolaire.",
    permission: "students:read",
    listUrl: "/api/students",
    filters: { q: "nom, téléphone ou e-mail", status: "active | archived | all", page: "page, à partir de 1", pageSize: "1 à 100" },
    getUrl: (id) => `/api/students/${id}`,
  },
  {
    name: "groups",
    description: "Groupes de cours et de formation, avec leur planning.",
    permission: "catalogue:read",
    listUrl: "/api/groups",
    filters: { status: "active | archived | all" },
    getUrl: (id) => `/api/groups/${id}`,
  },
  {
    name: "coworking_members",
    description: "Clients du coworking (personnes et membres d'entreprises).",
    permission: "coworking:read",
    listUrl: "/api/coworking/members",
    filters: { q: "nom, e-mail ou téléphone", status: "pending | active | disabled", kind: "member | guest", companyId: "identifiant de société", page: "page", pageSize: "taille de page" },
    getUrl: (id) => `/api/coworking/members/${id}`,
  },
  {
    name: "coworking_bookings",
    description: "Réservations de places et de salles du coworking.",
    permission: "coworking:read",
    listUrl: "/api/coworking/bookings",
    filters: {
      from: "date de début YYYY-MM-DD",
      to: "date de fin YYYY-MM-DD",
      status: "requested | confirmed | checked_in | completed | cancelled | refused | expired | no_show | all",
      memberId: "identifiant du client",
      resourceId: "identifiant de la place",
      page: "page",
      pageSize: "1 à 200",
    },
    getUrl: (id) => `/api/coworking/bookings/${id}`,
  },
  {
    name: "visitors",
    description: "Registre des visiteurs d'une journée.",
    permission: "coworking:read",
    listUrl: "/api/coworking/visitors",
    filters: { date: "jour YYYY-MM-DD (obligatoire)", status: "expected | arrived | left | cancelled | all" },
    requiredFilters: ["date"],
    getUrl: (id) => `/api/coworking/visitors/${id}`,
  },
  {
    name: "rentals",
    description: "Locations de salles.",
    permission: "catalogue:read",
    listUrl: "/api/rentals",
    filters: { status: "active | cancelled | all", roomId: "identifiant de salle", renterId: "identifiant du locataire" },
    getUrl: (id) => `/api/rentals/${id}`,
  },
  {
    name: "payments",
    description: "Encaissements enregistrés.",
    permission: "payments:read",
    listUrl: "/api/payments",
    filters: {
      from: "date de début YYYY-MM-DD",
      to: "date de fin YYYY-MM-DD",
      method: "cash | transfer | cheque | card",
      studentId: "identifiant d'élève",
      memberId: "identifiant de client coworking",
      renterId: "identifiant de locataire",
      page: "page",
      pageSize: "taille de page",
    },
  },
  {
    name: "invoices",
    description: "Factures et avoirs, avec ce qui reste à payer.",
    permission: "invoices:read",
    listUrl: "/api/invoices",
    filters: { state: "all | unpaid | overdue | paid | unsent | credited | credit_note", q: "numéro ou client", page: "page", pageSize: "taille de page" },
    getUrl: (id) => `/api/invoices/${id}`,
  },
  {
    name: "prospects",
    description: "Prospects suivis jusqu'à l'inscription.",
    permission: "prospects:read",
    listUrl: "/api/prospects",
    filters: { stage: "open | new | contacted | visit | proposal | won | lost | all", due: "true pour les relances du jour ou en retard", q: "nom, société, e-mail" },
    getUrl: (id) => `/api/prospects/${id}`,
  },
];

const str = (description: string) => ({ type: "string", description });
const id = (description: string) => ({ type: "string", format: "uuid", description });
const date = (description: string) => ({ type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description });
const enumOf = (values: string[], description: string) => ({ type: "string", enum: values, description });
const pick = (args: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));

export const TOOLS: ToolDefinition[] = [
  {
    name: "list_entities",
    title: "Types de données disponibles",
    description: "Liste les types d'enregistrements que ce jeton peut consulter, avec les filtres de chacun. À appeler avant list_records.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    writes: false,
    permissions: [],
    plan: () => [],
  },
  {
    name: "list_records",
    title: "Lister des enregistrements",
    description: "Liste les enregistrements d'un type (voir list_entities), avec ses filtres.",
    inputSchema: {
      type: "object",
      properties: {
        entity: str("nom du type, par exemple coworking_bookings"),
        filters: { type: "object", description: "filtres du type, valeurs texte, nombre ou booléen", additionalProperties: { type: ["string", "number", "boolean"] } },
      },
      required: ["entity"],
      additionalProperties: false,
    },
    writes: false,
    permissions: [],
    plan: () => [],
  },
  {
    name: "get_record",
    title: "Lire un enregistrement",
    description: "Lit un enregistrement par son identifiant, avec son détail.",
    inputSchema: { type: "object", properties: { entity: str("nom du type"), id: id("identifiant") }, required: ["entity", "id"], additionalProperties: false },
    writes: false,
    permissions: [],
    plan: () => [],
  },
  {
    name: "centre_overview",
    title: "Tableau de bord du centre",
    description: "Indicateurs du jour : encaissements, impayés, présences, occupation, tâches et agenda, selon le rôle du jeton.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    writes: false,
    permissions: ["dashboard:operational", "dashboard:financial"],
    plan: () => [{ method: "GET", url: "/api/dashboard" }],
  },
  {
    name: "coworking_occupancy",
    title: "Occupation du coworking maintenant",
    description: "Pour chaque étage, le nombre de places libres, réservées, occupées et bloquées à cet instant.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    writes: false,
    permissions: ["coworking:read"],
    plan: () => "occupancy",
  },
  {
    name: "overdue_charges",
    title: "Impayés en retard",
    description: "Échéances en retard de tous les payeurs, avec le reste dû.",
    inputSchema: { type: "object", properties: { page: { type: "integer", minimum: 1 } }, additionalProperties: false },
    writes: false,
    permissions: ["payments:read"],
    plan: (args) => [{ method: "GET", url: `/api/payments/overdue${args.page ? `?page=${Number(args.page)}` : ""}` }],
  },
  {
    name: "create_prospect",
    title: "Créer un prospect",
    description: "Ajoute une personne ou une société intéressée au suivi des prospects. Un e-mail ou un téléphone est nécessaire.",
    inputSchema: {
      type: "object",
      properties: {
        name: str("nom et prénom"),
        company: str("société"),
        email: str("e-mail"),
        phone: str("téléphone"),
        source: enumOf(["website", "walk_in", "phone", "referral", "event", "social", "other"], "origine du contact"),
        interests: { type: "array", items: enumOf(["training", "coworking", "rental", "cafe", "other"], "intérêt") },
        nextAction: str("prochaine action"),
        nextActionOn: date("date de relance"),
        notes: str("notes"),
      },
      required: ["name", "source"],
      additionalProperties: false,
    },
    writes: true,
    permissions: ["prospects:write"],
    plan: (args) => [{ method: "POST", url: "/api/prospects", body: pick(args, ["name", "company", "email", "phone", "source", "interests", "nextAction", "nextActionOn", "notes"]) }],
  },
  {
    name: "log_prospect_activity",
    title: "Noter un échange avec un prospect",
    description: "Ajoute un appel, un e-mail, une visite ou une note à l'historique d'un prospect.",
    inputSchema: {
      type: "object",
      properties: { prospectId: id("prospect"), kind: enumOf(["call", "email", "visit", "note"], "type d'échange"), text: str("ce qui a été dit ou convenu") },
      required: ["prospectId", "kind", "text"],
      additionalProperties: false,
    },
    writes: true,
    permissions: ["prospects:write"],
    plan: (args) => [{ method: "POST", url: `/api/prospects/${String(args.prospectId)}/activities`, body: pick(args, ["kind", "text"]) }],
  },
  {
    name: "move_prospect_stage",
    title: "Changer l'étape d'un prospect",
    description: "Passe un prospect à une autre étape ; une perte demande un motif.",
    inputSchema: {
      type: "object",
      properties: { prospectId: id("prospect"), stage: enumOf(["new", "contacted", "visit", "proposal", "lost"], "nouvelle étape"), lostReason: str("motif, pour une perte") },
      required: ["prospectId", "stage"],
      additionalProperties: false,
    },
    writes: true,
    permissions: ["prospects:write"],
    plan: (args) => [{ method: "POST", url: `/api/prospects/${String(args.prospectId)}/stage`, body: pick(args, ["stage", "lostReason"]) }],
  },
  {
    name: "announce_visitor",
    title: "Annoncer un visiteur",
    description: "Inscrit au registre un visiteur attendu par un client du coworking.",
    inputSchema: {
      type: "object",
      properties: {
        hostMemberId: id("client qui reçoit"),
        name: str("nom du visiteur"),
        company: str("société"),
        expectedOn: date("jour de la visite"),
        expectedAt: { type: "string", pattern: "^\\d{2}:\\d{2}$", description: "heure prévue HH:MM" },
        purpose: str("objet de la visite"),
      },
      required: ["hostMemberId", "name", "expectedOn"],
      additionalProperties: false,
    },
    writes: true,
    permissions: ["coworking:write"],
    plan: (args) => [{ method: "POST", url: "/api/coworking/visitors", body: pick(args, ["hostMemberId", "name", "company", "expectedOn", "expectedAt", "purpose"]) }],
  },
  {
    name: "record_visitor",
    title: "Enregistrer l'arrivée ou le départ d'un visiteur",
    description: "Enregistre l'arrivée, le départ ou l'annulation d'une visite ; le client est prévenu de l'arrivée si le centre l'a choisi.",
    inputSchema: {
      type: "object",
      properties: { visitorId: id("visite"), step: enumOf(["arrive", "leave", "cancel"], "étape") },
      required: ["visitorId", "step"],
      additionalProperties: false,
    },
    writes: true,
    permissions: ["coworking:write"],
    plan: (args) => [{ method: "POST", url: `/api/coworking/visitors/${String(args.visitorId)}/${String(args.step)}` }],
  },
  {
    name: "create_coworking_booking",
    title: "Réserver une place ou une salle",
    description: "Réserve une ressource du coworking pour un client, avec un format et un créneau. Le prix et les droits sont calculés comme à l'accueil.",
    inputSchema: {
      type: "object",
      properties: {
        memberId: id("client"),
        resourceId: id("place ou salle"),
        formatId: id("format de réservation"),
        date: date("jour"),
        startTime: { type: "string", pattern: "^\\d{2}:\\d{2}$", description: "début HH:MM" },
        durationMinutes: { type: "integer", minimum: 15, maximum: 1440, description: "durée, pour un format libre" },
      },
      required: ["memberId", "resourceId", "formatId", "date", "startTime"],
      additionalProperties: false,
    },
    writes: true,
    permissions: ["coworking:write"],
    plan: (args) => [{ method: "POST", url: "/api/coworking/bookings", body: pick(args, ["memberId", "resourceId", "formatId", "date", "startTime", "durationMinutes"]) }],
  },
  {
    name: "send_invoice",
    title: "Envoyer une facture",
    description: "Envoie par e-mail le PDF archivé d'une facture ou d'un avoir.",
    inputSchema: { type: "object", properties: { invoiceId: id("facture"), to: str("adresse e-mail du destinataire") }, required: ["invoiceId", "to"], additionalProperties: false },
    writes: true,
    permissions: ["invoices:write"],
    plan: (args) => [{ method: "POST", url: `/api/invoices/${String(args.invoiceId)}/send`, body: pick(args, ["to"]) }],
  },
];

const PERSONAL_KEYS = /^(email|phone|address|taxId|birthDate|recipient|sentTo|receiptEmail|guardianPhone|guardianEmail|memberEmail|memberPhone)$/i;

/** Hides personal details: e-mail addresses keep their first letter and domain, other values their last two characters. */
export function maskPersonalData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskPersonalData);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, v]) => {
      if (PERSONAL_KEYS.test(key) && typeof v === "string" && v.length > 0) {
        const at = v.indexOf("@");
        return [key, at > 0 ? `${v[0]}***${v.slice(at)}` : `***${v.slice(-2)}`];
      }
      return [key, maskPersonalData(v)];
    }),
  );
}
