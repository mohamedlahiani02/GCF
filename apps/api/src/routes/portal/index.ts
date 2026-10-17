import type { FastifyPluginAsync } from "fastify";
import { portalAccountRoutes } from "./account.js";
import { portalAuthRoutes } from "./auth.js";
import { portalBookingRoutes } from "./booking.js";
import { portalTeamRoutes } from "./team.js";

/** Client portal API, used by coworking members from the public origin. */
export const portalRoutes: FastifyPluginAsync = async (app) => {
  await app.register(portalAuthRoutes);
  await app.register(portalBookingRoutes);
  await app.register(portalAccountRoutes);
  await app.register(portalTeamRoutes);
};
