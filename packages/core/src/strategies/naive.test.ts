import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { naive } from "./naive.js";

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
      res.writeHead(req.url === "/full" ? 409 : 201, { "content-type": "application/json" });
      res.end(JSON.stringify({ echo: body }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("naive strategy", () => {
  it("sends every request and records status, body and timings", async () => {
    const traces = await naive.fire(baseUrl, [
      { method: "POST", url: "/book", body: { userId: 1 } },
      { method: "POST", url: "/full", body: "raw", headers: { "content-type": "text/plain" } },
    ]);

    expect(traces.map((t) => t.status)).toEqual([201, 409]);
    expect(traces[0]?.body).toContain('{\\"userId\\":1}');
    for (const t of traces) {
      expect(t.sentAtMs).toBeGreaterThanOrEqual(0);
      expect(t.headersAtMs).toBeGreaterThanOrEqual(t.sentAtMs);
    }
    const json = seen.find((s) => s.url === "/book");
    expect(json?.contentType).toBe("application/json");
    const raw = seen.find((s) => s.url === "/full");
    expect(raw).toMatchObject({ contentType: "text/plain", body: "raw" });
  });

  it("records a connection error instead of throwing", async () => {
    const [trace] = await naive.fire("http://127.0.0.1:1", [{ method: "GET", url: "/" }]);
    expect(trace?.status).toBeUndefined();
    expect(trace?.error).toBeTruthy();
  });
});
