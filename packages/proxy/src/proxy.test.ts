// Integration: a real Postgres behind the proxy. Needs `docker compose up -d` locally;
// CI provides a Postgres service.
import pg from "pg";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startProxy, type ProxyEvent, type QueryEvent, type RunningProxy } from "./proxy.js";

const UPSTREAM = new URL(
  process.env.DATABASE_URL ?? "postgres://deadheat:deadheat@localhost:55432/deadheat",
);
let proxy: RunningProxy;
let events: ProxyEvent[] = [];

const queries = () => events.filter((e): e is QueryEvent => e.type === "query");
const viaProxy = () => {
  const url = new URL(UPSTREAM);
  url.port = String(proxy.port);
  url.hostname = "127.0.0.1";
  return url.toString();
};

beforeAll(async () => {
  proxy = await startProxy({
    upstream: { host: UPSTREAM.hostname, port: Number(UPSTREAM.port) },
    onEvent: (e) => events.push(e),
  });
});
afterAll(() => proxy.close());
beforeEach(() => {
  events = [];
});

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: viaProxy(), application_name: "proxy-test" });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

describe("proxy", () => {
  it("authenticates through the proxy and reports the connection", async () => {
    await withClient(async (c) => {
      expect((await c.query("SELECT current_user AS u")).rows[0]).toEqual({ u: "deadheat" });
    });
    expect(events[0]).toMatchObject({
      type: "connection-open",
      user: "deadheat",
      database: "deadheat",
      applicationName: "proxy-test",
    });
    expect(events.at(-1)).toMatchObject({ type: "connection-close", queries: 1 });
  });

  it("emits a query event with SQL, rows, tag and transaction status", async () => {
    await withClient((c) => c.query("SELECT generate_series(1, 3) AS n"));
    expect(queries()).toEqual([
      expect.objectContaining({
        protocol: "simple",
        sql: "SELECT generate_series(1, 3) AS n",
        rows: 3,
        commandTags: ["SELECT 3"],
        txStatus: "I",
      }),
    ]);
    expect(queries()[0]!.durationMs).toBeGreaterThan(0);
  });

  it("tracks transaction status and errors", async () => {
    await withClient(async (c) => {
      await c.query("BEGIN");
      await expect(c.query("SELECT * FROM no_such_table")).rejects.toThrow(/does not exist/);
      await c.query("ROLLBACK");
    });
    expect(queries().map((q) => [q.sql, q.txStatus, q.error?.code])).toEqual([
      ["BEGIN", "T", undefined],
      ["SELECT * FROM no_such_table", "E", "42P01"],
      ["ROLLBACK", "I", undefined],
    ]);
  });

  it("reports every statement of a multi-statement query", async () => {
    await withClient((c) => c.query("SELECT 1; SELECT 2, 3"));
    expect(queries()[0]).toMatchObject({ rows: 2, commandTags: ["SELECT 1", "SELECT 1"] });
  });

  it("forwards the extended protocol transparently (decoded from Week 5)", async () => {
    await withClient(async (c) => {
      expect((await c.query("SELECT $1::int + 1 AS n", [41])).rows[0]).toEqual({ n: 42 });
    });
    expect(queries()).toHaveLength(0);
  });

  it("refuses SSL so a client that prefers TLS falls back to plaintext", async () => {
    const sql = postgres(viaProxy(), { ssl: "prefer", max: 1 });
    try {
      // postgres.js uses the extended protocol; .simple() forces a simple query.
      const [row] = await sql`SELECT 1 AS one`.simple();
      expect(row).toEqual({ one: 1 });
    } finally {
      await sql.end();
    }
    expect(queries().map((q) => q.sql)).toContain("SELECT 1 AS one");
  });

  it("handles many concurrent connections", async () => {
    const pool = new pg.Pool({ connectionString: viaProxy(), max: 10 });
    try {
      const results = await Promise.all(
        Array.from({ length: 50 }, (_, i) => pool.query(`SELECT ${i} AS i`)),
      );
      expect(results.map((r) => r.rows[0].i)).toEqual(Array.from({ length: 50 }, (_, i) => i));
    } finally {
      await pool.end();
    }
    expect(queries()).toHaveLength(50);
  });
});
