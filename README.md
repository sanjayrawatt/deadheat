# Deadheat

> Deadheat finds the race conditions in your API before your users do.

Double bookings, double spends, a coupon redeemed twice, stock going negative. These bugs only show up when two requests arrive at the same moment, so a normal test suite, which sends one request at a time, never catches them. With Deadheat, you describe a rule that must always hold (for example, "bookings for a slot never exceed its capacity") and it hits your API with precisely synchronized concurrent requests to break that rule. Later versions add a proxy in front of Postgres that pauses and reorders queries to force the dangerous timing. When the rule breaks, Deadheat shows the exact sequence of requests and queries that caused it, so you can replay it.

**Status:** v0 done (burst mode, `deadheat run`). v1 in progress: `deadheat proxy` sits between the app and Postgres, and with the agent in the app, every report shows each request's SQL in the order it ran. `--widen` makes rare races show up on almost every trial, `--schedule random` controls the query order with a seed, and every run is saved as a full trace. Not on npm yet.

## Local development

Requires Node 22+, Docker, and pnpm (via `corepack pnpm`).

```bash
corepack pnpm install
docker compose up -d        # Postgres 16 on localhost:55432
corepack pnpm lint
corepack pnpm test
corepack pnpm build
```

## Docs

- [Design (v0)](docs/DESIGN.md)
- [Benchmarks](docs/BENCHMARKS.md)
- [Prior art](docs/PRIOR_ART.md)
- [Devlog](DEVLOG.md)

## Quick start: find the oversell bug

```bash
corepack pnpm install && corepack pnpm build
docker compose up -d --wait

# terminal 1: a deliberately buggy booking API on :4100
cd demo-apps/booking-api && corepack pnpm start

# terminal 2
export DEADHEAT_DATABASE_URL=postgres://deadheat:deadheat@localhost:55432/deadheat
node packages/cli/dist/bin.js run scenarios/booking-oversell.ts
```

```
✗ slot is never oversold: 100/100 trials violated (100.0%), strategy=sync, run-20261004T064248-0d65

  Trial 1: bookings = 7, capacity = 1
    Request #1   POST /bookings  201  sent +0.02ms  response +40.19ms
    Request #10  POST /bookings  201  sent +0.07ms  response +44.43ms
    Request #11  POST /bookings  201  sent +0.08ms  response +45.07ms
    …
```

A scenario is a TypeScript file with a setup, the concurrent requests, and the invariant:
see [scenarios/booking-oversell.ts](scenarios/booking-oversell.ts) and
[scenarios/wallet-overdraft.ts](scenarios/wallet-overdraft.ts). `deadheat run --help` lists
the options. Exit codes: `0` no violation, `1` invariant violated, `2` error (including "no request reached the app"), so it can fail a CI job.

If the API sits behind a proxy or load balancer, add `--settle 50` (see [BENCHMARKS.md §3](docs/BENCHMARKS.md)).

## See the SQL behind the race

Run Deadheat's proxy between the app and Postgres, and add `@deadheat/agent` to the app (two lines: `instrumentPg(pg)` and `registerFastify(app)`, as the demo apps do):

```bash
node packages/cli/dist/bin.js proxy --upstream localhost:55432        # app port :55433, control :55434
cd demo-apps/booking-api && DATABASE_URL=postgres://deadheat:deadheat@127.0.0.1:55433/deadheat corepack pnpm start
node packages/cli/dist/bin.js run scenarios/booking-oversell.ts --proxy http://127.0.0.1:55434
```

```
  Trial 2: bookings = 18, capacity = 1
    …
    SQL, in the order it ran:
      #0   SELECT capacity FROM slots WHERE id = $1  [1] → 1
      #1   SELECT capacity FROM slots WHERE id = $1  [1] → 1
      #0   SELECT COUNT(*)::int AS count FROM bookings WHERE slot_id = $1  [1] → 0
      #1   SELECT COUNT(*)::int AS count FROM bookings WHERE slot_id = $1  [1] → 0
      #0   INSERT INTO bookings (slot_id, user_id) VALUES ($1, $2) RETURNING id  [1, 1] → 50474
      #1   INSERT INTO bookings (slot_id, user_id) VALUES ($1, $2) RETURNING id  [1, 2] → 50475
```

Both requests counted 0 bookings before either inserted: check-then-act on a stale read. (Trimmed from a real run of 5 shown requests.) Without `--proxy`, `deadheat proxy` on its own prints a live log of every query.

**Make rare races common:** add `--widen 200`. Trial 1 learns which reads each request acts on, and from then on the proxy holds those reads' results for 200ms. Every concurrent request then reads before any of them writes, even when network jitter spreads their arrival out (numbers in [BENCHMARKS.md §6](docs/BENCHMARKS.md)).

**Force the interleaving:** add `--schedule random` (or `pct`, or `barrier`). The proxy holds every request's queries and releases them in an order chosen by a seed: one at a time at random, by PCT priorities, or phase by phase all together (for races inside a single statement). The report prints the seed and each violating trial's release order, and `--seed <n>` gives the same orders again.

**Shrink it to a bug report:** `deadheat shrink <run-id> --proxy http://127.0.0.1:55434` re-runs smaller and smaller subsets of the violating trial's requests and keeps the smallest one that still breaks the invariant. A 20-request oversell comes down to the 2 requests that race, saved as a run you can `show` and `replay`.

**Lock waits:** transfers in a transaction take row locks, so a query the scheduler releases can wait on a lock held by a request it's holding back. `deadheat proxy` spots this within ~10ms with `pg_blocking_pids` (it uses `DEADHEAT_DATABASE_URL`, or `--monitor-url`), moves on, and the report says which request waited on whose lock.

**Replay a violation:** `deadheat replay <run-id> --proxy http://127.0.0.1:55434` re-runs the first violating trial of a saved run with its queries released in exactly the recorded order, and says whether the violation reproduced.

**Look again later:** every run is saved to `.deadheat/runs/<run-id>.json`. `deadheat show` prints the latest one again, and `deadheat show <run-id> --trial 3` prints trial 3 in full, with every request and all of its SQL in order.

## Use it in CI

The repo is also a GitHub Action. The job fails when the invariant breaks, and the saved runs are uploaded as an artifact so you can `show`, `replay` or `shrink` them locally.

```yaml
- name: Start the API (and Postgres) however you normally do
  run: ...
- uses: sanjayrawatt/deadheat@main # pin a commit or tag
  with:
    scenario: scenarios/booking-oversell.ts
    trials: 50
    database-url: postgres://user:pass@localhost:5432/app
```

Other inputs: `strategy`, `settle`, `base-url`, `proxy`, `schedule`, `seed`, `widen` and `args` (extra flags). Outputs: `violations`, `trials`, `run-id` and `run-file`. Deadheat isn't on npm yet, so the action builds itself from its own checkout on first use. [.github/workflows/action-selftest.yml](.github/workflows/action-selftest.yml) runs it against the buggy booking API on every push.

## Demo apps

| App                                  | Port | Variants (`*_VARIANT` env)                         | Invariant it breaks          |
| ------------------------------------ | ---- | -------------------------------------------------- | ---------------------------- |
| [booking-api](demo-apps/booking-api) | 4100 | `naive`, `single-statement`                        | bookings ≤ capacity          |
| [wallet-api](demo-apps/wallet-api)   | 4200 | `naive` (overdraft), `lost-update` (money created) | balance ≥ 0, total conserved |

## License

[MIT](LICENSE)
