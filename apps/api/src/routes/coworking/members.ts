import { formatTnd } from "@gcf/shared";
import type { FastifyPluginAsync } from "fastify";
import { sql, type Transaction } from "kysely";
import { z } from "zod";
import { writeAudit } from "../../audit.js";
import { deleteMemberSessions } from "../../auth/memberSessions.js";
import { issueMemberToken, MEMBER_TOKEN_TTL_MINUTES } from "../../auth/memberTokens.js";
import type { SessionUser } from "../../auth/sessions.js";
import type { CwMailKind } from "../../db/types.coworking.js";
import type { Database } from "../../db/types.js";
import { cancelMemberCharges, issueMemberCharges } from "../../domain/coworking/memberCharges.js";
import { portalLink, sendMemberMail } from "../../domain/coworking/memberMail.js";
import {
  assertAssignableResource,
  createSubscription,
  loadPlanForSale,
  periodEnd,
  renewSubscription,
} from "../../domain/coworking/subscriptions.js";
import { centreClock, installmentBalances, lockPayer, payerTotals, settlePayer, type Payer } from "../../domain/ledger.js";
import { addDays } from "@gcf/shared";
import { conflict, HttpError, notFound, unprocessable } from "../../errors.js";
import { archiveBody, idParam, optionalEmail, optionalText, reason, requiredText, uuid } from "../../validation.js";

const page = { page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) };
const flag = z.enum(["true", "false"]).optional();
const email = z.string().trim().toLowerCase().email().max(254);

const companyFields = {
  name: requiredText(150),
  taxId: optionalText(50),
  address: optionalText(300),
  email: optionalEmail,
  phone: optionalText(40),
};
const companyCreate = z.object(companyFields).strict();
const companyUpdate = z.object(companyFields).partial().strict();
const companyQuery = z.object({ q: z.string().trim().max(100).optional(), status: z.enum(["active", "archived", "all"]).default("active") });

const memberFields = {
  firstName: requiredText(100),
  lastName: optionalText(100),
  email: optionalEmail,
  phone: optionalText(40),
  companyId: uuid.nullable().optional(),
  companyRole: z.enum(["admin", "member"]).nullable().optional(),
  notes: optionalText(2000),
};
const memberCreate = z.object({ kind: z.enum(["member", "guest"]), ...memberFields }).strict();
const memberUpdate = z.object(memberFields).partial().strict();
const memberQuery = z.object({
  q: z.string().trim().max(100).optional(),
  kind: z.enum(["member", "guest"]).optional(),
  status: z.enum(["pending", "active", "disabled"]).optional(),
  hasSubscription: flag,
  companyId: uuid.optional(),
  ...page,
});
const convertBody = z.object({ email, lastName: optionalText(100), phone: optionalText(40) }).strict();

const subscriptionCreate = z
  .object({ memberId: uuid, planId: uuid, startsOn: z.string(), assignedResourceId: uuid.nullable().optional(), autoRenew: z.boolean().optional() })
  .strict();
const subscriptionQuery = z.object({
  status: z.enum(["current", "upcoming", "ended", "cancelled", "all"]).default("all"),
  memberId: uuid.optional(),
  endingWithinDays: z.coerce.number().int().min(0).max(366).optional(),
  unpaid: flag,
  ...page,
});
const terminateBody = z.object({ endsOn: z.string(), reason }).strict();
const autoRenewBody = z.object({ autoRenew: z.boolean() }).strict();

const packSell = z.object({ memberId: uuid, productId: uuid }).strict();

const MAIL_KINDS = ["letter", "registered", "parcel", "other"] as const;
const mailCreate = z.object({ memberId: uuid, kind: z.enum(MAIL_KINDS), sender: optionalText(200), reference: optionalText(100), notes: optionalText(1000) }).strict();
const mailQuery = z.object({
  status: z.enum(["open", "received", "notified", "collected", "returned", "all"]).default("all"),
  memberId: uuid.optional(),
  ...page,
});
const collectBody = z.object({ collectedByName: requiredText(150), notes: optionalText(1000) }).strict();
const MAIL_KIND_FR: Record<CwMailKind, string> = { letter: "une lettre", registered: "une lettre recommandée", parcel: "un colis", other: "un envoi" };

