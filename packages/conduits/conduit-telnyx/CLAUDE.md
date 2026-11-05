# conduit-telnyx — package map

`src/index.ts` target, `sendMessage`, `getMessage`, `toE164` · `src/errors.ts`
the one reader of `error.raw` and the code sets · `src/verify.ts` Ed25519,
pure, plus `keywordOf` · `sink.ts` · `test/telnyx.drive.ts`.

## What bites

- **Nothing is replayed by conduit**: a send is unkeyed and a retry is a second text.
- **The codes are unverified.** `OPTED_OUT_CODES` and `INVALID_DESTINATION_CODES`
  are the one place to correct them when a real account answers.
- **The receipt can beat the send's answer.** `finalizeFirst` in the sink is that case.
- **`keywordOf` is classification only**; the suppression row is the app's.

## Proving a change

`bun run drive`: 10 rows.
