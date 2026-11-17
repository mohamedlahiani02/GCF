import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import { can } from "../auth/permissions.js";
import type { SessionUser } from "../auth/sessions.js";
import { ENTITIES, maskPersonalData, TOOLS, type ApiCall, type ToolDefinition } from "../mcp/tools.js";

/** Protocol revisions this server speaks, newest first. */
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "axelia", title: "AXÉLIA", version: "1.0.0" };
const INSTRUCTIONS =
  "Outils de gestion d'un centre AXÉLIA (formation, coworking, finances). Commencez par list_entities pour voir ce que ce jeton peut lire. " +
  "Les outils qui modifient des données agissent avec le rôle du jeton et sont tracés au journal d'audit ; demandez confirmation à l'utilisateur avant de les appeler. " +
  "Les montants sont en millimes (1 TND = 1000).";

type JsonRpcId = string | number;
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** A tool failure the assistant should read and act on (wrong argument, refused by a business rule). */
class ToolError extends Error {}

const visibleTools = (user: SessionUser) =>
  TOOLS.filter((t) => (t.permissions.length === 0 || t.permissions.some((p) => can(user, p))) && !(t.writes && user.apiToken?.readOnly));

const visibleEntities = (user: SessionUser) => ENTITIES.filter((e) => can(user, e.permission));

/** Checks the arguments against the tool's schema: required keys present, no unknown key, plain values only. */
function checkArguments(tool: ToolDefinition, args: unknown): Record<string, unknown> {
  if (args === undefined) args = {};
  if (typeof args !== "object" || args === null || Array.isArray(args)) throw new ToolError("arguments must be an object");
  const values = args as Record<string, unknown>;
  const known = Object.keys(tool.inputSchema.properties);
  const unknown = Object.keys(values).filter((k) => !known.includes(k));
  if (unknown.length) throw new ToolError(`unknown arguments: ${unknown.join(", ")}`);
  const missing = (tool.inputSchema.required ?? []).filter((k) => values[k] === undefined || values[k] === null || values[k] === "");
  if (missing.length) throw new ToolError(`missing arguments: ${missing.join(", ")}`);
  for (const [key, value] of Object.entries(values)) {
    const schema = tool.inputSchema.properties[key] as { format?: string; enum?: string[] };
    if (schema.format === "uuid" && (typeof value !== "string" || !/^[0-9a-f-]{36}$/i.test(value))) throw new ToolError(`${key} must be an identifier`);
    if (schema.enum && !schema.enum.includes(String(value))) throw new ToolError(`${key} must be one of ${schema.enum.join(", ")}`);
  }
  return values;
}

function queryString(filters: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null) continue;
    if (!["string", "number", "boolean"].includes(typeof value)) throw new ToolError(`filter ${key} must be text, a number or a boolean`);
    params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** Calls the application's own REST API with the caller's token: same permissions, validation and audit as any client. */
async function callApi(app: FastifyInstance, request: FastifyRequest, call: ApiCall): Promise<unknown> {
  const response = await app.inject({
    method: call.method,
    url: call.url,
    // Counted against the caller's own rate limit, not against the server's.
    remoteAddress: request.ip,
    headers: { authorization: request.headers.authorization!, ...(call.body === undefined ? {} : { "content-type": "application/json" }) },
    ...(call.body === undefined ? {} : { payload: JSON.stringify(call.body) }),
  });
  const body: unknown = response.body ? JSON.parse(response.body) : null;
  if (response.statusCode >= 400) {
    const error = body as { code?: string; message?: string; details?: unknown } | null;
    throw new ToolError(
      `${response.statusCode} ${error?.code ?? "error"}: ${error?.message ?? "the request failed"}${error?.details ? ` (${JSON.stringify(error.details)})` : ""}`,
    );
  }
  return body;
}

