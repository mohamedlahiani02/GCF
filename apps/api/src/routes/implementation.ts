import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { can } from "../auth/permissions.js";
import { HttpError, notFound, unauthenticated } from "../errors.js";
import { IMPORTS, MAX_IMPORT_ROWS, previewRows, summarise, totalsOf, type RowResult } from "../implementation/imports.js";
import { AUTOMATIONS_PERMISSION, PACK_FORMAT, packSchema, pick, sameValue, SETTINGS_SECTIONS, type Change, type Pack } from "../implementation/pack.js";

const entityParam = z.object({ entity: z.string().max(40) });
const importBody = z.object({ mode: z.enum(["preview", "apply"]), rows: z.array(z.unknown()).min(1).max(MAX_IMPORT_ROWS) }).strict();
const packBody = z.object({ mode: z.enum(["preview", "apply"]), pack: packSchema }).strict();

interface ApiResult {
  status: number;
  body: unknown;
}

/** Calls the application's own REST API with the caller's token: same permissions, validation and audit as any client. */
async function callApi(
  app: FastifyInstance,
  request: FastifyRequest,
  method: "GET" | "POST" | "PUT" | "PATCH",
  url: string,
  body?: unknown,
): Promise<ApiResult> {
  const response = await app.inject({
    method,
    url,
    remoteAddress: request.ip,
    headers: { authorization: request.headers.authorization!, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
  return { status: response.statusCode, body: response.body ? (JSON.parse(response.body) as unknown) : null };
}

function apiError(result: ApiResult): string {
  const error = result.body as { code?: string; message?: string; details?: unknown } | null;
  return `${result.status} ${error?.code ?? "error"}: ${error?.message ?? "the request failed"}${error?.details ? ` (${JSON.stringify(error.details)})` : ""}`;
}

/**
 * Tools of an implementation consultant: bulk loading of reference data and configuration packs. Only an access
 * token reaches them (the consultant's own scripts), never a browser session. They write nothing themselves: every
 * record and setting goes through the REST endpoint the back-office uses, with the token's role.
 */
export const implementationRoutes: FastifyPluginAsync = async (app) => {
  const run = app.requirePermission("implementation:run");

  app.addHook("onRequest", async (request) => {
    if (!request.headers.authorization) throw unauthenticated();
  });

  /** What can be loaded, in dependency order, with the JSON Schema of a row: the contract of the consultant's files. */
  app.get("/imports", { preHandler: run }, async (request) =>
    IMPORTS.map((d) => ({
      entity: d.entity,
      description: d.description,
      dependsOn: d.dependsOn,
      keyFields: d.keyFields,
      available: can(request.user!, d.permission),
      schema: z.toJSONSchema(d.row, { io: "input", unrepresentable: "any" }),
    })),
  );

  /**
   * Checks (preview) or loads (apply) rows of one entity. Apply checks again first and only sends the rows the check
   * accepts; a row already present (same business key) is left as it is, so the same file can be sent twice.
   */
  app.post("/imports/:entity", { preHandler: run }, async (request) => {
    const actor = request.user!;
    const { entity } = entityParam.parse(request.params);
    const definition = IMPORTS.find((d) => d.entity === entity);
    if (!definition) throw notFound("import");
    if (!can(actor, definition.permission)) throw new HttpError(403, "forbidden", "this token cannot load this entity, or its module is not enabled");
    const body = importBody.parse(request.body);
    const { results, bodies } = await previewRows(app.db, actor.centreId, definition, body.rows);
    if (body.mode === "apply") {
      for (const row of results) {
        if (row.action !== "create") continue;
        const planned = bodies.get(row.line)!;
        const created = await callApi(app, request, "POST", planned.url, planned.body);
        if (created.status === 201) {
          (row as RowResult).action = "created";
          const answer = created.body as Record<string, unknown>;
          row.id = definition.resultId ? definition.resultId(answer) : String(answer.id);
        } else {
          row.action = "failed";
          row.errors.push(apiError(created));
        }
      }
    }
    return { entity, mode: body.mode, summary: summarise(results), totals: totalsOf(results), rows: results };
  });

  /** The centre's current settings as a pack; sections of modules the centre does not run are left out. */
  app.get("/pack", { preHandler: run }, async (request) => {
    const actor = request.user!;
    const sections: Pack["sections"] = {};
    for (const section of SETTINGS_SECTIONS) {
      if (!can(actor, section.permission)) continue;
      const current = await callApi(app, request, "GET", section.url);
      if (current.status !== 200) throw new HttpError(502, "pack_read_failed", `could not read the ${section.name} settings: ${apiError(current)}`);
      sections[section.name] = pick(current.body as Record<string, unknown>, section.keys);
    }
    if (can(actor, AUTOMATIONS_PERMISSION)) {
      const current = await callApi(app, request, "GET", "/api/automations/settings");
      if (current.status !== 200) throw new HttpError(502, "pack_read_failed", `could not read the automations: ${apiError(current)}`);
      type Automation = NonNullable<Pack["sections"]["automations"]>[number];
      sections.automations = (current.body as (Automation & { available: boolean })[])
        .filter((a) => a.available)
        .map((a) => ({ key: a.key, mode: a.mode, params: a.params }));
    }
    return { format: PACK_FORMAT, exportedAt: new Date().toISOString(), sections } satisfies Pack;
  });

  /**
   * Lists what a pack would change (preview), or applies it section by section (apply). A section the token cannot
   * change is reported as skipped. Sections are applied one after the other: one refused section does not undo
   * those already applied, and the result names it with the API's reason.
   */
  app.post("/pack", { preHandler: run }, async (request) => {
    const actor = request.user!;
    const { mode, pack } = packBody.parse(request.body);
    const changes: Change[] = [];
    const skipped: { section: string; reason: string }[] = [];
    const applied: string[] = [];
    const failed: { section: string; error: string }[] = [];

    for (const section of SETTINGS_SECTIONS) {
      const wanted = pack.sections[section.name];
      if (!wanted) continue;
      if (!can(actor, section.permission)) {
        skipped.push({ section: section.name, reason: "module not enabled or not allowed for this token" });
        continue;
      }
      const unknown = Object.keys(wanted).filter((k) => !section.keys.includes(k));
      if (unknown.length) throw new HttpError(422, "unknown_pack_fields", `unknown fields in section ${section.name}`, { fields: unknown });
      const current = await callApi(app, request, "GET", section.url);
      if (current.status !== 200) throw new HttpError(502, "pack_read_failed", `could not read the ${section.name} settings: ${apiError(current)}`);
      const now = pick(current.body as Record<string, unknown>, section.keys);
      const diff = Object.keys(wanted).filter((k) => !sameValue(now[k], wanted[k]));
      for (const field of diff) changes.push({ section: section.name, field, current: now[field], next: wanted[field] });
      if (mode === "apply" && diff.length) {
        const payload = section.partial ? pick(wanted, diff) : { ...now, ...wanted };
        const result = await callApi(app, request, section.method, section.url, payload);
        if (result.status >= 400) failed.push({ section: section.name, error: apiError(result) });
        else applied.push(section.name);
      }
    }

    if (pack.sections.automations) {
      if (!can(actor, AUTOMATIONS_PERMISSION)) skipped.push({ section: "automations", reason: "not allowed for this token" });
      else {
        const current = await callApi(app, request, "GET", "/api/automations/settings");
        if (current.status !== 200) throw new HttpError(502, "pack_read_failed", `could not read the automations: ${apiError(current)}`);
        const now = new Map((current.body as { key: string; mode: string; params: Record<string, unknown> }[]).map((a) => [a.key, a]));
        for (const wanted of pack.sections.automations) {
          const existing = now.get(wanted.key);
          if (existing && existing.mode === wanted.mode && sameValue(existing.params, wanted.params)) continue;
          changes.push({
            section: "automations",
            field: wanted.key,
            current: existing ? { mode: existing.mode, params: existing.params } : null,
            next: { mode: wanted.mode, params: wanted.params },
          });
          if (mode !== "apply") continue;
          const result = await callApi(app, request, "PUT", `/api/automations/settings/${wanted.key}`, { mode: wanted.mode, params: wanted.params });
          if (result.status >= 400) failed.push({ section: `automations.${wanted.key}`, error: apiError(result) });
          else applied.push(`automations.${wanted.key}`);
        }
      }
    }

    return { mode, changes, skipped, ...(mode === "apply" ? { applied, failed } : {}) };
  });
};
