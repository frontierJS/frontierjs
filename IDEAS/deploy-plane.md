---
id: deploy-plane
status: partial
dated: 2026-08-13
---

# Idea — The deploy plane: build once, promote a digest, and how the plane itself arrives

**Status: PARTIAL.** The journal and the content-addressed digest have shipped,
and `@frontierjs/outpost` exists — the build-once-promote-a-digest half below
is still unbuilt. Dated 2026-08-13. Produced by
grading the shipped `fli deploy` pipeline against the twelve-factor build/release/run
split, then following the one failure that is *not* forced by an architectural choice
FJS has already made deliberately.

This does not replace `IDEAS/release-transitions.md`, which asks **what a Release is
and what a deploy may promise**, nor `IDEAS/offline-first-and-release.md`, which asks
**what kinds of artefact a Release can be**. It answers the two questions both leave
open: **who builds the artefact and where it lives**, and **how the thing that
promotes artefacts gets installed in the first place**.

---

## The grading, briefly

Against twelve-factor the shipped pipeline is stronger than most of the field on the
factors that are usually faked and weaker on one that is usually free.

**Genuinely strong.** Dev/prod parity is the best thing in the repo: `bun run ci` is
one node script that runs identically on a laptop and in the workflow, `fli check`
shares its engine with CI's `structure` phase, and `fli deploy:local` runs *the same
Dockerfile and the same entrypoint* a real deploy runs. Config is env vars with
`01b-env-check` diffing the server's file against `.env.example` and aborting before
anything moves — that is better than the factor asks for. Logs go to stdout, JSON
under `NODE_ENV=production`, with the file writer an opt-in adapter. One-off admin
work runs in the deployed image via `fli deploy:run`.

**Deviates on purpose, and says so.** Backing services, stateless processes and
scale-out concurrency all fail, and all three fail for one reason: SQLite on local
disk. The database is a bind mount rather than an attached resource, channels hold
socket state in memory, and the deploy lock is a file on the server. `06-swap`'s own
comment names the trade — *"a brief gap (3-10s)… the correct tradeoff for SQLite"*.
That is a chosen ceiling, not drift, and the rest of this document assumes it stands.

**Deviates by accident.** Build, release and run are not separated, and nothing about
SQLite requires that.

---

## The finding

**Every environment builds its own artefact, so no two environments provably run the
same bytes.** The pipeline pulls source on the target server, runs `bun run build`
there, and runs `docker build` there. Dev, stage and production each execute that
independently. What is promoted between them is a git ref; what actually runs is
whatever three separate builds produced from it.

Four consequences, in rising order of how much they cost:

**The build toolchain must live on every production box.** Bun, the source tree and
a Docker daemon with build access, on the machine serving traffic.

**A build failure happens after the deploy lock is taken.** `01-preflight` acquires
`{serverPath}/.deploy.lock`; the build is steps 03 and 04. A compile error therefore
costs a held lock and an operator who has to know that removing a lock file is safe.

**Rollback restores a container, not a known artefact.** `07-health` renames and
restarts `_replaced`, which is genuinely the right mechanism — but the thing it
restores is *the previous build of possibly-the-same source*, and the image it would
otherwise fall back to is a tag rather than a digest.

**Rolling back the code says nothing about the data, and only one direction of that
is derived.** The pipeline is well wired to replication — `01-preflight` detects
litestream and version-checks it, `05-backup` takes the copy, `06-swap` is built
around the checkpoint the container stop forces, `deploy:doctor` fails on a build too
old to parse STRICT tables — and `litestone replicate` derives one replica per
declared database off the seed. Two gaps sit under that, both filed: `deploy:setup`
installs docker, nginx, git, bun, rsync and sqlite3 and **not litestream**, so every
one of those checks grades a binary the plane never put there (`ISSUES.md`
`FJS-243`); and there is no `litestone restore`, so the way back is one
`litestream restore` per database typed by hand plus a directory copy for the
jsonl/logger ones (`FJS-552`). An operator restoring under pressure is the worst
possible audience for a step nothing derives.

