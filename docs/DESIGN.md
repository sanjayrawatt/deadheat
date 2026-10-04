# Deadheat design (v0)

_Status: draft v0, 2026-10-04. Owner: Sanjay Singh Rawat._

> Deadheat finds the race conditions in your API before your users do.

## 1. Problem and audience

**The bug.** Endpoints that read a value, decide, then write (check-then-act) break when two requests interleave: two bookings for the last seat, two withdrawals that each see enough balance, a single-use coupon redeemed twice. Postgres's default READ COMMITTED isolation does not prevent any of these.

**Who has it.** Backend developers building booking, inventory, wallet, coupon or voting logic on a relational database, typically Node/TypeScript with `pg` or an ORM. ORMs make the bug easy to write without noticing (`findOne`, then `save`).

**How they deal with it today** (see [PRIOR_ART.md](PRIOR_ART.md)):

- Ad-hoc `Promise.all` scripts, run once by hand and never added to CI.
- Manual security tools (Burp Suite Turbo Intruder, single-packet tooling), used by pentesters rather than the developers who own the code.
- Production incidents.

Research has attacked the problem (ACIDRain, ReqRace, IsoDiff, RaceDB), but none of it became a tool a normal developer installs.

**Gap statement.** Today, developers catch race conditions with ad-hoc load scripts, manual security tools, or production incidents. That fails because those methods don't run in CI, don't check the business rule that actually broke, and can't reproduce the failing interleaving.

## 2. Goals and non-goals

### v0 goals (Weeks 1–3)

- A TypeScript **scenario** format: setup, concurrent HTTP actions, invariant.
- `deadheat run <scenario>` runs many trials, checks the invariant after each one, and reports the violation rate.
- **Synchronized release**: requests are primed and released together, to minimise arrival spread.
- A readable report of each violation, with per-request status and timing.
- Two demo apps, `booking-api` and `wallet-api`, with scenarios.

### v0 non-goals

- No database proxy, query attribution or interleaving control (that's v1/v2).
- Postgres only: no MySQL until v2 is done.
- No GUI and no hosted service.
- Not a load-testing tool. Throughput isn't measured.

## 3. Core concepts

| Concept       | Meaning                                                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Scenario**  | A file describing `setup`, `actions` and `invariant` for one property.                                                       |
| **Action**    | One HTTP request in a trial. `request(i)` builds the i-th of `concurrency` requests.                                         |
| **Invariant** | An async function over the DB (and optionally the responses) that returns `true` or a violation message.                     |
| **Trial**     | setup → fire all actions concurrently → check invariant. One pass/fail result.                                               |
| **Run**       | Many trials of one scenario under one strategy and one seed.                                                                 |
| **Strategy**  | How actions are released: `naive` (`Promise.all`) or `sync` (synchronized release) in v0. Later `widen`, `random` and `pct`. |
| **Trace**     | What happened in a trial: per request, the send time, first-byte time, status and body. v1 adds the request's SQL queries.   |
| **Seed**      | Random seed for every choice a strategy makes, so runs are reproducible. It matters from v1 onwards.                         |

## 4. Scenario format

TypeScript, default-exported:

```ts
// scenarios/booking-oversell.ts
import { scenario } from "deadheat";

export default scenario({
  name: "slot is never oversold",
  baseUrl: "http://127.0.0.1:4100",
  setup: async ({ sql }) => {
    await sql`DELETE FROM bookings WHERE slot_id = 1`;
    await sql`UPDATE slots SET capacity = 1 WHERE id = 1`;
  },
  actions: {
    concurrency: 20,
    request: (i) => ({ method: "POST", url: "/bookings", body: { slotId: 1, userId: i + 1 } }),
  },
  invariant: async ({ sql }) => {
    const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM bookings WHERE slot_id = 1`;
    return count <= 1 || `bookings = ${count}, capacity = 1`;
  },
  trials: 200,
});
```

Decisions:

- `scenario()` is an identity function that exists for type inference and editor autocomplete.
- `sql` is a tagged-template client pointed at the app's DB (`DEADHEAT_DATABASE_URL`). It's used only in setup and the invariant, never inside actions, so Deadheat doesn't add load to the race window.
- The invariant returns `true | string`. That's simpler than throwing, and the string becomes the report headline.
- `request(i)` makes it easy to vary users per request (`userId: i + 1`). Heterogeneous actions (for example a transfer plus a withdrawal) come later as `actions: [...]`.

## 5. Architecture

### v0

```
 scenario.ts ──► CLI (deadheat run) ──► core: Runner
                                          │  for each trial:
                                          │   1. setup(sql)
                                          │   2. strategy.fire(actions)  ──HTTP──► app under test ──► Postgres
                                          │   3. invariant(sql)          ─────────────────────────────►  ▲
                                          │   4. record TrialResult + trace                               │
                                          ▼                                                    (sql client)
                                      Reporter (console, JSON in .deadheat/runs/)
