# junction — what bites here

The full hazard catalog for `@frontierjs/junction`, moved out of `CLAUDE.md`. The traps that bite most often stay there as one-liners; this is every one, verbatim, with the rules a change must keep in full.

## Rules a change must keep

Each names its pin. The failure behind each is `docs/internals.md`, by path.

- **A broadcast is graded per recipient**, on the service path and on the
  background tap alike, with the DECLARED `model:` as the accessor (`FJS-D175`,
  `FJS-672`, `FJS-700`) — `test/realtime-grading.test.ts`. A connection's claims
  are the app's to state, per channel (`FJS-749`, `test/channel-claims.test.ts`).
- **A room bound by `channels({ rooms })` is graded at the join and again after
  every committed write its row's read policy reaches**, since presence and a
  raw `send` are not graded per frame (`FJS-D596`, `test/channel-rooms.test.ts`).
- **A service broadcasts through `channel:` or the `announce()` hook, never
  both**, matched on the hook's mark rather than its name (`FJS-045`,
  `test/double-broadcast.test.ts`).
- **A write is done when the OUTERMOST transaction commits.** The commit scope in
  `core/context.ts` drains `afterCommit` and the announcement on commit and
  discards both on rollback (`FJS-682`, `FJS-688`, `test/commit-scope.test.ts`).
- **The gate wraps every hook an app wrote** —
  `around(gateAuth) → before → validated → method → after` (`FJS-403`,
  `test/hook-ordering.test.ts`).
- **A key issued with scopes reaches only a method whose declared `scope:` it
  holds**, refused in `callService` on every wire call and read by mcp's tool
  list through `scopeRefusal`; a method naming none refuses it (`FJS-D916`,
  `test/method-scopes.test.ts`).
- **A custom method takes the model's read gate as a floor**, and a `gate:` on a
  CRUD verb is graded only over no model (`FJS-826`, `FJS-D408`,
  `test/custom-method-gate.test.ts`). **An omitted `model:` resolves from the
  service's NAME**, so a model-less service named like a model is graded by that
  model; `model: null` says there is none, and `serviceAccessor()` is the one
  reader — never write `model ?? name` (`FJS-D628`).
- **A filtered bulk PATCH/REMOVE writes one row at a time through `update()`**,
  under `bulkMax` (`FJS-044`, `test/bulk-partial-success.test.ts`).
- **An `Idempotency-Key` needs a principal and names ONE request** — a stranger's
  key is ignored, a changed payload is 422 (`FJS-680`, `test/idempotency.test.ts`).
- **The METHOD decides list vs single, and a stream is refused by name**, from
  a method or a hook (`FJS-140`, `FJS-D13`, `FJS-1693`, `test/envelope.test.ts`).
- **What a thrown value becomes is committed and executed** — `errors.snapshot.md`
  at this root, `junction errors` (`FJS-255`, `test/errors-snapshot.test.ts`).
- **Every socket bound is the socket's own**, since every HTTP bound stops at the
  upgrade (`FJS-705`, `FJS-704`, `test/ws-limits.test.ts`). Presence is opt-in and
  batched on a timer (`FJS-703`, `test/presence-scale.test.ts`).
- **A reconnect is a gap**: the client emits `reconnected` and a live list refetches,
  jittered (`FJS-701`, `test/reconnected.test.ts`). A present WS token that does not
  verify closes 4001; no token stays anonymous (`FJS-702`,
  `test/realtime-grading.test.ts`).
- **A shutdown that does not finish exits 1** (`FJS-693`, `test/shutdown.test.ts`).
- **A `junction.config.js` key reaches the app only where `loadConfig` maps it**
  (`FJS-1066`, `FJS-D256`) — `test/config-surface.test.ts` fails a key added
  without a behavioral row.
- **A route registers once**, keyed on its shape (`FJS-225`,
  `test/duplicate-routes.test.ts`).
- **A webhook destination is graded at registration and before every attempt, and
  its subscriber is read from the registrant** (`FJS-681`, `FJS-D193`,
  `test/webhook-targets.test.ts`, `test/webhook-payload.test.ts`). **A
  subscription receives the same scheme, dedupes on the SIGNED body id, and
  dedupe means applied, not seen** — a `receive` that throws leaves the receipt
  unapplied and answers 500 (`FJS-D1087`, `test/webhooks.test.ts` § receiving).
- **A CRLF in a mail address or header is refused at the builder AND at
  `sendMessage()`** (`FJS-677`, `test/mail-injection.test.ts`).
- **A reply tag threads a reply onto its record and proves only that the
  holder RECEIVED our mail** — attribution also needs `from` to be the address
  the mail went to; an expired or forged tag still delivers, unthreaded, and a
  mailbox longer than 21 characters cannot carry one (`FJS-D1091`, `FJS-D1092`,
  `test/mail-received.test.ts`). Mail arrives through a conduit Receiver, never
  a route here.
- **The static server serves a file inside its root**, symlinks resolved, 404 on
  the way out (`FJS-746`, `test/static-root.test.ts`). Its cases are shared with
  sierra's origins: one found by either goes in
  `test/fixtures/served-path-vectors.json` (`FJS-D653`).
- **`$` throws outside a call, and a call that has ended is outside it**
  (`FJS-687`, `test/call-scope.test.ts`).
- **A claim resolver runs inside the data hook, for a guest as well as a
  session, and a guest's claims never become `ctx.user`** (`FJS-D113`,
  `test/principal-claims.test.ts`).
