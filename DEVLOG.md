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
