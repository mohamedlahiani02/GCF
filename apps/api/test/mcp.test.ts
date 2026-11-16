import { todayIn } from "@gcf/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiToken } from "../src/auth/apiTokens.js";
import { createHarness, ORIGIN, type Harness } from "./harness.js";

let h: Harness;
let admin: string;
let readToken: string;
let writeToken: string;
let openToken: string;
const ids: Record<string, string> = {};
const today = todayIn("Africa/Tunis");

let rpcId = 0;
async function rpc(token: string | null, method: string, params?: Record<string, unknown>) {
  const res = await h.app.inject({
    method: "POST",
    url: "/api/mcp",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    payload: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, ...(params ? { params } : {}) }),
  });
  return { status: res.statusCode, headers: res.headers, body: res.body ? JSON.parse(res.body) : null };
}
const call = async (token: string, name: string, args: Record<string, unknown> = {}) => (await rpc(token, "tools/call", { name, arguments: args })).body.result;

beforeAll(async () => {
  h = await createHarness();
  await h.setModules(["training", "coworking"]);
  ids.admin = await h.createUser("admin", "admin@mcp.test");
  admin = await h.login("admin@mcp.test");
  const token = async (readOnly: boolean, sharePersonalData: boolean) =>
    (
      await createApiToken(h.db, {
        centreId: h.centreId,
        name: `MCP ${readOnly}-${sharePersonalData}`,
        role: "secretariat",
        readOnly,
        sharePersonalData,
        expiresAt: null,
        createdBy: ids.admin,
      })
    ).token;
  readToken = await token(true, false);
  writeToken = await token(false, false);
  openToken = await token(true, true);
  ids.member = (
    await h.db
      .insertInto("members")
      .values({
        centre_id: h.centreId,
        kind: "member",
        first_name: "Selma",
        last_name: "Aurelle",
        email: "selma@mcp.test",
        phone: "55 123 456",
        status: "active",
      })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
});

afterAll(async () => {
  await h.close();
});

describe("MCP server", () => {
  it("asks for an access token and negotiates the protocol", async () => {
    const anonymous = await rpc(null, "initialize", { protocolVersion: "2025-06-18" });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers["www-authenticate"]).toContain("Bearer");
    const withSession = await h.app.inject({
      method: "POST",
      url: "/api/mcp",
      headers: { cookie: admin, origin: ORIGIN, "content-type": "application/json" },
      payload: "{}",
    });
    expect(withSession.statusCode).toBe(401);
    const init = await rpc(readToken, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(init.body.result).toMatchObject({ protocolVersion: "2025-03-26", serverInfo: { name: "axelia" }, capabilities: { tools: {} } });
    expect((await rpc(readToken, "initialize", { protocolVersion: "1999-01-01" })).body.result.protocolVersion).toBe("2025-06-18");
    const notification = await h.app.inject({
      method: "POST",
      url: "/api/mcp",
      headers: { "content-type": "application/json", authorization: `Bearer ${readToken}` },
      payload: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(notification.statusCode).toBe(202);
    expect((await rpc(readToken, "resources/list")).body.error.code).toBe(-32601);
  });

  it("lists only the tools the token may use and hides writes from read-only tokens", async () => {
    const read = (await rpc(readToken, "tools/list")).body.result.tools.map((t: { name: string }) => t.name);
    expect(read).toEqual(expect.arrayContaining(["list_entities", "list_records", "get_record", "coworking_occupancy"]));
    expect(read).not.toContain("create_prospect");
    expect(read).not.toContain("send_invoice");
    const write = (await rpc(writeToken, "tools/list")).body.result.tools;
    const prospect = write.find((t: { name: string }) => t.name === "create_prospect");
    expect(prospect.annotations).toMatchObject({ readOnlyHint: false });
    expect(write.find((t: { name: string }) => t.name === "list_records").annotations.readOnlyHint).toBe(true);
    expect((await rpc(readToken, "tools/call", { name: "create_prospect", arguments: { name: "X", source: "phone" } })).body.error.code).toBe(-32602);
  });

  it("reads records through the API and masks personal details unless the token may see them", async () => {
    const entities = await call(readToken, "list_entities");
    expect(entities.structuredContent.items.map((e: { entity: string }) => e.entity)).toEqual(
      expect.arrayContaining(["coworking_members", "prospects", "visitors"]),
    );
    expect(entities.structuredContent.items.map((e: { entity: string }) => e.entity)).not.toContain("payments_secret");
    const masked = await call(readToken, "get_record", { entity: "coworking_members", id: ids.member });
    expect(masked.isError).toBe(false);
    expect(masked.structuredContent).toMatchObject({ firstName: "Selma", email: "s***@mcp.test", phone: "***56" });
    const open = await call(openToken, "get_record", { entity: "coworking_members", id: ids.member });
    expect(open.structuredContent).toMatchObject({ email: "selma@mcp.test", phone: "55 123 456" });
    const listed = await call(readToken, "list_records", { entity: "coworking_members", filters: { q: "Selma" } });
    expect(JSON.stringify(listed.structuredContent)).not.toContain("selma@mcp.test");
    expect((await call(readToken, "list_records", { entity: "coworking_members", filters: { secret: 1 } })).isError).toBe(true);
    expect((await call(readToken, "list_records", { entity: "visitors" })).content[0].text).toContain("needs the filters: date");
    expect((await call(readToken, "list_records", { entity: "invented" })).isError).toBe(true);
  });

  it("writes through the API with the token's role, and reports business errors to the assistant", async () => {
    const created = await call(writeToken, "create_prospect", { name: "Karim Valmont", phone: "55 999 000", source: "phone", interests: ["coworking"] });
    expect(created.isError).toBe(false);
    expect(created.structuredContent).toMatchObject({ name: "Karim Valmont", stage: "new", phone: "***00" });
    const audit = await h.db
      .selectFrom("audit_log")
      .select(["action", "api_token_id", "user_id"])
      .where("object_id", "=", created.structuredContent.id)
      .executeTakeFirstOrThrow();
    expect(audit).toMatchObject({ action: "prospect.created", user_id: ids.admin });
    expect(audit.api_token_id).not.toBeNull();
    const refused = await call(writeToken, "create_prospect", { name: "Sans contact", source: "phone" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain("prospect_contact_required");
    expect((await call(writeToken, "create_prospect", { name: "X" })).content[0].text).toContain("missing arguments: source");
    expect((await call(writeToken, "log_prospect_activity", { prospectId: "nope", kind: "call", text: "x" })).content[0].text).toContain(
      "must be an identifier",
    );
    const visitor = await call(writeToken, "announce_visitor", { hostMemberId: ids.member, name: "Nadia Orbite", expectedOn: today });
    expect(visitor.structuredContent).toMatchObject({ status: "expected", hostName: "Selma Aurelle" });
    const arrived = await call(writeToken, "record_visitor", { visitorId: visitor.structuredContent.id, step: "arrive" });
    expect(arrived.structuredContent.status).toBe("arrived");
  });

  it("summarises the coworking occupancy floor by floor", async () => {
    const floor = (await h.db.insertInto("cw_floors").values({ centre_id: h.centreId, name: "RDC" }).returning("id").executeTakeFirstOrThrow()).id;
    const type = (
      await h.db
        .insertInto("cw_resource_types")
        .values({ centre_id: h.centreId, name: "Open space", category: "hot_desk" })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    await h.db
      .insertInto("cw_resources")
      .values([
        { centre_id: h.centreId, type_id: type, floor_id: floor, code: "A1" },
        { centre_id: h.centreId, type_id: type, floor_id: floor, code: "A2" },
      ])
      .execute();
    const occupancy = await call(readToken, "coworking_occupancy");
    expect(occupancy.structuredContent.items).toEqual([{ floor: "RDC", total: 2, byState: { free: 2 } }]);
  });
});
