# conduit-telnyx — package map

`src/index.ts` target, `sendMessage`, `getMessage`, `toE164`, `isE164` ·
`src/calls.ts` call control, `client_state`, `parseEvent` · `src/credentials.ts`
SIP credentials and the token · `src/stream.ts` media frames and μ-law ·
`src/errors.ts` the one reader of `error.raw` and the code sets · `src/verify.ts`
Ed25519, pure, plus `keywordOf` · `sink.ts` the one sink (texts, calls, devices,
stream) · `test/telnyx.drive.ts`.

## What bites

- **Nothing is replayed by conduit**: a send is unkeyed and a retry is a second text.
  A call command is the exception: `replayable` with `command_id` in the body, so
  the target needs the app's `resilience` (there is no default).
- **Every function takes the bound `send` first**, and nothing under `src/` reads
  `env` or names an app: connection ids, the default country and the `client_state`
  type are the app's.
- **`credentialToken` is not a `send`**: the bare JWT has no content-type and conduit
  refuses it. The drive pins that refusal; when it flips, route it through conduit.
- **A `perCaller` target is asked `getFor(ref, who)`**; the sink takes a list of keys
  so a drive can prove two tenants never swap.
- **The codes are partly unverified.** `40300` and `10039` were seen on the carrier;
  `OPTED_OUT_CODES` and `INVALID_DESTINATION_CODES` are where to correct the rest.
- **The receipt can beat the send's answer.** `finalizeFirst` in the sink is that case.
- **`keywordOf` is classification only**; the suppression row is the app's.
- **The sink's exact magic numbers beat its `…0000` / `…9999` suffix rules.**

## Proving a change

`bun run drive`: 28 rows. grouppi's `bun run test` runs its texts against this sink.
