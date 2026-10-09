# Litestone Project State

**Header re-verified:** 2026-08-05 · **trimmed:** 2026-10-09
**Tests:** 1416 pass / 0 fail across 6 files (`bun run test`)
**Status:** shipped — **v1.1.9**, which is also npm `latest` (checked 2026-10-08).

Re-verify any number before citing — see `../../VERIFYING.md`.

## Snapshot

- Public API: 70+ symbols exported from `src/index.js`
- Runtime: Bun ≥ 1.0 · bin `litestone` → `src/tools/cli.js`
- Subpath exports: `/migrate`, `/migrations`, `/parser`, `/ddl`, `/testing`, `/types`, `/storage`, `/external-ref`

## Publishing

`@frontierjs/litestone` publishes. The unscoped `litestone` name is still blocked
by npm's similarity check — support ticket filed, not chased — and nothing
depends on it.

## Open work

Proposals are `IDEAS/` at the repo root and defects are `ISSUES.md`; this file
is not a third list.

## Moved

- History (phases 1–10, the April "Recent additions", April test/perf numbers, session file locations) → `../../docs/changes-archive/litestone.md` § April snapshot. Newer history is the top of that file.
- Architecture notes (naming, per-model maps, three-proxy client, trait/type pipeline, fast paths, statement cache, auto-ANALYZE) → `docs/internals.md` § Architecture notes.
