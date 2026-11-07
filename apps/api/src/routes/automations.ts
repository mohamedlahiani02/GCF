import type { FastifyPluginAsync } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { can } from "../auth/permissions.js";
import type { AutomationKey, ProposalKind } from "../db/types.js";
import { AUTOMATION_KEYS, AUTOMATIONS, PROPOSAL_PERMISSION } from "../domain/automations/definitions.js";
import { decideProposal, expireProposals } from "../domain/automations/proposals.js";
import { loadSettings, recentRuns, saveSetting } from "../domain/automations/settings.js";
import { unauthenticated, unprocessable } from "../errors.js";
import { idParam } from "../validation.js";

const keyParam = z.object({ key: z.enum(AUTOMATION_KEYS as [AutomationKey, ...AutomationKey[]]) });
const settingBody = z.object({ mode: z.enum(["off", "propose", "auto"]), params: z.record(z.string(), z.unknown()).default({}) }).strict();
const proposalsQuery = z.object({ status: z.enum(["pending", "decided"]).default("pending") });
const decisionBody = z.object({ approve: z.boolean(), note: z.string().trim().max(500).optional() }).strict();

const PROPOSAL_KINDS = Object.keys(PROPOSAL_PERMISSION) as ProposalKind[];

/**
 * Automation settings for the administrator, and the proposals inbox for whoever may carry out each kind of
 * proposal (sending reminders, calculating pay).
 */
export const automationRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  const manage = app.requirePermission("centre:manage");

  app.get("/settings", { preHandler: manage }, async (request) => {
    const actor = request.user!;
    const [settings, runs] = await Promise.all([loadSettings(db, actor.centreId), recentRuns(db, actor.centreId)]);
    return settings.map((s) => ({
      ...s,
      modes: AUTOMATIONS[s.key].modes,
      available: AUTOMATIONS[s.key].module === null || actor.modules.includes(AUTOMATIONS[s.key].module!),
      runs: runs.filter((r) => r.key === s.key),
    }));
  });

  app.put("/settings/:key", { preHandler: manage }, async (request) => {
    const actor = request.user!;
    const { key } = keyParam.parse(request.params);
    const body = settingBody.parse(request.body);
    const definition = AUTOMATIONS[key];
    if (!definition.modes.includes(body.mode)) throw unprocessable("mode_not_allowed", "this automation does not offer that mode", { modes: definition.modes });
    if (definition.module && !actor.modules.includes(definition.module) && body.mode !== "off") {
      throw unprocessable("module_not_enabled", "this automation belongs to a module the centre does not run");
    }
    const params = definition.params.parse(body.params);
    await db.transaction().execute(async (trx) => {
      const { before } = await saveSetting(trx, actor.centreId, actor.userId, key, body.mode, params);
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "automation.updated",
        objectType: "automation",
        objectId: key,
        before,
        after: { mode: body.mode, params },
      });
    });
    const settings = await loadSettings(db, actor.centreId);
    return settings.find((s) => s.key === key);
  });

  /** Proposals the person may decide on: pending ones, or the last decided ones. */
  app.get("/proposals", async (request) => {
    const actor = request.user;
    if (!actor) throw unauthenticated();
    const kinds = PROPOSAL_KINDS.filter((k) => can(actor, PROPOSAL_PERMISSION[k]));
    if (!kinds.length) return [];
    const query = proposalsQuery.parse(request.query);
    await expireProposals(db, actor.centreId);
    let base = db
      .selectFrom("proposals")
      .leftJoin("users", "users.id", "proposals.decided_by")
      .select([
        "proposals.id",
        "proposals.kind",
        "proposals.title",
        "proposals.summary",
        "proposals.status",
        "proposals.created_at as createdAt",
        "proposals.expires_at as expiresAt",
        "proposals.decided_at as decidedAt",
        "users.full_name as decidedByName",
        "proposals.decision_note as decisionNote",
        "proposals.result",
        "proposals.error",
      ])
      .where("proposals.centre_id", "=", actor.centreId)
      .where("proposals.kind", "in", kinds);
    base = query.status === "pending" ? base.where("proposals.status", "=", "pending") : base.where("proposals.status", "<>", "pending");
    return base.orderBy("proposals.created_at", "desc").limit(50).execute();
  });

  app.get("/proposals/count", async (request) => {
    const actor = request.user;
    if (!actor) throw unauthenticated();
    const kinds = PROPOSAL_KINDS.filter((k) => can(actor, PROPOSAL_PERMISSION[k]));
    if (!kinds.length) return { pending: 0 };
    const row = await db
      .selectFrom("proposals")
      .select(sql<number>`count(*)::integer`.as("pending"))
      .where("centre_id", "=", actor.centreId)
      .where("kind", "in", kinds)
      .where("status", "=", "pending")
      .where("expires_at", ">", sql<Date>`now()`)
      .executeTakeFirstOrThrow();
    return row;
  });

  app.post("/proposals/:id/decision", async (request) => {
    const actor = request.user;
    if (!actor) throw unauthenticated();
    const { id } = idParam.parse(request.params);
    const body = decisionBody.parse(request.body);
    return decideProposal(db, app.mailer, actor, id, { approve: body.approve, note: body.note ?? null });
  });
};
