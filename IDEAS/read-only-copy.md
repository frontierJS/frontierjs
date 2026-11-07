---
id: read-only-copy
status: proposed
dated: 2026-11-04
---

# Read-only copy — an App's own API over yesterday's data, switched on from Basecamp

**Status: PROPOSED.** Dated 2026-11-04. Nothing here is built. Do not cite this
file as describing behavior — see `VERIFYING.md`. "Read-only copy" is a working
name; Q6 settles it. It is not "replica": that word already means the Litestream
object in the bucket, and the copy is restored from it, not kept live beside it.

The want (owner, 2026-11-04): if the server went down and one thing could be
brought up quickly for users to reach their data securely, what is it? The
answer argued here is the App's database, Junction and `@frontierjs/mcp`, with
the user's Claude standing in for the UI layer, read-only, over a copy that may
be a day old.

**Built as a reporting feature first, and only then a lifeboat.** A copy that
runs every day serves reports and Claude without load on production. Using it
each day proves it works, so it is also a restore drill. And when production
dies, switching over is one DNS change rather than a rebuild. A lifeboat that
only runs during an outage has not been proved when it is needed.

**Why this is cheap here.** Access lives in the schema and is enforced at the
Data boundary (Invariant 6). MCP derives its tools from the schema and grades
each one by the caller's gate. So a copy with no UI enforces the same access as
the full App without rewriting any access rules.

---

## What exists

- **Staging a copy is built.** The replica drill stages every database the App's
  Litestream replica lists and runs the App's live release image over the copy
  with `--network none`, so schema and code agree. The detail and line numbers
  are in `basecamp-studio.md` § What exists; this paper reuses that staging
  and runs the API instead of `restore --verify-only`.
- **Studio over the same copy** is `basecamp-studio.md`, for operators. This
  paper is the same copy for the App's users.