**The image tag is not unique, and Docker will believe it.** `02-pull` sets
`imageTag = ${appId}:${shortSha}` from the SHA of *the target server's own checkout*.
Two servers at the same commit hold two images with the same name and different
bytes; the same server rebuilding after a dependency change produces a third. Nothing
in the pipeline compares them, and the failure mode is the worst available shape —
stage and production reporting the same version while running different code.

That last one was reachable in a sharper form until this session: **the pipeline
never ran `bun install` at all** (fixed, `docs/changes-archive/cli.md`). The API side was
covered by accident because its Dockerfile installs inside the image; web built
against whatever `node_modules` the server was carrying.

**The pipeline's advertised path has also never been run end to end.** Three
separate defects say so, and they were all found by reading rather than by anything
failing: `fli make:deploy` writes a Dockerfile against a layout `fli new` does not
produce (`FJS-232`); it points the health check at `/health` while the scaffold
serves health at `/api/health`, so the pipeline **rolls back a deployment that
worked** (`FJS-238`); and a failed step leaks the deploy lock, because the
`runOnAbort` flag written to prevent exactly that is defeated by a throw
(`FJS-237`). Worth stating plainly here because it is evidence about the whole
seam rather than three bad lines: nothing has ever forced these commands to agree,
and **the cheapest fix for all three is one scaffold-and-deploy test in CI** —
`fli new` into a temp directory, `make:deploy`, then `deploy:local`, which needs no
server. That test is a precondition for the sequence below, not a follow-up to it:
build-once is a change to a pipeline nobody can currently prove works.

**The first half of that test exists as of 2026-08-14.** CI's `scaffold` phase
(`scripts/scaffold-build.mjs`) packs every publishable package, scaffolds an app
against the tarballs, installs and builds it — so `fli new` → install → `bun run
build` is now proven on every run, in ~6s. It caught `FJS-251` on its first
outing, a one-string defect that broke every npm install while 836 sierra tests
stayed green.

