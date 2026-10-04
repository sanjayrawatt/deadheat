# Devlog

A few lines after every session: what I tried, what broke, what I decided and why.

## Week 1 (Sep 28 – Oct 4, 2026)

### 2026-09-28

- Prior-art check done ([docs/PRIOR_ART.md](docs/PRIOR_ART.md)). Closest work is academic (ACIDRain, RaceDB, ReqRace, IsoDiff). Positioning: bring research-grade race detection into an ordinary Node/TS developer's CI.
- Repo scaffolded: pnpm workspaces, strict TypeScript, ESLint flat config, Prettier, Vitest, Postgres 16 in Docker (port 55432, so it doesn't clash with other local Postgres instances), GitHub Actions CI.
