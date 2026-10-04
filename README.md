# Deadheat

> Deadheat finds the race conditions in your API before your users do.

Double bookings, double spends, a coupon redeemed twice, stock going negative. These bugs only show up when two requests arrive at the same moment, so a normal test suite, which sends one request at a time, never catches them. With Deadheat, you describe a rule that must always hold (for example, "bookings for a slot never exceed its capacity") and it hits your API with precisely synchronized concurrent requests to break that rule. Later versions add a proxy in front of Postgres that pauses and reorders queries to force the dangerous timing. When the rule breaks, Deadheat shows the exact sequence of requests and queries that caused it, so you can replay it.

**Status:** early development (v0). Not usable yet.

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

## Demo: the oversell bug

```bash
docker compose up -d --wait
cd demo-apps/booking-api
corepack pnpm start                       # terminal 1: buggy booking API on :4100
corepack pnpm burst --concurrency 20      # terminal 2: 100 trials of 20 concurrent bookings
```

## License

[MIT](LICENSE)
