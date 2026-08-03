# Junction examples

Every file here was run and exercised over HTTP on 2026-08-01. If one stops
working, that is a bug — these are not sketches.

Read them in this order.

| Example | Port | What it is for |
|---|---|---|
| [`minimal/app.ts`](./minimal/app.ts) | 3100 | The smallest useful app. Schema → service → CRUD, nothing else. |
| [`elegant.ts`](./elegant.ts) | 3200 | **Start here.** The 80% path in the current idiom: schema-derived 400s, `@@gate` 401s, declared `channel:`, one custom action. |
| [`fullstack/app.ts`](./fullstack/app.ts) | 3400 | The whole road: `db/schema.lite` → service → HTTP + WS → a browser page that renders it. |
| [`single-file.ts`](./single-file.ts) | 3000 | Kitchen sink in one file — auth, hooks, mail, OpenAPI, channels. |
| [`app.ts`](./app.ts) | 3000 | The demo API `bun run dev` starts. Broadest feature surface; autoloads [`services/`](./services). |
| [`server.ts`](./server.ts) | 3000 | Litestone-backed smoke server: login, seeded leads, every lead route behind a token. |
| [`email-system.ts`](./email-system.ts) | 3000 | Tier-1 native SMTP — no third-party dependency. |
| [`file-upload.ts`](./file-upload.ts) | 3000 | `File` fields: multipart in, stored refs expanded to URLs on the way out. Runs offline. |
| [`test.ts`](./test.ts) | — | The test harness, not a server. `bun test ./example/test.ts` → 26 tests. |

Most of these share port 3000 — run one at a time.

## Things these examples pin down

Each of the following was a real defect found by running them, and each is the
kind of thing that reads as correct on the page:

- **Route patterns are `{id}`, never `:id`.** A `:id` segment is matched
  literally, so the route registers fine and then never fires. `file-upload.ts`
  had two of these.
- **`apiPrefix` defaults to `''`.** Without setting it, a service mounts at
  `/leads`, not `/api/leads` — while any hand-written `/api/...` route in the
  same file sits somewhere else entirely.
- **Custom methods dispatch by `X-Service-Method` header, not by URL.** There is
  no `POST /servers/1/reboot`; that 404s.
- **`ctx.result` is an envelope, and `kind` says what `data` holds.** A helper
  that does `for (const row of result.data)` works on lists and throws
  `{} is not iterable` on every single-record write.
- **`createClient` takes one options object.** Positional args throw.
- **Scalars are `Int`/`String`/`Float`/`Bytes`.** The pre-1.0 names are rejected
  outright, so a stale schema stops the app at startup.

## Known gaps, stated rather than faked

- **Presigned direct-to-bucket uploads do not exist yet.** `file-upload.ts`
  documents exactly why (litestone's `sign()` signs an existing ref and mints a
  GET) instead of shipping a route that cannot work.
- **A model with a `File` field cannot take a generated `schema:`.**
  `generateJsonSchema()` emits `$ref`/`anyOf` for those fields and Junction's
  validator does not resolve `$ref` — every write becomes a 500. `file-upload.ts`
  omits `schema:` and says so.
