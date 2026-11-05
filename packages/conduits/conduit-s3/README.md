# @frontierjs/conduit-s3

The S3 protocol over `@frontierjs/conduit` (`FJS-D889`): put, get, head,
delete, list, and a presigned URL. Source:
`frontierjs/packages/litestone/src/storage/providers/s3.js` and
`storage/sigv4.js` at commit `6ad199f2`. Litestone keeps both.

**SigV4 is not forked.** `src/signer.ts` imports `@frontierjs/toolbelt/sigv4`,
where `FJS-2543` moved it out of litestone.

## What it covers

| Piece | Where |
| --- | --- |
| target builder | `s3Target({ address, region, ref })` — `signed`, signer `S3_SIGNER`, `auth.params.region`, `encoding: 'binary'` |
| signer | `s3Signer`, registered by the app under `S3_SIGNER`; the resolver's string is `<accessKeyId>:<secretAccessKey>` |
| calls | `putObject`, `getObject` (with `ifNoneMatch` → 304 as `unchanged`), `headObject`, `deleteObject` (404 is gone), `listObjects` (one ListObjectsV2 page; follow `nextToken`) |
| the call that never crosses conduit | `presign({ url, credential, region, expiresIn })` |
| error mapping | `translate` reads the XML `<Code>` — table below |
| sink | `sink.ts`: path-style store with its OWN SigV4 verifier in `node:crypto` |
| drive | `bun run drive` — 12 rows on the sink; `FIXTURE_URL=…` adds 8 against a real server (`FIXTURE_PREFIX=` for a key restricted to an object-name prefix); green on Backblaze B2 |
| fixtures | MinIO and SeaweedFS, `test/fixture/README.md` — **unproved here, no docker** |

## Errors

| `<Code>` | HTTP | conduit kind | `S3Failure.kind` | retryable |
| --- | --- | --- | --- | --- |
| `NoSuchKey`, `NoSuchBucket` | 404 | `client_error` | `missing` (delete: success) | no |
| `SignatureDoesNotMatch`, `InvalidAccessKeyId` | 403 | `auth_failed` | `auth_failed` | no |
| `AccessDenied` | 403 | `auth_failed` | `forbidden` — the key is right, the policy says no | no |
| `RequestTimeTooSkewed` | 403 | `auth_failed` | `clock_skew` | no |
| `PreconditionFailed` | 412 | `client_error` | `etag_mismatch` | no |
| `SlowDown` | 503 + `Retry-After` | `rate_limited` | `rate_limited` | yes (every verb is idempotent) |
| 304 | 304 | success | `unchanged: true` | — |

A HEAD carries no body and therefore no `<Code>`: a HEAD refusal is the
conduit kind alone. Read with GET where the code matters.

## Chaos the sink owns

`{ lost }`, `{ slowDown: { retryAfter } }`, `{ skew: seconds }` (moves the
SINK's clock), a `private/` prefix is `AccessDenied` for every key.
