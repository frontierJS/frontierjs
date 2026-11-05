# conduit-s3 — package map

`src/signer.ts` the SigV4 signer factory and `presign`, over
`@frontierjs/toolbelt/sigv4` · `src/index.ts` target and calls · `src/errors.ts`
reads the XML code · `sink.ts` an object store that VERIFIES SigV4 with its
own canonicalization · `test/s3.drive.ts`.

## What bites

- **One signer for every region.** The region rides `auth.params` (FJS-2725);
  a target without one is `auth_failed`, nothing sent.
- **The sink's verifier is written from the AWS rules, not imported.** If the
  signer and the sink both drift the same way, the fixture is what catches it.
- **Every header conduit sends is signed**, including its default
  `Accept: application/json`. A proxy that rewrites a header is a 403.
- **A HEAD refusal has no code.** Real S3 sends none either.
- **No signing-key cache.** Toolbelt's kit is pure and the signer passes `now`
  on every request, so each one re-derives the day-key; litestone keeps a cache.

## Proving a change

`bun run drive` (sink). With docker: `test/fixture/README.md`, both servers.
