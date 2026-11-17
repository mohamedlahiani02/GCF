import type { Kysely } from "kysely";
import { z } from "zod";
import type { Permission } from "../auth/permissions.js";
import type { Database } from "../db/types.js";
import { productBody } from "../routes/cafe.js";
import { roomBody, studyCreate, subjectBody, trainingCreate } from "../routes/catalogue.js";
import { companyCreate, memberCreate } from "../routes/coworking/members.js";
import { createBody as instructorCreate } from "../routes/instructors.js";
import { renterCreate } from "../routes/rentals.js";
import { createBody as studentCreate } from "../routes/students.js";

/**
 * Bulk loading of a centre's reference data by an implementation consultant. A file row is never written to the
 * database here: each row becomes the body of the same REST request the back-office sends, so validation, business
 * rules, permissions and the audit log are those of the application. This module only checks rows ahead of time,
 * resolves references written as names, and recognises rows already loaded (by a business key) so that loading the
 * same file twice creates nothing twice. Nothing is updated or deleted.
 */

type Db = Kysely<Database>;

/** A reference written by name in the file (a subject, a company), resolved to its identifier before sending. */
type References = Record<string, Map<string, string>>;

export interface ImportDefinition {
  entity: string;
  description: string;
  /** Permission the caller needs; it also carries the module the entity belongs to. */
  permission: Permission;
  /** Entities to load first, because this one refers to them by name. */
  dependsOn: string[];
  /** Shape of a file row: the REST body, with references written as names. */
  row: z.ZodType<Record<string, unknown>>;
  /** Fields that form the business key, in the order they are compared. */
  keyFields: string[];
  key: (row: Record<string, unknown>) => string;
  existing: (db: Db, centreId: string) => Promise<Map<string, string>>;
  references: (db: Db, centreId: string) => Promise<References>;
  /** Turns a checked row into the REST body, or returns the names that could not be resolved. */
  toBody: (row: Record<string, unknown>, refs: References) => { body: Record<string, unknown> } | { missing: string[] };
  /** The REST endpoint that creates one record. */
  url: string;
  /** The schema the REST endpoint applies to its body. */
  body: z.ZodType;
}

/** Lower case, trimmed, inner spaces collapsed: two spellings of the same name give the same key. */
export function normalise(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").toLocaleLowerCase("fr") : "";
}

const personKey = (row: Record<string, unknown>) =>
  normalise(row.email) ? `email:${normalise(row.email)}` : `name:${normalise(row.firstName)}|${normalise(row.lastName)}|${normalise(row.phone)}`;

const byName = (rows: { id: string; name: string }[]) => new Map(rows.map((r) => [normalise(r.name), r.id]));

const noReferences = async (): Promise<References> => ({});

/** A row equal to the REST body: nothing to resolve. */
const asIs = (row: Record<string, unknown>) => ({ body: row });

const subjectNames = async (db: Db, centreId: string): Promise<References> => ({
  subject: byName(await db.selectFrom("subjects").select(["id", "name"]).where("centre_id", "=", centreId).execute()),
});

