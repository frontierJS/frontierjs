# conduit-github — package map

`src/index.ts` target, calls · `src/errors.ts` `translate` · `src/verify.ts`
`verifyGithubSignature`, `parsePush` · `sink.ts` · `test/github.drive.ts`.

## What bites

- **A 403 is two things.** Conduit grades both `auth_failed` and never
  replays one. `translate` splits them on `x-ratelimit-remaining: 0` (or a
  `retry-after`, or a secondary-limit message); do not read the status
  elsewhere in the package.
- **A 404 is two things too.** `readFile` asks for the repository first, so a
  missing file is never read as an unseen repository.
- **`verify` throws on a limit.** A false from `/user` marks a working token
  broken; only a 401 or a refusal is `false`.
- **No idempotency key, ever.** A lost deploy-key or hook create is resolved by
  the list read, matched by key material or URL.
- **No Basecamp nouns here.** `send` first, never an app.

## Proving a change

`bun run drive`: 57 rows. The `control` rows must fail if `translate` is removed.
