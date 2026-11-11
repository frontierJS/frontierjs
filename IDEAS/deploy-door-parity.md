---
id: deploy-door-parity
status: shipped
dated: 2026-11-05
---

# Deploy door parity — one commit, one release, one install

**Status: SHIPPED.** Dated 2026-11-05; every box closed 2026-11-06. The tree is
the record now (`packages/cli/core/release-build.js`,
`packages/cli/core/deploy-move.js`, `packages/outpost/src/doors.js`); this file
says why. § What exists is the 2026-11-05 reading the plan started from, not
today's behavior.

The want: `fli deploy` through the `deploy` block in `frontier.config.js` (the
SSH door) and `fli deploy` with `BASECAMP_APP_ID` set (the Basecamp door)
deploy the same thing. A team where one person releases through Basecamp and
another over SSH ends up with one app on the box, serving one database.

Today the same commit builds two different releases, and the two doors make
two installs of one app on one box that never see each other.

---

## What exists

Read 2026-11-05 off committed code. `CMD` is `packages/cli/commands/deploy`,
`BC` is `packages/cli/commands/basecamp/deploy.md`, `OP` is
`packages/outpost/src`.

| | SSH door | Basecamp door |
| --- | --- | --- |
| Source | `git archive HEAD`, an uncommitted edit warned and left out (`CMD/_steps-docker/02-ship.md`) | the working tree, tagged `<sha>-dirty` (`FJS-3561`) |
| Dockerfile | `deploy.api.dockerfile ?? 'deploy/Dockerfile'` (`04-build-api.md`) | `chooseDockerfile` (`FJS-D1560`) |
| Vendoring | `vendorApp` always | only when `needsGenerated(dockerfile)` |
| Image tag | `<appId>:<sha7>` | `fjs-<appId>:<sha12>[-dirty]` |
| web/ build | on the box; `VITE_FJS_BUILD` and `FRONTIER_PUBLIC_API_URL` injected (`03-build-web.md`) | on the laptop from its own `.env`, neither injected |
| Runtime env | `<path>/.env.production`, `<path>/secrets` at `/run/secrets` | Basecamp Variables, its own minted `ENCRYPTION_KEY` |
| Database on the host | `<path>/db` | `/var/lib/outpost/apps/<id>/data` (`OP/layout.js`) |
| Container | `<appId>-api`, port 3000, no labels | `fjs--<project>-<env>-<slug>-<id8>`, port from 10000, `fjs.*` labels (`OP/docker.js`) |
| Routes | `fli-<appId>…` in the box's Caddy (`core/edge.js`) | `fjs-<appId>…` in the same Caddy (`OP/ingress.js`) |
| Record | `<path>/.fli/deploy.db` journal | a `Deployment` row |

**Already one owner:** the swap (`FJS-D1840`, `FJS-D1866`, `OP/swap.js`) and
the in-container mount at `/db`.

**What each door sees of the other:** only a hostname collision inside Caddy.
Both route writers refuse a host another `@id` holds, and the SSH door checks
only at `deploy:setup`. Two containers and two databases coexist silently.

**Ranked by what it costs a user:**

1. Two databases. Switching doors serves the other door's data, or an empty one.
2. Two `ENCRYPTION_KEY`s. Encrypted columns stop decrypting, sessions and tokens die.
3. The domain claimed twice, refused only at the second door's route write.
4. Source and Dockerfile drift: one commit, two images.
5. Bundle drift: the API origin and build stamp baked from different places.

---

## The design

**One build.** Both doors take the same inputs from a commit: its tree as
committed, the Dockerfile `chooseDockerfile` picks, `deploy/generated/`
vendored on that Dockerfile's word, and web/ built with the API origin and
the build stamp passed in. One module computes those inputs and both doors
call it. The build still runs where each door runs it (the box or
`deploy.builder` over SSH, the laptop for Basecamp), so the inputs are
identical and the digests need not be.