const NARROW_NBSP = String.fromCharCode(0x202f);
const tnd = (amount: number) => `${formatTnd(amount, "fr").split(NARROW_NBSP).join(" ")} TND`;
const frDate = (iso: string) => iso.split("-").reverse().join("/");
const escapeLike = (value: string) => `%${value.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const isoDate = (value: string, field: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new HttpError(400, "invalid_input", "the request is invalid", [{ path: field, message: "expected a valid YYYY-MM-DD date" }]);
  }
  return value;
};

const MEMBER_COLUMNS = [
  "members.id",
  "members.kind",
  "members.first_name as firstName",
  "members.last_name as lastName",
  "members.email",
  "members.phone",
  "members.company_id as companyId",
  "companies.name as companyName",
  "members.company_role as companyRole",
  "members.status",
  "members.notes",
  "members.last_login_at as lastLoginAt",
  "members.created_at as createdAt",
  sql<boolean>`members.password_hash is not null`.as("hasPassword"),
] as const;

const COMPANY_COLUMNS = ["id", "name", "tax_id as taxId", "address", "email", "phone", "status", "created_at as createdAt"] as const;

/** Remaining money on the open charges of a subscription; with `today`, only what is already due. */
const subscriptionDue = (today?: string) =>
  sql<number>`(select coalesce(sum(i.amount - coalesce((select sum(a.amount) from effective_allocations a where a.installment_id = i.id), 0)), 0)::bigint
    from installments i where i.cw_subscription_id = s.id and i.kind = 'charge' and i.status = 'open'
    ${today === undefined ? sql`` : sql`and i.due_date <= ${today}::date`})`;

const subscriptionState = (today: string) =>
  sql<"current" | "upcoming" | "ended" | "cancelled">`case when s.status = 'cancelled' then 'cancelled' when s.starts_on > ${today}::date then 'upcoming'
    when s.ends_on < ${today}::date then 'ended' else 'current' end`;

/** Members, companies, subscriptions, credit packs, domiciliation mail and member accounts (staff). */
export const coworkingMemberRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  const read = app.requirePermission("coworking:read");
  const write = app.requirePermission("coworking:write");

  const audit = (trx: Transaction<Database>, actor: SessionUser, action: string, objectType: string, objectId: string, extra: { before?: unknown; after?: unknown; reason?: string }) =>
    writeAudit(trx, { centreId: actor.centreId, userId: actor.userId, action, objectType, objectId, ...extra });

  const centreName = async (centreId: string) => (await db.selectFrom("centres").select("name").where("id", "=", centreId).executeTakeFirstOrThrow()).name;

  /* Companies */

  app.get("/companies", { preHandler: read }, async (request) => {
    const query = companyQuery.parse(request.query);
    return db
      .selectFrom("companies")
      .select([
        ...COMPANY_COLUMNS,
        (eb) =>
          eb
            .selectFrom("members")
            .select(sql<number>`count(*)::integer`.as("n"))
            .whereRef("members.company_id", "=", "companies.id")
            .where("members.status", "!=", "disabled")
            .as("memberCount"),
      ])
      .where("centre_id", "=", request.user!.centreId)
      .$if(query.status !== "all", (qb) => qb.where("status", "=", query.status as "active" | "archived"))
      .$if(!!query.q, (qb) =>
        qb.where((eb) =>
          eb.or([eb(sql`lower(name)`, "like", escapeLike(query.q!)), eb(sql`lower(coalesce(tax_id, ''))`, "like", escapeLike(query.q!))]),
        ),
      )
      .orderBy(sql`lower(name)`)
      .limit(200)
      .execute();
  });

  app.post("/companies", { preHandler: write }, async (request, reply) => {
    const actor = request.user!;
    const body = companyCreate.parse(request.body);
    const row = await db.transaction().execute(async (trx) => {
      const created = await trx
        .insertInto("companies")
        .values({
          centre_id: actor.centreId,
          name: body.name,
          tax_id: body.taxId ?? null,
          address: body.address ?? null,
          email: body.email ?? null,
          phone: body.phone ?? null,
          created_by: actor.userId,
        })
        .returning(COMPANY_COLUMNS)
        .executeTakeFirstOrThrow();
      await audit(trx, actor, "company.created", "company", created.id, { after: created });
      return created;
    });
    return reply.status(201).send(row);
  });

  app.patch("/companies/:id", { preHandler: write }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = companyUpdate.parse(request.body);
    return db.transaction().execute(async (trx) => {
      const before = await trx
        .selectFrom("companies")
        .select(COMPANY_COLUMNS)
        .where("id", "=", id)
        .where("centre_id", "=", actor.centreId)
        .forUpdate()
        .executeTakeFirst();
      if (!before) throw notFound("company");
      const after = await trx
        .updateTable("companies")
        .set({
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.taxId === undefined ? {} : { tax_id: body.taxId }),
          ...(body.address === undefined ? {} : { address: body.address }),
          ...(body.email === undefined ? {} : { email: body.email }),
          ...(body.phone === undefined ? {} : { phone: body.phone }),
          updated_at: new Date(),
        })
        .where("id", "=", id)
        .returning(COMPANY_COLUMNS)
        .executeTakeFirstOrThrow();
      await audit(trx, actor, "company.updated", "company", id, { before, after });
      return after;
    });
  });

  /** Members keep their link to an archived company; it simply cannot receive new members. */
  app.post("/companies/:id/archive", { preHandler: write }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const { reason } = archiveBody.parse(request.body);
    return db.transaction().execute(async (trx) => {
      const after = await trx
        .updateTable("companies")
        .set({ status: "archived", updated_at: new Date() })
        .where("id", "=", id)
        .where("centre_id", "=", actor.centreId)
        .returning(COMPANY_COLUMNS)
        .executeTakeFirst();
      if (!after) throw notFound("company");
      await audit(trx, actor, "company.archived", "company", id, { after: { status: "archived" }, reason });
      return after;
    });
  });

  app.get("/companies/:id/members", { preHandler: read }, async (request) => {
    const centreId = request.user!.centreId;
    const { id } = idParam.parse(request.params);
    const company = await db.selectFrom("companies").select("id").where("id", "=", id).where("centre_id", "=", centreId).executeTakeFirst();
    if (!company) throw notFound("company");
    return db
      .selectFrom("members")
      .leftJoin("companies", "companies.id", "members.company_id")
      .select(MEMBER_COLUMNS)
      .where("members.company_id", "=", id)
      .orderBy(sql`lower(members.first_name)`)
      .execute();
  });

  /* Members */

  const assertCompany = async (trx: Transaction<Database>, centreId: string, companyId: string) => {
    const company = await trx
      .selectFrom("companies")
      .select("id")
      .where("id", "=", companyId)
      .where("centre_id", "=", centreId)
      .where("status", "=", "active")
      .executeTakeFirst();
    if (!company) throw unprocessable("unknown_company", "the company does not exist or is archived");
  };

  /** E-mail addresses identify portal accounts across the whole platform. */
  const assertEmailFree = async (trx: Transaction<Database>, address: string, memberId: string | null) => {
    const taken = await trx
      .selectFrom("members")
      .select("id")
      .where("email", "=", address)
      .$if(memberId !== null, (qb) => qb.where("id", "!=", memberId!))
      .executeTakeFirst();
    if (taken) throw conflict("email_taken", "another client already uses this e-mail address");
  };

  const loadMemberRow = async (trx: Transaction<Database>, centreId: string, id: string) => {
    const member = await trx
      .selectFrom("members")
      .select(["id", "kind", "first_name", "last_name", "email", "phone", "company_id", "company_role", "status", "password_hash", "notes"])
      .where("id", "=", id)
      .where("centre_id", "=", centreId)
      .forUpdate()
      .executeTakeFirst();
    if (!member) throw notFound("member");
    return member;
  };

  const memberView = async (centreId: string, id: string) => {
    const member = await db
      .selectFrom("members")
      .leftJoin("companies", "companies.id", "members.company_id")
      .select(MEMBER_COLUMNS)
      .where("members.id", "=", id)
      .where("members.centre_id", "=", centreId)
      .executeTakeFirst();
    if (!member) throw notFound("member");
    return member;
  };

  app.get("/members", { preHandler: read }, async (request) => {
    const centreId = request.user!.centreId;
    const query = memberQuery.parse(request.query);
    const { today } = await centreClock(db, centreId);
    const current = sql<boolean>`exists (select 1 from cw_subscriptions s where s.member_id = members.id and s.status = 'active'
      and s.starts_on <= ${today}::date and s.ends_on >= ${today}::date)`;
    let base = db.selectFrom("members").leftJoin("companies", "companies.id", "members.company_id").where("members.centre_id", "=", centreId);
    if (query.kind) base = base.where("members.kind", "=", query.kind);
    if (query.status) base = base.where("members.status", "=", query.status);
    if (query.companyId) base = base.where("members.company_id", "=", query.companyId);
    if (query.hasSubscription) base = base.where(query.hasSubscription === "true" ? current : sql<boolean>`not ${current}`);
    if (query.q) {
      const pattern = escapeLike(query.q);
      base = base.where((eb) =>
        eb.or([
          eb(sql`lower(members.first_name || ' ' || coalesce(members.last_name, ''))`, "like", pattern),
          eb(sql`lower(coalesce(members.last_name, '') || ' ' || members.first_name)`, "like", pattern),
          eb(sql`coalesce(members.email, '')`, "like", pattern),
          eb(sql`coalesce(members.phone, '')`, "like", pattern),
          eb(sql`lower(coalesce(companies.name, ''))`, "like", pattern),
        ]),
      );
    }
    const [{ total }] = (await base.select((eb) => eb.fn.countAll<number>().as("total")).execute()) as [{ total: number }];
    const items = await base
      .select([
        ...MEMBER_COLUMNS,
        sql<string | null>`(select p.name from cw_subscriptions s join cw_plans p on p.id = s.plan_id where s.member_id = members.id and s.status = 'active'
          and s.starts_on <= ${today}::date and s.ends_on >= ${today}::date order by s.starts_on desc limit 1)`.as("currentPlan"),
      ])
      .orderBy(sql`lower(members.first_name)`)
      .orderBy(sql`lower(coalesce(members.last_name, ''))`)
      .orderBy("members.id")
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize)
      .execute();
    return { items, total: Number(total), page: query.page, pageSize: query.pageSize };
  });

  /** The desk view of a client: current subscription, usable packs, activity counters and money totals. */
  app.get("/members/:id", { preHandler: read }, async (request) => {
    const centreId = request.user!.centreId;
    const { id } = idParam.parse(request.params);
    const member = await memberView(centreId, id);
    const { today } = await centreClock(db, centreId);
    const activeSubscription =
      (await db
        .selectFrom("cw_subscriptions as s")
        .innerJoin("cw_plans as p", "p.id", "s.plan_id")
        .leftJoin("cw_resources as r", "r.id", "s.assigned_resource_id")
        .select([
          "s.id",
          "s.plan_id as planId",
          "p.name as planName",
          "s.starts_on as startsOn",
          "s.ends_on as endsOn",
          "s.includes_domiciliation as includesDomiciliation",
          "s.auto_renew as autoRenew",
          "s.assigned_resource_id as assignedResourceId",
          "r.code as assignedResourceCode",
        ])
        .where("s.member_id", "=", id)
        .where("s.status", "=", "active")
        .where("s.starts_on", "<=", today)
        .where("s.ends_on", ">=", today)
        .orderBy("s.starts_on", "desc")
        .executeTakeFirst()) ?? null;
    const packs = (await packRows(centreId, today).where("k.member_id", "=", id).where("k.status", "=", "active").where("k.expires_on", ">=", today).execute())
      .map(presentPack(today))
      .filter((p) => p.remaining > 0);
    const counters = await sql<{ bookingsLast30Days: number; upcomingBookings: number; noShowsLast90Days: number; openMail: number }>`
      select
        (select count(*)::integer from cw_bookings b where b.member_id = ${id} and b.kind = 'booking'
          and b.status in ('confirmed', 'checked_in', 'completed', 'no_show') and b.starts_at >= now() - interval '30 days' and b.starts_at <= now()) as "bookingsLast30Days",
        (select count(*)::integer from cw_bookings b where b.member_id = ${id} and b.status in ('requested', 'confirmed', 'checked_in') and b.ends_at > now()) as "upcomingBookings",
        (select count(*)::integer from cw_bookings b where b.member_id = ${id} and b.status = 'no_show' and b.starts_at >= now() - interval '90 days') as "noShowsLast90Days",
        (select count(*)::integer from cw_mail_items m where m.member_id = ${id} and m.status in ('received', 'notified')) as "openMail"`.execute(db);
    const c = counters.rows[0]!;
    return {
      ...member,
      activeSubscription,
      packs,
      bookingsLast30Days: c.bookingsLast30Days,
      upcomingBookings: c.upcomingBookings,
      noShowsLast90Days: c.noShowsLast90Days,
      openMailCount: c.openMail,
      totals: await payerTotals(db, centreId, { kind: "member", id }),
    };
  });

  /** A member gets a portal account without a password (invited later); a guest is a walk-in recorded at the desk. */
  app.post("/members", { preHandler: write }, async (request, reply) => {
    const actor = request.user!;
    const body = memberCreate.parse(request.body);
    if (body.kind === "member" && !body.email) throw unprocessable("email_required", "a member with a portal account needs an e-mail address");
    const id = await db.transaction().execute(async (trx) => {
      if (body.companyId) await assertCompany(trx, actor.centreId, body.companyId);
      if (body.email) await assertEmailFree(trx, body.email, null);
      const created = await trx
        .insertInto("members")
        .values({
          centre_id: actor.centreId,
          kind: body.kind,
          first_name: body.firstName,
          last_name: body.lastName ?? null,
          email: body.email ?? null,
          phone: body.phone ?? null,
          company_id: body.companyId ?? null,
          company_role: body.companyId ? (body.companyRole ?? "member") : null,
          status: "active",
          password_hash: null,
          notes: body.notes ?? null,
          created_by: actor.userId,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await audit(trx, actor, "member.created", "member", created.id, { after: body });
      return created.id;
    });
    return reply.status(201).send(await memberView(actor.centreId, id));
  });

  app.patch("/members/:id", { preHandler: write }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = memberUpdate.parse(request.body);
    await db.transaction().execute(async (trx) => {
      const before = await loadMemberRow(trx, actor.centreId, id);
      const nextEmail = body.email === undefined ? before.email : body.email;
      if (before.kind === "member" && !nextEmail) throw unprocessable("email_required", "a member with a portal account needs an e-mail address");
      const emailChanged = body.email !== undefined && body.email !== before.email;
      if (emailChanged && body.email) await assertEmailFree(trx, body.email, id);
      const companyId = body.companyId === undefined ? before.company_id : body.companyId;
      if (companyId && companyId !== before.company_id) await assertCompany(trx, actor.centreId, companyId);
      const companyRole = companyId ? (body.companyRole ?? before.company_role ?? "member") : null;
      await trx
        .updateTable("members")
        .set({
          ...(body.firstName === undefined ? {} : { first_name: body.firstName }),
          ...(body.lastName === undefined ? {} : { last_name: body.lastName }),
          ...(body.phone === undefined ? {} : { phone: body.phone }),
          ...(body.notes === undefined ? {} : { notes: body.notes }),
          ...(emailChanged ? { email: body.email ?? null, email_verified_at: null } : {}),
          company_id: companyId,
          company_role: companyRole,
          updated_at: new Date(),
        })
        .where("id", "=", id)
        .execute();
      const { password_hash: _hash, ...visible } = before;
      await audit(trx, actor, "member.updated", "member", id, { before: visible, after: body });
    });
    return memberView(actor.centreId, id);
  });

  /** Disabling signs the member out of the portal at once. */
  app.post("/members/:id/disable", { preHandler: write }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const { reason } = archiveBody.parse(request.body);
    await db.transaction().execute(async (trx) => {
      const member = await loadMemberRow(trx, actor.centreId, id);
      if (member.status === "disabled") throw conflict("member_disabled", "the member is already disabled");
      await trx.updateTable("members").set({ status: "disabled", updated_at: new Date() }).where("id", "=", id).execute();
      await deleteMemberSessions(trx, id);
      await audit(trx, actor, "member.disabled", "member", id, { before: { status: member.status }, after: { status: "disabled" }, reason });
    });
    return memberView(actor.centreId, id);
  });

  app.post("/members/:id/enable", { preHandler: write }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    await db.transaction().execute(async (trx) => {
      const member = await loadMemberRow(trx, actor.centreId, id);
      if (member.status !== "disabled") throw conflict("member_not_disabled", "the member is not disabled");
      await trx.updateTable("members").set({ status: "active", updated_at: new Date() }).where("id", "=", id).execute();
      await audit(trx, actor, "member.enabled", "member", id, { before: { status: "disabled" }, after: { status: "active" } });
    });
    return memberView(actor.centreId, id);
  });

  /** The guest keeps its row, so bookings and payments recorded before stay with the new member. */
  app.post("/members/:id/convert", { preHandler: write }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = convertBody.parse(request.body);
    await db.transaction().execute(async (trx) => {
      const member = await loadMemberRow(trx, actor.centreId, id);
      if (member.kind !== "guest") throw conflict("not_a_guest", "only a guest can be converted into a member");
      await assertEmailFree(trx, body.email, id);
      await trx
        .updateTable("members")
        .set({
          kind: "member",
          email: body.email,
          ...(body.lastName === undefined ? {} : { last_name: body.lastName }),
          ...(body.phone === undefined ? {} : { phone: body.phone }),
          updated_at: new Date(),
        })
        .where("id", "=", id)
        .execute();
      await audit(trx, actor, "member.converted", "member", id, { before: { kind: "guest", email: member.email }, after: { kind: "member", ...body } });
    });
    return memberView(actor.centreId, id);
  });

  /** Sends the activation link of a portal account that has no password yet. */
  app.post("/members/:id/invite", { preHandler: write }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    if (!app.config.publicOrigin) throw new HttpError(503, "portal_not_configured", "the public origin of the client portal is not configured");
    const issued = await db.transaction().execute(async (trx) => {
      const member = await loadMemberRow(trx, actor.centreId, id);
      if (member.kind !== "member" || !member.email) throw conflict("not_a_member", "only a member with an e-mail address has a portal account");
      if (member.status === "disabled") throw conflict("member_disabled", "the member is disabled");
      if (member.status === "pending") throw conflict("member_pending", "validate the sign-up of this member first");
      if (member.password_hash) throw conflict("already_activated", "the member has already chosen a password");
      const token = await issueMemberToken(trx, id, "activation");
      await audit(trx, actor, "member.invited", "member", id, { after: { email: member.email, expiresAt: token.expiresAt } });
      return { ...token, email: member.email, firstName: member.first_name };
    });
    const centre = await centreName(actor.centreId);
    const link = portalLink(app.config.publicOrigin, `/activation?token=${encodeURIComponent(issued.token)}`)!;
    const hours = MEMBER_TOKEN_TTL_MINUTES.activation / 60;
    const mail = await sendMemberMail(db, app.mailer, request.log, {
      centreId: actor.centreId,
      memberId: id,
      kind: "member_activation",
      to: issued.email,
      subject: `${centre} : activez votre espace client`,
      text: `Bonjour ${issued.firstName},\n\nUn espace client a été ouvert pour vous chez ${centre}. Il vous permet de réserver vos espaces et de suivre vos abonnements.\n\nPour choisir votre mot de passe et activer votre compte, ouvrez ce lien (valable ${hours} heures) :\n${link}\n\nSi vous n'attendiez pas ce message, ignorez-le.\n\n${centre}`,
      sentBy: actor.userId,
    });
    return { id, mail, expiresAt: issued.expiresAt };
  });

  /** Accepts a pending self sign-up from the portal and tells the member by e-mail. */
  app.post("/members/:id/validate", { preHandler: write }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const member = await db.transaction().execute(async (trx) => {
      const row = await loadMemberRow(trx, actor.centreId, id);
      if (row.status !== "pending") throw conflict("member_not_pending", "the member is not waiting for validation");
      await trx.updateTable("members").set({ status: "active", updated_at: new Date() }).where("id", "=", id).execute();
      await audit(trx, actor, "member.validated", "member", id, { before: { status: "pending" }, after: { status: "active" } });
      return row;
    });
    let mail: "sent" | "failed" | null = null;
    if (member.email) {
      const centre = await centreName(actor.centreId);
      const link = portalLink(app.config.publicOrigin, "/");
      mail = await sendMemberMail(db, app.mailer, request.log, {
        centreId: actor.centreId,
        memberId: id,
        kind: "member_activation",
        to: member.email,
        subject: `${centre} : votre compte est validé`,
        text: `Bonjour ${member.first_name},\n\nVotre inscription chez ${centre} est validée. Vous pouvez dès maintenant vous connecter à votre espace client${link ? ` :\n${link}` : "."}\n\n${centre}`,
        sentBy: actor.userId,
      });
    }
    return { ...(await memberView(actor.centreId, id)), mail };
  });

  /** Same view as a renter account: charges with their state, credit, totals and payments with their receipts. */
  app.get("/members/:id/account", { preHandler: read }, async (request) => {
    const centreId = request.user!.centreId;
    const { id } = idParam.parse(request.params);
    const member = await memberView(centreId, id);
    const payer: Payer = { kind: "member", id };
    const payments = await db
      .selectFrom("payments")
      .leftJoin("receipts", (join) => join.onRef("receipts.payment_id", "=", "payments.id").on("receipts.kind", "!=", "cancellation"))
      .select([
        "payments.id",
        "payments.kind",
        "payments.received_at as receivedAt",
        "payments.amount",
        "payments.method",
        "payments.cheque_status as chequeStatus",
        "payments.status",
        "payments.cancel_reason as cancelReason",
        "receipts.id as receiptId",
        "receipts.number as receiptNumber",
      ])
      .where("payments.member_id", "=", id)
      .orderBy("payments.received_at", "desc")
      .execute();
    return { member, totals: await payerTotals(db, centreId, payer), installments: await installmentBalances(db, centreId, { payer }), payments };
  });

  /* Subscriptions */

  const subscriptionBase = (centreId: string, today: string) =>
    db
      .selectFrom("cw_subscriptions as s")
      .innerJoin("members as m", "m.id", "s.member_id")
      .innerJoin("cw_plans as p", "p.id", "s.plan_id")
      .leftJoin("cw_resources as r", "r.id", "s.assigned_resource_id")
      .where("s.centre_id", "=", centreId)
      .where(sql<boolean>`true`)
      .$narrowType<{ today: string }>()
      .where(sql<boolean>`${today}::date is not null`);

  const subscriptionColumns = (today: string) =>
    [
      "s.id",
      "s.member_id as memberId",
      sql<string>`concat_ws(' ', m.first_name, m.last_name)`.as("memberName"),
      "s.plan_id as planId",
      "p.name as planName",
      "s.starts_on as startsOn",
      "s.ends_on as endsOn",
      "s.price",
      "s.billing",
      "s.includes_domiciliation as includesDomiciliation",
      "s.entitlements",
      "s.assigned_resource_id as assignedResourceId",
      "r.code as assignedResourceCode",
      "s.auto_renew as autoRenew",
      "s.renewed_from_id as renewedFromId",
      sql<string | null>`(select n.id from cw_subscriptions n where n.renewed_from_id = s.id and n.status = 'active')`.as("renewalId"),
      "s.status",
      "s.cancelled_at as cancelledAt",
      "s.cancel_reason as cancelReason",
      "s.created_at as createdAt",
      subscriptionState(today).as("state"),
      subscriptionDue().as("due"),
      subscriptionDue(today).as("overdue"),
    ] as const;

  const loadSubscription = async (centreId: string, id: string) => {
    const { today } = await centreClock(db, centreId);
    const row = await subscriptionBase(centreId, today).select(subscriptionColumns(today)).where("s.id", "=", id).executeTakeFirst();
    if (!row) throw notFound("subscription");
    const installments = (await installmentBalances(db, centreId, { payer: { kind: "member", id: row.memberId } })).filter((i) => i.cwSubscriptionId === id);
    return { ...row, installments };
  };

  const lockSubscription = async (trx: Transaction<Database>, centreId: string, id: string) => {
    const row = await trx
      .selectFrom("cw_subscriptions")
      .select(["id", "member_id", "starts_on", "ends_on", "status", "auto_renew"])
      .where("id", "=", id)
      .where("centre_id", "=", centreId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw notFound("subscription");
    return row;
  };

  const openSubscriptionCharges = (trx: Transaction<Database>, subscriptionId: string, after?: string) =>
    trx
      .selectFrom("installments")
      .select(["id", "amount"])
      .where("cw_subscription_id", "=", subscriptionId)
      .where("kind", "=", "charge")
      .where("status", "=", "open")
      .$if(after !== undefined, (qb) => qb.where("due_date", ">", after!))
      .execute();

  const activeRenewal = (trx: Transaction<Database>, subscriptionId: string) =>
    trx.selectFrom("cw_subscriptions").select("id").where("renewed_from_id", "=", subscriptionId).where("status", "=", "active").executeTakeFirst();

  app.get("/subscriptions", { preHandler: read }, async (request) => {
    const centreId = request.user!.centreId;
    const query = subscriptionQuery.parse(request.query);
    const { today } = await centreClock(db, centreId);
    let base = subscriptionBase(centreId, today);
    if (query.status !== "all") base = base.where(sql<boolean>`${subscriptionState(today)} = ${query.status}`);
    if (query.memberId) base = base.where("s.member_id", "=", query.memberId);
    if (query.endingWithinDays !== undefined) {
      base = base
        .where("s.status", "=", "active")
        .where("s.ends_on", ">=", today)
        .where("s.ends_on", "<=", addDays(today, query.endingWithinDays));
    }
    if (query.unpaid) base = base.where(sql<boolean>`${subscriptionDue(today)} ${query.unpaid === "true" ? sql`>` : sql`=`} 0`);
    const [{ total }] = (await base.select((eb) => eb.fn.countAll<number>().as("total")).execute()) as [{ total: number }];
    const items = await base
      .select(subscriptionColumns(today))
      .orderBy("s.ends_on", query.endingWithinDays !== undefined ? "asc" : "desc")
      .orderBy("s.id")
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize)
      .execute();
    return { items, total: Number(total), page: query.page, pageSize: query.pageSize };
  });

  app.get("/subscriptions/:id", { preHandler: read }, async (request) => {
    const { id } = idParam.parse(request.params);
    return loadSubscription(request.user!.centreId, id);
  });

  app.post("/subscriptions", { preHandler: write }, async (request, reply) => {
    const actor = request.user!;
    const body = subscriptionCreate.parse(request.body);
    const startsOn = isoDate(body.startsOn, "startsOn");
    const id = await db.transaction().execute(async (trx) => {
      await lockPayer(trx, { kind: "member", id: body.memberId }, actor.centreId);
      const member = await trx.selectFrom("members").select("status").where("id", "=", body.memberId).executeTakeFirstOrThrow();
      if (member.status === "disabled") throw conflict("member_disabled", "the member is disabled");
      const plan = await loadPlanForSale(trx, actor.centreId, body.planId);
      if (!plan || plan.status !== "active") throw unprocessable("unknown_plan", "the plan does not exist or is archived");
      const assignedResourceId = body.assignedResourceId ?? null;
      if (plan.assignedTypeId) {
        if (!assignedResourceId) throw unprocessable("assigned_resource_required", "this plan assigns a resource: choose one");
        await assertAssignableResource(trx, actor.centreId, plan.assignedTypeId, assignedResourceId, startsOn, periodEnd(startsOn, plan.period), {
          allowOutOfService: false,
        });
      } else if (assignedResourceId) {
        throw unprocessable("resource_not_assigned", "this plan does not assign a resource");
      }
      const created = await createSubscription(trx, {
        centreId: actor.centreId,
        memberId: body.memberId,
        plan,
        startsOn,
        assignedResourceId,
        autoRenew: body.autoRenew ?? false,
        renewedFromId: null,
        userId: actor.userId,
      });
      await audit(trx, actor, "cw_subscription.created", "cw_subscription", created.id, {
        after: { ...body, endsOn: created.endsOn, price: plan.price, billing: plan.billing, entitlements: plan.entitlements },
      });
      return created.id;
    });
    return reply.status(201).send(await loadSubscription(actor.centreId, id));
  });

  /** Résiliation: the subscription ends earlier; charges due after the new end are cancelled. */
  app.post("/subscriptions/:id/terminate", { preHandler: write }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = terminateBody.parse(request.body);
    const endsOn = isoDate(body.endsOn, "endsOn");
    await db.transaction().execute(async (trx) => {
      const sub = await lockSubscription(trx, actor.centreId, id);
      if (sub.status !== "active") throw conflict("subscription_cancelled", "the subscription is cancelled");
      const { today } = await centreClock(trx, actor.centreId);
      if (endsOn < today) throw unprocessable("end_before_today", "the new end date cannot be in the past");
      if (endsOn < sub.starts_on) throw unprocessable("end_before_start", "the new end date cannot be before the start of the subscription");
      if (endsOn > sub.ends_on) throw unprocessable("end_after_current", "the new end date cannot be after the current end date");
      if (await activeRenewal(trx, id)) throw conflict("has_renewal", "cancel or terminate the renewal of this subscription first");
      await lockPayer(trx, { kind: "member", id: sub.member_id }, actor.centreId);
      const charges = await openSubscriptionCharges(trx, id, endsOn);
      await cancelMemberCharges(trx, actor.centreId, sub.member_id, { cwSubscriptionId: id }, charges, actor.userId, `abonnement résilié : ${body.reason}`);
      await trx.updateTable("cw_subscriptions").set({ ends_on: endsOn, auto_renew: false }).where("id", "=", id).execute();
      await audit(trx, actor, "cw_subscription.terminated", "cw_subscription", id, {
        before: { endsOn: sub.ends_on, autoRenew: sub.auto_renew },
        after: { endsOn, autoRenew: false, cancelledCharges: charges.length },
        reason: body.reason,
      });
    });
    return loadSubscription(actor.centreId, id);
  });

  /** Cancellation corrects a mistake: allowed only while no money was received on the subscription. */
  app.post("/subscriptions/:id/cancel", { preHandler: write }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const { reason } = archiveBody.parse(request.body);
    await db.transaction().execute(async (trx) => {
      const sub = await lockSubscription(trx, actor.centreId, id);
      if (sub.status !== "active") throw conflict("already_cancelled", "the subscription is already cancelled");
      if (await activeRenewal(trx, id)) throw conflict("has_renewal", "cancel or terminate the renewal of this subscription first");
      await lockPayer(trx, { kind: "member", id: sub.member_id }, actor.centreId);
      const paid = await trx
        .selectFrom("effective_allocations")
        .innerJoin("installments", "installments.id", "effective_allocations.installment_id")
        .select(sql<number>`coalesce(sum(effective_allocations.amount), 0)::bigint`.as("paid"))
        .where("installments.cw_subscription_id", "=", id)
        .executeTakeFirstOrThrow();
      if (Number(paid.paid) > 0) throw conflict("installment_paid", "money was received on this subscription; terminate it instead or cancel the payment first");
      const charges = await openSubscriptionCharges(trx, id);
      await cancelMemberCharges(trx, actor.centreId, sub.member_id, { cwSubscriptionId: id }, charges, actor.userId, `abonnement annulé : ${reason}`);
      await trx
        .updateTable("cw_subscriptions")
        .set({ status: "cancelled", cancelled_at: new Date(), cancelled_by: actor.userId, cancel_reason: reason, auto_renew: false })
        .where("id", "=", id)
        .execute();
      await audit(trx, actor, "cw_subscription.cancelled", "cw_subscription", id, { after: { status: "cancelled", cancelledCharges: charges.length }, reason });
    });
    return loadSubscription(actor.centreId, id);
  });

  app.post("/subscriptions/:id/renew", { preHandler: write }, async (request, reply) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const next = await db.transaction().execute(async (trx) => {
      const created = await renewSubscription(trx, actor.centreId, id, { userId: actor.userId, anyRenewal: false });
      await audit(trx, actor, "cw_subscription.renewed", "cw_subscription", created.id, { after: { ...created, renewedFromId: id, automatic: false } });
      return created;
    });
    return reply.status(201).send(await loadSubscription(actor.centreId, next.id));
  });

  app.put("/subscriptions/:id/auto-renew", { preHandler: write }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = autoRenewBody.parse(request.body);
    await db.transaction().execute(async (trx) => {
      const sub = await lockSubscription(trx, actor.centreId, id);
      if (sub.status !== "active") throw conflict("subscription_cancelled", "the subscription is cancelled");
      const { today } = await centreClock(trx, actor.centreId);
      // Renewing a subscription that ended long ago would create past periods and charges.
      if (body.autoRenew && sub.ends_on < today) throw conflict("subscription_ended", "the subscription has already ended");
      await trx.updateTable("cw_subscriptions").set({ auto_renew: body.autoRenew }).where("id", "=", id).execute();
      await audit(trx, actor, "cw_subscription.auto_renew_changed", "cw_subscription", id, { before: { autoRenew: sub.auto_renew }, after: body });
    });
    return loadSubscription(actor.centreId, id);
  });

  /* Credit packs */

  const packRows = (centreId: string, _today: string) =>
    db
      .selectFrom("cw_packs as k")
      .innerJoin("cw_pack_products as pp", "pp.id", "k.product_id")
      .innerJoin("cw_resource_types as t", "t.id", "k.type_id")
      .select([
        "k.id",
        "k.member_id as memberId",
        "k.product_id as productId",
        "pp.name as productName",
        "k.type_id as typeId",
        "t.name as typeName",
        "k.quota_kind as quotaKind",
        "k.quota",
        "k.price",
        "k.starts_on as startsOn",
        "k.expires_on as expiresOn",
        "k.status",
        "k.cancelled_at as cancelledAt",
        "k.cancel_reason as cancelReason",
        "k.created_at as createdAt",
        sql<number>`coalesce((select sum(u.amount) from cw_entitlement_usage u where u.pack_id = k.id and u.status = 'active'), 0)::integer`.as("used"),
      ])
      .where("k.centre_id", "=", centreId);

  type PackRow = Awaited<ReturnType<ReturnType<typeof packRows>["execute"]>>[number];
  const presentPack = (today: string) => (p: PackRow) => {
    const remaining = Math.max(p.quota - p.used, 0);
    const state = p.status === "cancelled" ? "cancelled" : p.expiresOn < today ? "expired" : remaining === 0 ? "used_up" : "active";
    return { ...p, remaining, state };
  };

  app.get("/members/:id/packs", { preHandler: read }, async (request) => {
    const centreId = request.user!.centreId;
    const { id } = idParam.parse(request.params);
    await memberView(centreId, id);
    const { today } = await centreClock(db, centreId);
    const rows = await packRows(centreId, today).where("k.member_id", "=", id).orderBy("k.expires_on", "desc").orderBy("k.created_at", "desc").execute();
    return rows.map(presentPack(today));
  });

  /** Sells a pack: quota, validity and price are copied from the product; one charge is due today. */
  app.post("/packs", { preHandler: write }, async (request, reply) => {
    const actor = request.user!;
    const body = packSell.parse(request.body);
    const id = await db.transaction().execute(async (trx) => {
      await lockPayer(trx, { kind: "member", id: body.memberId }, actor.centreId);
      const member = await trx.selectFrom("members").select("status").where("id", "=", body.memberId).executeTakeFirstOrThrow();
      if (member.status === "disabled") throw conflict("member_disabled", "the member is disabled");
      const product = await trx
        .selectFrom("cw_pack_products")
        .select(["id", "name", "type_id", "quota_kind", "quota", "validity_days", "price"])
        .where("id", "=", body.productId)
        .where("centre_id", "=", actor.centreId)
        .where("status", "=", "active")
        .executeTakeFirst();
      if (!product) throw unprocessable("unknown_pack_product", "the pack product does not exist or is archived");
      const { today } = await centreClock(trx, actor.centreId);
      const expiresOn = addDays(today, product.validity_days - 1);
      const pack = await trx
        .insertInto("cw_packs")
        .values({
          centre_id: actor.centreId,
          member_id: body.memberId,
          product_id: product.id,
          type_id: product.type_id,
          quota_kind: product.quota_kind,
          quota: product.quota,
          price: product.price,
          starts_on: today,
          expires_on: expiresOn,
          created_by: actor.userId,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await issueMemberCharges(
        trx,
        actor.centreId,
        body.memberId,
        { cwPackId: pack.id },
        [{ label: `Pack ${product.name}, valable jusqu'au ${frDate(expiresOn)}`, amount: product.price, dueDate: today }],
        actor.userId,
      );
      await settlePayer(trx, actor.centreId, { kind: "member", id: body.memberId }, actor.userId);
      await audit(trx, actor, "cw_pack.sold", "cw_pack", pack.id, { after: { ...body, quota: product.quota, price: product.price, startsOn: today, expiresOn } });
      return pack.id;
    });
    const { today } = await centreClock(db, actor.centreId);
    const row = await packRows(actor.centreId, today).where("k.id", "=", id).executeTakeFirstOrThrow();
    return reply.status(201).send(presentPack(today)(row));
  });

  /** A pack can be cancelled only before it is used or paid. */
  app.post("/packs/:id/cancel", { preHandler: write }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const { reason } = archiveBody.parse(request.body);
    await db.transaction().execute(async (trx) => {
      const pack = await trx
        .selectFrom("cw_packs")
        .select(["id", "member_id", "status"])
        .where("id", "=", id)
        .where("centre_id", "=", actor.centreId)
        .forUpdate()
        .executeTakeFirst();
      if (!pack) throw notFound("pack");
      if (pack.status !== "active") throw conflict("already_cancelled", "the pack is already cancelled");
      await lockPayer(trx, { kind: "member", id: pack.member_id }, actor.centreId);
      const used = await trx.selectFrom("cw_entitlement_usage").select("id").where("pack_id", "=", id).where("status", "=", "active").executeTakeFirst();
      if (used) throw conflict("pack_used", "the pack has already been used for a booking");
      const charges = await trx
        .selectFrom("installments")
        .select(["id", "amount"])
        .where("cw_pack_id", "=", id)
        .where("kind", "=", "charge")
        .where("status", "=", "open")
        .execute();
      await cancelMemberCharges(trx, actor.centreId, pack.member_id, { cwPackId: id }, charges, actor.userId, `pack annulé : ${reason}`);
      await trx
        .updateTable("cw_packs")
        .set({ status: "cancelled", cancelled_at: new Date(), cancelled_by: actor.userId, cancel_reason: reason })
        .where("id", "=", id)
        .execute();
      await audit(trx, actor, "cw_pack.cancelled", "cw_pack", id, { after: { status: "cancelled", cancelledCharges: charges.length }, reason });
    });
    const { today } = await centreClock(db, actor.centreId);
    return presentPack(today)(await packRows(actor.centreId, today).where("k.id", "=", id).executeTakeFirstOrThrow());
  });

  /* Domiciliation and mail */

  const mailRows = (centreId: string) =>
    db
      .selectFrom("cw_mail_items as mi")
      .innerJoin("members as m", "m.id", "mi.member_id")
      .leftJoin("users as u", "u.id", "mi.handed_by")
      .select([
        "mi.id",
        "mi.member_id as memberId",
        sql<string>`concat_ws(' ', m.first_name, m.last_name)`.as("memberName"),
        "mi.received_at as receivedAt",
        "mi.kind",
        "mi.sender",
        "mi.reference",
        "mi.status",
        "mi.notified_at as notifiedAt",
        "mi.collected_at as collectedAt",
        "mi.collected_by_name as collectedByName",
        "u.full_name as handedBy",
        "mi.notes",
      ])
      .where("mi.centre_id", "=", centreId);

  const loadMailItem = async (centreId: string, id: string) => {
    const row = await mailRows(centreId).where("mi.id", "=", id).executeTakeFirst();
    if (!row) throw notFound("mail item");
    return row;
  };

  const lockOpenMailItem = async (trx: Transaction<Database>, centreId: string, id: string) => {
    const item = await trx
      .selectFrom("cw_mail_items")
      .select(["id", "member_id", "status", "kind", "sender", "received_at"])
      .where("id", "=", id)
      .where("centre_id", "=", centreId)
      .forUpdate()
      .executeTakeFirst();
    if (!item) throw notFound("mail item");
    if (item.status !== "received" && item.status !== "notified") throw conflict("mail_item_closed", "this mail has already been collected or returned");
    return item;
  };

  /** Members holding a domiciliation today, with how many items wait for them. */
  app.get("/domiciliations", { preHandler: read }, async (request) => {
    const centreId = request.user!.centreId;
    const { today } = await centreClock(db, centreId);
    return db
      .selectFrom("members as m")
      .innerJoin("cw_subscriptions as s", "s.member_id", "m.id")
      .innerJoin("cw_plans as p", "p.id", "s.plan_id")
      .leftJoin("companies as c", "c.id", "m.company_id")
      .select([
        "m.id as memberId",
        sql<string>`concat_ws(' ', m.first_name, m.last_name)`.as("memberName"),
        "c.name as companyName",
        "m.email",
        "m.phone",
        sql<string>`max(s.ends_on)::text`.as("endsOn"),
        sql<string>`string_agg(distinct p.name, ', ')`.as("planName"),
        sql<number>`(select count(*)::integer from cw_mail_items mi where mi.member_id = m.id and mi.status in ('received', 'notified'))`.as("openMailCount"),
      ])
      .where("m.centre_id", "=", centreId)
      .where("s.status", "=", "active")
      .where("s.includes_domiciliation", "=", true)
      .where("s.starts_on", "<=", today)
      .where("s.ends_on", ">=", today)
      .groupBy(["m.id", "c.name"])
      .orderBy(sql`lower(m.first_name)`)
      .orderBy(sql`lower(coalesce(m.last_name, ''))`)
      .execute();
  });

  app.get("/mail-items", { preHandler: read }, async (request) => {
    const centreId = request.user!.centreId;
    const query = mailQuery.parse(request.query);
    let base = db.selectFrom("cw_mail_items as mi").where("mi.centre_id", "=", centreId);
    if (query.status === "open") base = base.where("mi.status", "in", ["received", "notified"]);
    else if (query.status !== "all") base = base.where("mi.status", "=", query.status);
    if (query.memberId) base = base.where("mi.member_id", "=", query.memberId);
    const [{ total }] = (await base.select((eb) => eb.fn.countAll<number>().as("total")).execute()) as [{ total: number }];
    const ids = await base
      .select("mi.id")
      .orderBy(sql`mi.status in ('received', 'notified')`, "desc")
      .orderBy("mi.received_at", "desc")
      .orderBy("mi.id")
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize)
      .execute();
    const rows = ids.length
      ? await mailRows(centreId)
          .where(
            "mi.id",
            "in",
            ids.map((r) => r.id),
          )
          .execute()
      : [];
    const items = ids.map((r) => rows.find((row) => row.id === r.id)!);
    return { items, total: Number(total), page: query.page, pageSize: query.pageSize };
  });

  /** Mail is accepted only for a member domiciled on the reception day. */
  app.post("/mail-items", { preHandler: write }, async (request, reply) => {
    const actor = request.user!;
    const body = mailCreate.parse(request.body);
    const id = await db.transaction().execute(async (trx) => {
      const member = await trx.selectFrom("members").select("id").where("id", "=", body.memberId).where("centre_id", "=", actor.centreId).executeTakeFirst();
      if (!member) throw notFound("member");
      const { today } = await centreClock(trx, actor.centreId);
      const domiciled = await trx
        .selectFrom("cw_subscriptions")
        .select("id")
        .where("member_id", "=", body.memberId)
        .where("status", "=", "active")
        .where("includes_domiciliation", "=", true)
        .where("starts_on", "<=", today)
        .where("ends_on", ">=", today)
        .executeTakeFirst();
      if (!domiciled) throw unprocessable("no_domiciliation", "the member has no domiciliation subscription today");
      const created = await trx
        .insertInto("cw_mail_items")
        .values({
          centre_id: actor.centreId,
          member_id: body.memberId,
          kind: body.kind,
          sender: body.sender ?? null,
          reference: body.reference ?? null,
          notes: body.notes ?? null,
          created_by: actor.userId,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await audit(trx, actor, "cw_mail_item.received", "cw_mail_item", created.id, { after: body });
      return created.id;
    });
    return reply.status(201).send(await loadMailItem(actor.centreId, id));
  });

  app.post("/mail-items/:id/notify", { preHandler: write }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const notice = await db.transaction().execute(async (trx) => {
      const item = await lockOpenMailItem(trx, actor.centreId, id);
      const member = await trx.selectFrom("members").select(["email", "first_name"]).where("id", "=", item.member_id).executeTakeFirstOrThrow();
      if (!member.email) throw unprocessable("no_recipient", "the member has no e-mail address");
      const { timezone } = await centreClock(trx, actor.centreId);
      const received = await sql<{ day: string }>`select to_char(${item.received_at}::timestamptz at time zone ${timezone}, 'DD/MM/YYYY') as day`.execute(trx);
      await trx.updateTable("cw_mail_items").set({ status: "notified", notified_at: new Date() }).where("id", "=", id).execute();
      await audit(trx, actor, "cw_mail_item.notified", "cw_mail_item", id, { before: { status: item.status }, after: { status: "notified" } });
      return { item, member: { email: member.email, firstName: member.first_name }, day: received.rows[0]!.day };
    });
    const centre = await centreName(actor.centreId);
    const from = notice.item.sender ? ` de la part de ${notice.item.sender}` : "";
    const mail = await sendMemberMail(db, app.mailer, request.log, {
      centreId: actor.centreId,
      memberId: notice.item.member_id,
      kind: "mail_item",
      to: notice.member.email,
      subject: `${centre} : du courrier vous attend`,
      text: `Bonjour ${notice.member.firstName},\n\nNous avons reçu ${MAIL_KIND_FR[notice.item.kind]}${from} pour vous le ${notice.day}. Vous pouvez le retirer à l'accueil aux heures d'ouverture.\n\n${centre}`,
      sentBy: actor.userId,
    });
    return { ...(await loadMailItem(actor.centreId, id)), mail };
  });

  app.post("/mail-items/:id/collect", { preHandler: write }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = collectBody.parse(request.body);
    await db.transaction().execute(async (trx) => {
      const item = await lockOpenMailItem(trx, actor.centreId, id);
      await trx
        .updateTable("cw_mail_items")
        .set({
          status: "collected",
          collected_at: new Date(),
          collected_by_name: body.collectedByName,
          handed_by: actor.userId,
          ...(body.notes === undefined ? {} : { notes: body.notes }),
        })
        .where("id", "=", id)
        .execute();
      await audit(trx, actor, "cw_mail_item.collected", "cw_mail_item", id, { before: { status: item.status }, after: { status: "collected", ...body } });
    });
    return loadMailItem(actor.centreId, id);
  });

  app.post("/mail-items/:id/return", { preHandler: write }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const { reason } = archiveBody.parse(request.body);
    await db.transaction().execute(async (trx) => {
      const item = await lockOpenMailItem(trx, actor.centreId, id);
      await trx.updateTable("cw_mail_items").set({ status: "returned", handed_by: actor.userId }).where("id", "=", id).execute();
      await audit(trx, actor, "cw_mail_item.returned", "cw_mail_item", id, { before: { status: item.status }, after: { status: "returned" }, reason });
    });
    return loadMailItem(actor.centreId, id);
  });

  /** Kept for the money screens of a member: the amount formatted like on receipts. */
  void tnd;
};
