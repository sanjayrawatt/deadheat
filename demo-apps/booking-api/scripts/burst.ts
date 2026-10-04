// Naive burst baseline: fire N concurrent bookings with Promise.all and count how often the
// "bookings never exceed capacity" invariant breaks. This is the number Deadheat's
// synchronized release has to beat.
//
// Usage: tsx scripts/burst.ts [--trials 100] [--concurrency 20] [--capacity 1] [--url http://127.0.0.1:4100]
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    trials: { type: "string", default: "100" },
    concurrency: { type: "string", default: "20" },
    capacity: { type: "string", default: "1" },
    url: { type: "string", default: "http://127.0.0.1:4100" },
  },
});
const trials = Number(values.trials);
const concurrency = Number(values.concurrency);
const capacity = Number(values.capacity);
const base = values.url;
const slotId = 1;

async function post(path: string, body: unknown): Promise<number> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  await res.arrayBuffer(); // drain so the connection goes back to the pool
  return res.status;
}

const { variant } = (await (await fetch(`${base}/variant`)).json()) as { variant: string };
console.log(`booking-api variant: ${variant}`);

let violations = 0;
let worstOverbook = 0;
const started = performance.now();

for (let trial = 1; trial <= trials; trial++) {
  await post("/reset", { slotId, capacity });

  const statuses = await Promise.all(
    Array.from({ length: concurrency }, (_, i) => post("/bookings", { slotId, userId: i + 1 })),
  );

  const slot = (await (await fetch(`${base}/slots/${slotId}`)).json()) as { booked: number };
  const ok = slot.booked <= capacity;
  if (!ok) {
    violations++;
    worstOverbook = Math.max(worstOverbook, slot.booked - capacity);
  }
  const created = statuses.filter((s) => s === 201).length;
  console.log(
    `trial ${String(trial).padStart(3)}  ${ok ? "PASS" : "FAIL"}  booked=${slot.booked} capacity=${capacity} (201s: ${created})`,
  );
}

const seconds = ((performance.now() - started) / 1000).toFixed(1);
const rate = ((violations / trials) * 100).toFixed(1);
console.log(
  `\n${violations} violations in ${trials} trials = ${rate}% hit rate` +
    ` (variant=${variant}, concurrency=${concurrency}, capacity=${capacity}, worst overbook=+${worstOverbook}, ${seconds}s, node ${process.version})`,
);
