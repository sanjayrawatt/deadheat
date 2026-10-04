import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadScenario, validateScenario } from "./loader.js";

const valid = {
  name: "ok",
  baseUrl: "http://127.0.0.1:4100",
  actions: { concurrency: 2, request: () => ({ method: "GET", url: "/" }) },
  invariant: async () => true as const,
};

describe("validateScenario", () => {
  it("accepts a well-formed scenario", () => {
    expect(validateScenario(valid)).toBe(valid);
  });

  it("explains a missing default export", () => {
    expect(() => validateScenario(undefined, "x.ts")).toThrow(/no default export/);
  });

  it("lists every problem at once", () => {
    const bad = {
      ...valid,
      name: "",
      baseUrl: "not a url",
      actions: { concurrency: 0 },
      trials: -1,
    };
    expect(() => validateScenario(bad)).toThrow(
      /`name`[\s\S]*`baseUrl`[\s\S]*concurrency[\s\S]*request[\s\S]*`trials`/,
    );
  });
});

describe("loadScenario", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  it("imports a TypeScript scenario file without a build step", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deadheat-loader-"));
    dirs.push(dir);
    const file = join(dir, "s.ts");
    await writeFile(
      file,
      `const concurrency: number = 4;
       export default {
         name: "from file",
         baseUrl: "http://127.0.0.1:4100",
         actions: { concurrency, request: (i: number) => ({ method: "POST", url: "/b/" + i }) },
         invariant: async () => true as const,
       };`,
    );
    const s = await loadScenario(file);
    expect(s.name).toBe("from file");
    expect(s.actions.request(7).url).toBe("/b/7");
  });
});
