import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/** GET requests on the public origin that are not API calls: website pages, media, sitemap and the portal. */
export async function handlePublicGet(_app: FastifyInstance, _request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  return reply.status(404).type("text/plain; charset=utf-8").send("Not found");
}