**One owner per install.** An app on a box is installed by one door. Each
door's preflight reads the box for the other door's install of the same app
(its container and its Caddy routes for the deploy hostname) and refuses,
naming the command that moves the install across: the database files, the
secrets including `ENCRYPTION_KEY`, and the domain.

---

## Open questions

- ~~**Q1 — How far "the same thing" goes.**~~ **Answered 2026-11-06 (`FJS-D1967`): A — One build module both doors call, plus a guard: each door refuses the other's install of the app on the box, and a command moves an install across.**
  - **A** — One build module both doors call, plus a guard: each door refuses
    the other's install of the app on the box, and a command moves an install
    across.
  - **B** — The build module only; the two installs may coexist.
  - **C** — Basecamp is the only release path; the `deploy` block stays for an
    app with no Basecamp.
  - **D** — The SSH door writes Outpost's layout (container name, data dir,
    route ids), so either door updates one install.
  - **Recommend A** — the build is mechanical to share and follows `FJS-D1560`
    and `FJS-D1840`; the data cannot be shared without one door writing the
    other's store of record, so a refusal plus a move is what keeps one
    database.
- ~~**Q2 — What source both doors build.**~~ **Answered 2026-11-06 (`FJS-D1968`): A — `HEAD` as committed, on both doors; an uncommitted edit is warned and left out.**
  - **A** — `HEAD` as committed, on both doors; an uncommitted edit is warned
    and left out.
  - **B** — The working tree, on both doors; an uncommitted build is tagged
    `-dirty`.
  - **Recommend A** — a release is always a commit, so a rollback rebuilds the
    same tree and two people on one commit ship the same inputs.
- ~~**Q3 — What the web/ bundle bakes.**~~ **Answered 2026-11-06 (`FJS-D1969`): A — Both doors pass `FRONTIER_PUBLIC_API_URL` from the target's domain and `VITE_FJS_BUILD` from the commit.**
  - **A** — Both doors pass `FRONTIER_PUBLIC_API_URL` from the target's domain
    and `VITE_FJS_BUILD` from the commit.
  - **B** — Both bake whatever `.env` files the build machine holds.
  - **Recommend A** — the bundle never depends on whose laptop built it, and
    the stale-client check works on both doors.
- ~~**FJS-D1970 — Q4 — What moves an install across, and which way?**~~ **Answered 2026-11-06 (`FJS-D1970`): A, asked when Phase 2 starts.** The SSH
  door keeps its database at `<path>/db` and its env in `.env.production`, and
  the Basecamp door keeps them at `/var/lib/outpost/apps/<id>/data` and in
  Basecamp Variables. FJS-4051 closes only once Phase 2's guard and the move
  exist, and the move's shape is this question.
  - **A** — One command, both directions, named by the door it moves to.
  - **B** — SSH → Basecamp only; an install leaves Basecamp by hand.
  - **Recommend A, asked when Phase 2 starts** — a team may need to leave either
    door, and kapp's live install may sit on either one (0.2); the noun goes
    through `decision-rules` then.
- ~~**Q5 — Which keys the SSH door's env check requires.**~~ **Answered 2026-11-06 (`FJS-D1977`): A — Both doors grade the `defineEnv` spec; `.env.example` is the fallback for an app with no env module, and a spec that does not load warns before it falls back.** `01b-env-check`
  requires every `.env.example` key, and Basecamp's preflight only those the
  `defineEnv` spec marks required, so a move to SSH leaves the first deploy
  refused on an optional key Basecamp never held.
  - **A** — Both doors grade the `defineEnv` spec; `.env.example` is the
    fallback for an app with no env module, and a spec that does not load
    warns before it falls back.
  - **B** — Keep `01b`; `deploy:move --to=ssh` lists the `.env.example` keys
    Basecamp never held.
  - **C** — Read both: the spec's required keys refuse, the rest of
    `.env.example` warns on every deploy.
  - **Recommend A** — one answer to what a release needs, read by
    `readEnvSpec`, the reader Basecamp's check already uses; an optional key
    an app wants enforced goes in `deploy.secrets`.

