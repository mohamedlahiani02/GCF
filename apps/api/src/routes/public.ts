import { LEAD_KINDS, sectionIdSchema, SITE_LANGUAGES } from "@gcf/shared";
import type { FastifyPluginAsync } from "fastify";
import { z, ZodError } from "zod";
import { writeAudit } from "../audit.js";
import { HttpError, notFound, unprocessable } from "../errors.js";
import { publicCentre } from "../publicCentre.js";
import { isoDate, optionalEmail, optionalText, requiredText } from "../validation.js";

const FORM_TYPE = "application/x-www-form-urlencoded";
const LEAD_BODY_LIMIT = 16 * 1024;

const leadBody = z
  .object({
    kind: z.enum(LEAD_KINDS),
    name: requiredText(150),
    email: optionalEmail,
    phone: optionalText(40),
    company: optionalText(150),
    message: optionalText(3000),
    preferredDate: z
      .union([z.literal(""), isoDate])
      .transform((v) => (v === "" ? null : v))
      .optional(),
    language: z.enum(SITE_LANGUAGES),
    // Path of the page holding the form; the visitor is sent back there, so only site paths are accepted.
    page: z
      .string()
      .max(300)
      .regex(/^\/[a-z0-9/-]*$/)
      .refine((p) => !p.startsWith("//"), "expected a site path")
      .optional(),
    section: sectionIdSchema.optional(),
    // Honeypot: hidden from people, filled by bots.
    website: z.string().max(500).optional(),
  })
  .strict();

const backTo = (page: string | undefined, section: string | undefined, flag: "envoye" | "erreur") =>
  `${page ?? "/"}?${flag}=1${section ? `#${section}` : ""}`;

/** Endpoints the public website posts to (visitor requests). */
export const publicRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;

  // The website form is a plain HTML form (no script), which browsers send URL-encoded.
  app.addContentTypeParser(FORM_TYPE, { parseAs: "string", bodyLimit: LEAD_BODY_LIMIT }, (_request, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  app.post("/leads", { bodyLimit: LEAD_BODY_LIMIT, config: { rateLimit: { max: 5, timeWindow: "10 minutes" } } }, async (request, reply) => {
    const isForm = (request.headers["content-type"] ?? "").startsWith(FORM_TYPE);
    const raw = (request.body ?? {}) as Record<string, unknown>;
    const fallbackPage = typeof raw.page === "string" && /^\/[a-z0-9/-]*$/.test(raw.page) && !raw.page.startsWith("//") ? raw.page : undefined;
    const fallbackSection = typeof raw.section === "string" && sectionIdSchema.safeParse(raw.section).success ? raw.section : undefined;
    let body: z.infer<typeof leadBody>;
    try {
      body = leadBody.parse(raw);
      if (!body.email && !body.phone) throw unprocessable("contact_required", "give an e-mail address or a phone number");
    } catch (error) {
      if (isForm && (error instanceof ZodError || error instanceof HttpError)) return reply.redirect(backTo(fallbackPage, fallbackSection, "erreur"), 303);
      throw error;
    }

    const centre = await publicCentre(db);
    const site = await db.selectFrom("site_settings").select("online").where("centre_id", "=", centre.id).executeTakeFirst();
    if (!centre.modules.includes("website") || !site?.online) throw notFound("website");

    // A filled honeypot gets the same answer as a real request, so bots learn nothing, but nothing is stored.
    if (!body.website) {
      await db.transaction().execute(async (trx) => {
        const lead = await trx
          .insertInto("site_leads")
          .values({
            centre_id: centre.id,
            kind: body.kind,
            name: body.name,
            email: body.email ?? null,
            phone: body.phone ?? null,
            company: body.company ?? null,
            message: body.message ?? null,
            preferred_date: body.kind === "visit" ? (body.preferredDate ?? null) : null,
            page_path: body.page ?? null,
            language: body.language,
          })
          .returning(["id", "kind"])
          .executeTakeFirstOrThrow();
        await writeAudit(trx, {
          centreId: centre.id,
          userId: null,
          action: "site_lead.received",
          objectType: "site_lead",
          objectId: lead.id,
          after: { kind: lead.kind, page: body.page ?? null },
        });
      });
    }
    if (isForm) return reply.redirect(backTo(body.page, body.section, "envoye"), 303);
    return reply.status(201).send({ received: true });
  });
};
