// Arrival spread: how far apart N concurrent requests *finish arriving* at the server,
// naive (Promise.all + fetch) vs sync (last-byte synchronization). Smaller spread means the
// requests hit the race window together.
//
// Usage: corepack pnpm arrival-spread [--mode http|raw] [--trials 200] [--concurrency 20] [--warmup 20]
// See arrival-server.mjs for what each --mode measures.
import { fork } from "node:child_process";
import { arch, cpus, platform, totalmem } from "node:os";
import { parseArgs } from "node:util";
import { createSync, naive, percentile, sync, type Strategy } from "@deadheat/core";

const { values } = parseArgs({
  options: {
    trials: { type: "string", default: "200" },
    concurrency: { type: "string", default: "20" },
    warmup: { type: "string", default: "20" },
    port: { type: "string", default: "4199" },
    mode: { type: "string", default: "http" },
  },
});
const trials = Number(values.trials);
const concurrency = Number(values.concurrency);
const warmup = Number(values.warmup);
const base = `http://127.0.0.1:${values.port}`;

const server = fork(new URL("./arrival-server.mjs", import.meta.url), [values.port, values.mode]);
await new Promise<void>((resolve, reject) => {
  server.once("message", () => resolve());
  server.once("exit", (code) => reject(new Error(`arrival server exited (${code})`)));
});

async function spreadsFor(strategy: Strategy, count: number): Promise<number[]> {
  const specs = Array.from({ length: concurrency }, () => ({
    method: "POST",
    url: "/hit",
    body: { pad: "x".repeat(64) },
  }));
  const spreads: number[] = [];
  for (let i = 0; i < count; i++) {
    await fetch(`${base}/arrivals`).then((r) => r.json()); // clear
    const traces = await strategy.fire(base, specs);
    const failed = traces.filter((t) => t.status !== 204);
    if (failed.length) throw new Error(`${strategy.name}: ${failed.length} requests failed`);
    const arrivals = (await fetch(`${base}/arrivals`).then((r) => r.json())) as number[];
    spreads.push(Math.max(...arrivals) - Math.min(...arrivals));
  }
  return spreads.sort((a, b) => a - b);
}

try {
  console.log(
    `arrival spread (${values.mode} server), ${trials} trials × ${concurrency} requests (after ${warmup} warm-up trials)`,
  );
  console.log(
    `machine: ${cpus()[0]?.model}, ${cpus().length} cores, ${Math.round(totalmem() / 2 ** 30)} GB, ${platform()}/${arch()}, node ${process.version}\n`,
  );
  console.log("strategy              p50 µs    p90 µs    p99 µs    max µs");
  for (const strategy of [naive, sync, createSync({ settleMs: 50 })]) {
    await spreadsFor(strategy, warmup);
    const s = await spreadsFor(strategy, trials);
    const cols = [50, 90, 99, 100].map((p) => percentile(s, p).toFixed(0).padStart(8));
    console.log(`${strategy.name.padEnd(19)} ${cols.join("  ")}`);
  }
} finally {
  server.kill();
}
