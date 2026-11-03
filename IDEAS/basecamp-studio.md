---
id: basecamp-studio
status: proposed
dated: 2026-11-03
---

# Basecamp Studio — Litestone Studio over a deployed App's data, opened from Basecamp

**Status: PROPOSED.** Dated 2026-11-03. Nothing here is built. Do not cite this
file as describing behavior — see `VERIFYING.md`.

The want: an operator looking at an App in Basecamp clicks **Open Studio** and
browses that App's production data in the Studio they already know from
`fli studio` — the App's own schema, its own databases, read-only — without
SSHing to the machine, copying a file down, or finding the schema that matches
the running release.

Studio is not a static page. `studio.html` is an 8.7k-line client that calls
about 60 `/api/*` routes, and `cmdStudio` answers them from a live database
handle. So "open Studio" means a Studio process somewhere holding a copy of the
App's data, and a path from the operator's browser to it.

---

## What exists

- **The drill already does the hard half.** `POST /replica/drill`
  ([server.js:370](../packages/outpost/src/server.js#L370)) stages every database
  the App's Litestream replica lists into a directory on the machine
  (`replicator.stage`), then runs the App's LIVE release image over it with
  `--network none`, invoking `bun x litestone restore --verify-only`
  (`docker.verifyCopy`, [docker.js:1214](../packages/outpost/src/docker.js#L1214),
  `FJS-D1524`). The image ships the schema and the litestone that release
  opens its data with, so schema and code agree by construction.
  `drillApp` ([app-drill-run.job.ts](../packages/basecamp/api/src/jobs/app-drill-run.job.ts))
  is the Basecamp side: `replicaOf`, the newest successful Deployment's
  `toImage`, `releaseEnv` for the key.
- **Studio already takes a token.** `?token=` on the page becomes a Bearer
  header on every call (`STUDIO_TOKEN`, studio.html:1903), and `--readonly`
  refuses every write route and the REPL ([studio.js:855](../packages/litestone/src/tools/studio.js#L855)),
  leaving `/api/query`'s `SELECT` open.
- **Studio's page assumes the origin root.** `const API = '/api'`
  (studio.html:1878) and `<link href="/studio.css">` (studio.html:19). Under a
  path prefix both miss.
- **The executor is calls and streams, not a proxy.** `executor.call(path, body)`
  and `executor.stream(...)` over conduit, signed
  ([executor.ts](../packages/basecamp/api/src/providers/executor.ts)). Nothing
  forwards arbitrary HTTP from Basecamp to a port on a machine.
- **A navigated raw route has a precedent.** `/backup-archive/{id}?expires=&sig=`
  ([backup-archive.ts](../packages/basecamp/api/src/plugins/backup-archive.ts))
  is a raw route whose link carries its own HMAC credential, because a
  navigation carries no bearer. It is listed in `NAVIGATED_API_PATHS`
  ([api-paths.js:132](../packages/basecamp/web/config/api-paths.js#L132)) so both
  proxies stop answering it with the SPA shell.
- **Replica restore is an ADMINISTRATOR method.** `apps.restoreReplica`
  (`gate: LEVELS.ADMINISTRATOR`, apps.service.ts:697) is the gate to match.

---

## Prior art

Confirmed against each vendor's pages 2026-11-03 (0.4).

- **Neon Time Travel — the nearest.** The console's SQL Editor queries a past
  instant on a temporary branch; it "only allows non-destructive read-only
  queries", and the branch is torn down after a short idle
  ([time-travel-assist](https://neon.com/docs/postgres/backup-restore/time-travel-assist)).
  A dashboard viewer over a point-in-time copy with an idle teardown is this
  paper's shape.
- **Heroku Dataclips** — SQL in the dashboard "executed via a read-only
  transaction" ([blog](https://www.heroku.com/blog/how-we-use-heroku-postgres-dataclips/)),
  ten-minute timeout, 100,000-row cap
  ([Dev Center](https://devcenter.heroku.com/articles/dataclips)). A follower is
  recommended, not required. A session-level read-only transaction is reported
  bypassable, which is why `--readonly` here is a server refusal, not a mode.
- **Railway's Data tab, Supabase Studio — the contrast.** Both browse and edit
  the live database ([Railway](https://docs.railway.com/databases/database-view),
  [Supabase](https://supabase.com/docs/guides/database/overview)).
- **Fly.io `fly proxy`** — the tunnel-to-laptop shape
  ([docs](https://docs.fly.io/flyctl/proxy)); the earlier option A.
- **No database console found that isolates its document for untrusted row
  content.** The nearest is Retool's `SANDBOX_DOMAIN`, a second domain for
  builder-written JavaScript
  ([docs](https://docs.retool.com/self-hosted/self-managed/guides/origin-sandbox)).
  Q3's ruling stands on its own reasoning.

---

## Security

- **Studio renders production row contents.** Those rows were written by the
  App's users. Served on Basecamp's origin, a single escaping miss in Studio
  would run script beside Basecamp's admin session. So the Studio document
  gets an opaque origin (Q3) and reaches the relay by the session id in its
  path, never by Basecamp's own credentials.
- **A copy, never the live volume.** The replica is staged into a directory of
  its own and the App's volume is never mounted, as in a drill.
- **No network in the container.** `--network none`, as in a drill; the relay is
  the only way in (Q1).
- **Read-only always.** `--readonly` is passed unconditionally. A write to a copy
  would go nowhere and read as if it had landed.
- **No key, and no protected value in the clear** (Q2, Q6). The container never
  holds the release's key, and every protected kind answers the mask the audit
  trail writes.
- **Who opened what is recorded** (Q4), and a session ends on its own: an idle
  limit and a hard cap enforced by Outpost, so a Basecamp crash cannot leave one
  running.

---

## Phases

### Phase 0 — Groundwork

Goal: the numbers and probes the design below assumes, read off a real machine.
Done when: each step below has its answer written under it.

- [x] 0.1 Time a replica stage for the largest App on yuma, and measure what
  `executor.call` carries: its body-size ceiling and timeout. Decides whether
  `/api/table-dump` needs a stream route (2.4).
  - The relay's limits, read off the code: an answer is capped at 10 MiB
    (conduit's `DEFAULT_MAX_BYTES`, Basecamp sets no other), a call times out
    at 10 s unless it passes `timeoutMs`, Basecamp's conduit retries 3 times,
    and Outpost refuses a body over 40 MiB (`MAX_BODY_BYTES`). `/api/info` on
    a real App's schema is 262 KB and the page 362 KB, so a table view fits;
    a whole-table dump does not, so 2.4 is a stream route.
  - A retried `/studio/open` would stage twice; one-per-App replacement (2.1)
    makes that a waste, not a fault.
  - Not timed: yuma has had no App placed since its 2026-11-03 reinstall, and
    no drill has run on the dev Basecamp. The stage time moves to 4.2.
- [x] 0.2 Price Q1's A against D on a real image: `Bun.serve({ unix })` in a
  container on a bind mount and `fetch(url, { unix })` from the host as
  Outpost's user (socket file modes), against `docker exec` per request to
  Studio on the container's loopback (milliseconds per call, times the ~10
  calls a table view makes).
  - Run on a local release image (litestone 1.1.13, bun 1.4.4), Studio under
    `--network none` over the image's own schema: ready 651 ms after start.
    Per `/api/info`: 8 ms in the container; **D** 225–296 ms (an exec each);
    **E**, one persistent `docker exec -i` carrying a JSON line per request,
    231 ms once then 12–17 ms, 10 parallel in 105 ms; **A**, a unix socket on
    the bind mount, 6–9 ms (with an extra hop in the probe), 10 parallel in 51 ms.
  - Bun creates the socket `srwxrwxrwx`, so its directory's mode is the only
    access control: the staging directory is owned by Outpost's user, mode 0700.
  - Every image built today fails in two other ways: the page hard-codes
    `const API = '/api'`, and Studio refuses to start keyless (0.6). Both need
    new litestone, so every option has an image floor. See Q1.
- [x] 0.3 Read the headers Basecamp's Caddy and the API set on a raw route
  (CSP, CORS), and what `Access-Control-Allow-Origin` a sandboxed document's
  `null` origin needs, so 3.2 knows what it overrides. Studio's one storage use
  (the rail, studio.html:2968) is already wrapped for a storage that throws.
  - Caddy adds nothing but gzip. Junction's `helmet()` stamps
    `content-security-policy: default-src 'self'; …; frame-ancestors 'none'`
    on every answer, which blocks Studio's one inline `<script>` and its inline
    styles. It stamps only headers a response has not set
    (`http.ts:573`), so the relay's own CSP wins.
  - The relay's CSP: `sandbox allow-scripts allow-forms allow-downloads
    allow-popups; default-src 'self'; script-src 'unsafe-inline';
    style-src 'self' 'unsafe-inline'`. The sandboxed page's `api/*` calls carry
    `Origin: null` and no credentials, so `Access-Control-Allow-Origin: *` and
    an `OPTIONS` answer for its JSON POSTs suffice. Whether `'self'` matches
    under an opaque origin is browser-dependent; the Phase 3 drive runs it in
    Chromium and Firefox (Firefox is the stricter one).
- [x] 0.4 Confirm the prior art above against each vendor's docs.
  - § Prior art is rewritten from the sources.
- [x] 0.5 Run `decision-rules` on the route and method names in Phases 2–3.
  - `/studio/*` stays its own noun rather than `/replica/studio/*`: a session
    with three verbs and an id, which consumes a staged replica as
    `/logs/follow` consumes a log. `/studio/request` became `/studio/relay`,
    one word for one hop. 3.1's input is named `AppStudioOpen`.
  - `--without-key` takes a new effect in Studio (sealed columns read as
    `[redacted]`) beside its `restore` meaning (sealed columns unchecked), so
    its help text says which.
- [x] 0.6 Open a schema with `@encrypted` columns in Studio with no key
  (`encryptionKey: null`, studio.js:351) and read what each protected kind
  shows — `@encrypted`, `@secret`, `@hashed`, `@guarded`, `@personal`, `@opaque`
  — with no principal selected. Q2 and Q6 rule on what this finds.
  - **Studio does not start keyless** on a schema with `@encrypted` or
    `@secret`: `createClient` refuses (`client.js:6091`). studio.js:351's
    `null` is the tenant registry, not the main client. The same refusal ended
    the 0.2 probe until a throwaway key was passed.
  - With the key and no principal (`asSystem()`): `/api/table` shows
    `@encrypted`, `@secret` and `@guarded` in plaintext; `@hashed` is dropped;
    `@personal` and `@opaque` are plaintext, and are also plaintext at rest.
    Nothing in the browse path writes Invariant 7's masks.
  - `/api/query` reads the raw file: ciphertext and hashes for the sealed
    kinds, plaintext for `@guarded`, `@personal` and `@opaque`.
  - A principal drops the sealed kinds and `@guarded` but needs a `@@gate`
    on every model — an ungated model answers "requires SYSTEM access". So a
    principal is not a mask.
  - The JSON table dump writes `@encrypted`, `@secret` and `@guarded` in
    plaintext under an `X-Withheld-Columns` header that says they were
    withheld — `FJS-3939`.
  - A wrong key starts, then fails the whole page on the first sealed column.

**Done 2026-11-03.** Studio today cannot open a sealed schema without its key,
and with the key it shows sealed and guarded values in plaintext — so the
viewer needs two litestone modes (1.3, 1.4), and those set an image floor that
makes the unix socket the cheapest transport. The relay's 10 MiB cap puts the
dump on a stream route. The stage time is owed to 4.2.

### Phase 1 — Studio serves under a prefix, on a socket, keyless and masked

Goal: one Studio build serves `fli studio` unchanged and a relayed session
that holds no key and shows no protected value.
Done when: litestone's `verify:studio:*` drives pass, and
`litestone studio --socket <path> --redact` over a sealed schema with no key
answers `curl --unix-socket` with every protected sentinel masked.

- [ ] 1.1 Relative paths in `studio.html`: `API = 'api'`, `href="studio.css"`.
  The page is then served at a URL ending in `/`.
- [ ] 1.2 `--socket <path>` in `cmdStudio`: `Bun.serve({ unix })`, refusing
  `--host`/`--port` beside it. (Under Q1 = A.)
- [ ] 1.3 `--without-key`: a `createClient` mode in which `@encrypted` and
  `@secret` read as `[redacted]` where the client now refuses, and every write
  to them is refused. (Under Q2 = A.)
- [ ] 1.4 `--redact`, implying `--without-key` and `--readonly`: Studio serves
  an allowlist of routes whose answers are masked — info, browse, row detail,
  dump — with Invariant 7's masks for `@guarded`, `@personal`, `@opaque`, and
  `@hashed` dropped as today. Every other route is refused by name, so a route
  added later fails closed. `/api/query` is refused. A test seeds one sentinel
  per protected kind and walks Studio's route table, not a hand list,
  asserting no sentinel in the clear. Fixes `FJS-3939` on the way. (Under
  Q6 = B.)
- [ ] 1.5 Release litestone, and redeploy one fleet App so an image carries
  1.1–1.4. An older image is refused by 2.1 with "redeploy to open Studio".

### Phase 2 — Outpost: a Studio over a staged replica

Goal: a machine runs Studio for one App over a copy, and answers relayed
requests to it.
Done when: outpost's tests cover the three routes against a stubbed docker, and
on `bun run dev:outpost` an example App's image serves `/api/info` through
`/studio/relay`.

- [ ] 2.1 `POST /studio/open` `{app_id, replica, databases, image, digest}`
  → `replicator.stage` into a directory owned by Outpost's user, mode 0700,
  then `docker run -d --network none --label fjs.studio=<app_id>` over it
  running `bun x litestone studio --redact --socket`. Waits for the socket,
  answers `{studio_id, expires_at}`. One per App: opening again replaces the
  last. Before staging, `bun x litestone studio --help` in the image must name
  `--redact` and `--socket`; one that does not is refused with "this release's
  litestone predates Studio in Basecamp — redeploy to open it", rather than
  surfacing as a socket-wait timeout. A test asserts the container's
  environment carries no encryption key.
- [ ] 2.2 `POST /studio/relay` `{studio_id, method, path, query, body}` →
  fetch over the socket, answers `{status, content_type, body}`. Any path is
  forwarded: the socket reaches one Studio and Studio's own allowlist (1.4)
  answers what it does not serve, so there is no second route list to drift.
  Each request resets the idle timer.
- [ ] 2.3 `POST /studio/close`, the idle limit (30 min) and hard cap (2 h) as
  Outpost timers, and a startup sweep that removes every `fjs.studio` container
  and its staging directory.
- [ ] 2.4 `POST /studio/relay/stream` for `/api/table-dump`: a dump outgrows
  the 10 MiB call cap (0.1), so it rides a stream route as `/logs/follow` does.

### Phase 3 — Basecamp: open and relay

Goal: an ADMINISTRATOR opens a session and a browser drives Studio through
Basecamp.
Done when: on a dev Basecamp beside `dev:outpost`, `apps.openStudio` answers a
URL, and `drive-browser` — in Chromium and Firefox — browses a table, sees
every protected column masked, and sees raw SQL and a write refused.

- [ ] 3.1 `apps.openStudio` (`gate: LEVELS.ADMINISTRATOR`, input `AppStudioOpen`
  `{serverId}`): `replicaOf`, the newest successful Deployment, `executor.call('/studio/open')`
  as `drillApp` does. Holds the session (Q4) under a random 256-bit id and
  answers `/studio/<session>/`. The id is the whole credential — the
  `backup-archive.ts` stance, one secret in the link and nothing beside it.
- [ ] 3.2 Raw route `plugins/studio-relay.ts` at `/studio/<session>/*`: looks
  the session up, relays through `executor.call('/studio/relay')`, and
  isolates the document per Q3 with the CSP 0.3 wrote, plus CORS for its
  `null` origin. `/studio/` joins `NAVIGATED_API_PATHS`. A test asserts the
  sandbox header on `/`, `/studio.css`, `/api/*` and every error answer. The
  relay filters nothing: refusals are Studio's (1.4), which knows its routes.
- [ ] 3.3 `apps.closeStudio`, and the relay answers an expired session with a
  page that says so.

### Phase 4 — The button, and a real box

Goal: an operator opens Studio from the App page against real data.
Done when: the owner browses a real App's data on yuma from Basecamp.

- [ ] 4.1 **Open Studio** on the App page, ADMINISTRATOR only: a machine picker
  when the App is placed on more than one, a wait state while the replica
  stages, a new tab on success, and the refusal's own words otherwise (no
  replica, no release, an image older than 1.5).
- [ ] 4.2 Run it on yuma against a real App and its replica, and time the
  stage (owed from 0.1).
- [ ] 4.3 Basecamp README section, Outpost's route table, and a drive once the
  owner calls it settled.

---

## Open questions

- ~~**Q1 — How does Outpost reach Studio inside a container with no network?**~~ **Answered 2026-11-03 (`FJS-D1830`): A — a unix socket in the staging mount. `--network none` holds; needs 1.2, so an image built before it cannot open Studio until redeployed.**
  - **A** — a unix socket in the staging mount. `--network none` holds; needs
    1.2, so an image built before it cannot open Studio until redeployed.
  - **B** — a bridge network with `-p 127.0.0.1:<port>`. Works with every image
    today; the container gains outbound network while holding production data.
  - **C** — Outpost runs its own litestone as a host process, with the schema
    copied out of the image. No image change; the litestone reading the data is
    no longer the release's own, which is the agreement `FJS-D1524` bought.
  - **D** — Studio on the container's own loopback (it exists under
    `--network none`), each request relayed by `docker exec`. No image change and
    no network; an exec per call.
  - **E** — D through one persistent `docker exec -i` per session, a JSON line
    per request on its stdin. No litestone flag; a framing protocol of its own,
    and a dump cannot stream through it.
  - **Recommend A** — 0.2 measured A at 6–9 ms, E at 12–17 ms after a 231 ms
    start, and D at ~230 ms per call. E's one advantage was no image change,
    and 0.2 and 0.6 found that every image built today needs new litestone
    anyway (the page's absolute `/api`, the keyless refusal). Given that floor,
    A is plain HTTP and can stream a dump.
- ~~**Q2 — Is the release's encryption key passed in?**~~ **Answered 2026-11-03 (`FJS-D1832`): A — no. Studio gains `--without-key`, as `restore --verify-only` has: `@encrypted` and `@secret` read as `[redacted]` instead of the client refusing. The key never enters a viewer's container.** Studio cannot open a
  sealed schema without one today (0.6), so A is a litestone change.
  - **A** — no. Studio gains `--without-key`, as `restore --verify-only` has:
    `@encrypted` and `@secret` read as `[redacted]` instead of the client
    refusing. The key never enters a viewer's container.
  - **B** — yes, as the drill does, and Q6's mask hides the plaintext Studio
    then holds.
  - **Recommend A** — B's safety is one masking path being right on every
    route, and 0.6 found that path wrong today (`FJS-3939`: the JSON dump
    writes plaintext under a header that says it withheld it). A keyless
    client cannot leak what it cannot decrypt. It costs a `createClient` mode
    whose reads answer a mask where they now refuse.
- ~~**Q3 — How is the Studio document kept apart from Basecamp's origin?**~~ **Answered 2026-11-03 (`FJS-D1821`): A — a `Content-Security-Policy: sandbox allow-scripts allow-forms allow-downloads allow-popups` header on the document. It runs at an opaque origin and sends no cookies; its `api/*` calls are cross-origin, carried by the session id in the path, and the relay answers CORS for them.**
  - **A** — a `Content-Security-Policy: sandbox allow-scripts allow-forms
    allow-downloads allow-popups` header on the document. It runs at an opaque
    origin and sends no cookies; its `api/*` calls are cross-origin, carried by
    the session id in the path, and the relay answers CORS for them.
  - **B** — a hostname of its own, e.g. `studio.<basecamp host>`. Real origin
    separation; needs DNS and a certificate, which `IDEAS/ingress-name.md` has
    not settled.
  - **Recommend A** — one header and a CORS answer, no new name, and B stays open
    once the ingress name lands.
- ~~**Q4 — Where does an open session live?**~~ **Answered 2026-11-03 (`FJS-D1822`): A — in Basecamp's process memory, as `backup-archive.ts` keeps its key: a restart voids every session (one click to reopen), and each open is one audit line.**
  - **A** — in Basecamp's process memory, as `backup-archive.ts` keeps its key:
    a restart voids every session (one click to reopen), and each open is one
    audit line.
  - **B** — a model, e.g. `AppStudioSession`, with `@@log(audit)`: who, when,
    which machine, closed or expired; shown on the App page.
  - **Recommend A** — one level simpler, and the audit line answers "who looked";
    B is the step if the App page should list sessions.
- ~~**Q5 — Replica only, or also a snapshot of the live volume?**~~ **Answered 2026-11-03 (`FJS-D1823`): A — replica only, as the drill. An App with no replica destination gets the refusal "set a replica destination to open Studio".**
  - **A** — replica only, as the drill. An App with no replica destination gets
    the refusal "set a replica destination to open Studio".
  - **B** — also a point-in-time copy of the volume for Apps without one.
  - **Recommend A** — B is a second staging path with its own consistency
    problem (a live WAL), for Apps that should have a replica anyway.
- ~~**Q6 — What does an ADMINISTRATOR see of protected columns?**~~ **Answered 2026-11-03 (`FJS-D1831`): B — Studio gains `--redact`: browse, row detail and dump answer Invariant 7's masks (`[redacted]`, `[personal]`, `[opaque:<digest>]`) for every protected kind, and `/api/query` is refused, because raw SQL cannot be masked by column. Basecamp always passes it.** 0.6: with the
  key, `asSystem()` browse shows `@encrypted`, `@secret` and `@guarded` in
  plaintext, and `@personal`/`@opaque` are plaintext even at rest, so Q2 alone
  does not hide them.
  - **A** — what `fli studio` shows today.
  - **B** — Studio gains `--redact`: browse, row detail and dump answer
    Invariant 7's masks (`[redacted]`, `[personal]`, `[opaque:<digest>]`) for
    every protected kind, and `/api/query` is refused, because raw SQL cannot
    be masked by column. Basecamp always passes it.
  - **C** — open as a principal with no standing. It drops the sealed kinds and
    `@guarded`, but shows `@personal` and `@opaque`, and an ungated model
    refuses to browse at all.
  - **Recommend B** — a fleet viewer of production rows shows no more than the
    audit trail does. C fails on ungated models, and A leaves `@guarded`
    plaintext even with Q2 = A. A test asserts no protected value in the clear
    on any route.

---

## Out of scope

- Writing to production data from Studio. A governed write path is a different
  paper (`IDEAS/review-prior-art.md` § *A data change that is reviewed before it
  lands*).
- Porting Studio into Mesa (`IDEAS/one-console.md` Phase 4, deferred).
- Studio on a laptop over a pulled replica — the earlier option A, which this
  paper's Phases 2–3 do not need and do not block.
