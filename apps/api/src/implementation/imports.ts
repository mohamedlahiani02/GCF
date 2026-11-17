import type { Kysely } from "kysely";
import { z } from "zod";
import type { Permission } from "../auth/permissions.js";
import type { Database } from "../db/types.js";
import { clockTime, isoDate, millimes, reason, requiredText } from "../validation.js";
import { productBody, stockBody } from "../routes/cafe.js";
import { roomBody, studyCreate, subjectBody, trainingCreate } from "../routes/catalogue.js";
import { companyCreate, memberCreate, subscriptionCreate } from "../routes/coworking/members.js";
import { enrolmentBody } from "../routes/enrolments.js";
import { createBody as groupCreate } from "../routes/groups.js";
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
  toBody: (row: Record<string, unknown>, refs: References) => Mapped;
  /** The REST endpoint that creates one record, unless the row names its own (a record that belongs to another). */
  url: string;
  /** Identifier of what the REST endpoint created, read from its answer; `id` by default. */
  resultId?: (response: Record<string, unknown>) => string;
  /** The schema the REST endpoint applies to its body. */
  body: z.ZodType;
}

/** The REST body of a row and, when it depends on the row, the endpoint; or why the row cannot be sent. */
export type Mapped = { body: Record<string, unknown>; url?: string } | { problems: string[] };

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

/** Marks a name shared by several records: a row naming it must use something unique instead. */
const AMBIGUOUS = "\u0000ambiguous";

/** Index of names to identifiers, where a name given to two different records resolves to neither. */
function nameIndex(entries: [string, string][]): Map<string, string> {
  const index = new Map<string, string>();
  for (const [name, id] of entries) {
    if (!name) continue;
    const known = index.get(name);
    index.set(name, known === undefined || known === id ? id : AMBIGUOUS);
  }
  return index;
}

/** Resolves a name written in a row, or records why it cannot be resolved. */
function resolve(index: Map<string, string>, kind: string, name: unknown, problems: string[]): string | undefined {
  const id = index.get(normalise(name));
  if (id === undefined) problems.push(`unknown reference ${kind}:${String(name)}`);
  else if (id === AMBIGUOUS) problems.push(`ambiguous reference ${kind}:${String(name)}: several records have this name, write the e-mail address`);
  else return id;
  return undefined;
}

/** A person is named in a row by e-mail address or by first and last name. */
const personNames = (p: { email: string | null; firstName: string; lastName: string | null }): string[] => [
  normalise(p.email),
  normalise(`${p.firstName} ${p.lastName ?? ""}`),
];

const peopleIndex = (rows: { id: string; email: string | null; firstName: string; lastName: string | null }[]) =>
  nameIndex(rows.flatMap((r) => personNames(r).map((n): [string, string] => [n, r.id])));