export const IMPORTS: readonly ImportDefinition[] = [
  {
    entity: "rooms",
    description: "Salles (cours, locations, coworking)",
    permission: "rooms:write",
    dependsOn: [],
    row: roomBody,
    keyFields: ["name"],
    key: (r) => normalise(r.name),
    existing: async (db, centreId) => byName(await db.selectFrom("rooms").select(["id", "name"]).where("centre_id", "=", centreId).execute()),
    references: noReferences,
    toBody: asIs,
    url: "/api/catalogue/rooms",
    body: roomBody,
  },
  {
    entity: "subjects",
    description: "Matières",
    permission: "catalogue:write",
    dependsOn: [],
    row: subjectBody,
    keyFields: ["name"],
    key: (r) => normalise(r.name),
    existing: async (db, centreId) => (await subjectNames(db, centreId)).subject!,
    references: noReferences,
    toBody: asIs,
    url: "/api/catalogue/subjects",
    body: subjectBody,
  },
  {
    entity: "instructors",
    description: "Intervenants, avec les matières enseignées écrites par leur nom",
    permission: "instructors:write",
    dependsOn: ["subjects"],
    row: instructorCreate
      .omit({ subjectIds: true, availability: true })
      .extend({ subjects: z.array(z.string().trim().min(1)).max(50).default([]), availability: instructorCreate.shape.availability.default([]) })
      .strict(),
    keyFields: ["email", "firstName", "lastName", "phone"],
    key: personKey,
    existing: async (db, centreId) =>
      new Map(
        (
          await db
            .selectFrom("instructors")
            .select(["id", "email", "first_name as firstName", "last_name as lastName", "phone"])
            .where("centre_id", "=", centreId)
            .execute()
        ).map((r) => [personKey(r), r.id]),
      ),
    references: subjectNames,
    toBody: (row, refs) => {
      const names = row.subjects as string[];
      const missing = names.filter((n) => !refs.subject!.has(normalise(n)));
      if (missing.length) return { missing: missing.map((n) => `subject:${n}`) };
      const { subjects: _subjects, ...rest } = row;
      return { body: { ...rest, subjectIds: names.map((n) => refs.subject!.get(normalise(n))!) } };
    },
    url: "/api/instructors",
    body: instructorCreate,
  },
  {
    entity: "studies",
    description: "Cours réguliers (études), rattachés à une matière écrite par son nom",
    permission: "catalogue:write",
    dependsOn: ["subjects"],
    row: studyCreate
      .omit({ subjectId: true })
      .extend({ subject: z.string().trim().min(1).max(100) })
      .strict(),
    keyFields: ["subject", "name"],
    key: (r) => `${normalise(r.subject)}|${normalise(r.name)}`,
    existing: async (db, centreId) =>
      new Map(
        (
          await db
            .selectFrom("studies")
            .innerJoin("subjects", "subjects.id", "studies.subject_id")
            .select(["studies.id", "studies.name", "subjects.name as subject"])
            .where("studies.centre_id", "=", centreId)
            .execute()
        ).map((r) => [`${normalise(r.subject)}|${normalise(r.name)}`, r.id]),
      ),
    references: subjectNames,
    toBody: (row, refs) => {
      const subjectId = refs.subject!.get(normalise(row.subject));
      if (!subjectId) return { missing: [`subject:${String(row.subject)}`] };
      const { subject: _subject, ...rest } = row;
      return { body: { ...rest, subjectId } };
    },
    url: "/api/catalogue/studies",
    body: studyCreate,
  },
  {
    entity: "trainings",
    description: "Formations à durée fixe",
    permission: "catalogue:write",
    dependsOn: [],
    row: trainingCreate,
    keyFields: ["title"],
    key: (r) => normalise(r.title),
    existing: async (db, centreId) =>
      new Map((await db.selectFrom("trainings").select(["id", "title"]).where("centre_id", "=", centreId).execute()).map((r) => [normalise(r.title), r.id])),
    references: noReferences,
    toBody: asIs,
    url: "/api/catalogue/trainings",
    body: trainingCreate,
  },
  {
    entity: "students",
    description: "Élèves",
    permission: "students:write",
    dependsOn: [],
    row: studentCreate,
    keyFields: ["email", "firstName", "lastName", "phone"],
    key: personKey,
    existing: async (db, centreId) =>
      new Map(
        (
          await db
            .selectFrom("students")
            .select(["id", "email", "first_name as firstName", "last_name as lastName", "phone"])
            .where("centre_id", "=", centreId)
            .execute()
        ).map((r) => [personKey(r), r.id]),
      ),
    references: noReferences,
    toBody: asIs,
    url: "/api/students",
    body: studentCreate,
  },
  {
    entity: "renters",
    description: "Locataires de salles",
    permission: "rooms:write",
    dependsOn: [],
    row: renterCreate,
    keyFields: ["name", "email", "phone"],
    key: (r) => `${normalise(r.name)}|${normalise(r.email) || normalise(r.phone)}`,
    existing: async (db, centreId) =>
      new Map(
        (await db.selectFrom("renters").select(["id", "name", "email", "phone"]).where("centre_id", "=", centreId).execute()).map((r) => [
          `${normalise(r.name)}|${normalise(r.email) || normalise(r.phone)}`,
          r.id,
        ]),
      ),
    references: noReferences,
    toBody: asIs,
    url: "/api/renters",
    body: renterCreate,
  },
  {
    entity: "companies",
    description: "Entreprises clientes du coworking",
    permission: "coworking:write",
    dependsOn: [],
    row: companyCreate,
    keyFields: ["taxId", "name"],
    key: (r) => (normalise(r.taxId) ? `tax:${normalise(r.taxId)}` : `name:${normalise(r.name)}`),
    existing: async (db, centreId) => {
      const rows = await db.selectFrom("companies").select(["id", "name", "tax_id as taxId"]).where("centre_id", "=", centreId).execute();
      return new Map(rows.map((r) => [normalise(r.taxId) ? `tax:${normalise(r.taxId)}` : `name:${normalise(r.name)}`, r.id]));
    },
    references: noReferences,
    toBody: asIs,
    url: "/api/coworking/companies",
    body: companyCreate,
  },
  {
    entity: "members",
    description: "Clients du coworking (membres), avec leur entreprise écrite par son nom ou son matricule fiscal",
    permission: "coworking:write",
    dependsOn: ["companies"],
    row: memberCreate
      .omit({ companyId: true })
      .extend({ company: z.string().trim().min(1).max(150).nullable().optional() })
      .strict(),
    keyFields: ["email", "firstName", "lastName", "phone"],
    key: personKey,
    existing: async (db, centreId) =>
      new Map(
        (
          await db
            .selectFrom("members")
            .select(["id", "email", "first_name as firstName", "last_name as lastName", "phone"])
            .where("centre_id", "=", centreId)
            .execute()
        ).map((r) => [personKey(r), r.id]),
      ),
    references: async (db, centreId) => {
      const rows = await db.selectFrom("companies").select(["id", "name", "tax_id as taxId"]).where("centre_id", "=", centreId).execute();
      const company = new Map<string, string>();
      for (const r of rows) {
        company.set(normalise(r.name), r.id);
        if (r.taxId) company.set(normalise(r.taxId), r.id);
      }
      return { company };
    },
    toBody: (row, refs) => {
      const { company, ...rest } = row;
      if (!company) return { body: rest };
      const companyId = refs.company!.get(normalise(company));
      return companyId ? { body: { ...rest, companyId } } : { missing: [`company:${String(company)}`] };
    },
    url: "/api/coworking/members",
    body: memberCreate,
  },
  {
    entity: "cafe-products",
    description: "Produits du café (sans stock : le stock initial se saisit par un inventaire)",
    permission: "cafe:manage",
    dependsOn: [],
    row: productBody,
    keyFields: ["name"],
    key: (r) => normalise(r.name),
    existing: async (db, centreId) => byName(await db.selectFrom("cafe_products").select(["id", "name"]).where("centre_id", "=", centreId).execute()),
    references: noReferences,
    toBody: asIs,
    url: "/api/cafe/products",
    body: productBody,
  },
];

