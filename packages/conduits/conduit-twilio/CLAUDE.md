# conduit-twilio — package map

`src/index.ts` is the whole connector. `sink.ts` · `test/twilio.drive.ts`.

## What bites

- **`url` in the verifier is the PUBLIC one**, exactly as given to Twilio, query included.
- **Codes 30xxx arrive on the status webhook**, not the send; `UNREGISTERED_CODES` holds the one that comes back on a send.
- **`toE164`/`keywordOf` are duplicated from telnyx on purpose** until the `sms` helper is promoted.

## Proving a change

`bun run drive`: 12 rows.