const studyKey = (subject: unknown, study: unknown) => `${normalise(subject)}|${normalise(study)}`;

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
      if (missing.length) return { problems: missing.map((n) => `unknown reference subject:${n}`) };
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
      if (!subjectId) return { problems: [`unknown reference subject:${String(row.subject)}`] };
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
      return companyId ? { body: { ...rest, companyId } } : { problems: [`unknown reference company:${String(company)}`] };
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
  {
    entity: "groups",
    description: "Groupes de cours réguliers (études), avec leurs créneaux ; l'intervenant et les salles écrits par leur nom",
    permission: "groups:write",
    dependsOn: ["studies", "instructors", "rooms"],
    row: z
      .object({
        subject: requiredText(100),
        study: requiredText(150),
        name: requiredText(100),
        instructor: requiredText(254),
        room: z.string().trim().max(100).nullable().optional(),
        capacity: z.number().int().min(1).max(1000).optional(),
        startDate: isoDate,
        endDate: isoDate,
        priceOverride: millimes.nullable().optional(),
        absenceBilledOverride: z.boolean().nullable().optional(),
        countJustifiedOverride: z.boolean().nullable().optional(),
        countMakeupOverride: z.boolean().nullable().optional(),
        slots: z
          .array(
            z
              .object({
                weekday: z.number().int().min(1).max(7),
                startTime: clockTime,
                endTime: clockTime,
                room: z.string().trim().max(100).nullable().optional(),
              })
              .strict(),
          )
          .max(14)
          .default([]),
      })
      .strict(),
    keyFields: ["subject", "study", "name"],
    key: (r) => `${studyKey(r.subject, r.study)}|${normalise(r.name)}`,
    existing: async (db, centreId) =>
      new Map(
        (
          await db
            .selectFrom("groups")
            .innerJoin("studies", "studies.id", "groups.study_id")
            .innerJoin("subjects", "subjects.id", "studies.subject_id")
            .select(["groups.id", "groups.name", "studies.name as study", "subjects.name as subject"])
            .where("groups.centre_id", "=", centreId)
            .where("groups.kind", "=", "study")
            .execute()
        ).map((g) => [`${studyKey(g.subject, g.study)}|${normalise(g.name)}`, g.id]),
      ),
    references: async (db, centreId) => {
      const [studies, instructors, rooms] = await Promise.all([
        db
          .selectFrom("studies")
          .innerJoin("subjects", "subjects.id", "studies.subject_id")
          .select(["studies.id", "studies.name", "subjects.name as subject"])
          .where("studies.centre_id", "=", centreId)
          .execute(),
        db.selectFrom("instructors").select(["id", "email", "first_name as firstName", "last_name as lastName"]).where("centre_id", "=", centreId).execute(),
        db.selectFrom("rooms").select(["id", "name"]).where("centre_id", "=", centreId).execute(),
      ]);
      return {
        study: new Map(studies.map((s) => [studyKey(s.subject, s.name), s.id])),
        instructor: peopleIndex(instructors),
        room: nameIndex(rooms.map((r): [string, string] => [normalise(r.name), r.id])),
      };
    },
    toBody: (row, refs) => {
      const problems: string[] = [];
      const studyId = refs.study!.get(studyKey(row.subject, row.study));
      if (!studyId) problems.push(`unknown reference study:${String(row.subject)} / ${String(row.study)}`);
      const instructorId = resolve(refs.instructor!, "instructor", row.instructor, problems);
      const roomId = row.room ? resolve(refs.room!, "room", row.room, problems) : null;
      const slots = (row.slots as { weekday: number; startTime: string; endTime: string; room?: string | null }[]).map((s) => ({
        weekday: s.weekday,
        startTime: s.startTime,
        endTime: s.endTime,
        ...(s.room ? { roomId: resolve(refs.room!, "room", s.room, problems) } : {}),
      }));
      if (problems.length) return { problems };
      const { subject: _subject, study: _study, instructor: _instructor, room: _room, slots: _slots, ...rest } = row;
      return { body: { ...rest, kind: "study", studyId, instructorId, roomId, slots } };
    },
    url: "/api/groups",
    body: groupCreate,
  },
  {
    entity: "enrolments",
    description:
      "Inscriptions des élèves dans les groupes. La date d'effet fixe le début de l'échéancier : à la reprise, prendre la date de bascule, l'antériorité n'étant pas recréée",
    permission: "enrolments:write",
    dependsOn: ["students", "groups"],
    row: z
      .object({
        student: requiredText(254),
        subject: requiredText(100),
        study: requiredText(150),
        group: requiredText(100),
        effectiveDate: isoDate,
        paymentMode: z.enum(["full", "installments", "monthly", "per_session"]).optional(),
        plan: z.string().trim().min(1).max(150).optional(),
        firstDueDate: isoDate.optional(),
        proratePartialMonths: z.boolean().optional(),
      })
      .strict(),
    keyFields: ["student", "subject", "study", "group"],
    key: (r) => `${normalise(r.student)}|${studyKey(r.subject, r.study)}|${normalise(r.group)}`,
    existing: async (db, centreId) => {
      const rows = await db
        .selectFrom("enrolments")
        .innerJoin("students", "students.id", "enrolments.student_id")
        .innerJoin("groups", "groups.id", "enrolments.group_id")
        .innerJoin("studies", "studies.id", "groups.study_id")
        .innerJoin("subjects", "subjects.id", "studies.subject_id")
        .select([
          "enrolments.id",
          "students.email",
          "students.first_name as firstName",
          "students.last_name as lastName",
          "groups.name as group",
          "studies.name as study",
          "subjects.name as subject",
        ])
        .where("groups.centre_id", "=", centreId)
        .execute();
      return new Map(rows.flatMap((e) => personNames(e).map((n): [string, string] => [`${n}|${studyKey(e.subject, e.study)}|${normalise(e.group)}`, e.id])));
    },
    references: async (db, centreId) => {
      const [students, groups, plans] = await Promise.all([
        db.selectFrom("students").select(["id", "email", "first_name as firstName", "last_name as lastName"]).where("centre_id", "=", centreId).execute(),
        db
          .selectFrom("groups")
          .innerJoin("studies", "studies.id", "groups.study_id")
          .innerJoin("subjects", "subjects.id", "studies.subject_id")
          .select(["groups.id", "groups.name", "groups.study_id as studyId", "studies.name as study", "subjects.name as subject"])
          .where("groups.centre_id", "=", centreId)
          .where("groups.status", "=", "active")
          .execute(),
        db
          .selectFrom("payment_plans")
          .select(["id", "name", "study_id as studyId"])
          .where("centre_id", "=", centreId)
          .where("status", "=", "active")
          .where("study_id", "is not", null)
          .execute(),
      ]);
      return {
        student: peopleIndex(students),
        group: new Map(groups.map((g) => [`${studyKey(g.subject, g.study)}|${normalise(g.name)}`, g.id])),
        groupStudy: new Map(groups.map((g) => [g.id, g.studyId!])),
        plan: nameIndex(plans.map((p): [string, string] => [`${p.studyId}|${normalise(p.name)}`, p.id])),
      };
    },
    toBody: (row, refs) => {
      const problems: string[] = [];
      const studentId = resolve(refs.student!, "student", row.student, problems);
      const groupId = refs.group!.get(`${studyKey(row.subject, row.study)}|${normalise(row.group)}`);
      if (!groupId) problems.push(`unknown reference group:${String(row.subject)} / ${String(row.study)} / ${String(row.group)}`);
      let planId: string | undefined;
      if (groupId && row.plan) planId = resolve(refs.plan!, "plan", `${refs.groupStudy!.get(groupId)}|${normalise(row.plan)}`, problems);
      if (problems.length)
        return { problems: problems.map((p) => (p.startsWith("unknown reference plan:") ? `unknown reference plan:${String(row.plan)}` : p)) };
      const { student: _student, subject: _subject, study: _study, group: _group, plan: _plan, ...rest } = row;
      return { body: { ...rest, studentId, groupId, ...(planId ? { planId } : {}) } };
    },
    url: "/api/enrolments",
    body: enrolmentBody,
  },
  {
    entity: "subscriptions",
    description: "Abonnements des membres du coworking. La date de début fixe la première facturation : à la reprise, prendre la date de bascule",
    permission: "coworking:write",
    dependsOn: ["members"],
    row: z
      .object({
        member: requiredText(254),
        plan: requiredText(150),
        startsOn: isoDate,
        resource: z.string().trim().max(50).nullable().optional(),
        autoRenew: z.boolean().optional(),
      })
      .strict(),
    keyFields: ["member", "plan", "startsOn"],
    key: (r) => `${normalise(r.member)}|${normalise(r.plan)}|${String(r.startsOn)}`,
    existing: async (db, centreId) => {
      const rows = await db
        .selectFrom("cw_subscriptions")
        .innerJoin("members", "members.id", "cw_subscriptions.member_id")
        .innerJoin("cw_plans", "cw_plans.id", "cw_subscriptions.plan_id")
        .select([
          "cw_subscriptions.id",
          "cw_subscriptions.starts_on as startsOn",
          "members.email",
          "members.first_name as firstName",
          "members.last_name as lastName",
          "cw_plans.name as plan",
        ])
        .where("cw_subscriptions.centre_id", "=", centreId)
        .where("cw_subscriptions.status", "!=", "cancelled")
        .execute();
      return new Map(rows.flatMap((s) => personNames(s).map((n): [string, string] => [`${n}|${normalise(s.plan)}|${String(s.startsOn).slice(0, 10)}`, s.id])));
    },
    references: async (db, centreId) => {
      const [members, plans, resources] = await Promise.all([
        db.selectFrom("members").select(["id", "email", "first_name as firstName", "last_name as lastName"]).where("centre_id", "=", centreId).execute(),
        db.selectFrom("cw_plans").select(["id", "name"]).where("centre_id", "=", centreId).where("status", "=", "active").execute(),
        db.selectFrom("cw_resources").select(["id", "code"]).where("centre_id", "=", centreId).execute(),
      ]);
      return {
        member: peopleIndex(members),
        plan: nameIndex(plans.map((p): [string, string] => [normalise(p.name), p.id])),
        resource: nameIndex(resources.map((r): [string, string] => [normalise(r.code), r.id])),
      };
    },
    toBody: (row, refs) => {
      const problems: string[] = [];
      const memberId = resolve(refs.member!, "member", row.member, problems);
      const planId = resolve(refs.plan!, "plan", row.plan, problems);
      const assignedResourceId = row.resource ? resolve(refs.resource!, "resource", row.resource, problems) : undefined;
      if (problems.length) return { problems };
      return {
        body: {
          memberId,
          planId,
          startsOn: row.startsOn,
          ...(assignedResourceId ? { assignedResourceId } : {}),
          ...(row.autoRenew === undefined ? {} : { autoRenew: row.autoRenew }),
        },
      };
    },
    url: "/api/coworking/subscriptions",
    body: subscriptionCreate,
  },
  {
    entity: "cafe-stock",
    description: "Stock initial des produits du café, saisi comme un inventaire avec son motif ; un produit qui a déjà un mouvement de stock n'est pas repris",
    permission: "cafe:manage",
    dependsOn: ["cafe-products"],
    row: z.object({ product: requiredText(80), counted: z.number().int().min(0).max(1_000_000), reason }).strict(),
    keyFields: ["product"],
    key: (r) => normalise(r.product),
    existing: async (db, centreId) =>
      byName(
        await db
          .selectFrom("cafe_products")
          .select(["cafe_products.id", "cafe_products.name"])
          .where("cafe_products.centre_id", "=", centreId)
          .where((eb) =>
            eb.exists(
              eb.selectFrom("cafe_stock_movements").select("cafe_stock_movements.id").whereRef("cafe_stock_movements.product_id", "=", "cafe_products.id"),
            ),
          )
          .execute(),
      ),
    references: async (db, centreId) => ({
      product: nameIndex(
        (await db.selectFrom("cafe_products").select(["id", "name"]).where("centre_id", "=", centreId).execute()).map((p): [string, string] => [
          normalise(p.name),
          p.id,
        ]),
      ),
    }),
    toBody: (row, refs) => {
      const problems: string[] = [];
      const productId = resolve(refs.product!, "product", row.product, problems);
      if (problems.length) return { problems };
      return { body: { kind: "count", counted: row.counted, reason: row.reason }, url: `/api/cafe/products/${productId}/stock` };
    },
    url: "/api/cafe/products",
    resultId: (answer) => String(answer.productId),
    body: stockBody,
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
): Promise<{ results: RowResult[]; bodies: Map<number, { body: Record<string, unknown>; url: string }> }> {
  const [existing, refs] = await Promise.all([definition.existing(db, centreId), definition.references(db, centreId)]);
  const seen = new Map<string, number>();
  const bodies = new Map<number, { body: Record<string, unknown>; url: string }>();
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
    if ("problems" in mapped) return { line, action: "error", key, errors: mapped.problems };
    const checked = definition.body.safeParse(mapped.body);
    if (!checked.success) return { line, action: "error", key, errors: issues(checked.error) };
    bodies.set(line, { body: mapped.body, url: mapped.url ?? definition.url });
    return { line, action: "create", key, errors: [] };
  });
  return { results, bodies };
}

export function summarise(results: RowResult[]): Record<RowAction, number> {
  const summary: Record<RowAction, number> = { create: 0, exists: 0, error: 0, created: 0, failed: 0 };
  for (const r of results) summary[r.action] += 1;
  return summary;
}