export const MAX_IMPORT_ROWS = 2000;

export type RowAction = "create" | "exists" | "error" | "created" | "failed";

export interface RowResult {
  /** Position of the row in the file, starting at 1. */
  line: number;
  action: RowAction;
  key: string;
  id?: string;
  errors: string[];
}

function issues(error: z.ZodError): string[] {
  return error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message));
}

/** Checks every row without writing anything: shape, references, the REST body rules, and duplicates. */
export async function previewRows(
  db: Db,
  centreId: string,
  definition: ImportDefinition,
  rows: unknown[],
): Promise<{ results: RowResult[]; bodies: Map<number, Record<string, unknown>> }> {
  const [existing, refs] = await Promise.all([definition.existing(db, centreId), definition.references(db, centreId)]);
  const seen = new Map<string, number>();
  const bodies = new Map<number, Record<string, unknown>>();
  const results = rows.map((raw, index): RowResult => {
    const line = index + 1;
    const parsed = definition.row.safeParse(raw);
    if (!parsed.success) return { line, action: "error", key: "", errors: issues(parsed.error) };
    const key = definition.key(parsed.data);
    const earlier = seen.get(key);
    if (earlier !== undefined) return { line, action: "error", key, errors: [`duplicate of line ${earlier}`] };
    seen.set(key, line);
    const id = existing.get(key);
    if (id) return { line, action: "exists", key, id, errors: [] };
    const mapped = definition.toBody(parsed.data, refs);
    if ("missing" in mapped) return { line, action: "error", key, errors: mapped.missing.map((m) => `unknown reference ${m}`) };
    const checked = definition.body.safeParse(mapped.body);
    if (!checked.success) return { line, action: "error", key, errors: issues(checked.error) };
    bodies.set(line, mapped.body);
    return { line, action: "create", key, errors: [] };
  });
  return { results, bodies };
}

export function summarise(results: RowResult[]): Record<RowAction, number> {
  const summary: Record<RowAction, number> = { create: 0, exists: 0, error: 0, created: 0, failed: 0 };
  for (const r of results) summary[r.action] += 1;
  return summary;
}
