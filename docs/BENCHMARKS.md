# Benchmarks

Every number here must be reproducible. Each entry lists the machine, the exact commands and the raw result.

## Machine

|           |                                                                  |
| --------- | ---------------------------------------------------------------- |
| CPU       | Apple M2, 8 cores                                                |
| RAM       | 8 GB                                                             |
| OS        | macOS 26.6.2                                                     |
| Node      | v22.18.0                                                         |
| Postgres  | 16.15 in Docker (`docker compose up -d`), default READ COMMITTED |
| Network   | Client, API and DB all on localhost                              |
| Toxiproxy | 2.12.0 in Docker (`--profile bench`), only for §3                |

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

That changed how the Week 3 benchmark was designed (Option A in DESIGN.md §7.1): measure **arrival spread** directly (§2), and compare hit rates under **network jitter** (§3).

## 2. Arrival spread: naive vs sync (2026-10-04)

How far apart N=20 concurrent requests _finish arriving_ at a server running in a separate process. 200 trials after 20 warm-up trials. Two server modes:

- **http**: Node's http server, timestamped on the request's `'end'` event, i.e. when a Node app could start acting. Includes HTTP parsing and event-loop queueing.
- **raw**: plain TCP, timestamped on the `'data'` event that completes the request. As close to network arrival as user space gets.

```bash
cd benchmarks
corepack pnpm arrival-spread --mode http
corepack pnpm arrival-spread --mode raw
```

| Strategy                                  | http p50 | http p90 | raw p50   | raw p90   |
| ----------------------------------------- | -------- | -------- | --------- | --------- |
| naive (`Promise.all` + fetch, keep-alive) | 398µs    | 772µs    | 252µs     | 367µs     |
| **sync** (last-byte, settle 0)            | 328µs    | 835µs    | **164µs** | **260µs** |
| sync, settle 50ms                         | 800µs    | 1317µs   | 818µs     | 1449µs    |

Across three runs, raw-mode p50 was 245–267µs for naive and 152–164µs for sync, so **sync narrows arrival spread by about 35–40% at the socket level.** At the http level the gain shrinks or disappears, because Node's single event loop parses the 20 requests one after another (~13µs each). That serial processing, not the network, is the floor on localhost.

**Settle delay sweep** (raw mode, 100 trials each, one run):

| settle | 0ms   | 2ms   | 10ms  | 20ms  | 50ms   |
| ------ | ----- | ----- | ----- | ----- | ------ |
| p50    | 223µs | 313µs | 378µs | 459µs | 665µs  |
| p90    | 318µs | 379µs | 454µs | 602µs | 1147µs |

A longer pause between priming and release _widens_ the spread on a direct connection. The cause isn't pinned down yet. The likely suspects are CPU/scheduler wake-up after the idle gap, or TCP delayed-ACK interactions on macOS. Hence the default settle is 0.

## 3. Hit rate under network jitter (2026-10-04)

Booking API, `single-statement` variant (the narrow window), scenario `booking-oversell` (N=20), 100 trials per cell. Toxiproxy adds 10ms latency ± jitter on the client→API direction.

```bash
docker compose --profile bench up -d --wait    # Postgres + Toxiproxy
cd benchmarks && corepack pnpm jitter-hit-rate
```

| Path               | naive | **sync** (settle 0) | sync, settle 50ms |
| ------------------ | ----- | ------------------- | ----------------- |
| direct (no proxy)  | 95%   | 99%                 | 100%              |
| proxy, jitter 0ms  | 99%   | **53%**             | 99%               |
| proxy, jitter 1ms  | 100%  | 58%                 | 97%               |
| proxy, jitter 3ms  | 95%   | 32%                 | 93%               |
| proxy, jitter 10ms | 40%   | 18%                 | 51%               |

What this shows:

1. **Direct**: sync slightly beats naive (99–100% vs 95%).
2. **Behind a proxy, sync without settle is much worse than naive.** Toxiproxy opens its upstream connection only when the client connects, and sync releases right after connecting, so the proxy is still holding the primed bytes. A 50ms settle fixes it. With only the proxy and no added latency, a quick 30-trial check gave settle 0 = 20–30% and settle 20ms = 100%. A real-world lesson: **`--settle` must exceed the client→server latency when a proxy or load balancer sits in between.**
3. **At 10ms jitter, everything drops to ~50%.** Last-byte sync can't remove jitter that hits each connection's final packet separately. Beating that needs a single-packet send (HTTP/2) or controlling timing at the database, which is v1's proxy.

## 4. Wallet demo (2026-10-04)

`scenarios/wallet-overdraft.ts`: accounts 1 and 2 start at 100, account 3 at 0. 10 concurrent "pay 100 to account 3" requests, alternating senders. 100 trials per row.

```bash
cd demo-apps/wallet-api && WALLET_VARIANT=naive corepack pnpm start    # or lost-update
DEADHEAT_DATABASE_URL=postgres://deadheat:deadheat@localhost:55432/deadheat \
  node packages/cli/dist/bin.js run scenarios/wallet-overdraft.ts --strategy sync
```

| Variant                                               | naive | sync | Typical violation                                |
| ----------------------------------------------------- | ----- | ---- | ------------------------------------------------ |
| `naive` (relative `balance - $1` after a stale check) | 100%  | 100% | `overdraft: account 1 = -400, account 2 = -400`  |
| `lost-update` (absolute `balance = $computed`)        | 99%   | 100% | `money not conserved: total = 100, expected 200` |

Both variants run inside a transaction at READ COMMITTED. The transaction alone doesn't help.

## 5. Proxy overhead (2026-10-04)

Query latency straight to Postgres vs through `deadheat proxy` (the real CLI, in its own process, logging every query). One connection, 2000 sequential queries per row after 200 warm-up; then throughput with a 10-connection pool.

```bash
docker compose up -d --wait && corepack pnpm build
cd benchmarks && corepack pnpm proxy-overhead
```

| Query                | direct p50 | proxy p50 | direct p99 | proxy p99 |
| -------------------- | ---------- | --------- | ---------- | --------- |
| simple `SELECT 1`    | 152µs      | 181µs     | 468µs      | 346µs     |
| extended `SELECT $1` | 148µs      | 188µs     | 215µs      | 385µs     |

Throughput (10 connections, 4000 extended queries): direct 23,314 q/s, proxy 15,818 q/s (**68%**). A second run gave the same picture: +35–44µs p50 per round trip, 67% throughput.

**Reading it:** the proxy adds ~30–45µs per round trip. That's small next to the race windows Deadheat targets (the naive booking handler takes ~5ms per request) and next to the 200ms holds planned for v1. Throughput isn't a goal, because Deadheat runs in test environments, but the 32% hit tells us the per-message decode/forward path is worth profiling before the scheduler adds more work to it.