---

## Plan

### Phase 0 — Groundwork

Goal: the gap is pinned by a test before anything moves.
Done when: a test over one fixture app prints both doors' build inputs side by side, and fails on today's differences.

- [x] 0.1 A contract test: the source tree, Dockerfile, vendoring and web
  env each door would use for one commit of a fixture app.
  - Built as `packages/cli/test/release-build.test.js`, 14 tests over a real
    temp repo against `stageRelease` and `webBuildEnv`, the one module both
    doors call — so it pins the shared inputs rather than diffing two copies.
- [x] 0.2 Read what is live for kapp on yuma (`ls /apps; docker ps`, the
  Caddy route ids) — the owner's ssh — so Phase 2's first real move is known.
  - kapp was Basecamp-only: `/apps` held only `basecamp`, and the one kapp
    container was `fjs--kapp-production-kapp-23da988f`. Its static App
    (`432e884a`) also holds `kobami.app`.

### Phase 1 — One build

Goal: both doors build a commit from the same inputs.
Done when: 0.1's test passes, and a Basecamp release and an SSH release of one commit name the same sha and Dockerfile in their records.

- [x] 1.1 One module for the release's source: the commit's tree as an
  archive, vendored when `needsGenerated` says so. `02-ship` ships it.
  - `packages/cli/core/release-build.js`. `02-ship` also vendors when web/ is
    deployed, since `03-build-web` installs from the generated manifest.
- [x] 1.2 `basecamp:deploy` builds that archive in place of the working tree;
  the `-dirty` tag goes, and the uncommitted-edit warning is the SSH door's.
  - The build context goes to docker over stdin: a snap docker cannot read
    the staged temp directory. Proved by staging `packages/basecamp` at HEAD
    and building its image on this laptop's snap docker.
  - The static App's web/ build runs from the staged tree with the
    checkout's `node_modules` linked in; an app whose dependencies are
    hoisted to a parent repository's root does not resolve there (unproved).
  - The preflight still reads the env spec, health route and databases off
    the working tree, so an uncommitted `defineEnv` edit is graded though it
    does not ship.
- [x] 1.3 The SSH door picks its Dockerfile through `chooseDockerfile`.
  - `02b-build-check` reads the same `$.config.dockerfile` that `04` builds.
- [x] 1.4 One helper for web/'s build env (`VITE_FJS_BUILD`,
  `FRONTIER_PUBLIC_API_URL`); the Basecamp door takes the origin from the
  App's Domain.
  - The Basecamp door passes no origin: under `FJS-D1547` the API answers on
    the static App's own Domain through its routes, as the SSH door does
    with no `deploy.api.domain`.
- [x] 1.5 The Basecamp door's container carries `FJS_BUILD`, so the
  stale-client check runs there too.
  - Set in `startBody` (`basecamp/api/src/jobs/deployment-run.job.ts`), the
    one builder of Outpost's `/deploy` body, after the Variables so a stored
    `FJS_BUILD` cannot name another commit. A git release takes the commit
    `/build` answered; a put-back takes the live release's. Outpost is
    unchanged: it runs the env it is sent.
  - The stamp is the full sha, as the Basecamp door's static App bundle is;
    the SSH door stamps both halves with the short one. Each door agrees with
    itself, which is all the stale-client check compares.
  - Pinned in `basecamp/api/test/rollback.test.ts` § the build the container
    states.

### Phase 2 — One owner per install

Goal: a box holds one install of an app, and moving it between doors keeps its data.
Done when: on a scratch box, a deploy through one door makes the other refuse by name, and the move serves the same rows with the same `ENCRYPTION_KEY`.