- **Litestone opens a single database read-only.** `access: 'readonly'` leaves
  that name's write half null
  ([databases.js:55](../packages/litestone/src/core/databases.js#L55)). Data can
  be read-only while sessions stay writable, provided the two are in different
  `database` blocks.
- **MCP grades by the App's own session** (`sessionGateLevel`,
  [plugin.ts:26](../packages/mcp/src/plugin.ts#L26)). It has no OAuth of its
  own, so how a claude.ai connector signs in is open (0.3). Its read-only mode is
  `agent-surface.md` change 4, also not built.
- **Every Domain is a CNAME to the App's ingress record** `<appId>.<ingress zone>`
  (`FJS-D561`, `ingress-name.md`). Pointing that one record at another machine
  moves every Domain with it. But the record is derived: `edge.service`'s
  `push()` owns it, and `domain-dns.job.ts` re-pushes it from the release's
  machines whenever a release lands or a machine changes state, so a hand-edited
  record is overwritten.
- **The auth models are appended into every tenant's database**
  (`example/db/schema.lite`, line 40). Placing `Session` in a writable block of
  its own is not something the schema does today.
- **A restored copy sending mail is already a known hazard.** `FJS-D665` stamps
  the outbox for restores; a copy that runs no relay at all sidesteps it.
- **An image built or loaded on a machine has no registry** (`FJS-2645`,
  [docker.js:830](../packages/outpost/src/docker.js#L830)). If the App's release
  image lives only on its own box, the copy cannot run on another one.

---

## The switch, as the owner sees it

```
Read-only copy     ● On   as of 03:00 today   on machine: yuma-2
Refresh            nightly ▾
Address            <appId>-copy.<zone>
[ Serve at the main address ]
```

Who gets what from a copy:

| Who | What | Why |
| --- | --- | --- |
| A member | MCP and a read-only viewer at their own gate level | to look things up while production is down |
| The account owner | a full export, recorded in the audit trail | the data is theirs to move; bulk volume is the one thing a gate does not limit |
| Jobs, crons, conduits, the outbox | nothing — refused at boot | a copy re-sending mail from stale state is worse than no copy |

---

### Phase 0 — What has to be true first

Goal: the facts the design rests on, observed rather than assumed.
Done when: each step below has a line under it saying what was observed and how.

- [x] 0.1 Can a release image be pulled from a machine other than the one it runs
      on? Read where a Basecamp release's image comes from, against `FJS-2645`.
      If an image can be built on its own box only, the copy needs a registry
      or an image export into the bucket first.
  - **Observed 2026-11-05: only a registry release can.** A release reaches its
    machine one of three ways, and two leave the bytes on that machine only:
    - **A registry tag** is pulled (`POST /pull`). Portable, given the
      registry's credentials on the copy's machine.
    - **A git push** is built on the target machine (`POST /build`, git source
      only). The bytes exist nowhere else, and a rebuild at `commitSha` on
      another machine is new bytes needing that machine's own deploy key at
      the forge.
    - **A laptop release** (`fli basecamp:deploy`) is `docker save | ssh
      docker load` onto each placement, no registry (`FJS-D942` ruled no
      registry).
  - Outpost's `reference(image, digest)` (docker.js:497) runs `name@digest`
    when the machine does not hold the digest, and Docker then pulls it. Run
    here against a tag no registry holds: *pull access denied for
    fjs-probe-app, repository does not exist*. Today's drill never meets this,
    because it runs only on a machine the App is placed on
    (`app-drills.service.ts`, the `appServer` lookup). A copy on any other
    machine would, for every non-registry release.
  - `builtImage` is the id the *placement's* daemon gave the bytes. A containerd
    image store and the classic store id the same bytes differently (deploy.md
    § the load), so a copy's machine records its own id rather than reusing the
    release's.
  - Consequence: the copy needs the release image off the box before the box is
    lost. That is Q7.
- [x] 0.2 Does `example`'s API boot with its data databases `access: 'readonly'`
      and sign-in still working? The auth models are appended into every
      tenant's database, so first ask whether `Session` can live in a writable
      block of its own at all. Then find what else writes on a read (the audit
      trail, a touch on the session).
  - **Observed 2026-11-05, at the client, on a `VACUUM INTO` snapshot of
    `flagship` in a scratch directory.** The API itself was not booted;
    that is 1.1's drive.
    - **`clientOptions.readOnly: true` reaches every shop's client and holds.**
      Reads answer (4 users, 13 products), `autoMigrate` skips, and both a
      user update and a `session.create` throw *Database 'main' is readonly in
      this client*. So with everything read-only, sign-in cannot work.
    - **Per-name access works inside one shop's file.** A minimal
      `strategy database` schema with `database main` read-only and `database
      sessions` read-write: the `main` write was refused and the `sessions` write
      landed, both in the shop's one file.
    - **A relation cannot cross database blocks**, even when both resolve to the
      same shop file: the parser refuses it by name. Auth's `--db` swap
      (`auth.lite` header, `schema.ts`) moves *every* auth model, `User`
      included, and every app model relating to `User` would then cross. So
      the swap as built cannot be the answer.
    - **`Session` alone can move**: it carries `userId` as a plain column with no
      `@relation`, and nothing in `example` relates to it. That needs auth to
      place `Session` apart from its other models, which it cannot do today.
    - **A read-only name still writes its file on open** (`FJS-4033`): the WAL
      switch runs on a writer opened first. Not a blocker, since a copy is
      staged into a writable directory, but a copy cannot be served off a
      read-only mount until it is fixed.
  - **Follow-up for `FJS-D1920`, same snapshot.** A scratch copy of `example`'s
    schema with `Session` alone moved to `@@db(sessions)` and `database
    sessions` declared, opened with `main` read-only and `sessions` writable:
    - **The existing `Session` table answers under the new name.** 4 rows read,
      and a `session.create` landed in the shop file.
    - **`autoMigrate` on `sessions` planned to drop all 58 other tables** in the
      shared file (`FJS-4034`, S2). The data-loss guard blocked it, nothing was
      applied, and `product`/`user` counts were intact after. It reproduces with
      both blocks writable on a two-model schema, so it is a defect of every
      `strategy database` schema with two SQLite blocks, not of the copy.
    - **Sign-out is refused**: `session.delete` throws *Database 'main' is
      readonly* while `create` and `update` succeed, because every transaction
      begins on `main`'s write handle first (`FJS-4035`). `User` and
      `Credential` updates are refused, as they should be.
    - **The move cannot live in auth's `retargetDb`.** It is a string rewrite
      over fragments assembled in memory, and no app calls it: `example`
      imports `auth.lite` by file (`FJS-626`). The move happens where litestone
      parses the schema. That is Q8.
- [x] 0.3 What auth does a claude.ai custom connector need, and can
      `@frontierjs/mcp` offer it over the App's sessions? Read the connector
      docs with sources.
  - **Read 2026-11-05.** Sources: Anthropic's
    [connector authentication](https://claude.com/docs/connectors/building/authentication)
    (fetched and checked), the MCP authorization spec revision
    [2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).
  - **What a connector needs, for a user to sign in as themselves:** OAuth.
    - An unauthenticated call answers `401` with `WWW-Authenticate: Bearer
      resource_metadata="…"`; a header on a `200` is ignored.
    - Protected-resource metadata (RFC 9728) whose `resource` equals the MCP URL
      exactly, and authorization-server metadata (RFC 8414 or OIDC discovery)
      reachable from Anthropic's egress range `160.79.104.0/21`.
    - Client identity through CIMD (used only when the metadata advertises
      `client_id_metadata_document_supported: true` and `"none"` in
      `token_endpoint_auth_methods_supported`) or else DCR.
    - S256 PKCE on every request, a form-encoded `/token`, 10 s on discovery and
      token, 30 s on refresh.
    - Redirect URIs `https://claude.ai/api/mcp/auth_callback` (web, Desktop,
      mobile, Cowork) and a port-agnostic loopback for Claude Code, for both
      `localhost` and `127.0.0.1`.
    - Refresh tokens for a public client **rotate**: the response that issues a
      new one invalidates the old.
  - **A static key is not a per-user answer.** `static_headers` is beta, for a
    limited set of organizations, entered once by an Owner, and Anthropic's page
    says to treat it as the organization's credential, not a person's.
  - **What exists: none of the OAuth half.** `@frontierjs/mcp` reads `ctx.user`
    off junction's one Bearer door; nothing in `packages/` answers
    `WWW-Authenticate` or `.well-known/oauth-protected-resource` (rg, empty).
    `verifySession` looks the raw token up as a `Session` row (`auth.ts`, the
    hot path), and an API key is a `Credential` row. `oauth.ts` is a client of
    identity providers only; FrontierJS is not an authorization server.
  - **The gap is the live app's, not only the copy's.** A user cannot connect
    claude.ai to the live App's MCP today either. On the copy it is worse: a
    token that is a row minted after the copy was staged does not exist there,
    and rotating a refresh token is a write. That is Q9.
- [x] 0.4 Prior art with sources: platforms that offer a read-only mode during an
      outage, and reporting replicas a user can query directly.
  - Read 2026-11-05; extends `basecamp-studio.md` § Prior art rather than
    repeating it.
  - **[Wikimedia switchover](https://wikitech.wikimedia.org/wiki/Switch_Datacenter)**:
    MediaWiki goes read-only by one config value before the databases move,
    twice a year, minutes long. Readers see nothing, editors a try-later notice.
    A freeze, not a copy, but it is the "rehearse it routinely" shape.
  - **[Discourse read-only mode](https://meta.discourse.org/t/read-only-modes-in-discourse/296976)**:
    switched on from the admin's Backups page or one command. Posting stops,
    signed-in users keep reading, **new sign-ins are refused**. The same session
    problem Q1 answers.
  - **[Heroku followers](https://devcenter.heroku.com/articles/heroku-postgres-follower-databases)**:
    a copy no role can write, seconds behind; `pg:unfollow` promotes it.
  - **[Neon read replicas](https://neon.com/docs/introduction/read-replicas)**:
    read-only compute over the same storage; a write fails with SQLSTATE 25006.
  - **[Supabase read replicas](https://supabase.com/docs/guides/platform/read-replicas)**:
    the REST API answers GET only, and Auth, Storage and Realtime cannot run on a
    replica. Again the session problem, solved there by not solving it.
  - **[GitLab Geo](https://docs.gitlab.com/ee/administration/geo/secondary_proxy/)**,
    the counter-example: a secondary proxies writes to the primary, so with the
    primary down its web UI fails. A copy that depends on production being up is
    not a lifeboat.
  - Not found with a first-party source: Stack Overflow's and GitHub.com's
    read-only modes, so neither is cited.
- [x] 0.5 Certificates at the main address. Caddy issues an ACME certificate per
      hostname and Outpost refuses wildcards, so after the flip each Domain needs
      a certificate issued during the outage. Decide whether that is acceptable
      or whether the copy's machine holds them ahead of time. A proxied Domain's
      `origin_ca` certificate is already stored and pushed by Basecamp
      (`fleet-ingress.md` § The shape), so it can be pushed to the copy's machine
      as well; an `acme` Domain cannot.
  - **Observed 2026-11-06, from yuma's Caddy log** (`journalctl -u caddy-api`,
    `obtaining certificate` to `certificate obtained successfully`): **issuance
    is not the wait. A try made before DNS reaches the machine is.**
    - Once the name resolves to the machine, five issuances took 3.1 s, 3.1 s,
      3.8 s, 8.6 s and 12.9 s by HTTP-01.
    - A try made before the record pointed there failed, and Caddy backed
      off: retries came after 60 s and 120 s, then 30 min, 1 h, 2 h, 3 h and 6 h
      (`my.kobami.com`, 2026-11-04 to 05, which never issued). Each time
      `kobami.app` went live it took 316 s and 348 s from first try to
      certificate, because the route went up before its record did.
    - The flip changes one record. Every Domain is a CNAME to the App's
      ingress name (`edge.service.ts` `push()`), and the ingress A record is
      written at ttl 1, which is Cloudflare's automatic 300 s. Visitors' resolvers
      hold the old address that long whatever the certificate does.
    - **An `acme` Domain can be minted ahead after all.** `push()` refuses a
      Domain no connected zone holds, so every Domain Basecamp publishes is
      in a zone whose token Basecamp has. That is what DNS-01 needs, and
      `providers/acme` already issues by DNS-01 for the wildcard
      (`ingress-cert.job.ts`). Its copy goes to the copy's machine through
      Outpost's `/certs/load`, which takes any id. Q10 ruled B (`FJS-D1988`):
      minted ahead, built as 2.4.

### Phase 1 — Outpost serves a copy

Goal: a machine runs an App's release over its staged replica, read-only, with
nothing outbound.
Done when: a drive stages `example`'s replica onto a second stand-in machine,
serves it, a write over HTTP and over MCP is refused, and no job runs.

- [x] 1.1 Outpost `/replica/serve`: stage the way the drill does, then run the
      release image's API with data databases `access: 'readonly'`. Inbound
      traffic only. Signalled per `FJS-D1996`, in three steps:
  - [x] 1.1a Litestone `readOnlyCopy()`: the one reader of
        `FRONTIER_READ_ONLY_COPY`. `createClient` and `createTenantRegistry`
        call it, and under it every database opens `access: 'readonly'` and
        `placeModels: { Session: 'sessions' }` applies; an explicit option
        wins, and a malformed value refuses. Proved by a test in which a
        `Session` write succeeds and a `User` write throws, with the var set
        and no option passed.
    **Built 2026-11-06**: `src/core/read-only-copy.js` holds `readOnlyCopy()`
    and `copyOptions()`, and a single-database app's sessions go to
    `copy-sessions.db` beside main's file. Proved by `test/place-models.test.ts`
    § FRONTIER_READ_ONLY_COPY with no option passed. The tenant case goes red
    with the registry's placement line disabled.
  - [x] 1.1b Junction answers every request on a copy with
        `x-frontier-read-only: <as-of>`, read through litestone's
        `readOnlyCopy()`. Proved by a junction test.
    **Built 2026-11-06**: the `read-only-copy` start phase reads it once, and
    `HttpTransport._handle` sets the header on every answer, refusals and
    timeouts included. Proved by `test/read-only-copy.test.ts`.
  - [x] 1.1c Outpost `/replica/serve`: stages as `/replica/drill` does, runs
        the image with the var set, on a network that takes inbound traffic
        and has no egress, keeps it running, and refuses to report it served
        until its API answers with the header. Proved by an outpost test.
    **Built 2026-11-06**: `docker.serveCopy`/`unserveCopy` and the routes
    `POST /replica/serve` and `/replica/unserve`. The copy runs on the
    `--internal` network `fjs-copy` (bridge `fjs-copy0`), labeled `fjs.copy`
    and never `fjs.app`, as root over the Outpost's own staged directory. A
    second serve starts beside the first and removes it only once it answers,
    which is the swap 1.3 needs. An answer without the header is refused and
    removed. Proved by `test/outpost.test.js` § /replica/serve (no docker) and
    `test/docker-live.test.js` § read-only copy against the daemon: the host
    dials the copy and gets the header, the copy cannot reach 1.1.1.1,
    `copy-sessions.db` is written beside the data, and an image that ignores
    the var is refused.
- [x] 1.2 Jobs, crons, conduits, push and the outbox relay are refused at
      startup, in the one startup phase list every caller runs (Invariant 4),
      not merely left idle. Hook it on 1.1b's `read-only-copy` phase, kept in a
      closure, and have `start-work` refuse when it is set. The tenant
      registry's own index file is still writable on a copy, so its `create`
      and `delete` need refusing too.
  **Built 2026-11-06**: on a copy `start-work` arms no scheduler and calls no
  plugin's `work()`, so caravan's workers and cron, the outbox relay, orion's
  watch, auth's session cleanup, metrics and otlp all stay off. It logs one
  line naming each withheld plugin. It does not throw: every App with caravan
  would then be unable to run as a copy. The tenant registry refuses `create`,
  `delete`, `meta.set` and `meta.replace` by name, before `create` writes a
  tenant file or `delete` unlinks one. Proved by junction
  `test/read-only-copy.test.ts` § starts no scheduler and litestone
  `test/place-models.test.ts` § the tenant registry refuses. Each goes red with
  its guard disabled.
- [x] 1.3 Refresh re-stages on a schedule and swaps the copy in one step, so a
      reader never sees half of two days. The copy is never fresher than the
      replica, so this schedule only decides how often a copy is staged from it.
      It is not a second backup schedule.
  **Built 2026-11-07**: per Q13 (`FJS-D2001`), Basecamp's `AppCopy` row (one
  per App, `serverId` and `cron` required, `@@gate(5)`) is the copy being on.
  `syncAppCopySchedule` in `job-schedule.ts` puts its cron on the clock,
  `restoreSchedules` re-registers it after a restart, and an App's remove and
  restore take it off and back on. The fire dispatches `app-copy:refresh`
  (`jobs/app-copy-refresh.job.ts`), the one caller of `/replica/serve`: the
  newest successful release's image and runtime (`runtimeFor`, now in
  `runtime.ts` beside `runtimeOf`), the bucket's databases, on the row's
  machine through `executorOn`. The swap is 1.1c's: the old copy is removed
  only once the new one answers. A refresh records Outpost's `as_of`, never
  the clock; a failed one writes `error`, keeps the `asOf` of the copy still
  serving, and sends `AppBackupFailed` with `what: 'copy'`. Proved by
  basecamp `api/test/services.test.ts` § a copy's cron and § a copy refresh.
  Each goes red with the restore loop removed, the deleted-app filter
  dropped, the remove's unschedule dropped, `asOf` cleared on failure, the
  clock stamped, or the runtime left out. **Owed to 2.1:** nothing writes the
  row but a test and the seed, and nothing sends `/replica/unserve`, so a copy
  turned off or an App deleted leaves its container running on the machine.
- [x] 1.4 Serve on any machine that can reach the bucket, not only the App's own.
  **Built 2026-11-07**, per Q7 (`FJS-D1914`). Outpost `POST /image/export`
  `docker save`s the release image, gzipped, and PUTs it to a URL Basecamp
  minted, answering the sha256 of those bytes. After every successful
  release of an App with a replica destination, `deployment-run` dispatches
  `release-image:export` (`domain/release/image-export.ts`). It stores the
  image at `<replica path>/images/<release id>.tar.gz`, records
  `Deployment.imageSha256` (`@system`) and deletes every other image under
  `images/`, since a copy runs only the newest release. A failed export is a
  warning: the release keeps its status and the sha256 stays null. The
  refresh sends `image_url` (a minted GET) and `image_sha256`. `copyImage`
  uses the release digest where the machine holds it, then the cache tag
  `fjs-copy-image:<sha256>`, then the fetched archive. It checks the hash
  before `docker load`, loads over stdin because a snap docker cannot open a
  dotdir path, and tags the result. After a swap it drops the other cache
  tags. Proved by outpost `test/outpost.test.js` § the release image on a
  machine that does not hold it and § /image/export. `test/docker-live.test.js`
  exports a real image, removes it from the daemon, and serves a copy from
  the URL. Basecamp `api/test/services.test.ts` § a release's image in the
  replica bucket and `api/test/rollback.test.ts` § the release's image export
  cover the Basecamp side. Each goes red with its guard removed. Not yet
  proved: a real bucket, and a containerd image store (this daemon is
  classic). A release whose export failed has no image off its box, so a
  copy elsewhere fails in Outpost's words on the `AppCopy` row.
- [x] 1.8 The copy's as-of time is the replica's, not the moment it was
      staged. `/replica/serve` without `at` stamps the staging time today, and
      `stage` reports no time of its own. If the App's machine stopped
      replicating yesterday, the copy claims to be current while serving
      yesterday's data, which is the lifeboat case. Read the newest point the
      restore reached from Litestream and stamp that.
  **Built 2026-11-07**: `stage` reads every database's newest LTX time
  (`ltx -json`, asked always now, not only with `at`) and answers each
  database's `as_of`. That is `at` where `at` was pinned, else its newest
  time. The overall `as_of` is the newest across them, per Q12
  (`FJS-D1999`). `/replica/serve` stamps that and refuses a replica whose
  time cannot be read, before anything runs. Proved by `test/outpost.test.js`
  § /replica/serve: without `at`, two databases 5 Nov and 1 Oct stamp
  5 Nov, an `at` past the newest point stamps the point, and an unreadable
  replica is refused. All three go red with the clock stamp put back. Probed
  on litestream 0.5.17: a database with no writes gets no new LTX file or
  snapshot, so it stays at its last write.
- [x] 1.9 The copy cannot reach the host. `--internal` blocks the internet,
      but the bridge's gateway address still answers. Observed on this laptop:
      sshd on every interface was open from inside a copy. On a box that means
      Outpost's command port and Caddy's 80/443, and through Caddy every App
      on the machine, the live one included. Drop it in the install's firewall
      by `iifname "fjs-copy0"` (`enrollment.ts` `installScript()`), allowing
      established replies only, with a drive that dials the gateway from
      inside a copy.
  **Built 2026-11-06**: `iifname "fjs-copy0" drop` sits after the
  established/related accept in both the input and the forward chain. Proved
  by basecamp `test/compute.test.ts` § the install drops a read-only copy
  dialing the box. In an unprivileged namespace, the install's own ruleset is
  loaded, a veth `fjs-copy0` joins a second namespace standing in for the copy,
  and the copy dials 22, 80, 443 and 8180 on the gateway (all closed) while the
  box dials the copy (open). With the rule removed, all four open. **Owed:** an
  enrolled box gets the rule only when the install runs again, so yuma and kapp
  have none, and posture does not check for it. Until one of those changes, do
  not serve a copy on a box enrolled before this.
- [x] 1.5 `FJS-4035`: a transaction begins only on handles that can write, so
      sign-out works with `main` read-only.
  **Built 2026-11-05**: `FJS-4035` closed, proved by
  `test/second-database-tx.test.ts` § a readonly main does not refuse a
  writable sibling.
- [x] 1.6 `FJS-4034`: under `strategy database`, each database name's migration
      diffs only its own models, so a `sessions` block does not plan to drop
      `main`.
  **Built 2026-11-05**: `FJS-4034` closed, proved by `test/tenancy.test.ts`
  § strategy database — autoMigrate over two sqlite databases in one file.
- [x] 1.7 Move `Session` on the copy per Q8, with a test that opens a copy and
      shows a `Session` create and delete succeed while a `User` update, a
      `Credential` update and a raw write all throw.
  **Built 2026-11-06**: `createClient({ placeModels: { Session: 'sessions' } })`
  copies the parse, moves the named models, declares a missing database and
  runs the validator again. An undeclared database takes its path from
  `databases` or is refused by name; the tenant registry puts it in the
  tenant's file. Proved by litestone `test/place-models.test.ts`: a
  single-database copy writes sessions to a scratch file, a tenant copy reads
  its staged sessions and writes new ones into its own file alone, and the
  refusals are named. The tenant case goes red with the registry line removed.
  The copy's boot passing the option is 1.1's.

### Phase 2 — The switch in Basecamp

Goal: the owner turns a copy on from the App page and reads it.
Done when: the owner turns it on from the screen, and Claude reads yesterday's
numbers through MCP at the copy's address.

- [ ] 2.1 The card above: on or off, refresh schedule, which machine. Gated at
      ADMINISTRATOR, matching `apps.restoreReplica`.
      The card writes `AppCopy` (`FJS-D2001`) through a service that checks
      the cron with `cronProblem` and calls `syncAppCopySchedule`. Turning it
      off, and `apps.remove`, send `/replica/unserve` to the row's machine.
- [ ] 2.2 The copy's address per Q2. Waits on `ingress-name.md` serving a name
      at all.
      The upstream is the copy container's IP on `fjs-copy`, and a restart can
      move it to another App's copy, so the route reads it from the container
      each time and does not keep the address `serve` answered with.
- [ ] 2.3 Posture flags a copy older than its schedule, with a test that feeds
      it a stale copy.
- [ ] 2.4 Each `acme` Domain's certificate is minted ahead (`FJS-D1988`). With the copy
      on, Basecamp mints it by DNS-01 through `providers/acme`, keeps it in a
      `tlsCert` Secret apart from the Domain's `certSecretId`, renews it at
      30 days and pushes it to the copy's machine with `/certs/load`, in the
      shape of `ingress-cert.job.ts`. A proxied Domain's `origin_ca` takes the
      same push. A failed mint fails the job and shows on the card, with a
      test that runs against Pebble.

### Phase 3 — The lifeboat

Goal: with the App's machine down, users reach their data at the App's own
address.
Done when: a drill stops the App's machine, presses the button, and a connection
made before the outage keeps answering with the read-only header and an as-of
time, or asks its person to sign in again once its access token expires. The
drill also records which users had to sign in again, and asserts that each
Domain served the certificate pushed by 2.4, so nothing was issued at the flip.

- [ ] 3.1 "Serve at the main address" is a declared column on the App that
      `domain-dns.job.ts` reads, so the job itself points the ingress record at
      the copy's machine and does not overwrite the flip on its next run. Domains
      are CNAMEs to the record, so no Domain changes.
- [ ] 3.2 Every answer says it is read-only and gives the as-of time: the MCP
      server's instructions, the viewer's banner, and a header on the API that
      the Phase 3 drill asserts.
- [ ] 3.2a Sessions on the lifeboat. The copy's session table is as old as the
      copy and the cookie is host-only, so anyone who signed in after the copy
      was staged signs in again. State that in the banner rather than hide it.
- [ ] 3.3 Switching back points the record home; the copy keeps running as the
      reporting copy.
- [ ] 3.4 The same steps from `fli` on a laptop, for when Basecamp is the thing
      that is down.
- [ ] 3.5 A connection made on the live App keeps answering on the copy until
      its access token expires, because the copy accepts tokens the live App
      signed. A refresh the copy cannot match signs the person in again there,
      into the `sessions` block. Built as `mcp-oauth.md` Phase 6, which waits
      on that paper's Q6.

### Phase 4 — Who gets what

Goal: the table above, built.
Done when: a member's MCP tool list offers no write, a member sees only rows
their gate opens, and only the owner's export runs.

- [ ] 4.1 MCP's read-only mode (`agent-surface.md` change 4), so a copy does not
      offer write tools at all. The read-only database still refuses writes if
      this is wrong.
- [ ] 4.2 A read-only viewer derived from the schema and graded at the caller's
      gate, for members without Claude. Not designed. It is a Mesa target, not a
      new surface (`FJS-D38`), and a Sierra resource's default form may already
      be most of it.
- [ ] 4.3 The owner's export: every row the owner's standing can read, protected
      fields redacted as in the audit trail (Invariant 7), one audit entry per
      export. Who may run it is a gate declared in the schema on the export
      action, not an owner check in a hook (Invariant 6).

---

## Open questions

- ~~**Q1 — Where do sessions live while the data is read-only?**~~ **Answered 2026-11-05 (`FJS-D1920`): A — only on the copy: normal boot is unchanged and `Session` stays in `main`. The read-only boot flag retargets `Session` alone to a writable `sessions` block as the schema is read, and opens every other block `access: 'readonly'`. Under `strategy database` that block is the staged shop file; in a single-database app it is a scratch file beside the copy. Either way it is discarded at refresh.**
  - **A** — only on the copy: normal boot is unchanged and `Session` stays in
    `main`. The read-only boot flag retargets `Session` alone to a writable
    `sessions` block as the schema is read, and opens every other block
    `access: 'readonly'`. Under `strategy database` that block is the staged shop
    file; in a single-database app it is a scratch file beside the copy. Either
    way it is discarded at refresh.
  - **B** — always: `Session` lives in its own block in every app. No change on
    disk under `strategy database`, but a second file to back up and replicate in
    every single-database app, all the time, for a copy that may never run.
  - **C** — a signed token that needs no row, checked against the copy's
    `Credential`.
  - **D** — every auth model in its own writable block, through the `--db` swap
    auth already has.
  - **Recommend A** — 0.2 proved its mechanism: per-name access holds inside one
    shop's file, and `Session` has no relation to break. Auth's `retargetDb`
    already rewrites `@@db(main)` in memory, though for every auth model at once,
    so it needs a one-model form. B pays a cost in every app for one mode. C is a
    second session mechanism for one mode, and a jsonl store (the owner's
    first thought) is append-only, while sign-out deletes. D is refused by the
    parser, because every model relating to `User` would cross databases. Under
    A, `Credential` stays read-only, so a password changed on the copy is refused
    rather than lost at the next refresh. Still to probe: the existing `Session`
    table in a shop file opened under the `sessions` name.
- ~~**Q2 — What is the copy's address?**~~ **Answered 2026-11-06 (`FJS-D1982`): A — `<appId>-copy.<zone>`, one label under the ingress zone like the ingress name.**
  - **A** — `<appId>-copy.<zone>`, one label under the ingress zone like the
    ingress name.
  - **B** — `copy.<appId>.<zone>`.
  - **C** — a path under the App's ingress name.
  - **Recommend A** — same shape as a name `ingress-name.md` already serves, and
    C cannot serve the copy while the App answers that host.
- ~~**Q3 — Which machine serves the copy by default?**~~ **Answered 2026-11-06 (`FJS-D1983`): A — a machine the owner picks, never the App's own unless it is the only one.**
  - **A** — a machine the owner picks, never the App's own unless it is the only
    one.
  - **B** — Basecamp's own box.
  - **Recommend A** — a copy on the App's own machine dies with it, and B puts
    users' traffic on the control plane.
- ~~**Q4 — Who may run the full export?**~~ **Answered 2026-11-06 (`FJS-D1984`): A — the account owner only.**
  - **A** — the account owner only.
  - **B** — anyone at ADMINISTRATOR.
  - **Recommend A** — export is the one action a gate does not bound, so it goes
    to the one person responsible for the data. Declared as a gate in the schema
    (4.3).
- ~~**Q5 — Does the lifeboat switch on by itself?**~~ **Answered 2026-11-06 (`FJS-D1985`): A — a button only.**
  - **A** — a button only.
  - **B** — automatically after the App's health check fails for a set time.
  - **Recommend A** — an automatic flip on a network blip sends every user to
    yesterday's data; B can follow once Phase 3's drill has run.
- ~~**Q6 — What is it called?**~~ **Answered 2026-11-06 (`FJS-D1986`): A — "Read-only copy", plain words.**
  - **A** — "Read-only copy", plain words.
  - **B** — the field's terms: "read replica" for reporting, "warm standby" or
    "pilot light" for disaster recovery.
  - **Recommend A** — "replica" already means the Litestream object, and this is
    a daily restore, not a live standby. If it becomes a column or a noun in
    code, it needs a ruling first.
- ~~**Q7 — How does the release image reach the copy's machine?**~~ **Answered 2026-11-05 (`FJS-D1914`): A — every release also writes its image (`docker save`) into the App's replica bucket, keyed by release, and the copy's machine `docker load`s it from there.** (from 0.1)
  - **A** — every release also writes its image (`docker save`) into the App's
    replica bucket, keyed by release, and the copy's machine `docker load`s it
    from there.
  - **B** — a registry every machine pulls from.
  - **C** — the copy's machine rebuilds from git at `commitSha`.
  - **D** — while a copy is on, each release ships its image to the copy's
    machine too, the way a laptop release ships to each placement.
  - **Recommend A** — the bucket is already the one thing that must survive the
    box, so it adds no new service, and `FJS-D942` ruled out a registry. It
    covers all three release paths and keeps the bytes identical. B adds a
    service and reopens D942. C is new bytes and a deploy key per machine. D
    needs a machine-to-machine path a git build on the box does not have. Cost
    of A: one image per release in the bucket, pruned to the releases a copy
    might run.
- ~~**Q8 — Where does the copy's boot move `Session`?**~~ **Answered 2026-11-05 (`FJS-D1921`): A — a litestone client option, `placeModels: { Session: 'sessions' }` or similar: after the schema is parsed and before it is validated, it declares the named database if the schema has none and moves the named models into it, for this client only, so the parser's refusal of a relation across databases still runs. It is the AST form of what `import … into` already does to text (`retargetDbText`, `parser.js`).** (from 0.2's follow-up)
  - **A** — a litestone client option, `placeModels: { Session: 'sessions' }`
    or similar: after the schema is parsed and before it is validated, it
    declares the named database if the schema has none and moves the named
    models into it, for this client only, so the parser's refusal of a
    relation across databases still runs. It is the AST form of what
    `import … into` already does to text (`retargetDbText`, `parser.js`).
  - **B** — a one-model form of auth's `retargetDb`.
  - **C** — a model-level exception to `readOnly`, so one model stays writable
    in a read-only name.
  - **Recommend A** — it is the only option that works on a schema that
    imports `auth.lite` by file (`FJS-626`), and it leaves the database blocks
    alone. B rewrites source text that no app assembles in memory, and no app
    calls it. C breaks "access is per name" and puts a second access owner
    beside the database block (Invariant 4). `FJS-4034` and `FJS-4035` come
    first (1.5, 1.6).
- ~~**Q9 — How does a user's claude.ai connector sign in to an App's MCP?**~~ **Answered 2026-11-05 (`FJS-D1922`): B, in its own paper.** (from 0.3)
  - **A** — a static API key, entered once in claude.ai's `static_headers`.
  - **B** — an authorization server inside `@frontierjs/auth`:
    protected-resource and server metadata, `/authorize` on the existing cookie
    session and ending at `firstFactorProven()` so MFA still applies, `/token`
    with S256 PKCE, CIMD client identity, rotating refresh tokens. The access
    token is signed with the App's key rather than stored as a row, so a copy
    staged before it was minted still accepts it. The refresh token is a row,
    in the `sessions` block on the copy.
  - **C** — an external identity provider as the authorization server.
  - **Recommend B, in its own paper** — the live App lacks connector sign-in
    too, so this is the MCP's gap and not the copy's. The copy keeps 3.5.
    A is beta, organization-wide and names no user, so a gate cannot grade the
    caller and the audit trail cannot name them; it is a stopgap for a
    single-owner App. C adds a vendor to every App and is a live service the
    lifeboat would depend on. B is the largest build of the three.
- ~~**Q10 — Where do an `acme` Domain's certificates come from after the flip?**~~ **Answered 2026-11-06 (`FJS-D1988`): B — minted ahead: when the copy is turned on, Basecamp mints each `acme` Domain's certificate by DNS-01 through `providers/acme`, keeps it as a `tlsCert` Secret kept apart from the Domain's own `certSecretId` (otherwise `certStatusOf` reports a certificate the live machine does not serve), renews it at 30 days, and pushes it to the copy's machine with `/certs/load`. That is the per-Domain half `ingress-cert.job.ts` left open (`FJS-D1975`). The flip then issues nothing.** (from 0.5)
  - **A** — issued during the outage: the copy's Caddy orders by HTTP-01 once
    the flip has happened. The button flips the record first, then routes, then
    forces the order with `reload()` (`FJS-D1715`), so no try is made early and
    starts the backoff. Nothing new to build. On a good day it takes seconds,
    well inside the 300 s the record takes anyway. A failed order (Let's Encrypt
    down, five failed validations an hour for that host) is a certificate error
    on each Domain that failed, found out during the outage.
  - **B** — minted ahead: when the copy is turned on, Basecamp mints each `acme`
    Domain's certificate by DNS-01 through `providers/acme`, keeps it as a
    `tlsCert` Secret kept apart from the Domain's own `certSecretId` (otherwise
    `certStatusOf` reports a certificate the live machine does not serve),
    renews it at 30 days, and pushes it to the copy's machine with `/certs/load`.
    That is the per-Domain half `ingress-cert.job.ts` left open (`FJS-D1975`).
    The flip then issues nothing.
  - **Recommend B** — Basecamp already owns minting, for the wildcard and for
    `origin_ca`, and B keeps it there. A puts a new mint for every Domain at
    once into the outage. Under B a mint that fails shows up when the copy is
    turned on, as `expiring_soon` or a failed job, long before anyone needs
    the copy. The cost is one extra certificate per Domain every 60 days,
    inside Let's Encrypt's five duplicates a week, and a second machine holding
    the key, which `fleet-ingress.md` D3 already accepted for pushes. If
    `fleet-ingress.md` Phase 3 waits too long, ship Phase 3 here with A and
    upgrade to B.
- ~~**Q11 — How does a release image learn at boot that it is the copy?**~~ **Answered 2026-11-07 (`FJS-D1996`): A — one env var Outpost sets on the copy's container, `FRONTIER_READ_ONLY_COPY=<as-of ISO time>`, read by one exported `readOnlyCopy()` in litestone. Called from inside `createClient` and `createTenantRegistry`, it opens every database `access: 'readonly'` and passes `placeModels: { Session: 'sessions' }`. Junction imports it for 1.2's startup phase and 3.2's header. No App edits anything. An explicit option still wins, and a malformed value refuses boot. Outpost refuses to route a copy whose API does not answer with the read-only header, because an image on an older framework ignores the var and would run writable.** (from 1.1)
  The App opens its own litestone client in app code
  (`example/api/src/core/db.ts`), so nothing today can open its data read-only
  or move `Session` without the App's say. 1.2 needs the same signal in
  junction's startup.
  - **A** — one env var Outpost sets on the copy's container,
    `FRONTIER_READ_ONLY_COPY=<as-of ISO time>`, read by one exported
    `readOnlyCopy()` in litestone. Called from inside `createClient` and
    `createTenantRegistry`, it opens every database `access: 'readonly'` and
    passes `placeModels: { Session: 'sessions' }`. Junction imports it for 1.2's
    startup phase and 3.2's header. No App edits anything. An explicit option
    still wins, and a malformed value refuses boot. Outpost refuses to route a
    copy whose API does not answer with the read-only header, because an image
    on an older framework ignores the var and would run writable.
  - **B** — the App opts in: the scaffolded `db.ts` spreads
    `...readOnlyCopy()` into its options, and `app.ts` hands it to junction.
    Explicit, but every App edits two files, and an App that has not is a copy
    that runs writable.
  - **C** — Outpost alone: mount the staged files read-only and a sessions
    scratch writable, with no framework change. `FJS-4033` (a readonly open
    still writes WAL) makes those opens likely to fail, and it can neither place
    `Session` nor refuse a job.
  - **Recommend A** — Outpost already sets `FRONTIER_TRUST_PROXY=1` on a
    container and junction reads it (`docker.js:1095`, `app.ts:1180`), so this
    is the same shape. One origin, no App edits, and the header check catches the
    one way it fails open. Litestone reads no ambient env today, so the read
    lives in that one function.
- ~~**Q12 — Which time is a copy of several databases as of?**~~ **Answered 2026-11-07 (`FJS-D1999`): A — the newest across the databases. 1.8's case, a machine that stopped replicating yesterday, stops every database at yesterday, and a quiet one does not drag the stamp back. One database whose replication stopped while the rest ran is hidden in the header, though `/replica/serve` answers each database's own `as_of`.** (from 1.8)
  Litestream's `ltx -json` lists one database's LTX files with their commit
  times, and its snapshots with the time they were taken. A database with no
  writes gets neither, so its newest time is its last write even while
  replication is healthy (probed on 0.5.17, a file replica idle 30 s past a
  20 s snapshot interval). Each database's newest time is known; the header
  carries one.
  - **A** — the newest across the databases. 1.8's case, a machine that stopped
    replicating yesterday, stops every database at yesterday, and a quiet one
    does not drag the stamp back. One database whose replication stopped while
    the rest ran is hidden in the header, though `/replica/serve` answers each
    database's own `as_of`.
  - **B** — the oldest database's newest time. Never claims more than every
    database can back, but any quiet database (an audit file, a tenant nobody
    used this month) pulls it back, so a copy mostly reads older than it is.
  - **C** — a heartbeat (MySQL's `pt-heartbeat`, a heartbeat table read beside
    Postgres's last replay time): Outpost writes a tick each minute into a small
    database it replicates per App, and the copy is as of that one. Exact for an
    idle App, at the cost of a new replicated file and a timer on every machine,
    and still blind to one database stopped alone.
  - **Recommend A** — it answers 1.8's case whole and needs nothing new on the
    machine. B is the safe direction in theory and useless with tenants. C is
    the upgrade if an idle App's stamp ever misleads someone.
- ~~**Q13 — Where does Basecamp keep a copy's machine, schedule and last refresh?**~~ **Answered 2026-11-07 (`FJS-D2001`): A — an `AppCopy` row, one per App: its existence is "on", `serverId` and `cron` are required, and the newest refresh's `asOf`, `status` and `error` are `@system` columns on it. PlanetScale's `BackupPolicy` keeps `last_ran_at` on the policy the same way, and Coolify added `last_execution_at` to its schedule row because its run history was awkward to alert from.** (from 1.3)
  The refresh is a Basecamp job calling `/replica/serve`: Outpost cannot run
  the timer, because the replica key rides in the body and the machine holds
  nothing it was not handed. No product refreshes a restored copy on a
  schedule. The nearest is AWS Backup restore testing: a `RestoreTestingPlan`
  (`ScheduleExpression`, `LastExecutionTime`) and a restore job per run
  (`Status`, `RecoveryPointCreationDate`). A copy that serves is its own
  resource everywhere (an RDS read replica is a `DBInstance`; Heroku followers,
  Neon and PlanetScale branches). A schedule is its own row wherever a database
  holds it (Coolify `scheduled_database_backups`, Dokploy `backup` and
  `schedule`), never a column on the app.
  - **A** — an `AppCopy` row, one per App: its existence is "on", `serverId`
    and `cron` are required, and the newest refresh's `asOf`, `status` and
    `error` are `@system` columns on it. PlanetScale's `BackupPolicy` keeps
    `last_ran_at` on the policy the same way, and Coolify added
    `last_execution_at` to its schedule row because its run history was awkward
    to alert from.
  - **B** — A, plus an `AppCopyRefresh` row per run, the shape of Coolify's
    executions, Dokploy's `deployment` and AWS Backup's restore jobs. A
    timeline on the card, at the cost of a table and a retention rule from the
    start (Coolify prunes at 60 days, Dokploy keeps 10).
  - **C** — `copyCron`, `copyServerId`, `copyAsOf`, `copyError` on `App`, as
    `drillCron` is. Only Railway (`cronSchedule` on a service) and Dokku
    (per-service properties) do this, and neither has a control-plane
    database. A cron with no machine is a state it can write.
  - **Recommend A** — the copy is a resource and its machine is a required
    partner of its schedule, which a row holds and two nullable columns do not.
    A refresh replaces the copy rather than adding evidence, so the newest
    `asOf` is all a reader needs; B is the reopen if the card wants a timeline.
