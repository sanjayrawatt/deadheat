import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT_ERROR, EXIT_OK, formatProxyEvent, main, type Io } from "./cli.js";

let dir: string;

function io(env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const value: Io = {
    out: (t) => void out.push(t),
    err: (t) => void err.push(t),
    cwd: dir,
    env,
  };
  return { io: value, out: () => out.join(""), err: () => err.join("") };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "deadheat-cli-"));
  await writeFile(join(dir, "bad.ts"), "export default { name: 'x' };");
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe("deadheat CLI arguments", () => {
  it("prints the version", async () => {
    const t = io();
    expect(await main(["--version"], t.io)).toBe(EXIT_OK);
    expect(t.out()).toMatch(/^deadheat \d+\.\d+\.\d+/);
  });

  it("prints help with -h and exits 0", async () => {
    const t = io();
    expect(await main(["-h"], t.io)).toBe(EXIT_OK);
    expect(t.out()).toContain("deadheat run <scenario.ts>");
  });

  it("exits 2 with help when no command is given", async () => {
    const t = io();
    expect(await main([], t.io)).toBe(EXIT_ERROR);
    expect(t.err()).toContain("Usage:");
  });

  it.each([
    [["run"], /Expected: deadheat run/],
    [["walk", "x.ts"], /Expected: deadheat run/],
    [["run", "x.ts", "--bogus"], /Unknown option/],
    [["run", "x.ts", "--strategy", "magic"], /unknown strategy "magic"/],
    [["run", "x.ts", "--trials", "0"], /--trials must be/],
    [["run", "x.ts", "--strategy", "naive", "--settle", "5"], /--settle only applies/],
    [["run", "x.ts", "--settle=-1"], /--settle must be/],
    [["run", "x.ts"], /no database/],
  ])("rejects %j", async (argv, message) => {
    const t = io();
    expect(await main(argv, t.io)).toBe(EXIT_ERROR);
    expect(t.err()).toMatch(message);
  });

  it("reports an invalid scenario file before touching the database", async () => {
    const t = io({ DEADHEAT_DATABASE_URL: "postgres://nobody@127.0.0.1:1/none" });
    expect(await main(["run", "bad.ts"], t.io)).toBe(EXIT_ERROR);
    expect(t.err()).toMatch(/invalid scenario/);
  });
});

describe("deadheat proxy", () => {
  it("formats each kind of event on one line", () => {
    expect(
      formatProxyEvent({ type: "connection-open", connectionId: 3, user: "u", database: "d" }),
    ).toBe("#3   connected  user=u db=d");
    expect(
      formatProxyEvent({
        type: "query",
        connectionId: 3,
        protocol: "simple",
        sql: "SELECT  *\n  FROM bookings",
        startedAt: 0,
        durationMs: 1.234,
        rows: 2,
        commandTags: ["SELECT 2"],
        txStatus: "T",
      }),
    ).toBe("#3       1.2ms [T] SELECT * FROM bookings → SELECT 2 (2 rows)");
    expect(formatProxyEvent({ type: "connection-close", connectionId: 3, queries: 1 })).toBe(
      "#3   closed after 1 query",
    );
  });

  it("rejects a missing upstream", async () => {
    const t = io();
    expect(await main(["proxy"], t.io)).toBe(EXIT_ERROR);
    expect(t.err()).toMatch(/--upstream host:port/);
  });

  it("proxies a real connection and logs its queries until stopped", async () => {
    const upstream = new URL(
      process.env.DATABASE_URL ?? "postgres://deadheat:deadheat@localhost:55432/deadheat",
    );
    const controller = new AbortController();
    const t = io();
    t.io.signal = controller.signal;
    const done = main(
      ["proxy", "--upstream", `${upstream.hostname}:${upstream.port}`, "--port", "0"],
      t.io,
    );

    let port: string | undefined;
    for (let i = 0; i < 50 && !port; i++) {
      await new Promise((r) => setTimeout(r, 20));
      port = /127\.0\.0\.1:(\d+)/.exec(t.err())?.[1];
    }
    const url = new URL(upstream);
    url.hostname = "127.0.0.1";
    url.port = port!;
    const client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    await client.query("SELECT 40 + 2 AS answer");
    await client.end();

    controller.abort();
    expect(await done).toBe(EXIT_OK);
    expect(t.out()).toMatch(/connected {2}user=deadheat db=deadheat/);
    expect(t.out()).toMatch(/\[I\] SELECT 40 \+ 2 AS answer → SELECT 1 \(1 row\)/);
  });
});
