# conduit-cloudflare — package map

`src/index.ts` target, reads, `batch`, `setRecords` · `src/errors.ts` the
envelope validator and `translate` · `sink.ts` · `test/cloudflare.drive.ts`.

## What bites

- **A 200 can be a failure.** Every call passes `envelope` as `validate`;
  without it `result` reads as an empty list, which is a plausible wrong answer.
- **`records` walks `total_pages` to a cap of 100**, then throws: a vendor
  answering the count wrong would spend the whole rate budget on one screen.
- **`setRecords` refuses before sending** when any named set holds a record
  `owns` does not claim — a refusal after the first batch is the half-write it exists to prevent.
- **No idempotency key, ever.** Cloudflare ignores it; forwarding one would
  make a replayed batch look collapsed when it was not.

## Proving a change

`bun run drive`: 12 rows.
