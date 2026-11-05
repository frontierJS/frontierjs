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
- [ ] 0.5 Certificates at the main address. Caddy issues an ACME certificate per
      hostname and Outpost refuses wildcards, so after the flip each Domain needs
      a certificate issued during the outage. Decide whether that is acceptable
      or whether the copy's machine holds them ahead of time. A proxied Domain's
      `origin_ca` certificate is already stored and pushed by Basecamp
      (`fleet-ingress.md` § The shape), so it can be pushed to the copy's machine
      as well; an `acme` Domain cannot.

### Phase 1 — Outpost serves a copy

Goal: a machine runs an App's release over its staged replica, read-only, with
nothing outbound.
Done when: a drive stages `example`'s replica onto a second stand-in machine,
serves it, a write over HTTP and over MCP is refused, and no job runs.

- [ ] 1.1 Outpost `/replica/serve`: stage the way the drill does, then run the
      release image's API with data databases `access: 'readonly'`. Inbound
      traffic only.
- [ ] 1.2 Jobs, crons, conduits, push and the outbox relay are refused at
      startup, in the one startup phase list every caller runs (Invariant 4),
      not merely left idle.
- [ ] 1.3 Refresh re-stages on a schedule and swaps the copy in one step, so a
      reader never sees half of two days. The copy is never fresher than the
      replica, so this schedule only decides how often a copy is staged from it.
      It is not a second backup schedule.
- [ ] 1.4 Serve on any machine that can reach the bucket, not only the App's own.
- [ ] 1.5 `FJS-4035`: a transaction begins only on handles that can write, so
      sign-out works with `main` read-only.
- [ ] 1.6 `FJS-4034`: under `strategy database`, each database name's migration
      diffs only its own models, so a `sessions` block does not plan to drop
      `main`.
- [ ] 1.7 Move `Session` on the copy per Q8, with a test that opens a copy and
      shows a `Session` create and delete succeed while a `User` update, a
      `Credential` update and a raw write all throw.

### Phase 2 — The switch in Basecamp

Goal: the owner turns a copy on from the App page and reads it.
Done when: the owner turns it on from the screen, and Claude reads yesterday's
numbers through MCP at the copy's address.

- [ ] 2.1 The card above: on or off, refresh schedule, which machine. Gated at
      ADMINISTRATOR, matching `apps.restoreReplica`.
- [ ] 2.2 The copy's address per Q2. Waits on `ingress-name.md` serving a name
      at all.
- [ ] 2.3 Posture flags a copy older than its schedule, with a test that feeds
      it a stale copy.

### Phase 3 — The lifeboat

Goal: with the App's machine down, users reach their data at the App's own
address.
Done when: a drill stops the App's machine, presses the button, and a connector
set up before the outage keeps answering with the read-only header and an as-of
time. The drill also records which users had to sign in again and how long the
first certificate took.

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
- [ ] 3.5 A connector signed in on the live App keeps answering on the copy:
      the copy accepts access tokens the live App signed, and a refresh rotates
      in the `sessions` block. Waits on Q9's sign-in.

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
- **Q2 — What is the copy's address?**
  - **A** — `<appId>-copy.<zone>`, one label under the ingress zone like the
    ingress name.
  - **B** — `copy.<appId>.<zone>`.
  - **C** — a path under the App's ingress name.
  - **Recommend A** — same shape as a name `ingress-name.md` already serves, and
    C cannot serve the copy while the App answers that host.
- **Q3 — Which machine serves the copy by default?**
  - **A** — a machine the owner picks, never the App's own unless it is the only
    one.
  - **B** — Basecamp's own box.
  - **Recommend A** — a copy on the App's own machine dies with it, and B puts
    users' traffic on the control plane.
- **Q4 — Who may run the full export?**
  - **A** — the account owner only.
  - **B** — anyone at ADMINISTRATOR.
  - **Recommend A** — export is the one action a gate does not bound, so it goes
    to the one person responsible for the data. Declared as a gate in the schema
    (4.3).
- **Q5 — Does the lifeboat switch on by itself?**
  - **A** — a button only.
  - **B** — automatically after the App's health check fails for a set time.
  - **Recommend A** — an automatic flip on a network blip sends every user to
    yesterday's data; B can follow once Phase 3's drill has run.
- **Q6 — What is it called?**
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
