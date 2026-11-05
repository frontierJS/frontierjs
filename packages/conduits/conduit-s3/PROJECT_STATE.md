# conduit-s3 — state

**Drive green on the sink (14 rows), on Backblaze B2 live and on SeaweedFS 4.48 (10 protocol rows each).** 2026-10-24.

- B2 run: `s3.us-west-000.backblazeb2.com`, a private bucket, an application key
  restricted to that bucket and to the object-name prefix `basecamp-`
  (`FIXTURE_PREFIX`, added for it — a prefixed key makes every unprefixed row
  `AccessDenied`). Path-style, SigV4, conditional GET, presign all held.
- B2 differs from AWS in one place the drive touched: an EXPIRED presigned URL
  is `401 UnauthorizedAccess`, not `403 AccessDenied`; the row now asserts a
  401/403 refusal and logs the status. A negative `X-Amz-Expires` is a 400 on
  both (`InvalidRequest` on B2), which the old row was testing by mistake; the
  sink now answers 400 outside 1..604800 as AWS does.
- `listObjects` (ListObjectsV2, one page per call, `nextToken` to follow) is
  green on both: three keys over pages of two, an `&` unescaped, UTF-8 byte
  order. B2 answered it with the key's name-prefix restriction in place.
- **B2 refuses a create-only PUT: `if-none-match: *` is `501 NotImplemented`,
  on the first write too.** Nothing here may lean on it with B2 as the
  destination. The row asserts only that the second write never wins, and logs
  the answer; the sink and SeaweedFS answer 200 then `412 PreconditionFailed`.
- Basecamp consumes this package as its own lift (`FJS-D1490`), not as a
  dependency.

- Source: litestone `storage/providers/s3.js` + `storage/sigv4.js` at `6ad199f2`; SigV4 imported, not copied.
- `FJS-D889`'s two real servers: B2 and SeaweedFS 4.48 (`FJS-D1507`). The
  SeaweedFS run: `server -s3` with `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`
  set (anonymous access then closes), bucket made with `s3.bucket.create`
  piped into `docker exec -i … weed shell`, then `FIXTURE_URL=http://127.0.0.1:<port>`.
- Reconciliation: `FJS-2543` closed — SigV4 is `@frontierjs/toolbelt/sigv4`.
- Framework gaps met: one credential string carries two parts (G4). G2, signer
  parameters, closed by FJS-2725: the region rides `auth.params`.
- The SigV4 import goes through `node_modules/@frontierjs/litestone` (the `link.sh` symlink), so it survives a move of the workspace; `./link.sh` from the root is the fix when it fails to resolve.
- FJS filed: none yet (G2 is filed once from here after Tier A — see root `PROJECT_STATE.md`).