- [x] 2.1 One probe reads a box for an app's install: containers by name or
  `fjs.*` label, Caddy routes holding the hostname.
  - `packages/outpost/src/doors.js` (`@frontierjs/outpost/doors`):
    `heldBy(config, door, hosts)` reads the door off a route's `@id` prefix,
    and `doorRefusal` is the one sentence both doors print. Routes only: the
    two installs share no id, so the hostname is the one name a probe can
    match, and a container without a route is not found.
- [x] 2.2 The SSH door's preflight refuses a box where the Basecamp door's
  install holds the hostname.
  - `01-preflight`, after the reach check and before the lock, on every
    machine of the deploy. Before it, `07b-edge`'s `ifPresent` write left a
    Basecamp route alone and the SSH container ran unrouted beside it.
- [x] 2.3 `basecamp:deploy`'s preflight refuses a machine where the SSH
  door's install holds it.
  - In Outpost's `/deploy` instead, before the build, so a push or a screen
    release is refused as the laptop's is; the hostnames, path hosts and
    redirect hosts all count.
- [x] 2.4 The move command, per Q4: database files, secrets and
  `ENCRYPTION_KEY`, the domain.
  - Ruled 2026-11-05: Basecamp lets go of an App moving to SSH by soft-deleting
    it (`apps.remove` stops the container and its routes and keeps the data
    directory), and the move stops before the release, printing the deploy to
    run, since which door `fli deploy` takes is `BASECAMP_APP_ID` in `.env`.
  - The source stops before its files are copied, so the copy is consistent;
    the app is down from the move's first write until that release.
  - Built, not driven: `commands/deploy/move.md` over `core/deploy-move.js`,
    pinned by `test/deploy-move.test.js`. The data streams through the laptop,
    so the two boxes may differ; to Basecamp it lands in Outpost's restore
    directory and `apps.restoreVolume` takes it in. A key named like a secret
    (`SECRET_NAME`, as `env:push` reads it) is written as one, and an App on
    more than one machine is refused.
  - Driven 2026-11-05 on production kapp, there and back: Basecamp → SSH →
    Basecamp, each leg serving the same eight table counts under key
    fingerprint `e92a6727185c`. The drive changed four things:
    - A static App fronting the hostname is soft-deleted with the API App
      (`frontingApps`); a container App fronting it is refused.
    - `PORT` and `FRONTIER_PORT_BE` belong to a door (`DOOR_OWNED`) and are
      never carried across.
    - The size check measures the source again after it stops, since a clean
      SQLite close folds its `-wal` away.
    - To SSH, `deploy:setup` runs after the move: it cannot write routes while
      Basecamp holds the hostname, and the deploy rewrites only routes present.
  - `FJS-4054` closed: the Basecamp door's `fli deploy` releases the API and
    then each static App in front of it (`frontingStatics`), so the move's
    printed `fli deploy` also re-releases a static App back from Trash.
  - The SSH door's env check required every `.env.example` key, so a move to
    SSH left the first deploy refused on keys Basecamp never held. Per Q5
    (`FJS-D1977`) `01b-env-check` and `deploy:doctor` now grade the
    `defineEnv` spec through `requiredEnvKeys`, as Basecamp's `env-required`
    does: kos's 22 `.env.example` keys become the one its spec requires,
    `ENCRYPTION_KEY`, which the move carries.

### Phase 3 — Docs

Goal: a reader of either door learns the other exists and what they share.
Done when: `fli done` is clean.

- [x] 3.1 `deploy/index.md` and `basecamp/deploy.md` say what both doors
  share and that a box has one door per app.
  - Each names the other door's store (`<path>/db` and `.env.production`
    against the App's volume and Variables), the refusal, and
    `fli deploy:move --to=<door>`.

**Done 2026-11-06.** Both command docs name the other door, what the two
share and the refusal. `fli done`'s remaining failures are snapshots of other
sessions' uncommitted basecamp schema and litestone assistant edits.