**The deploy half landed the same day.** CI's `deploy` phase runs `fli new
--source npm` → `make:deploy` → `deploy:local` and asserts a built image, a
started container, migrations in the entrypoint, and a health answer — ~15s,
full tier, skipped-with-a-name when there is no Docker daemon and a failure
when `FJS_CI_REQUIRE_DOCKER=1` (the workflow sets it). **The advertised path now
runs on every CI run, and it had never run end to end before.**

Reintroducing `FJS-238` — the health path that drops the app's `apiPrefix` —
was caught exactly: image built, container started, migrations ran, health
failed on `/health` while the app served `/api/health`. That is the negative
control for the whole phase.

Building it also cost three more defects in `deploy:local` itself (`FJS-250`):
it inherited the legacy CapRover steps and printed `✓ Deployed to undefined in
NaNs`, every failure path exited 0, and `--port` had never worked. A pipeline
nobody could prove worked turned out to contain a rehearsal command that could
not fail.

**It now runs for both package sources.** It began as an npm-only test, because a
Docker build cannot see a `file:` tarball outside its context — the same wall
`link:` hits — so it proved the *pipeline* containerizes a real app rather than
proving the working tree does. `FJS-241` closed that by packing into the app,
and the phase gained a second run against `--source local`: the working tree,
containerized. The npm half stays, and is now the only thing in the repo testing
the PUBLISHED framework (`FJS-252`).

---

## What to do instead

**Build once, address by digest, promote the digest.** The artefact is produced in
one place, named by content, and every subsequent environment transition references
that name and never rebuilds. `fli deploy` becomes pull-tag → swap → health, which
is most of what steps 05–09 already do.

Three things follow, and only the first is real work.

**A builder needs somewhere to stand.** `fli` is a laptop CLI, so building locally
trades server drift for developer-machine drift, which is worse. The builder has to
be a machine with an identity and a lifecycle — which Basecamp already models:
`ServerRole` has a `build` member.

**Distribution does not have to mean a registry, but identity does.** FJS's bet is
portable and self-hosted — *"No registry required — image lives on the server"* is
written into the scaffolded Dockerfile's own header, and that instinct is right. The
mandatory part is the **digest**; how the bytes travel is a strategy. A registry is
the simplest and adds a dependency; `docker save | ssh docker load` needs no new
infrastructure and works today; a content-addressed store on the Basecamp host is
the middle option and the one that fits the fleet story. Keep all three, make none of
them the definition. **What may not vary is which bytes ran.**

**`deploy:local` becomes exact rather than merely faithful.** Today it proves the
same Dockerfile works. Under build-once it can run *the digest that will be promoted*,
which turns "it passed locally" from an argument into a fact.

**This is the build half of `release-transitions.md` 2.3b.** That row specifies a
content-addressed Release as image ⨯ config values ⨯ secret references ⨯ schema
version ⨯ declared pivot, and assumes the image term is well-defined.

**Shipped 2026-08-29, both halves.** The image term is defined: `01c-journal` is
`04c-journal`, so the transition opens after the artefact exists and the digest
is a term of the id. `deploy.builder` names the machine it is built on —
defaulting to the api target, so an app declaring none is unchanged — and where
that is not the target the bytes are shipped with `docker save | docker load`,
which preserves the image ID. No registry, which is the strategy this section
already argued for.

What is NOT closed by it: under build-on-target the digest is an image ID, true
on one host and meaningless on another, so *one artefact, many environments* is
sayable only for an app that declares a builder. And the shipping path is proven
at the argv level plus the property it rests on (a save/load round trip preserves
the id, executed) — not end to end, because that needs two machines and the CI
cycle has one.

**What running it found** is the sharpest evidence this row ever had. An
unchanged redeploy kept minting a new Release, which under the new ordering means
the bytes really moved: the container writes `db/app.db-wal` into the mounted
volume, the volume is inside the build context, and the scaffold's
`.dockerignore` said `db/*.db` — which never matched a sidecar. Every deploy
after the first copied the running app's write-ahead log into the image. The
check that exists to catch it was blind for the same class of reason its own
subject is: two lists for one fact (`FJS-555`).
Basecamp's `Deployment` model is further along than the CLI here — it already carries
`builtImage` separately from `fromImage`/`toImage`, which is exactly the distinction
between *what was produced* and *what is being promoted*.

---

## The bootstrap ring

**Basecamp is FJS's Coolify — and a control plane that installs applications cannot
install itself.** The schema has already committed to the harder half of this:
`Server` carries `outpostVersion`, `outpostUrl`, `lastHeartbeatAt` and `registerMethod`,
and `ServerStatus` runs `pending → provisioning → installing → ready` before it ever
reaches `online`. Those are not fields an SSH-push design needs.

**Basecamp's half is already written; the machine's half is not.** `fleet.engine.ts`
resolves an Outpost per server and dispatches through Conduit to `outpost:<server-id>`,
registered on heartbeat, with a stated fallback when none is; `deployment.engine.ts`
forwards each step the same way; `servers.service.ts` accepts the heartbeat and
registers the Conduit target. So the protocol has a caller and no callee — which makes
ring 1 smaller than it looks, and makes the naming urgent rather than cosmetic, since
`outpost:<id>` and the snake_case heartbeat payload are wire contracts nothing speaks
yet (`FJS-D29`).

The two are one question, and separating the rings answers both.

**Ring 0 — `fli deploy` installs Basecamp.** The SSH + Docker + nginx pipeline that
exists today is precisely the right size for exactly one job: put one FJS application
on one Linux box, from a laptop, with no control plane in existence yet. That
resolves what otherwise reads as a rivalry between `fli deploy` and Basecamp. **`fli
deploy` is not a competitor to the fleet tool; it is the fleet tool's installer**, and
it should be scoped and judged by that job — which is also why it does not need to
grow multi-node, blue-green or a scheduler.

**Ring 1 — Basecamp installs the Outpost.** Driving `pending → provisioning →
installing` and writing `ServerEvent` rows as it goes. ~~One-shot over SSH,
authenticated with a `Secret` of kind `ssh_key` (already modeled)~~ — **struck by
[`FJS-D241`](../DECISIONS.md#fjs-d241)**: a machine Basecamp provisioned is
installed by cloud-init and never reached over SSH, and an imported one by a
command an operator pastes. The ring is unchanged; only how it reaches a machine
is. `ssh_key` keeps its meaning as a person's recovery path. (`ready` was deleted
from `ServerStatus` on 2026-09-07 — see [FJS-1021](../ISSUES_ARCHIVE.md#fjs-1021).)

**Ring 2 — the Outpost deploys applications.** `Deployment` and `DeploymentStep` are
the record; the Outpost is the executor. This is where build-once pays: the Outpost pulls
a digest rather than a source tree, and needs no build toolchain at all.

**The plane never upgrades itself through ring 2.** A control plane that deploys its
own replacement has to survive its own restart mid-transition, and the honest answer
is that it cannot — the process holding the journal is the process being replaced.
Basecamp's own upgrade goes through ring 0. One installer, used twice, and the plane
never holds the knife to its own throat.

### Ring 0 is a distribution problem, and it is the one place an image earns its keep

Asked directly (2026-08-14): *should FrontierJS publish a dedicated Docker image?*
For the framework, no — the runtime image a scaffolded app builds is
`oven/bun:1-slim` and it lacks nothing that causes a problem. The things a
"FrontierJS base image" would obviously carry turn out not to belong in it:
**litestream runs on the host**, beside the container, watching the bind-mounted
database (`--volume {dbPath}:/db`, and every check greps the host's process
table) — so baking it in would be wrong rather than merely unnecessary. What
remains is a maintenance burden: an image republished on every bun release and
every CVE, where a stale one is strictly worse than upstream's.

**Ring 0 is the exception, because it is not a build question.** Every other
ring produces an artefact from a user's source. Ring 0 installs *our own
product* on a machine that has nothing, and today that means the fresh box needs
bun, the Basecamp source tree and a Docker build before a control plane exists
to manage it. An installer whose job is "get the plane onto a bare server"
should be a pull and a run.

This is a different question from `FJS-D31`, which refused to republish
**someone else's** binary. Basecamp is ours; publishing it is shipping a
product, and the maintenance is justified by the thing users actually install.
It also does not weaken *"no registry required — image lives on the server"*,
which is a promise about **a user's app**, not about how the control plane
arrives.

**Ring 0 and build-once want the same missing capability.** `fli deploy` knows
exactly one mode — pull source, build on the target. Build-once needs
pull-a-digest-and-run; so does installing Basecamp from an image. Whatever adds
that mode serves both, which is an argument for doing it once and deliberately
rather than twice by accident.

What ring 0 then needs, none of it decided:

- **Where the image lives** and how it is addressed. The digest is the mandatory
  part (same rule as §What to do instead); the registry is a strategy.
- **First-run seeding** — the initial admin, `ENCRYPTION_KEY`, and where the
  control plane's own SQLite database persists across an upgrade. It is a bind
  mount for exactly the reasons the rest of this document assumes SQLite.
- **Upgrade stays ring 0.** Pull a new digest, swap, health — the same installer,
  never ring 2, for the reason stated below.
- **What the image must not assume**: no litestream inside it, and no registry
  requirement pushed down onto the apps Basecamp goes on to deploy.

**On resident-process versus SSH-push, follow the seed, but let it degrade.** The
schema has chosen a resident process. The failure mode to design against is a fleet
bricked by an Outpost that will not start, so **the absence of a heartbeat must
degrade a server to SSH-managed rather than to unmanageable** — which ring 1 already
requires the code for. `registerMethod` is the field that records which way a given
server arrived.

---

## What FJS has here that Coolify and Forge structurally cannot

A generic fleet tool sees an opaque image and a shell script. Basecamp holds the
`.lite` schema of every application it deploys, which makes two things available for
free that the field cannot offer at any price:

**A deploy can be classified before it runs.** `release-transitions.md` 2.3a reads a
schema diff and answers expand / contract / unknown. Wired into ring 2 that is a
`Deployment` that *knows whether it is reversible* — the exact question every surveyed
rollback button guesses at.

**A fleet action already has the right cardinality.** `RecipeRun` is one row per
server rather than per invocation, with the comment explaining why: a single row for
"three succeeded and two failed" has to pick one status, and that is the answer an
operator most needs. Agent installation across a fleet is the same shape and can
reuse it rather than inventing a second one.

---

## Ring 2 as built, held against ring 0

Probed 2026-10-05. Ring 2 exists ahead of **b**: Basecamp's `deployment-run.job.ts`
sends `/pull` → `/deploy` → `/health-check` to an Outpost (`verify:outpost` drives
it against a real daemon), with `Deployment`/`DeploymentStep` as the record and
`rollback` creating a new release from the target's snapshot. It does not have what
makes `fli deploy` safe around **data**, and that matters more than the build
question. `frontier-cloud.md` step 7 moves client apps off `fli deploy`, so each of
these protections has to exist in the fleet before that move.

| Safeguard | `fli deploy` (ring 0) | Fleet (ring 2) |
| --- | --- | --- |
| A copy before the swap | `05-backup`: `litestone backup` inside the OLD container, every declared database plus the logger directories, the last five kept | **None.** The new container's entrypoint migrates the data volume forward with nothing taken first |
| The way back when the start fails | `swapContainer` renames the old one to `_replaced`, and `healthOrRestore` starts it again | **The same** (`FJS-1765`). `/deploy` renames the live container `_replaced` and stops it, waits for the new one to be healthy, and puts the old one back (and its route) when it is not |
| A rollback across a migration | `deploy:revert` refuses past the pivot (`litestone release`), with `--past-pivot` as the override | **Unchecked.** `Deployment` records no schema hash or pivot, so `rollback` puts old code on a migrated volume |
| A step that did nothing | Every step does its work or throws | **Validate only.** It is a command-less `/exec` that Outpost acknowledges as *needs no work*; a `database` app now runs the container steps (`FJS-1764`, closed) |
| Continuous copies and restore | Litestream on the host, checked by `deploy:status`; `litestone restore [--verify]` | **None** for an app's `fjs-<app>-data` volume. Owed in `frontier-cloud.md` step 5 |

**Basecamp's own backups belong in this table too.** `backup:run` copies `main` with
`VACUUM INTO` and leaves out the `audit` database and `-jobs.db` (`FJS-1766`). It
runs only when someone clicks: `BackupKind.scheduled` has nothing behind it. It
writes to the disk the live database sits on, never prunes, and has no restore.
Ring 0's upgrade of Basecamp is covered by `05-backup` today, so this gap shows up
between upgrades.

**What carries over and what does not.** The open question below (can the Outpost
reuse `_steps-docker`?) now has an answer: it cannot, because the Outpost is plain
Bun and depends on no framework package. So each safeguard comes across as a route
whose argv the Outpost owns, the way `/pull` and `/deploy` already work:

- **The pre-swap copy** is `fli`'s command, `docker exec fjs-<app> … litestone
  backup`, run by a step before `Start container`. It only works for an app that
  carries a schema. For an image that does not (PostgreSQL, Redis), the step must
  write *no copy taken* into its output rather than go green.
- **The put-back** is a rename instead of `rm -f`, followed by a restart of
  `fjs-<app>-replaced` when the run or the health check fails. Stopping first and
  then starting stays the order, for the SQLite reason `06-swap` gives.
- **The pivot** comes from the build and is recorded on `Deployment` (`FJS-D599`).

---

## Sequence

| | | Effort | Note |
| --- | --- | --- | --- |
| **a** | **Digest, not tag** — build stamps a digest, `Deployment.builtImage` records it, `deploy:status` shows it, health and rollback address it | S | No new infrastructure; makes the current pipeline honest about what ran |
| **b** | **Move the build off the target** — build on a `build`-role server or in CI, ship by `docker save`/registry/CAS, deploy becomes pull → swap → health | M | Requires **a**; retires the toolchain-on-prod requirement and the lock-held-during-build window |
| **c** | **Ring 1 — Outpost install over SSH** — `pending → installing → ready`, `ServerEvent` trail, `RecipeRun` cardinality, SSH retained as the degrade path | M | Answers VISION's resident-process question by implementing what the schema already declares |
| **d** | **Ring 2 — Outpost-driven `Deployment`** — the Outpost pulls a digest and runs the swap; the pivot classifier (2.3a) grades it first | L | Requires **b** and **c**. Partly built ahead of both, and it owes the five safeguards in § Ring 2 as built |

**a** is worth doing whether or not the rest happens, which is the test this file
was written to apply.

---

## Open questions

- ~~**Where the artefact store lives when there is no registry.**~~ **Answered 2026-10-09 (`FJS-D814`): A — Nowhere: the builder ships the bytes with `docker save | docker load`, as `deploy.builder` does today, and each target's own image store is the store.** On the Basecamp host
  is the obvious answer and makes Basecamp a single point of failure for deploys —
  acceptable for a control plane, but it should be stated rather than discovered.
  - **A** — Nowhere: the builder ships the bytes with `docker save | docker load`,
    as `deploy.builder` does today, and each target's own image store is the store.
  - **B** — A content-addressed store on the Basecamp host that every Outpost pulls
    from by digest, with Basecamp stated as the single point of failure for deploys.
  - **C** — A registry: a `registry:2` container on the Basecamp host when the user
    has none, mirrored by `RegistryImage` and pulled by the Outpost's `/pull`.
  - **Recommend A** — then C once a fleet deploy needs one artefact on many machines.
    A ships and needs no new infrastructure. B is a registry under another name, so
    when a store is owed, the existing one (`registry:2`) is the cheaper concept and
    the Outpost's `/pull` already speaks it.
- **Whether `fli deploy` grows a pull-a-digest mode, and whether that is the same
  mode ring 0 uses to install Basecamp from an image.** It knows one mode today —
  build on the target — and both build-once and ring 0 want the other one. Doing it
  once is the whole argument; doing it twice is what happens if nobody asks.
  - **A** — One mode: `fli deploy --image <digest>` replaces `02-pull` and the two
    build steps with a fetch of that digest, then runs `04c-journal` onward unchanged,
    and ring 0 installs Basecamp through the same flag.
  - **B** — Two: build-once stays `deploy.builder`, and ring 0 gets its own
    `fli basecamp:install` that pulls a published image.
  - **C** — Neither: ring 0 keeps building Basecamp from source on the target.
  - **Recommend A** — `deploy.builder` already proved that everything after the build
    is addressed by digest, so the mode is one step swapped for a fetch. B is the
    *twice* this question exists to prevent, and C keeps bun and a source tree on
    the box a control plane is meant to arrive on.
- **What ring 0 does about the Basecamp database.** `fli deploy`'s SQLite swap window
  is the control plane's own downtime, and it is the one application where somebody
  is likely watching a deploy through the thing being deployed.
  - **A** — Accept the window: `05-backup`, stop, start, health, as for any app.
    Basecamp is down for seconds and the fleet's heartbeats miss for that long.
  - **B** — Declare the window: ring 0 runs the upgrade inside `fli deploy:pause`,
    so the edge answers a stated pause and Caravan stops the queues (`FJS-D262`),
    then unpauses after health.
  - **C** — A zero-downtime swap for Basecamp alone, starting the new container
    beside the old one on the same database.
  - **Recommend B** — the pieces exist, and it turns the control plane's downtime
    from something an operator discovers mid-click into something the edge says.
    C runs two writers on one SQLite file, which is the reason `06-swap` stops
    before it starts.
- ~~**Whether the Outpost is an FJS application.**~~ **Answered 2026-10-09 (`FJS-D722`): A — Not an FJS application: plain Bun ESM with `@frontierjs/toolbelt` as its one dependency, no schema and no ORM.** If it is, it inherits the whole stack
  on every fleet server, which is heavy for something whose job is to run Docker
  commands and report health. If it is not, it is the first thing in the repo that
  does not derive from a seed.
  - **A** — Not an FJS application: plain Bun ESM with `@frontierjs/toolbelt` as its
    one dependency, no schema and no ORM.
  - **B** — An FJS application with a schema of its own, so its routes are services
    and its state is Litestone rows.
  - **C** — Junction without Litestone: services and the hook pipeline, no seed.
  - **Recommend A** — A is what ships in `packages/outpost`, and its README states
    why: a schema, a migration runner and an ORM on every fleet server, to run argv
    arrays. Its state is Basecamp's rows, so the seed it would derive from is
    Basecamp's, and it already does.
- **Whether a build-role server is a `Server` row.** Modeling it as one is free and
  makes the builder visible in the fleet; it also means Basecamp's build capacity is
  fleet state, with everything that implies for the tenancy work.
  - **A** — Yes: a `Server` with `role: build`, enrolled, heartbeating and graded like
    any other, belonging to one workspace.
  - **B** — No: a builder is `deploy.builder` in the app's config, a host `fli`
    reaches and the fleet never sees.
  - **C** — No builder machine at all: the image is built in CI and arrives by digest.
  - **Recommend A** — `ServerRole` already has the `build` member, so the schema has
    chosen. A builder is the machine whose drift decides which bytes ship, so it
    belongs where posture and heartbeats are graded. Workspace-scoped is the same
    tenancy every other `Server` already has.
- **How ring 0 and ring 2 stay one implementation.** Two deployers is how a framework
  ends up shipping two behaviors — the same argument `core/checks.js` settled for
  architecture rules. Whether the Outpost can literally reuse `_steps-docker` is the
  question to answer before writing a second one. **It cannot** (§ Ring 2 as built):
  the safeguards are restated as Outpost routes. The backup and the pivot keep one
  owner each, litestone. The swap and put-back become two implementations, and
  **nothing holds them together yet**. The candidate is one test that drives
  `swapContainer` and `/deploy` against the same recorded docker and compares what
  each did after a failed run and a failed health check.
  - **A** — Two implementations and one conformance test: `swapContainer` and the
    Outpost's `/deploy` driven against the same recorded docker, compared after a
    failed start and a failed health check.
  - **B** — One implementation: ring 0 installs an Outpost first and deploys through
    its `/deploy` route.
  - **C** — One plan: the swap and put-back become a pure argv sequence in
    `@frontierjs/toolbelt`, run by `fli` over ssh and by the Outpost locally.
  - **Recommend A** — then C if the test catches a drift. The two runners differ
    (ssh against a local spawn), so a shared plan saves less than it looks, and the
    test is the artefact that makes a drift visible. B makes ring 0 depend on a
    process that needs `BASECAMP_URL`, before Basecamp exists.
- ~~**Where does a fleet release get its pivot verdict?**~~ **Answered 2026-10-06 (`FJS-D599`): A — The build computes it, and the release records it on `Deployment` alongside `builtImage`.** Basecamp sees an image and no
  source, so it cannot run `litestone release` itself.
  - **A** — The build computes it, and the release records it on `Deployment`
    alongside `builtImage`.
  - **B** — The Outpost runs `litestone release` inside the new image before the swap.
  - **C** — No verdict: every fleet rollback asks for a typed confirmation.
  - **Recommend A** — it is where `mintRelease` already computes it for ring 0, so
    there is one place that knows. B boots the image to read a fact the build already
    had. With C, an operator mid-incident confirms the prompt every time. An image
    whose build reported nothing is `unknown`, which counts as a contract, as in
    ring 0.

---

## See also

- `IDEAS/release-transitions.md` — what a Release is, the pivot, and reversibility
- `IDEAS/offline-first-and-release.md` — which artefact kinds a Release may be
- `IDEAS/operational-edge.md` — the wider operational gap this sits inside
- `packages/basecamp/docs/VISION.md` § Open Questions — the two this proposes to close
- `FJS-232` — the scaffolded Dockerfile does not match the scaffold
