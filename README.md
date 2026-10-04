# Deadheat

> Deadheat finds the race conditions in your API before your users do.

Double bookings, double spends, a coupon redeemed twice, stock going negative. These bugs only show up when two requests arrive at the same moment, so a normal test suite, which sends one request at a time, never catches them. With Deadheat, you describe a rule that must always hold (for example, "bookings for a slot never exceed its capacity") and it hits your API with precisely synchronized concurrent requests to break that rule. Later versions add a proxy in front of Postgres that pauses and reorders queries to force the dangerous timing. When the rule breaks, Deadheat shows the exact sequence of requests and queries that caused it, so you can replay it.

**Status:** v0. Burst mode works end to end (`deadheat run`). It isn't on npm yet. The database proxy (v1) comes next.

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

## Demo apps

| App                                  | Port | Variants (`*_VARIANT` env)                         | Invariant it breaks          |
| ------------------------------------ | ---- | -------------------------------------------------- | ---------------------------- |
| [booking-api](demo-apps/booking-api) | 4100 | `naive`, `single-statement`                        | bookings ≤ capacity          |
| [wallet-api](demo-apps/wallet-api)   | 4200 | `naive` (overdraft), `lost-update` (money created) | balance ≥ 0, total conserved |

## License

[MIT](LICENSE)
