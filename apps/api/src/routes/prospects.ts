import { todayIn } from "@gcf/shared";
import type { FastifyPluginAsync } from "fastify";
import { sql, type Kysely, type Transaction } from "kysely";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import type { SessionUser } from "../auth/sessions.js";
import type { Database, ProspectStage } from "../db/types.js";
import { conflict, HttpError, notFound, unprocessable } from "../errors.js";
import { idParam, isoDate, optionalEmail, optionalText, requiredText, uuid } from "../validation.js";

type Db = Kysely<Database> | Transaction<Database>;

const STAGES = ["new", "contacted", "visit", "proposal", "won", "lost"] as const;
const OPEN_STAGES: ProspectStage[] = ["new", "contacted", "visit", "proposal"];
const color = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "expected #rrggbb")
  .transform((v) => v.toLowerCase());

const prospectFields = {
  name: requiredText(120),
  company: optionalText(120),
  email: optionalEmail,
  phone: optionalText(40),
  interests: z.array(z.enum(["training", "coworking", "rental", "cafe", "other"])).max(5),
  source: z.enum(["website", "walk_in", "phone", "referral", "event", "social", "other"]),
  ownerId: uuid.nullable(),
  nextAction: optionalText(200),
  nextActionOn: isoDate.nullable(),
  notes: optionalText(2000),
  tagIds: z.array(uuid).max(20),
};
const createBody = z.object(prospectFields).partial().required({ name: true, source: true }).strict();
const updateBody = z.object(prospectFields).partial().strict();
const stageBody = z
  .object({ stage: z.enum(STAGES).exclude(["won"]), lostReason: optionalText(300) })
  .strict()
  .refine((b) => b.stage !== "lost" || !!b.lostReason, { message: "a lost prospect needs a reason", path: ["lostReason"] });
const activityBody = z.object({ kind: z.enum(["note", "call", "email", "visit"]), text: requiredText(2000) }).strict();
const convertBody = z.object({ target: z.enum(["member", "student"]) }).strict();
const tagBody = z.object({ name: requiredText(40), color }).strict();
const listQuery = z.object({
  stage: z.enum([...STAGES, "open", "all"]).default("open"),
  tagId: uuid.optional(),
  ownerId: uuid.optional(),
  due: z.enum(["true", "false"]).optional(),
  q: z.string().trim().max(60).optional(),
});

const STAGE_LABEL: Record<ProspectStage, string> = {
  new: "Nouveau",
  contacted: "Contacté",
  visit: "Visite",
  proposal: "Proposition",
  won: "Gagné",
  lost: "Perdu",
};

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

function prospectRows(db: Db, centreId: string) {
  return db
    .selectFrom("prospects as p")
    .leftJoin("users as u", "u.id", "p.owner_id")
    .select([
      "p.id",
      "p.name",
      "p.company",
      "p.email",
      "p.phone",
      "p.interests",
      "p.source",
      "p.stage",
      "p.lost_reason as lostReason",
      "p.owner_id as ownerId",
      "u.full_name as ownerName",
      "p.next_action as nextAction",
      "p.next_action_on as nextActionOn",
      "p.notes",
      "p.site_lead_id as siteLeadId",
      "p.member_id as memberId",
      "p.student_id as studentId",
      "p.won_at as wonAt",
      "p.created_at as createdAt",
      "p.updated_at as updatedAt",
      sql<{ id: string; name: string; color: string }[]>`(select coalesce(json_agg(json_build_object('id', t.id, 'name', t.name, 'color', t.color)
        order by lower(t.name)), '[]') from prospect_tag_links l join prospect_tags t on t.id = l.tag_id where l.prospect_id = p.id)`.as("tags"),
    ])
    .where("p.centre_id", "=", centreId);
}

async function assertTags(db: Db, centreId: string, tagIds: string[]): Promise<void> {
  if (tagIds.length === 0) return;
  const found = await db.selectFrom("prospect_tags").select("id").where("centre_id", "=", centreId).where("id", "in", tagIds).execute();
  if (found.length !== new Set(tagIds).size) throw unprocessable("prospect_tag_unknown", "a tag does not exist");
}

