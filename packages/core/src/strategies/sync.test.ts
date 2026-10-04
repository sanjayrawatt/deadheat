import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseResponse, prepare, sync } from "./sync.js";

let server: Server;
let baseUrl: string;
const seen: { method?: string; url?: string; contentType?: string; body: string }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({
        method: req.method,
        url: req.url,
        contentType: req.headers["content-type"],
        body,
      });
      if (req.url === "/chunked") {
        // No content-length, so Node uses chunked transfer encoding.
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("hello ");
        res.end("world");
        return;
      }
      res.writeHead(req.url === "/full" ? 409 : 201, { "content-type": "application/json" });
      res.end(JSON.stringify({ echo: body }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("sync strategy", () => {
  it("delivers every request intact and parses each response", async () => {
    const specs = Array.from({ length: 10 }, (_, i) => ({
      method: "POST",
      url: `/book?i=${i}`,
      body: { userId: i },
    }));
    const traces = await sync.fire(baseUrl, specs);

    expect(traces.map((t) => t.status)).toEqual(Array(10).fill(201));
    for (const [i, t] of traces.entries()) {
      expect(t.error).toBeUndefined();
      expect(JSON.parse(t.body!)).toEqual({ echo: JSON.stringify({ userId: i }) });
      expect(t.headersAtMs).toBeGreaterThanOrEqual(t.sentAtMs);
    }
    const received = seen.filter((s) => s.url?.startsWith("/book?i="));
    expect(received).toHaveLength(10);
    expect(received.every((r) => r.contentType === "application/json")).toBe(true);
  });

  it("releases all final bytes within a fraction of a millisecond (client side)", async () => {
    const specs = Array.from({ length: 20 }, () => ({ method: "POST", url: "/x", body: {} }));
    const traces = await sync.fire(baseUrl, specs);
    const sent = traces.map((t) => t.sentAtMs);
    expect(Math.max(...sent) - Math.min(...sent)).toBeLessThan(1);
  });

  it("handles a GET with no body, a raw string body and custom headers", async () => {
    const [get, raw] = await sync.fire(baseUrl, [
      { method: "GET", url: "/full" },
      { method: "PUT", url: "/raw", body: "plain", headers: { "Content-Type": "text/plain" } },
    ]);
    expect(get?.status).toBe(409);
    expect(raw?.status).toBe(201);
    expect(seen.find((s) => s.url === "/raw")).toMatchObject({
      method: "PUT",
      contentType: "text/plain",
      body: "plain",
    });
  });

  it("decodes a chunked response", async () => {
    const [t] = await sync.fire(baseUrl, [{ method: "GET", url: "/chunked" }]);
    expect(t?.body).toBe("hello world");
  });

  it("turns a refused connection into an error trace instead of throwing", async () => {
    const [t] = await sync.fire("http://127.0.0.1:1", [{ method: "GET", url: "/" }]);
    expect(t?.status).toBeUndefined();
    expect(t?.error).toMatch(/ECONNREFUSED/);
  });

  it("rejects https for now", () => {
    expect(() => prepare("https://example.com", { method: "GET", url: "/" })).toThrow(/http:\/\//);
  });
});

describe("parseResponse", () => {
  it("respects content-length", () => {
    const raw = Buffer.from("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nokEXTRA");
    expect(parseResponse(raw)).toEqual({ status: 200, body: "ok" });
  });

  it("rejects a truncated response", () => {
    expect(() => parseResponse(Buffer.from("HTTP/1.1 200 OK\r\n"))).toThrow(/incomplete/);
  });
});
