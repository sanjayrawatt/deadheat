# Benchmarks

Every number here must be reproducible. Each entry lists the machine, the exact commands and the raw result.

## Machine

|          |                                                                  |
| -------- | ---------------------------------------------------------------- |
| CPU      | Apple M2, 8 cores                                                |
| RAM      | 8 GB                                                             |
| OS       | macOS 26.6.2                                                     |
| Node     | v22.18.0                                                         |
| Postgres | 16.15 in Docker (`docker compose up -d`), default READ COMMITTED |
| Network  | Client, API and DB all on localhost                              |

## 1. Naive `Promise.all` baseline (2026-10-04)

Invariant: `bookings(slot 1) <= capacity`. Each trial resets the slot, fires N concurrent `POST /bookings` with `Promise.all` + `fetch`, then reads the booking count. 100 trials per row.

```bash
docker compose up -d --wait
cd demo-apps/booking-api
BOOKING_VARIANT=naive corepack pnpm start            # terminal 1
corepack pnpm burst --concurrency 20                 # terminal 2 (change N / variant per row)
```

| Variant                                                         | Concurrency | Capacity | Violations / 100 | Worst overbook |
| --------------------------------------------------------------- | ----------- | -------- | ---------------- | -------------- |
| `naive` (3 round trips: capacity, COUNT, INSERT)                | 2           | 1        | 99               | +1             |
| `naive`                                                         | 5           | 1        | 100              | +4             |
| `naive`                                                         | 20          | 1        | 99               | +19            |
| `naive`                                                         | 20          | 5        | 100              | +15            |
| `single-statement` (`INSERT … SELECT … WHERE count < capacity`) | 2           | 1        | 96               | +1             |
| `single-statement`                                              | 5           | 1        | 94               | +4             |
| `single-statement`                                              | 20          | 1        | 99               | +9             |

Two plain `curl`s fired in parallel from a shell oversold the `naive` variant in 19 of 20 attempts.

### What this means

On localhost, a naive burst already hits the race almost every time. Even the single-statement variant, whose race window is sub-millisecond, loses 94–99% of the time. With client, API and DB on one machine, `Promise.all` requests already arrive within a fraction of a millisecond of each other, so **synchronized release has no headroom to show a hit-rate improvement in this setup.**

That changes how the Week 3 benchmark should be designed. See the open question in DESIGN.md §7.
