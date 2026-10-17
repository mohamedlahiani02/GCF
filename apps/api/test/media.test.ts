import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

let h: Harness;
let admin: string;
let secretariat: string;
let editor: string;

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A PNG header with the given size (signature, IHDR, IEND). */
function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IEND", Buffer.alloc(0))]);
}

/** A JPEG with an APP0 and a DHT segment before the SOF0 frame header, so the reader must skip both. */
function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const dht = Buffer.from([0xff, 0xc4, 0x00, 0x04, 0x00, 0x00]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, dht, sof, Buffer.from([0xff, 0xd9])]);
}

function riff(chunkType: string, payload: Buffer): Buffer {
  const size = Buffer.alloc(4);
  size.writeUInt32LE(payload.length);
  const body = Buffer.concat([Buffer.from("WEBP", "ascii"), Buffer.from(chunkType, "ascii"), size, payload]);
  const total = Buffer.alloc(4);
  total.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from("RIFF", "ascii"), total, body]);
}

function webpLossy(width: number, height: number): Buffer {
  const payload = Buffer.alloc(16);
  payload.set([0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a], 0);
  payload.writeUInt16LE(width, 6);
  payload.writeUInt16LE(height, 8);
  return riff("VP8 ", payload);
}

function webpLossless(width: number, height: number): Buffer {
  const bits = (width - 1) | ((height - 1) << 14);
  const payload = Buffer.alloc(16);
  payload[0] = 0x2f;
  payload.writeUInt32LE(bits >>> 0, 1);
  return riff("VP8L", payload);
}

function webpExtended(width: number, height: number): Buffer {
  const payload = Buffer.alloc(10);
  payload.writeUIntLE(width - 1, 4, 3);
  payload.writeUIntLE(height - 1, 7, 3);
  return riff("VP8X", payload);
}

const dataUrl = (mime: string, bytes: Buffer) => `data:${mime};base64,${bytes.toString("base64")}`;

beforeAll(async () => {
  h = await createHarness();
  await h.setModules(["training", "coworking", "website"]);
  await h.createUser("admin", "admin@media.tn");
  await h.createUser("secretariat", "sec@media.tn");
  await h.createUser("editor", "editor@media.tn");
  admin = await h.login("admin@media.tn");
  secretariat = await h.login("sec@media.tn");
  editor = await h.login("editor@media.tn");
});

afterAll(async () => {
  await h.close();
});

describe("media library", () => {
  it("reads the pixel size of PNG, JPEG and WebP files and stores their hash", async () => {
    const cases: [string, Buffer, number, number][] = [
      ["image/png", png(640, 480), 640, 480],
      ["image/jpeg", jpeg(1200, 800), 1200, 800],
      ["image/webp", webpLossy(320, 200), 320, 200],
      ["image/webp", webpLossless(1000, 750), 1000, 750],
      ["image/webp", webpExtended(4000, 3000), 4000, 3000],
    ];
    for (const [mime, bytes, width, height] of cases) {
      const res = await h.call("POST", "/api/media", editor, { image: dataUrl(mime, bytes), alt: "Open space", folder: "site" });
      expect(res.status, mime).toBe(201);
      expect(res.body).toMatchObject({ mime, width, height, bytes: bytes.length, alt: "Open space", folder: "site", status: "active" });
      expect(res.body.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
  });

  it("refuses a file whose content does not match its type or whose size cannot be read", async () => {
    const mismatch = await h.call("POST", "/api/media", editor, { image: dataUrl("image/jpeg", png(10, 10)) });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.code).toBe("invalid_image");
    const truncated = await h.call("POST", "/api/media", editor, { image: dataUrl("image/png", png(10, 10).subarray(0, 12)) });
    expect(truncated.body.code).toBe("invalid_image");
    const noFrame = await h.call("POST", "/api/media", editor, { image: dataUrl("image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xd9])) });
    expect(noFrame.body.code).toBe("invalid_image");
    const gif = await h.call("POST", "/api/media", editor, { image: "data:image/gif;base64,R0lGODlhAQABAAAAACw=" });
    expect(gif.body.code).toBe("invalid_image");
  });

  it("lists by folder, edits the alt text and archives", async () => {
    const plan = await h.call("POST", "/api/media", admin, { image: dataUrl("image/png", png(2000, 1200)), folder: "plans" });
    const list = await h.call("GET", "/api/media?folder=plans", secretariat);
    expect(list.status).toBe(200);
    expect(list.body.items.map((m: { id: string }) => m.id)).toEqual([plan.body.id]);
    const paged = await h.call("GET", "/api/media?pageSize=2", editor);
    expect(paged.body.items).toHaveLength(2);
    expect(paged.body.hasMore).toBe(true);

    const updated = await h.call("PATCH", `/api/media/${plan.body.id}`, admin, { alt: "Plan du rez-de-chaussée", folder: "" });
    expect(updated.body).toMatchObject({ alt: "Plan du rez-de-chaussée", folder: null });
    const archived = await h.call("POST", `/api/media/${plan.body.id}/archive`, admin);
    expect(archived.body.status).toBe("archived");
    expect((await h.call("GET", "/api/media?status=archived", admin)).body.items).toHaveLength(1);
  });

  it("serves the bytes to staff and publicly with an immutable cache", async () => {
    const bytes = png(16, 16);
    const created = await h.call("POST", "/api/media", editor, { image: dataUrl("image/png", bytes) });
    const staff = await h.app.inject({ method: "GET", url: `/api/media/${created.body.id}/file`, headers: { cookie: editor } });
    expect(staff.statusCode).toBe(200);
    expect(staff.headers["content-type"]).toBe("image/png");
    expect(staff.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(staff.rawPayload.equals(bytes)).toBe(true);

    const pub = await h.getPublic(`/media/${created.body.id}`);
    expect(pub.status).toBe(200);
    expect(pub.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect((await h.getPublic("/media/00000000-0000-0000-0000-000000000000")).status).toBe(404);
    expect((await h.getPublic("/media/not-an-id")).status).toBe(404);
  });

  it("lets coworking managers and editors upload, and only readers of either module read", async () => {
    const image = dataUrl("image/png", png(8, 8));
    expect((await h.call("POST", "/api/media", secretariat, { image })).status).toBe(403);
    expect((await h.call("GET", "/api/media", secretariat)).status).toBe(200);

    await h.setModules(["coworking"]);
    const adminCw = await h.login("admin@media.tn");
    const editorOff = await h.login("editor@media.tn");
    expect((await h.call("POST", "/api/media", adminCw, { image })).status).toBe(201);
    expect((await h.call("GET", "/api/media", editorOff)).status).toBe(403);

    await h.setModules(["training"]);
    const adminTraining = await h.login("admin@media.tn");
    expect((await h.call("GET", "/api/media", adminTraining)).status).toBe(403);
    expect((await h.call("POST", "/api/media", adminTraining, { image })).status).toBe(403);
    await h.setModules(["training", "coworking", "website"]);
  });
});
