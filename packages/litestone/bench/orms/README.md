# orms — Litestone against Drizzle, Prisma and ZenStack

Rough cross-ORM numbers. Its own install (not a workspace member), so the three
ORMs never enter the repo's dependency graph. The page's Speed section
(website/site/content/components/litestone/Speed.mesa) holds a copy of the result.
Same table everywhere: `user(id, name, age)`, 10k rows, WAL, `synchronous=NORMAL`.

    bun install
    bunx prisma generate
    bunx zen generate --schema zenstack/schema.zmodel --output zenstack
    bun bench.mjs  [rounds=5] [findUnique|findMany|create|update]   # Bun + bun:sqlite
    node bench-node.mjs [rounds=5] [case]                           # Node + better-sqlite3, no Litestone

Litestone is imported from `../../src`. `generated/`, `data/` and `zenstack/*.ts` are rebuilt, not committed.

## Versions (2026-11-02, Bun 1.4.4, Linux x64)
drizzle-orm 0.45.4 (bun-sqlite) · prisma + client 7.10.1 (libsql adapter) ·
zenstack orm 3.10.0 (Kysely SqliteDialect over a bun:sqlite shim, no policy plugin).

## Caveats
- Raw is bun:sqlite. Prisma runs on libsql (better-sqlite3 will not load in Bun), so its
  "floor" is not exactly raw. ZenStack goes through the shim, which adds a little.
- `drizzle` rebuilds its SQL each call; `drizzle+prepared` builds it once with placeholders.
- `zenstack+policy` runs the policy plugin with `@@allow('all', auth() != null)`; `litestone+gate` runs the GatePlugin at `@@gate(2.4.4.6)`, caller level 5.
- Absolute µs drift ~30% run to run on this machine; the ratios held. Only compare within a run.
- Run on a quiet machine: a load average above ~2 inflates write times (fsync) several-fold. The
  tables below predate the prepared/gate/policy variants; rerun before quoting those.

## Result (7 rounds, median µs/op, x raw)
| case       | raw  | litestone  | drizzle     | prisma       | zenstack     |
| ---------- | ---- | ---------- | ----------- | ------------ | ------------ |
| findUnique | 3.6  | 9.7 (2.7x) | 70 (20x)    | 197 (55x)    | 228 (64x)    |
| findMany   | 51.9 | 84 (1.6x)  | 153 (3.0x)  | 498 (9.6x)   | 279 (5.4x)   |
| create     | 32.8 | 85 (2.6x)  | 129 (3.9x)  | 251 (7.7x)   | 244 (7.4x)   |
| update     | 7.5  | 23 (3.1x)  | 63 (8.4x)   | 151 (20x)    | 131 (18x)    |
