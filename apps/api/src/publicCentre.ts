import type { FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import type { Config } from "./config.js";
import type { Database, Module } from "./db/types.js";
import { HttpError } from "./errors.js";

/** True when the request targets the public surface (website and portal) rather than the back-office. */
export function isPublicHost(request: FastifyRequest, config: Config): boolean {
  if (!config.publicOrigin) return false;
  return request.host.toLowerCase() === new URL(config.publicOrigin).host.toLowerCase();
}

export interface PublicCentre {
  id: string;
  modules: Module[];
}

/**
 * The centre the public surface belongs to: the single centre running the coworking or the website module.
 * A deployment serving several centres publicly would need a host-to-centre mapping, which is refused here
 * rather than guessed.
 */
export async function publicCentre(db: Kysely<Database>): Promise<PublicCentre> {
  const rows = await db
    .selectFrom("centres")
    .select(["id", "modules"])
    .where((eb) => eb.or([eb(eb.val("coworking"), "=", eb.fn.any("modules")), eb(eb.val("website"), "=", eb.fn.any("modules"))]))
    .limit(2)
    .execute();
  if (rows.length !== 1) throw new HttpError(503, "public_unavailable", "the public surface is not configured");
  return rows[0]!;
}
