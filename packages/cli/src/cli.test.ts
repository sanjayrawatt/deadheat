import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT_ERROR, EXIT_OK, main, type Io } from "./cli.js";

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