async function runTool(
  app: FastifyInstance,
  request: FastifyRequest,
  user: SessionUser,
  tool: ToolDefinition,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (tool.name === "list_entities") {
    return visibleEntities(user).map((e) => ({ entity: e.name, description: e.description, filters: e.filters, canGetById: e.getUrl !== undefined }));
  }
  if (tool.name === "list_records" || tool.name === "get_record") {
    const entity = visibleEntities(user).find((e) => e.name === args.entity);
    if (!entity) throw new ToolError(`unknown entity ${String(args.entity)}: call list_entities`);
    if (tool.name === "get_record") {
      if (!entity.getUrl) throw new ToolError(`${entity.name} cannot be read one by one: use list_records`);
      return callApi(app, request, { method: "GET", url: entity.getUrl(String(args.id)) });
    }
    const filters = (args.filters ?? {}) as Record<string, unknown>;
    const unknownFilters = Object.keys(filters).filter((k) => !(k in entity.filters));
    if (unknownFilters.length) throw new ToolError(`unknown filters for ${entity.name}: ${unknownFilters.join(", ")}`);
    const missing = (entity.requiredFilters ?? []).filter((k) => filters[k] === undefined);
    if (missing.length) throw new ToolError(`${entity.name} needs the filters: ${missing.join(", ")}`);
    return callApi(app, request, { method: "GET", url: `${entity.listUrl}${queryString(filters)}` });
  }
  const plan = tool.plan(args);
  if (plan === "occupancy") {
    const floors = (await callApi(app, request, { method: "GET", url: "/api/coworking/floors" })) as { id: string; name: string }[];
    const at = new Date().toISOString();
    return Promise.all(
      floors.map(async (floor) => {
        const state = (await callApi(app, request, { method: "GET", url: `/api/coworking/floors/${floor.id}/state?at=${encodeURIComponent(at)}` })) as {
          resources: { state: string }[];
        };
        const counts: Record<string, number> = {};
        for (const r of state.resources) counts[r.state] = (counts[r.state] ?? 0) + 1;
        return { floor: floor.name, total: state.resources.length, byState: counts };
      }),
    );
  }
  let result: unknown = null;
  for (const call of plan) result = await callApi(app, request, call);
  return result;
}

/**
 * Hosted MCP server (Streamable HTTP, JSON responses) for AI assistants. It authenticates with an access token,
 * acts with that token's role, never lists a write tool to a read-only token and masks personal details unless
 * the token was allowed to see them. Every tool goes through the REST API, so writes are validated and audited
 * exactly like the back-office ones, with the token named in the audit log.
 */
export const mcpRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", async (_request, reply) => reply.status(405).header("allow", "POST").send({ code: "method_not_allowed", message: "use POST" }));

  app.post("/", async (request, reply) => {
    const user = request.user;
    if (!user?.apiToken) {
      return reply
        .status(401)
        .header("www-authenticate", 'Bearer realm="axelia-mcp"')
        .send({ code: "unauthenticated", message: "use an access token created in Paramètres > Intégrations" });
    }
    const message = request.body as JsonRpcRequest | JsonRpcRequest[] | undefined;
    if (Array.isArray(message) || typeof message !== "object" || message === null || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return reply.status(400).send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } });
    }
    // Notifications (no id) get no answer.
    if (message.id === undefined) return reply.status(202).send();
    const respond = (result: unknown) => reply.send({ jsonrpc: "2.0", id: message.id, result });
    try {
      switch (message.method) {
        case "initialize": {
          const asked = String(message.params?.protocolVersion ?? "");
          return respond({
            protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
            instructions: INSTRUCTIONS,
          });
        }
        case "ping":
          return respond({});
        case "tools/list":
          return respond({
            tools: visibleTools(user).map((t) => ({
              name: t.name,
              title: t.title,
              description: t.description,
              inputSchema: t.inputSchema,
              annotations: { title: t.title, readOnlyHint: !t.writes, destructiveHint: false, idempotentHint: !t.writes, openWorldHint: false },
            })),
          });
        case "tools/call": {
          const name = String(message.params?.name ?? "");
          const tool = visibleTools(user).find((t) => t.name === name);
          if (!tool) throw new RpcError(-32602, `unknown tool ${name}`);
          try {
            const args = checkArguments(tool, message.params?.arguments);
            const raw = await runTool(app, request, user, tool, args);
            const data = user.apiToken.sharePersonalData ? raw : maskPersonalData(raw);
            const structured = data !== null && typeof data === "object" && !Array.isArray(data) ? data : { items: data };
            return respond({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: structured, isError: false });
          } catch (error) {
            if (error instanceof ToolError) return respond({ content: [{ type: "text", text: error.message }], isError: true });
            throw error;
          }
        }
        default:
          throw new RpcError(-32601, `method not found: ${message.method}`);
      }
    } catch (error) {
      if (error instanceof RpcError) return reply.send({ jsonrpc: "2.0", id: message.id, error: { code: error.code, message: error.message } });
      request.log.error({ err: error }, "mcp request failed");
      return reply.send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "internal error" } });
    }
  });
};
