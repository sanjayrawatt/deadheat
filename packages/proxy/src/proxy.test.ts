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

  it("decodes extended-protocol queries: SQL, params and the first row", async () => {
    await withClient(async (c) => {
      expect((await c.query("SELECT $1::int + 1 AS n, $2::text AS s", [41, null])).rows[0]).toEqual(
        {
          n: 42,
          s: null,
        },
      );
    });
    expect(queries()).toEqual([
      expect.objectContaining({
        protocol: "extended",
        sql: "SELECT $1::int + 1 AS n, $2::text AS s",
        params: ["41", null],
        rows: 1,
        firstRow: ["42", null],
        commandTags: ["SELECT 1"],
        txStatus: "I",
      }),
    ]);
  });

  it("follows named prepared statements across executions", async () => {
    await withClient(async (c) => {
      // pg sends Parse only the first time; the second run is just Bind + Execute.
      await c.query({ name: "get-n", text: "SELECT $1::int AS n", values: [1] });
      await c.query({ name: "get-n", text: "SELECT $1::int AS n", values: [2] });
    });
    expect(queries().map((q) => [q.sql, q.params, q.firstRow])).toEqual([
      ["SELECT $1::int AS n", ["1"], ["1"]],
      ["SELECT $1::int AS n", ["2"], ["2"]],
    ]);
  });

  it("reports extended-protocol errors and transaction status", async () => {
    await withClient(async (c) => {
      await c.query("BEGIN");
      await expect(c.query("INSERT INTO no_such_table VALUES ($1)", [1])).rejects.toThrow();
      await c.query("ROLLBACK");
    });
    expect(queries().map((q) => [q.protocol, q.txStatus, q.error?.code])).toEqual([
      ["simple", "T", undefined],
      ["extended", "E", "42P01"],
      ["simple", "I", undefined],
    ]);
  });

  it("reads the agent's request id from the SQL comment and strips it", async () => {
    await withClient(async (c) => {
      await c.query("/* deadheat_rid=run-1.3.7 */ SELECT $1::int AS n", [5]);
      await c.query("/* deadheat_rid=run-1.3.8 */ SELECT 1");
    });
    expect(queries().map((q) => [q.requestId, q.sql])).toEqual([
      ["run-1.3.7", "SELECT $1::int AS n"],
      ["run-1.3.8", "SELECT 1"],
    ]);
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

describe("holds (race-window widening)", () => {
  async function timed(c: pg.Client, sql: string, values?: unknown[]) {
    const t = performance.now();
    const res = await c.query(sql, values);
    return { ms: performance.now() - t, rows: res.rows };
  }

  it("holds the result of a matching tagged read, and nothing else", async () => {
    proxy.setHolds({ holdMs: 150, fingerprints: ["SELECT $1::int AS n"] });
    try {
      await withClient(async (c) => {
        const held = await timed(c, "/* deadheat_rid=r.1.0 */ SELECT $1::int AS n", [7]);
        expect(held.ms).toBeGreaterThanOrEqual(145);
        expect(held.rows).toEqual([{ n: 7 }]); // the held result arrives intact

        const untagged = await timed(c, "SELECT $1::int AS n", [8]);
        const otherQuery = await timed(c, "/* deadheat_rid=r.1.0 */ SELECT $1::int AS m", [9]);
        expect(untagged.ms).toBeLessThan(100);
        expect(otherQuery.ms).toBeLessThan(100);
      });
    } finally {
      proxy.setHolds(null);
    }
    const held = queries().filter((q) => q.heldMs);
    expect(held.map((q) => [q.sql, q.heldMs])).toEqual([["SELECT $1::int AS n", 150]]);
  });

  it("matches literal-only differences through the fingerprint", async () => {
    proxy.setHolds({ holdMs: 120, fingerprints: ["SELECT ? AS lit"] });
    try {
      await withClient(async (c) => {
        expect(
          (await timed(c, "/* deadheat_rid=r.2.0 */ SELECT 41 AS lit")).ms,
        ).toBeGreaterThanOrEqual(115);
      });
    } finally {
      proxy.setHolds(null);
    }
  });

  it("keeps a connection's later results in order behind a held one", async () => {
    proxy.setHolds({ holdMs: 100, fingerprints: ["SELECT $1::int AS n"] });
    try {
      await withClient(async (c) => {
        // pg pipelines these on one connection; the second must not overtake the held first.
        const [a, b] = await Promise.all([
          c.query("/* deadheat_rid=r.3.0 */ SELECT $1::int AS n", [1]),
          c.query("SELECT $1::int AS m", [2]),
        ]);
        expect(a.rows).toEqual([{ n: 1 }]);
        expect(b.rows).toEqual([{ m: 2 }]);
      });
    } finally {
      proxy.setHolds(null);
    }
    expect(proxy.holds).toBeNull();
  });
});
