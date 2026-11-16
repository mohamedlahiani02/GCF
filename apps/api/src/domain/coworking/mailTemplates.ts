import type { CwMailTemplateKey } from "@gcf/shared";
import { unprocessable } from "../../errors.js";
import type { Db } from "./schedule.js";

export interface MailTemplate {
  subject: string;
  body: string;
}

/** Values every booking e-mail can show, plus those that only make sense for one of them. */
const COMMON = ["client", "espace", "date", "debut", "fin", "montant", "options", "lien", "centre"] as const;
export const TEMPLATE_PLACEHOLDERS: Record<CwMailTemplateKey, readonly string[]> = {
  booking_confirmed: COMMON,
  booking_refused: [...COMMON, "motif"],
  booking_cancelled: [...COMMON, "motif", "frais"],
  booking_reminder: [...COMMON, "code"],
};

/** The wording used while the centre has not written its own. */
export const DEFAULT_TEMPLATES: Record<CwMailTemplateKey, MailTemplate> = {
  booking_confirmed: {
    subject: "Réservation confirmée",
    body: [
      "Bonjour {client},",
      "",
      "Votre réservation est confirmée :",
      "- {espace}",
      "- le {date} de {debut} à {fin}",
      "- {montant}",
      "{options}",
      "",
      "Vos réservations : {lien}",
      "",
      "{centre}",
    ].join("\n"),
  },
  booking_refused: {
    subject: "Réservation refusée",
    body: [
      "Bonjour {client},",
      "",
      "Votre demande de réservation n'a pas pu être acceptée :",
      "- {espace}",
      "- le {date} de {debut} à {fin}",
      "- motif : {motif}",
      "",
      "Vos réservations : {lien}",
      "",
      "{centre}",
    ].join("\n"),
  },
  booking_cancelled: {
    subject: "Réservation annulée",
    body: [
      "Bonjour {client},",
      "",
      "Votre réservation a été annulée par l'accueil :",
      "- {espace}",
      "- le {date} de {debut} à {fin}",
      "- motif : {motif}",
      "{frais}",
      "",
      "Vos réservations : {lien}",
      "",
      "{centre}",
    ].join("\n"),
  },
  booking_reminder: {
    subject: "Rappel de votre réservation",
    body: [
      "Bonjour {client},",
      "",
      "Nous vous rappelons votre réservation :",
      "- {espace}",
      "- le {date} de {debut} à {fin}",
      "- {montant}",
      "{options}",
      "",
      "À votre arrivée, donnez ce code à l'accueil : {code}",
      "",
      "Vos réservations : {lien}",
      "",
      "{centre}",
    ].join("\n"),
  },
};

const PLACEHOLDER = /\{([a-z_]+)\}/g;

/** Refuses a placeholder the e-mail cannot fill, so a typing mistake never reaches a client as raw braces. */
export function assertTemplate(key: CwMailTemplateKey, template: MailTemplate): void {
  const allowed = TEMPLATE_PLACEHOLDERS[key];
  const unknown = [...`${template.subject}\n${template.body}`.matchAll(PLACEHOLDER)].map((m) => m[1]!).filter((name) => !allowed.includes(name));
  if (unknown.length) {
    throw unprocessable("template_placeholder_unknown", `unknown placeholders: ${[...new Set(unknown)].map((n) => `{${n}}`).join(", ")}`, {
      placeholders: [...new Set(unknown)],
    });
  }
}

/**
 * Fills the placeholders. A line with a placeholder that has no value this time is dropped, so optional parts such
 * as the extras, a cancellation fee or the portal link leave no half-empty line; runs of blank lines become one.
 */
export function renderTemplate(template: MailTemplate, values: Record<string, string>): MailTemplate {
  const fill = (text: string) => text.replace(PLACEHOLDER, (_whole, name: string) => values[name] ?? "");
  const lines = template.body.split("\n").flatMap((line) => {
    const names = [...line.matchAll(PLACEHOLDER)].map((m) => m[1]!);
    return names.some((n) => !values[n]) ? [] : [fill(line)];
  });
  const body = lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { subject: fill(template.subject).trim(), body };
}

/** The centre's wording of an e-mail, or the default one. */
export async function loadTemplate(db: Db, centreId: string, key: CwMailTemplateKey): Promise<MailTemplate> {
  const row = await db.selectFrom("cw_mail_templates").select(["subject", "body"]).where("centre_id", "=", centreId).where("key", "=", key).executeTakeFirst();
  return row ?? DEFAULT_TEMPLATES[key];
}
