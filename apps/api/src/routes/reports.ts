import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { can } from "../auth/permissions.js";
import { buildReport, REPORTS, type ReportName } from "../domain/reports.js";
import { toCsv, toPdf, toXlsx } from "../domain/tableExport.js";
import { forbidden, unprocessable } from "../errors.js";
import { isoDate } from "../validation.js";

const params = z.object({ name: z.enum(Object.keys(REPORTS) as [ReportName, ...ReportName[]]) });
const query = z.object({ from: isoDate, to: isoDate, format: z.enum(["json", "csv", "xlsx", "pdf"]).default("json") });

export const reportRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;

  /** The reports a role may open: operational for the secretariat, financial for the accountant, all for the admin. */
  app.get("/", async (request) => {
    const user = request.user;
    if (!user) throw forbidden();
    return Object.entries(REPORTS)
      .filter(([, r]) => r.audiences.some((a) => can(user, a === "operational" ? "reports:operational" : "reports:financial")))
      .map(([name, r]) => ({ name, title: r.title }));
  });

  app.get("/:name", async (request, reply) => {
    const user = request.user;
    if (!user) throw forbidden();
    const { name } = params.parse(request.params);
    const q = query.parse(request.query);
    if (q.to < q.from) throw unprocessable("invalid_range", "the end date cannot be before the start date");
    const allowed = REPORTS[name].audiences.some((a) => can(user, a === "operational" ? "reports:operational" : "reports:financial"));
    if (!allowed) throw forbidden();
    const table = await buildReport(db, name, user.centreId, { from: q.from, to: q.to });
    if (q.format === "json") return table;
    await writeAudit(db, {
      centreId: user.centreId,
      userId: user.userId,
      action: "report.exported",
      objectType: "report",
      objectId: name,
      after: { from: q.from, to: q.to, format: q.format },
    });
    const file = `${name}-${q.from}-${q.to}`;
    if (q.format === "csv")
      return reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="${file}.csv"`).send(toCsv(table));
    if (q.format === "xlsx") {
      return reply
        .header("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        .header("content-disposition", `attachment; filename="${file}.xlsx"`)
        .send(await toXlsx(table));
    }
    return reply
      .header("content-type", "application/pdf")
      .header("content-disposition", `attachment; filename="${file}.pdf"`)
      .send(await toPdf(table));
  });
};