async function assertOwner(db: Db, centreId: string, ownerId: string | null | undefined): Promise<void> {
  if (!ownerId) return;
  const user = await db
    .selectFrom("users")
    .select("id")
    .where("id", "=", ownerId)
    .where("centre_id", "=", centreId)
    .where("active", "=", true)
    .executeTakeFirst();
  if (!user) throw unprocessable("prospect_owner_unknown", "the owner must be an active user of the centre");
}

async function setTags(trx: Transaction<Database>, prospectId: string, tagIds: string[]): Promise<void> {
  await trx.deleteFrom("prospect_tag_links").where("prospect_id", "=", prospectId).execute();
  if (tagIds.length) {
    await trx
      .insertInto("prospect_tag_links")
      .values([...new Set(tagIds)].map((tag_id) => ({ prospect_id: prospectId, tag_id })))
      .execute();
  }
}

async function logActivity(trx: Transaction<Database>, prospectId: string, kind: "note" | "call" | "email" | "visit" | "stage", text: string, userId: string) {
  await trx.insertInto("prospect_activities").values({ prospect_id: prospectId, kind, text, user_id: userId }).execute();
  await trx.updateTable("prospects").set({ updated_at: new Date() }).where("id", "=", prospectId).execute();
}

/** Splits a full name into first and last name at the first space. */
function splitName(name: string): { first: string; last: string | null } {
  const [first, ...rest] = name.trim().split(/\s+/);
  return { first: first!, last: rest.length ? rest.join(" ") : null };
}

