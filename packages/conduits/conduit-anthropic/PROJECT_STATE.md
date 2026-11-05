# conduit-anthropic — state

**New, sink-only, drive green (22 rows).** 2026-10-12.

- Drive green against: the sink. Fixture: none exists (a vendor).
- Real vendor: never called; no key in the environment. Error wording is the
  vendor's documented `error.type` set; the sink's messages are its own.
- Conforms to `CONTRACT.md` with two amendments recorded: C5 (a billed POST,
  and the vendor's word reopening `retryable` on a 529). C13's SSE amendment
  is retired: G1 closed as `FJS-2728` (`FJS-D934`), and `streamMessage` runs
  through `conduit.stream()`.
