# conduit-ahrefs — package map

`src/index.ts` target, calls · `src/errors.ts` `translate`, `costOf` ·
`src/types.ts` · `sink.ts` · `test/ahrefs.drive.ts`.

## What bites

- **A 403 is three things.** Conduit grades every one `auth_failed`. Only the
  body tells a spent allowance (`{ error: "…units limit reached…" }`, `quota`)
  from no key (`["Error","Forbidden"]`). A bad key is 401 `["Error","Unauthorized"]`.
  Bodies are an array or `{ error }`; `translate` reads both and nothing else
  reads the status or `raw`.
- **Cost is reported, never computed.** `costOf` reads the five `x-api-*`
  headers. A free test target reports `total: 50` and `actual: 0`. An absent
  header is `null`, never 0.
- **No idempotency key, ever.** `addProject` finds first, posts once and
  resolves a lost answer by the list; a replayed POST makes a second project.
- **`/site-audit/projects` takes no project id.** `siteAudit` reads the whole
  list (`healthscores`) and picks the row; a never-audited project is `null`.
- **The fixture is free calls only.** The drive's guard refuses a non-GET and
  any `target` outside `ahrefs.com`, `yep.com`, `firehose.com`. Never add a
  project add or delete to it: it is the owner's live workspace.
- **No TPM nouns here.** `send` first, never an app.

## Proving a change

`bun run drive`: 33 rows against the sink, 39 with `AHREFS_FIXTURE_KEY`. The
`CONTROL` row must fail if `translate`'s units match is removed.