/** Prospects: follow-up from first contact to signing up, with tags, activities, website requests and conversion. */
export const prospectRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  const read = app.requirePermission("prospects:read");
  const write = app.requirePermission("prospects:write");
  const audit = (
    trx: Transaction<Database>,
    actor: SessionUser,
    action: string,
    objectId: string,
    extra: { before?: unknown; after?: unknown; reason?: string },
  ) => writeAudit(trx, { centreId: actor.centreId, userId: actor.userId, action, objectType: "prospect", objectId, ...extra });

  const loadProspect = async (centreId: string, id: string) => {
    const row = await prospectRows(db, centreId).where("p.id", "=", id).executeTakeFirst();
    if (!row) throw notFound("prospect");
    return row;
  };

  /* Tags */

  app.get("/tags", { preHandler: read }, async (request) =>
    db
      .selectFrom("prospect_tags")
      .select(["id", "name", "color"])
      .where("centre_id", "=", request.user!.centreId)
      .orderBy(sql`lower(name)`)
      .execute(),
  );

  app.post("/tags", { preHandler: write }, async (request, reply) => {
    const actor = request.user!;
    const body = tagBody.parse(request.body);
    const tag = await db
      .insertInto("prospect_tags")
      .values({ centre_id: actor.centreId, name: body.name, color: body.color })
      .returning(["id", "name", "color"])
      .executeTakeFirstOrThrow();
    return reply.status(201).send(tag);
  });

  app.patch("/tags/:id", { preHandler: write }, async (request) => {
    const { id } = idParam.parse(request.params);
    const body = tagBody.parse(request.body);
    const tag = await db
      .updateTable("prospect_tags")
      .set({ name: body.name, color: body.color })
      .where("id", "=", id)
      .where("centre_id", "=", request.user!.centreId)
      .returning(["id", "name", "color"])
      .executeTakeFirst();
    if (!tag) throw notFound("tag");
    return tag;
  });

  /** Removing a tag takes it off every prospect. */
  app.delete("/tags/:id", { preHandler: write }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const removed = await db
      .deleteFrom("prospect_tags")
      .where("id", "=", id)
      .where("centre_id", "=", request.user!.centreId)
      .returning("id")
      .executeTakeFirst();
    if (!removed) throw notFound("tag");
    return reply.status(204).send();
  });

  /* Prospects */

  /** Prospects with their tags; `due` keeps those whose next action is today or late. Counts cover every stage. */
  app.get("/", { preHandler: read }, async (request) => {
    const centreId = request.user!.centreId;
    const query = listQuery.parse(request.query);
    const centre = await db.selectFrom("centres").select("timezone").where("id", "=", centreId).executeTakeFirstOrThrow();
    const today = todayIn(centre.timezone);
    const items = await prospectRows(db, centreId)
      .$if(query.stage === "open", (qb) => qb.where("p.stage", "in", OPEN_STAGES))
      .$if(query.stage !== "open" && query.stage !== "all", (qb) => qb.where("p.stage", "=", query.stage as ProspectStage))
      .$if(!!query.tagId, (qb) =>
        qb.where((eb) =>
          eb.exists(eb.selectFrom("prospect_tag_links as l").select("l.tag_id").whereRef("l.prospect_id", "=", "p.id").where("l.tag_id", "=", query.tagId!)),
        ),
      )
      .$if(!!query.ownerId, (qb) => qb.where("p.owner_id", "=", query.ownerId!))
      .$if(query.due === "true", (qb) => qb.where("p.next_action_on", "<=", today).where("p.stage", "in", OPEN_STAGES))
      .$if(!!query.q, (qb) =>
        qb.where((eb) =>
          eb.or([
            eb("p.name", "ilike", `%${escapeLike(query.q!)}%`),
            eb("p.company", "ilike", `%${escapeLike(query.q!)}%`),
            eb("p.email", "ilike", `%${escapeLike(query.q!)}%`),
            eb("p.phone", "ilike", `%${escapeLike(query.q!)}%`),
          ]),
        ),
      )
      .orderBy(sql`p.next_action_on asc nulls last`)
      .orderBy("p.updated_at", "desc")
      .limit(500)
      .execute();
    const counts = await db
      .selectFrom("prospects")
      .select(["stage", sql<number>`count(*)::integer`.as("count")])
      .where("centre_id", "=", centreId)
      .groupBy("stage")
      .execute();
    const due = await db
      .selectFrom("prospects")
      .select(sql<number>`count(*)::integer`.as("count"))
      .where("centre_id", "=", centreId)
      .where("stage", "in", OPEN_STAGES)
      .where("next_action_on", "<=", today)
      .executeTakeFirstOrThrow();
    return { items, today, counts: Object.fromEntries(STAGES.map((s) => [s, counts.find((c) => c.stage === s)?.count ?? 0])), due: due.count };
  });

  app.get("/:id", { preHandler: read }, async (request) => {
    const centreId = request.user!.centreId;
    const { id } = idParam.parse(request.params);
    const prospect = await loadProspect(centreId, id);
    const activities = await db
      .selectFrom("prospect_activities as a")
      .leftJoin("users as u", "u.id", "a.user_id")
      .select(["a.id", "a.kind", "a.text", "a.at", "u.full_name as userName"])
      .where("a.prospect_id", "=", id)
      .orderBy("a.at", "desc")
      .execute();
    return { ...prospect, activities };
  });

  app.post("/", { preHandler: write }, async (request, reply) => {
    const actor = request.user!;
    const body = createBody.parse(request.body);
    if (!body.email && !body.phone) throw unprocessable("prospect_contact_required", "give an e-mail address or a phone number");
    const id = await db.transaction().execute(async (trx) => {
      await assertTags(trx, actor.centreId, body.tagIds ?? []);
      await assertOwner(trx, actor.centreId, body.ownerId);
      const row = await trx
        .insertInto("prospects")
        .values({
          centre_id: actor.centreId,
          name: body.name,
          company: body.company ?? null,
          email: body.email ?? null,
          phone: body.phone ?? null,
          interests: body.interests ?? [],
          source: body.source,
          owner_id: body.ownerId ?? actor.userId,
          next_action: body.nextAction ?? null,
          next_action_on: body.nextActionOn ?? null,
          notes: body.notes ?? null,
          created_by: actor.userId,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await setTags(trx, row.id, body.tagIds ?? []);
      await audit(trx, actor, "prospect.created", row.id, { after: body });
      return row.id;
    });
    return reply.status(201).send(await loadProspect(actor.centreId, id));
  });

  /** Turns a website request into a prospect and marks the request handled. A request becomes one prospect only. */
  app.post("/from-lead/:id", { preHandler: write }, async (request, reply) => {
    const actor = request.user!;
    const { id: leadId } = idParam.parse(request.params);
    const id = await db.transaction().execute(async (trx) => {
      const lead = await trx
        .selectFrom("site_leads")
        .select(["id", "kind", "name", "email", "phone", "company", "message", "status"])
        .where("id", "=", leadId)
        .where("centre_id", "=", actor.centreId)
        .forUpdate()
        .executeTakeFirst();
      if (!lead) throw notFound("lead");
      const existing = await trx.selectFrom("prospects").select("id").where("site_lead_id", "=", lead.id).executeTakeFirst();
      if (existing) throw new HttpError(409, "lead_already_prospect", "this request is already a prospect", { prospectId: existing.id });
      const row = await trx
        .insertInto("prospects")
        .values({
          centre_id: actor.centreId,
          name: lead.name,
          company: lead.company,
          email: lead.email,
          phone: lead.phone,
          source: "website",
          owner_id: actor.userId,
          site_lead_id: lead.id,
          created_by: actor.userId,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      if (lead.message) await logActivity(trx, row.id, "note", `Message du site : ${lead.message}`, actor.userId);
      if (lead.status === "new") {
        await trx.updateTable("site_leads").set({ status: "handled", handled_at: new Date(), handled_by: actor.userId }).where("id", "=", lead.id).execute();
      }
      await audit(trx, actor, "prospect.created", row.id, { after: { fromLead: lead.id } });
      return row.id;
    });
    return reply.status(201).send(await loadProspect(actor.centreId, id));
  });

  app.patch("/:id", { preHandler: write }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = updateBody.parse(request.body);
    await db.transaction().execute(async (trx) => {
      const before = await trx.selectFrom("prospects").selectAll().where("id", "=", id).where("centre_id", "=", actor.centreId).forUpdate().executeTakeFirst();
      if (!before) throw notFound("prospect");
      const email = body.email === undefined ? before.email : body.email;
      const phone = body.phone === undefined ? before.phone : body.phone;
      if (!email && !phone) throw unprocessable("prospect_contact_required", "give an e-mail address or a phone number");
      if (body.tagIds) await assertTags(trx, actor.centreId, body.tagIds);
      await assertOwner(trx, actor.centreId, body.ownerId);
      await trx
        .updateTable("prospects")
        .set({
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.company === undefined ? {} : { company: body.company }),
          ...(body.email === undefined ? {} : { email: body.email }),
          ...(body.phone === undefined ? {} : { phone: body.phone }),
          ...(body.interests === undefined ? {} : { interests: body.interests }),
          ...(body.source === undefined ? {} : { source: body.source }),
          ...(body.ownerId === undefined ? {} : { owner_id: body.ownerId }),
          ...(body.nextAction === undefined ? {} : { next_action: body.nextAction }),
          ...(body.nextActionOn === undefined ? {} : { next_action_on: body.nextActionOn }),
          ...(body.notes === undefined ? {} : { notes: body.notes }),
          updated_at: new Date(),
        })
        .where("id", "=", id)
        .execute();
      if (body.tagIds) await setTags(trx, id, body.tagIds);
      await audit(trx, actor, "prospect.updated", id, { after: body });
    });
    return loadProspect(actor.centreId, id);
  });

  /** Moves a prospect through the follow-up; a lost prospect keeps its reason and can be reopened. "Won" comes from a conversion. */
  app.post("/:id/stage", { preHandler: write }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = stageBody.parse(request.body);
    await db.transaction().execute(async (trx) => {
      const before = await trx
        .selectFrom("prospects")
        .select("stage")
        .where("id", "=", id)
        .where("centre_id", "=", actor.centreId)
        .forUpdate()
        .executeTakeFirst();
      if (!before) throw notFound("prospect");
      if (before.stage === "won") throw conflict("prospect_won", "a prospect who became a client stays won");
      if (before.stage === body.stage) return;
      await trx
        .updateTable("prospects")
        .set({ stage: body.stage, lost_reason: body.stage === "lost" ? body.lostReason! : null })
        .where("id", "=", id)
        .execute();
      await logActivity(
        trx,
        id,
        "stage",
        `${STAGE_LABEL[before.stage]} → ${STAGE_LABEL[body.stage]}${body.stage === "lost" ? ` : ${body.lostReason}` : ""}`,
        actor.userId,
      );
      await audit(trx, actor, "prospect.stage", id, {
        before: { stage: before.stage },
        after: { stage: body.stage },
        ...(body.lostReason ? { reason: body.lostReason } : {}),
      });
    });
    return loadProspect(actor.centreId, id);
  });

  app.post("/:id/activities", { preHandler: write }, async (request, reply) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = activityBody.parse(request.body);
    await db.transaction().execute(async (trx) => {
      const prospect = await trx.selectFrom("prospects").select("id").where("id", "=", id).where("centre_id", "=", actor.centreId).executeTakeFirst();
      if (!prospect) throw notFound("prospect");
      await logActivity(trx, id, body.kind, body.text, actor.userId);
    });
    return reply.status(201).send(await loadProspect(actor.centreId, id));
  });

  /**
   * Signs a prospect up as a coworking client (who needs an e-mail address for the client portal) or as a student
   * (who needs a first and a last name), and marks the prospect won. The new record is checked like one created
   * from its own page; its other details are completed there.
   */
  app.post("/:id/convert", { preHandler: write }, async (request, reply) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const { target } = convertBody.parse(request.body);
    const modules = (await db.selectFrom("centres").select("modules").where("id", "=", actor.centreId).executeTakeFirstOrThrow()).modules;
    if (!modules.includes(target === "member" ? "coworking" : "training")) throw unprocessable("module_disabled", "this module is not enabled for the centre");
    const result = await db.transaction().execute(async (trx) => {
      const p = await trx.selectFrom("prospects").selectAll().where("id", "=", id).where("centre_id", "=", actor.centreId).forUpdate().executeTakeFirst();
      if (!p) throw notFound("prospect");
      if (p.stage === "won") throw conflict("prospect_won", "this prospect is already a client");
      const { first, last } = splitName(p.name);
      let link: { member_id: string } | { student_id: string };
      if (target === "member") {
        if (!p.email) throw unprocessable("email_required", "a coworking client needs an e-mail address for the client portal");
        const taken = await trx.selectFrom("members").select("id").where("email", "=", p.email).executeTakeFirst();
        if (taken) throw new HttpError(409, "email_taken", "another client already uses this e-mail address", { memberId: taken.id });
        const member = await trx
          .insertInto("members")
          .values({
            centre_id: actor.centreId,
            kind: "member",
            first_name: first,
            last_name: last,
            email: p.email,
            phone: p.phone,
            status: "active",
            password_hash: null,
            notes: p.company ? `Société indiquée : ${p.company}` : null,
            created_by: actor.userId,
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        await writeAudit(trx, {
          centreId: actor.centreId,
          userId: actor.userId,
          action: "member.created",
          objectType: "member",
          objectId: member.id,
          after: { fromProspect: id },
        });
        link = { member_id: member.id };
      } else {
        if (!last) throw unprocessable("name_incomplete", "a student needs a first and a last name");
        const student = await trx
          .insertInto("students")
          .values({ centre_id: actor.centreId, first_name: first, last_name: last, phone: p.phone, email: p.email, created_by: actor.userId })
          .returning("id")
          .executeTakeFirstOrThrow();
        await writeAudit(trx, {
          centreId: actor.centreId,
          userId: actor.userId,
          action: "student.created",
          objectType: "student",
          objectId: student.id,
          after: { fromProspect: id },
        });
        link = { student_id: student.id };
      }
      await trx
        .updateTable("prospects")
        .set({ ...link, stage: "won", won_at: new Date(), lost_reason: null, next_action: null, next_action_on: null })
        .where("id", "=", id)
        .execute();
      await logActivity(trx, id, "stage", `${STAGE_LABEL[p.stage]} → Gagné (${target === "member" ? "client coworking" : "élève"})`, actor.userId);
      await audit(trx, actor, "prospect.won", id, { before: { stage: p.stage }, after: { stage: "won", ...link } });
      return link;
    });
    return reply.status(201).send({ ...(await loadProspect(actor.centreId, id)), created: result });
  });
};