```

Packages: `core` (scenario types, runner, strategies, reporter), `cli` (argument parsing, loading `.ts` scenarios via `tsx`).

**Synchronized release (v0 strategy `sync`).** Open N HTTP/1.1 connections with undici, write every request except its last byte, wait until all N are primed, then flush the final byte on all sockets in one tick. HTTP/2 single-packet release is deferred: Fastify and Express serve HTTP/1.1 by default, and the first benchmark showed no headroom on localhost anyway (§7).

### v1 sketch (Weeks 4–7)

```
 app ──(pg, tagged by agent: /* deadheat_rid=… */)──► deadheat proxy ──► Postgres
                                                          │
                                                          └─ attributes queries to requests, delays reads
```

- **Agent**: wraps `pg` so every query carries the HTTP request id as a SQL comment (sqlcommenter style), using AsyncLocalStorage.
- **Proxy**: a Node `net` TCP proxy that parses the Postgres wire protocol (simple + extended query), reads the tag, and records per-request query traces.

## 6. Report format

```
✗ slot is never oversold. 97/200 trials violated (48.5%), strategy=sync, seed=8812

  Trial 14: bookings = 2, capacity = 1
    Request #3   POST /bookings   201  sent +0.00ms  first byte +4.1ms
    Request #11  POST /bookings   201  sent +0.02ms  first byte +4.3ms
    Request #7   POST /bookings   409  sent +0.01ms  first byte +5.0ms
    … 17 more (--verbose)

  Arrival spread (last − first send): p50 0.03ms, p99 0.11ms
  Replay: available from v1 (needs query-level trace)
```

Exit code 1 on any violation, so it works in CI. A JSON copy of every run goes to `.deadheat/runs/<run-id>.json`.

## 7. Open questions and risks

1. **Localhost leaves no headroom for synchronized release.** The naive `Promise.all` baseline already violates in 99% of trials, and even a single-statement race with a sub-ms window hits 94–99% ([BENCHMARKS.md](BENCHMARKS.md)). The planned headline "sync release ≫ naive" can't be shown on localhost. Options:
   - (a) Make **arrival spread** the primary metric for sync vs naive, which is measurable anywhere.
   - (b) Compare hit rates under injected network jitter (Toxiproxy between client and API).
   - (c) Run the client from a second machine or a cloud VM.
   - Leaning (a) + (b). **Needs a decision before Week 3.**
2. **Replay needs the scheduler.** Exact replay means forcing query order, which needs hold/release (Week 8). So replay and seeds either move to Weeks 8–9, or Week 7 builds a minimal hold/release.
3. **The proxy can't know at read time whether a write will follow.** For widening, either learn read→write fingerprints in a first, unwidened trial, or delay every read inside an explicit transaction.
4. **False positives.** An invariant that is wrong, or a setup that leaks state between trials, looks like a race. Mitigation: run the invariant once after setup, before firing (it must pass), and run one sequential control trial per run.
5. **Overhead and the observer effect.** Deadheat must not change the timing it measures. Keep `sql` off the hot path and measure proxy overhead in BENCHMARKS (v1).
6. **Prepared statements and the comment tag.** Tagging changes the query text, which can defeat prepared-statement caching in drivers. Needs checking in v1.
7. **Testing Deadheat itself.** CI has no Postgres yet. Add a Postgres service or Testcontainers before the runner's integration tests land (Week 2).

## 8. Alternatives considered

| Decision                 | Chosen                                   | Rejected, and why                                                                                                                                 |
| ------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scenario language        | TypeScript                               | **YAML**: invariants are real logic (SQL plus comparisons). YAML would need an expression language and loses type checking.                       |
| HTTP client for `sync`   | undici (raw socket control)              | **fetch/axios**: no control over when the last byte is written.                                                                                   |
| Detection approach       | Black-box: run requests, check invariant | **Static analysis** (ReqRace style): finds candidates but proves nothing. **Log analysis** (ACIDRain style): offline, can't reproduce.            |
| Query attribution (v1)   | SQL comment tag + wire proxy             | **ORM hooks only**: tied to one ORM and can't delay or reorder at the DB boundary. **Postgres extension**: needs DB superuser and a custom build. |
| Proxy language           | Node `net`                               | **Go**: faster, but adds a language before the design is proven. Possible later rewrite.                                                          |
| Interleaving search (v2) | Random + PCT, bounded                    | **Exhaustive**: combinatorial explosion.                                                                                                          |
| Demo app DB access       | Raw `pg`                                 | **ORM**: hides the queries. A TypeORM variant comes later on purpose.                                                                             |
