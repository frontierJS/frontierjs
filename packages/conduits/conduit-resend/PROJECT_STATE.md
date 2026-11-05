# conduit-resend — state

**Extracted, sink-only, drive green (12 rows).** 2026-10-11.

- Source: `packages/junction/src/mail/index.ts` § Resend adapter at `6ad199f2`.
- Drive green against: the sink. Fixture: none exists. Real vendor never called.
- Finding for `CONTRACT.md`: conduit does not replay an unkeyed POST on a 429;
  a connector whose writes are not idempotent must say so and hand the wait to
  the caller. Stripe's `replayable` intent is the other side of the same clause.
- FJS filed: none.
