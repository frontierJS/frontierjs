# conduit-cloudflare — state

**Extracted, sink-only, drive green (12 rows).** 2026-10-11.

- Source: basecamp `providers/edge/cloudflare.ts` + `cloudflare-sink.ts` at `6ad199f2`.
- Drive green against: the sink. Fixture: none exists. Scope: DNS only (purge not built, no caller).
- Findings for `CONTRACT.md`: a 200-that-fails needs `validate` on every call (clause);
  a target that ignores `Idempotency-Key` must never be sent one (clause, G6 in `PLAN.md`).
- FJS filed: none.