- **`principal` may be a list, run in order and merged; a claim name two
  elements emit is refused by name, and every element's `describe()` is read**
  (`FJS-D522`, `FJS-D694`, `test/principal-list.test.ts`). **A grant is minted by
  the caller's own create and a link redeemed for a cookie through `bearerClaim`'s
  `mint`/`redeem`**, never a second write below the boundary (`FJS-D819`,
  `test/bearer-claim.test.ts`). **A session beside a grant is a 400 before the
  grant is read, unless the grant states `session: 'merge'`** (`FJS-D832`, same
  file § a session beside a grant).
- **A claimed mirror's generated write lands at the Provider first, here
  second** (`FJS-D1125`): `create`/`update`/`patch`/`remove` ask
  `app.conduit.mirrored(accessor)` at call time, the row validator steps aside
  for the claim's input, the answer is upserted by `$mirrorKey` as the system,
  a `@local` column the caller named is written as the caller, the row is
  re-read as the caller, and a write naming no single row is refused.
  `mirrorClaimFor` in `core/litestone.ts` is the one reader; the proof is
  conduit's `junction-integration.test.ts` § *a claimed mirror model*.
- **A test names no port** — `port: 0`, then read `app.http.port` (`FJS-900`,
  `test/test-ports.test.ts`).
- **The whole package typechecks to zero, `test/` included** — junction has no
  baseline, and absent means 0 (`FJS-034`, Invariant 14).

## What the default gets wrong


- **Path captures are `ctx.route`**; there is no `ctx.params` on either context
  (`FJS-D03`).
- **A raw route writes `{id}`**; a `:id` is a literal segment.
- **`app.get`/`app.post` apply `apiPrefix`**; `app.http.router` is the escape for
  a path that must not move.
- **`update` is `patch` with an id required, and it MERGES** (`FJS-D179`).
- **`after` is after the METHOD.** An effect that must not run early goes in
  `ctx.afterCommit(fn)`, and one that must not be lost in `ctx.enqueue(job, payload)`.
- **`register` is sync.** Async setup and reading `junction.config.js` go in
  `boot()`; only a throw in `ready` lets the app start.
- **A timer in `boot()` ticks in every one-shot process.** `junction call` and
  the snapshot tools boot with `_startOnce()`, which runs `boot()` and skips
  `work()`; a worker, poller or `setInterval` goes in `work()`, and
  `app.scheduler` holds its jobs until then (`FJS-D551`,
  `test/start-work.test.ts`).
- **An internal caller's directives ride `{ directives }`** in the options, and
  filters are the first argument.
- **`_find`/`_get`/`_create` skip junction's hooks and keep Litestone's gate.**
- **A frame goes out through `wsSend()`** in `transport/send-queue.ts`, which
  holds what Bun drops.
- **`ctx.data` is a row or an ARRAY of rows**; a hook narrows with `Array.isArray`.
- **A `__`-prefixed context field is a declared contract.** A cast to
  `Record<string, unknown>` to reach one is the smell.
- **A Litestone client is probed with `'x' in db`**, since `typeof db.x` throws, and
  `$tapQuery`/`$tapEvents`/`$logContext` are on the ROOT client only (`FJS-673`).
- **Junction's edge is four axes and a host** (`FJS-D639`): admission, the call,
  carriage, announcement, and `createApp`. Everything else is a battery behind a
  subpath — nothing under `src/core/` or `src/transport/` imports one outside
  the allow-list in `test/edge.test.ts`, and the main entry re-exports none. A
  battery types its `app.<slot>` by augmenting an empty `App*` interface, never
  by an import in `app.ts` (`FJS-D640`). A schema-declared thing that needs a
  process and a queue is a battery over `app.jobs`, shipped with its `.lite`
  fragment (`FJS-D643`). Junction opens no database: `createApp({ db })` is the
  one way in (`FJS-D641`).
- **Junction owns no file store** (`FJS-D260`). Litestone's `FileStorage` is the one;
  junction owns the crossing — `transport/body.ts` parses multipart,
  `transport/bridge.ts` merges it into `ctx.data`, the client encodes a `File`.
- **A standing is the app's mapping**: `callerGateLevel` asks `db.$levelOf`, and
  `sessionGateLevel` is the fallback that never reads a `role` column (`FJS-D308`).
- **`createApp({ tenants })` replaces `createApp({ db })`** rather than joining it.
- **Helmet headers are on until `http: { helmet: false }`; CORS, the DDoS gate and
  the rate limiter are off until configured**, and `'*'` is never applied for you.
- **A test injects a transport rather than mocking a module**; `mock.module()` is
  process-wide in bun (`FJS-908`). A hand-built context sets `ctx.result = null`.
- **An `around` that ends the call without assigning `ctx.result` is a 500, not a 204** (`FJS-946`, `test/around-forgot-next.test.ts`). It is graded only on a context the three builders made through `hookContext`; a hand-built one is exempt, so a test that forgets `next()` still passes.
- **A local FileStorage's files are public by key.** `GET <apiPrefix>/files/*` (`transport/local-files.ts`) serves `<db dir>/files` with no gate, the same exposure as an R2 `publicBase`, so a key must stay an unguessable `:uuid`. It sets the store's `publicBase` from `FRONTIER_APP_URL` only where `FILES_PUBLIC_BASE` left it unset, and a type outside the inline allow-list downloads (`FJS-3536`, `FJS-D1549`).
