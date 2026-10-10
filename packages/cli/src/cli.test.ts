import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
    [["run", "x.ts", "--widen", "200"], /--widen needs --proxy/],
    [["run", "x.ts", "--widen", "0", "--proxy", "http://x"], /--widen must be/],
    [["run", "x.ts", "--schedule", "random"], /--schedule needs --proxy/],
    [["run", "x.ts", "--schedule", "pct", "--proxy", "http://x"], /--schedule must be "random"/],
    [
      ["run", "x.ts", "--schedule", "random", "--proxy", "http://x", "--widen", "100"],
      /either --widen or --schedule/,
    ],
    [["run", "x.ts", "--schedule", "random", "--proxy", "http://x", "--seed=-1"], /--seed must be/],
    [["run", "x.ts", "--seed", "5"], /--seed only applies/],
    [
      [
        "run",
        "x.ts",
        "--database-url",
        "postgres://x@127.0.0.1:1/x",
        "--proxy",
        "http://127.0.0.1:1",
      ],
      /cannot reach deadheat proxy/,
    ],
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

describe("deadheat show", () => {
  const run = (id: string, extra: object = {}) => ({
    formatVersion: 1,
    runId: id,
    scenario: "slot is never oversold",
    strategy: "sync",
    config: { baseUrl: "http://127.0.0.1:4100", concurrency: 2, trials: 2 },
    startedAt: "2026-10-10T00:00:00Z",
    durationMs: 100,
    violations: 1,
    trials: [
      { trial: 1, passed: true, durationMs: 5, requests: [] },
      {
        trial: 2,
        passed: false,
        violation: "bookings = 2, capacity = 1",
        durationMs: 5,
        requests: [0, 1].map((index) => ({
          index,
          method: "POST",
          url: "/bookings",
          sentAtMs: index,
          status: 201,
          queries: [
            {
              sql: "SELECT COUNT(*) FROM bookings WHERE slot_id = $1",
              params: ["1"],
              rows: 1,
              firstRow: ["0"],
              commandTags: ["SELECT 1"],
              startedAt: index,
              durationMs: 1,
              txStatus: "I",
              connectionId: index + 1,
              protocol: "extended",
            },
          ],
        })),
      },
    ],
    ...extra,
  });
  let showDir: string;

  beforeAll(async () => {
    showDir = await mkdtemp(join(tmpdir(), "deadheat-show-"));
    await mkdir(join(showDir, ".deadheat", "runs"), { recursive: true });
    for (const r of [run("run-20261010T100000-aaaa"), run("run-20261010T110000-bbbb")]) {
      await writeFile(join(showDir, ".deadheat", "runs", `${r.runId}.json`), JSON.stringify(r));
    }
    await writeFile(
      join(showDir, "future.json"),
      JSON.stringify(run("run-x", { formatVersion: 99 })),
    );
  });
  afterAll(() => rm(showDir, { recursive: true, force: true }));

  const showIo = () => {
    const t = io();
    t.io.cwd = showDir;
    return t;
  };

  it("prints the latest saved run by default", async () => {
    const t = showIo();
    expect(await main(["show"], t.io)).toBe(EXIT_OK);
    expect(t.out()).toContain("1/2 trials violated");
    expect(t.out()).toContain("run-20261010T110000-bbbb");
  });

  it("prints one trial in full by run id", async () => {
    const t = showIo();
    expect(await main(["show", "run-20261010T100000-aaaa", "--trial", "2"], t.io)).toBe(EXIT_OK);
    expect(t.out()).toContain("Trial 2: bookings = 2, capacity = 1");
    expect(t.out()).toContain("SQL, in the order it ran:");
  });

  it.each([
    [["show", "run-nope"], /cannot read .*run-nope\.json/],
    [["show", "--trial", "7"], /has no trial 7 \(it has 2\)/],
    [["show", "--trial", "0"], /--trial must be/],
    [["show", "future.json"], /run format 99, newer than this deadheat/],
  ])("%j fails with a clear message", async (argv, message) => {
    const t = showIo();
    expect(await main(argv, t.io)).toBe(EXIT_ERROR);
    expect(t.err()).toMatch(message);
  });

  it("says so when there are no saved runs", async () => {
    const t = io();
    expect(await main(["show"], t.io)).toBe(EXIT_ERROR);
    expect(t.err()).toMatch(/no saved runs in/);
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
