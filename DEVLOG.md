# Devlog

A few lines after every session: what I tried, what broke, what I decided and why.

## Week 1 (Sep 28 – Oct 4, 2026)

### 2026-09-28

- Prior-art check done ([docs/PRIOR_ART.md](docs/PRIOR_ART.md)). Closest work is academic (ACIDRain, RaceDB, ReqRace, IsoDiff). Positioning: bring research-grade race detection into an ordinary Node/TS developer's CI.
- Repo scaffolded: pnpm workspaces, strict TypeScript, ESLint flat config, Prettier, Vitest, Postgres 16 in Docker (port 55432, so it doesn't clash with other local Postgres instances), GitHub Actions CI.

### 2026-10-04

- Repo is live at github.com/sanjayrawatt/deadheat and CI is green.
- Built `demo-apps/booking-api` (Fastify + raw `pg`, pool max 10). A `BOOKING_VARIANT` switch picks the booking logic, so Week 12's fix gallery can plug into the same place.
- Reproduced the oversell by hand: two parallel `curl`s oversold in 19/20 attempts. The playbook expected this to be hard. It wasn't, because check and act are separate DB round trips.
- Naive `Promise.all` baseline: **99% hit rate** (100 trials, N=20, capacity 1). Even N=2 gives 99%. Details in [docs/BENCHMARKS.md](docs/BENCHMARKS.md).
- Surprise: a single-statement variant (`INSERT … SELECT … WHERE count < capacity`) with a sub-ms window still hits 94–99%. On localhost, requests already arrive near-simultaneously.
- Decision needed before Week 3: "synchronized release beats naive on hit rate" can't be shown on localhost. Options are measuring arrival spread directly, adding network jitter (e.g. Toxiproxy), or a remote client. Logged as an open question in DESIGN.md.

## Week 2 (Oct 5 – Oct 11, 2026)

### 2026-10-04: core engine

- `packages/core` now has scenario types, a loader (`tsx` `tsImport`, so `.ts` scenarios need no build), a runner, a naive strategy (`Promise.all` + fetch) and a console reporter.
- **Pre-flight check:** every trial checks the invariant after setup and before firing. If it already fails, the run aborts with "setup is broken" instead of reporting a fake race. This is the first false-positive guard.
- Bug found by a test: when a scenario file sits in a CommonJS folder, `tsImport` wraps the default export twice (`{ default: { default: … } }`). The loader now unwraps it.
- `scenarios/booking-oversell.ts` imports from `"deadheat"`, the same way a real user would. The `deadheat` package re-exports core, and the CLI binary moved to `bin.ts`.
- End-to-end test: the real runner + scenario file + booking API + Postgres. CI now runs a Postgres service container.
- First real report: 99/100 trials violated, matching the Week 1 burst script, so the runner agrees with the baseline. Naive client-side send spread: p50 0.52ms, p99 1.43ms. That's the number `sync` must shrink in Week 3.

## Week 3 (Oct 12 – Oct 18, 2026)

### 2026-10-04: sync release, CLI, wallet demo

- **`sync` strategy:** last-byte synchronization over raw `net` sockets, not undici. I need the `write` callback to know the primed bytes reached the kernel, and undici doesn't expose it.
- **Arrival spread** (server in a separate process): at the socket level, sync's p50 is ~160µs vs ~250µs for naive, about 35–40% tighter. At the HTTP level the gain mostly disappears, because Node's event loop parses requests one by one (~13µs each). On localhost the server, not the network, sets the floor.
- **Biggest surprise:** through Toxiproxy, sync was _much worse_ than naive (53% vs 99% hit rate). Debugging showed the proxy opens its upstream connection only when we connect, and we released before it finished, so it was still holding the primed bytes. Added a `settleMs` option, and settle 50ms restored 99%. But on a direct connection every ms of settle _widens_ the spread (0ms → 223µs, 50ms → 665µs, cause not pinned down). **Decision:** default settle 0, plus a documented `--settle` for proxied targets. Good interview story: a "precision" technique that silently breaks behind a middlebox.
- Under 10ms jitter, naive and sync both fall to ~50%. Last-byte sync can't beat per-packet jitter. That's the argument for v1 (control timing at the DB) or HTTP/2 single-packet.
- **`deadheat run` CLI:** strategies, `--trials`, `--settle`, `--base-url`, runs saved to `.deadheat/runs/`, exit codes 0/1/2.
- **False negative found while benchmarking:** with the API not running, every request got ECONNREFUSED, no rows changed, and the run reported **✓ 0 violations**. In CI that would hide a wrong port forever. Now a trial where every request fails aborts the run (exit 2).
- **Wallet demo** (`naive` = overdraft, `lost-update` = a credit overwritten). My first lost-update scenario never failed: all transfers went 1→2, so every transaction read the same snapshot and wrote the same absolute values, which cancel out. Lost updates only show when two _different_ writers race on the same row, so the scenario now has two senders paying one receiver. Both variants run inside a transaction at READ COMMITTED, and the transaction alone doesn't help.
- 44 tests (unit + e2e), including "no violation when requests don't overlap" for every buggy variant, so the invariants themselves aren't producing false positives.

## Week 4 (Oct 19 – Oct 25, 2026)

### 2026-10-04: Postgres proxy MVP

- `packages/proxy`: a TCP proxy plus a `FrameDecoder` for the v3 wire protocol. It forwards **frame by frame with the original bytes** rather than piping raw chunks, because Week 6 needs to hold a specific message (a read's result) while letting others through. Retrofitting that onto a byte pipe would be painful.
- The startup phase is the tricky part of the framing: the client's first message has no type byte, and after an SSLRequest (which the proxy refuses with `N` itself, to keep the hop readable) the _next_ message is untyped again. Tested by feeding streams byte by byte.
- SCRAM auth passes straight through, so the proxy never needs the password.
- A query tracker per connection: `Q` → rows/tags/errors → `ReadyForQuery`, which also gives the transaction status (`I`/`T`/`E`). That will matter for deadlock handling later.
- **The booking API runs unchanged through the proxy** and the oversell is still found: the v1 transparency requirement, covered by an e2e test.
- Gap this exposes: every demo-app query is parameterised, so `pg` uses the **extended** protocol, and the tracker sees none of them yet. That's Week 5.
- `deadheat proxy` CLI: a live query log. Overhead +30–45µs per query, throughput 68% of direct.
- A flaky test taught me that the e2e test files share Postgres rows (slot 1), so they can't run in parallel. Set `fileParallelism: false`. 61 tests, ~3.5s.

## Week 5 (Oct 26 – Nov 1, 2026)

### 2026-10-05: extended protocol, agent, attribution

- **Decisions taken (Sanjay delegated):** replay and seeds move to Weeks 8–9, after the scheduler, since exact replay needs hold/release. Widening will use a learning trial, because the proxy can't know at read time whether a write will follow.
- Extended protocol decoded: Parse → statement map, Bind → portal + params, Execute queue, then completion on C/I/s, error skips until Sync, emit at ReadyForQuery. Named statements re-executed without a Parse are handled. Tested against real pg.
- **Agent bug caught before it shipped:** patching only `Client.query` would read the request id inside pg-pool's callback, which runs in the context of whichever request _released_ the connection. An experiment showed 8/10 queries attributed to the wrong request with a 2-connection pool. Fix: tag eagerly in `Pool.query` too, and never double-tag. Good interview story about AsyncLocalStorage and callback-based libraries.
- Named prepared statements stay untagged (pg forbids the same name with different text). Documented as a limitation.
- Architecture call: the proxy is a separate long-lived process with an HTTP control port, not embedded in `deadheat run`. The app needs the DB at boot, and Week 6's delay injection needs a control channel anyway.
- **First real report with the SQL interleaving:** 5 requests read capacity, all 5 count 0, all 5 insert. Exactly the playbook's report, from a real run.
- A flaky e2e timeout appeared once (5s default) and didn't reproduce in 6 reruns. Raised the test timeout to 20s and noted it rather than ignoring it.
- Overhead with extended decoding looks like +70–92µs p50, but the machine was loaded during the measurement. Re-measure on an idle machine.
- 77 tests.

## Week 6 (Nov 2 – Nov 8, 2026)

### 2026-10-05: race-window widening

- **Learning trial instead of guessing:** the proxy can't know at read time whether a write will follow, but the runner can see it afterwards in each request's SQL. A read followed by a write in the same request is a "decision read". Fingerprints (literals → `?`) of those reads become hold rules from trial 2 on.
- **Holds** are an outbox per proxy connection. A matching tagged query's response pauses it for `holdMs`, and later frames queue behind. That's why I insisted on frame-level forwarding in Week 4: this was a ~30-line change on top of it.
- Holds are only applied to queries carrying a request tag, so other traffic through the proxy isn't slowed, and they're always cleared in a `finally`.
- Report now prints `Widened: …`, `(held 200ms)` per held read, and **`Pattern: check-then-act`** with the usual fixes, like the playbook's target report.
- **Honest limit, covered by a test:** the single-statement booking variant learns nothing, because there's no separate read to hold. That race needs v2's statement-ordering control.
- First benchmark cell: 2 concurrent users, 10ms network jitter. naive 35%, sync 40%, **sync + widen 100%**.
- 100 tests.

### 2026-10-10: widening benchmark, and a hang that wasn't ours

- The full widening benchmark aborted at N=20: a `sync` trial got no response from any of its 20 requests for 30s. Isolated step by step: it happened only through Toxiproxy in Docker, with or without `deadheat proxy`. During the hang the client held 20 established connections, the app had none, and Toxiproxy never logged accepting them. Docker Desktop's port forwarder swallowed the burst. Pacing trials didn't help.
- Replaced Toxiproxy in the widen benchmark with a ~50-line host-side jitter proxy. 900 N=20 trials, no hang.
- Results ([BENCHMARKS.md §6](docs/BENCHMARKS.md)): naive variant at 10ms jitter goes from 33–36% (N=2) to **100%** with widening. The single-statement variant stays where sync is, as expected.
