import { startProxy, type QueryEvent, type RunningProxy } from "@deadheat/proxy";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  currentRequestId,
  instrumentPg,
  registerFastify,
  REQUEST_ID_HEADER,
  tagSql,
  withRequestId,
} from "./index.js";

describe("tagSql / withRequestId", () => {
  it("tags only inside a request, and never twice", () => {
    expect(tagSql("SELECT 1")).toBe("SELECT 1");
    withRequestId("r.1.2", () => {
      const once = tagSql("SELECT 1");
      expect(once).toBe("/* deadheat_rid=r.1.2 */ SELECT 1");
      expect(tagSql(once)).toBe(once);
    });
  });

  it("keeps the id across awaits and replaces unsafe ids", async () => {
    await withRequestId("ok-id", async () => {
      await new Promise((r) => setTimeout(r, 5));
      expect(currentRequestId()).toBe("ok-id");
    });
    withRequestId("*/ DROP TABLE x; /*", () => {
      expect(currentRequestId()).toMatch(/^gen-[0-9a-f-]{36}$/);
    });
  });
});

describe("instrumentPg against real Postgres, observed through the proxy", () => {
  const upstream = new URL(
    process.env.DATABASE_URL ?? "postgres://deadheat:deadheat@localhost:55432/deadheat",
  );
  const events: QueryEvent[] = [];
  let proxy: RunningProxy;
  let undo: () => void;
  let url: string;

  beforeAll(async () => {
    proxy = await startProxy({
      upstream: { host: upstream.hostname, port: Number(upstream.port) },
      onEvent: (e) => e.type === "query" && events.push(e),
    });
    const u = new URL(upstream);
    u.hostname = "127.0.0.1";
    u.port = String(proxy.port);
    url = u.toString();
    undo = instrumentPg(pg);
  });
  afterAll(async () => {
    undo();
    await proxy.close();
  });

  it("attributes every query correctly even when requests wait for a pooled connection", async () => {
    events.length = 0;
    // 2 connections, 10 "requests": most of them queue inside pg-pool.
    const pool = new pg.Pool({ connectionString: url, max: 2 });
    try {
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          withRequestId(`req-${i}`, async () => {
            await pool.query("SELECT $1::int AS step, pg_sleep(0.005)", [1]);
            await pool.query("SELECT $1::int AS step", [2]);
          }),
        ),
      );
    } finally {
      await pool.end();
    }
    expect(events).toHaveLength(20);
    for (let i = 0; i < 10; i++) {
      const mine = events.filter((e) => e.requestId === `req-${i}`);
      expect(mine.map((e) => e.params?.[0])).toEqual(["1", "2"]);
    }
  });

  it("tags queries on a checked-out client, but leaves named statements alone", async () => {
    events.length = 0;
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    try {
      await withRequestId("tx-1", async () => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query({ name: "named-q", text: "SELECT $1::int AS n", values: [7] });
          await client.query("COMMIT");
        } finally {
          client.release();
        }
      });
    } finally {
      await pool.end();
    }
    expect(events.map((e) => [e.sql, e.requestId])).toEqual([
      ["BEGIN", "tx-1"],
      ["SELECT $1::int AS n", undefined],
      ["COMMIT", "tx-1"],
    ]);
  });

  it("does nothing outside a request", async () => {
    events.length = 0;
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query("SELECT 1");
    await client.end();
    expect(events[0]?.requestId).toBeUndefined();
  });
});

describe("registerFastify", () => {
  it("runs each request with the id from the Deadheat header, or a generated one", async () => {
    const app = Fastify();
    registerFastify(app);
    app.get("/whoami", async () => {
      await new Promise((r) => setTimeout(r, 2));
      return { id: currentRequestId() };
    });
    try {
      const withHeader = await app.inject({
        url: "/whoami",
        headers: { [REQUEST_ID_HEADER]: "run-9.1.4" },
      });
      expect(withHeader.json()).toEqual({ id: "run-9.1.4" });
      const without = await app.inject({ url: "/whoami" });
      expect(without.json().id).toMatch(/^gen-/);
    } finally {
      await app.close();
    }
  });
});
