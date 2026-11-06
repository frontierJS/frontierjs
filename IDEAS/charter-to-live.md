---
id: charter-to-live
status: proposed
dated: 2026-11-04
---

# Idea — charter to live: one charter carried to a deployed app someone logs into

**Status: PROPOSED. Q1, Q2, Q4 ruled `FJS-D1891`–`FJS-D1893`; nothing in this paper is built; every stage it chains is.** Probed against
the tree and `fjs-prototypes/charter` 2026-11-04, and run through `decision-rules` the same day.
Do not cite this file as behavior — see `VERIFYING.md`.

**The ask** (owner, 2026-11-04): automate the whole process for many cases. A charter becomes
an app, the app gets a feature, the app deploys to a designated Basecamp, and someone logs in
and uses it. **Built and proved in Charter first; Workbench takes it over as Phase 2.** The
designated Basecamp is the one locked-down piece: it is made once, and a run never buys,
reinstalls or replaces it. Reinstalling it or making a new one is a manual toggle.

**What must stay true:** a run touches only Apps in its own workspace and leaves the box as it
found it, apart from an App the run was set to keep (`FJS-D1893`). 1.5 checks that on every run.

**"Designated" is not `workbench-basecamps.md`'s *default*.** The default is the Basecamp fli
aims at when no flag is given, which is yuma, and that box serves real apps. The designated
Basecamp is the one `basecamps.json` entry marked for runs (Q1), so a run never reaches the
default by omission.

---

## What exists (probed 2026-11-04)

Each stage runs today, separately, and **no run has ever gone past a local copy.**

| Stage | What runs it | Where it stops |
| --- | --- | --- |
| Charter | `charter.json` (`builder/charter-file.ts`), which the `/new/` wizard downloads from Review and refuses whole when any part is not offered | — |
| Generate | `bun cli/charter.ts <charter.json> --condition oracle`: the corpus run over a one-prompt file, writing `runs/<date>-<condition>-bp-<name>.json` and `apps/charter/<condition>/` | a settled app on disk |
| Feature | `builder/behave.ts`: an ask from `corpus/behaviors.json`, then the writer, the migration and the drives | only the frozen corpus asks, not an ask chosen per charter |
| Use | `corpus/flows.json` (each app's main model, its parent chain and one move), `builder/access-drive.ts`, `builder/stranger-drive.ts` | a local port |
| Host | `builder/host.ts`: every corpus app at once on 17100+, owner login included (Phase 6) | the laptop |
| Deploy | `fli basecamp:app` (project, environment, App, `BASECAMP_APP_ID`), then `fli basecamp:deploy` (image built here, digest released) | never run on a Charter app |
| The box | `fli basecamp:create` / `basecamp:install` make one; `fli basecamp:reinstall` is `confirm: human` | — |
| Access | Basecamp's `WorkspaceRole`: `viewer` `billing` `developer` `admin` `owner` | which role can manage Apps but not servers is unprobed (0.2) |
| Record | Charter's `Run` model (`name` = the script, `record` = the JSON path, `@@gate(5.8.8.8)`) | — |

**The known risk:** a generated app depends on `link:@frontierjs/*` (for example
`apps/oracle/01-calendly/package.json`), and `zero-to-live.md` 4.2 names building off the
laptop as unbuilt once an app uses `link:`. `basecamp:deploy` builds on the laptop, so it
may work. 0.4 finds out.

**A second risk, read off `basecamp:deploy` 2026-11-04:** the image reaches each machine by
`docker save | ssh <machine> docker load`, and the deploy user's ssh is not graded by any
Basecamp key. So a run holds two credentials: the scoped key (Q5) and ssh to the box as the
deploy user, and the second is what actually bounds a run on the box. 0.4 writes down which
user that is and what it can do once there.

## The target

```
bun builder/live.ts corpus/live/03-saas-invite.json
  charter   checked                                   0.1s
  generate  oracle, settled in 2 turns          $0.31  84s
  feature   "a crew member marks a job done"    $0.40  95s
  deploy    App 03-saas-invite-1104 on <designated>    41s
  use       owner login, Booking cancel, gate ladder    12s
  clean     App removed, box diff empty              6s    (--keep: App left, diff = that App)
→ runs/2026-11-04-live-03-saas-invite.json
```

**A run holds a key that can manage Apps in its own workspace and nothing else**, so the limit
is Basecamp's access rather than the runner's good behavior (Invariant 6). Making, reinstalling
and retiring the box stay with a person: from a terminal in Phase 1, and behind a button in
Phase 2 that is separate from every run.

---

## Plan

### Phase 0 — One case by hand

Goal: the list of every step a person did, which is what Phase 1 automates.
Done when: one corpus charter is generated, deployed to the designated Basecamp, logged into
and removed, with each hand step and each failure written under its step.

- [x] 0.1 Designate the box (Q1). If it is a new box, make it once with `fli basecamp:create` +
  `basecamp:install`. By hand, as today's `basecamp:*` commands do, it is reached through
  `BASECAMP_URL` and `BASECAMP_API_KEY`.
  **Named 2026-11-04, not bought:** the owner chose `chartered.maverickmade.tech` at
  DigitalOcean, 4gb, with `maverickmade.tech` as the run workspace's ingress zone (Q3 = B,
  `FJS-D1899`). `maverickmade.tech` is at Cloudflare (`charles`/`reza` nameservers) but the
  stored `CLOUDFLARE_TOKEN` opens no zone of that name, and `basecamp:create` refuses before
  buying when the token holds no zone for the hostname. Waits on a token for that account,
  passed to the one run as `CLOUDFLARE_TOKEN=… fli basecamp:create --cloud digitalocean
  --size 4gb --name chartered --domain chartered.maverickmade.tech --admin <ME>`. Then the
  workspace's ingress pair is set to that zone, and `ingress-name.md` 0.1 is probed on this
  box rather than on yuma, whose workspace has no ingress pair and whose one Domain is live.
  **Made 2026-11-05** by the owner (DigitalOcean, Outpost enrolled, hostname behind
  Cloudflare's proxy). In `basecamps.json`, `chartered` is `runs: true` and its `apiKey` is the
  run key (1.0): holder the owner, scopes `apps`, `domains`, `deployments`, `projects`,
  `environments`, `domainRoutes`, `variables` read+write (`FJS-D1951`) and `servers:read`,
  named `charter-run-D1951`; probed `GET /apps`, `/domainRoutes`, `/variables` answer and
  `POST /servers` and `/apiKeys` are 403. The first run key, without the two D1951 added, is
  still to revoke on the API keys screen. The admin key is a second entry, `chartered-admin`, on the
  same box, because `basecamp:app`/`basecamp:deploy` reach an entry through `reachBasecamp`,
  which reads only `apiKey`. `basecamp:key --server chartered` files over `chartered`'s
  `apiKey`, so a new admin key takes `--basecamp chartered-admin`. Workspace `chartered`'s
  ingress pair is the Cloudflare account Basecamp holds and `maverickmade.tech`; that token
  opens all eight zones of the account, not one.
- [x] 0.2 Probe the roles (Q2). On the designated Basecamp, make a workspace for runs and a
  member at each `WorkspaceRole` below `admin`. Record which role can create, release and remove
  an App and its Domain, and which is refused servers and the hub.
  **Probed 2026-11-04** against the real API on a temp db, not the box, since gates are the
  schema's and not the box's. **No role fits** (`FJS-4024`): `developer` creates and updates
  an App and a Deployment but cannot delete an App (`@@gate(2.4.4.5)`) or write a Domain
  (`@@gate(2.5)`), and holds Server create, update and `reboot` by default
  (`core/capabilities.ts` `ROLE_GRANTS`); `admin` manages both and Servers too; `viewer` and
  `billing` manage nothing. The hub is refused to every role below system admin. **What fits
  with no change:** an API key minted by an admin with the scopes `apps:*`, `domains:*`,
  `deployments:*` (and `projects:*`, `environments:*`, `servers:read` for `basecamp:app`'s
  placement — the release path was not exercised, since a Deployment needs a live Outpost) is
  refused `/servers` writes and the hub by scope at the call (`domain/api-key/scopes.ts`). Q5
  asks which.
- [x] 0.3 Generate one preset charter with `cli/charter.ts --condition oracle`.
  **First run 2026-11-04** on `corpus/live/01-saas-signup.json` (the Calendly preset):
  `runs/2026-11-04-oracle-bp-01-saas-signup.json`, **not settled** in 8 turns, $1.77 and 9m56s —
  not the $0.31 and 84s the target above guessed; 91% of the spend was fix turns. From turn 4
  the only `fli check` finding was `migration-history`: the scaffold writes the initial
  migration once and the turn loop never runs `fli db:migrate` after the model rewrites the
  schema, so the finding cannot clear. An instrument gap in `builder/run.ts`, not a model
  fault; fixed and rerun the same day (see the second note). The generated `package.json`
  depends on `link:@frontierjs/*` throughout, as the risk above says.
  **Second note, same day:** `builder/run.ts` now resets the sandbox history each turn
  (`db/migrations/` and the three sandbox databases removed, then `fli db:migrate`), because a
  migration applied per turn turns a later dropped column into a DESTRUCTIVE migration nobody
  accepts, and the app grades green while unable to boot. A migrate that still fails is fed
  back as a `db:migrate` finding. Third run: **settled and green at turn 6, booted (M5)**, $1.48,
  522 s; one fresh migration per database. **Budget a run at about $1.50 and 9 minutes for the
  generate stage alone**, not the figures in the target block.
- [x] 0.4 `fli basecamp:app` + `fli basecamp:deploy` that app with the 0.2 key. Write down what
  `link:` dependencies, the env file, migrations and the first owner each needed.
  **Done 2026-11-06** on a copy of 0.3's app (`apps/charter/oracle/01-01-saas-signup`, copied to
  `~/charter-live-04/app`), run key `charter-run-D1951` throughout, App `saas-signup-0-4` at
  `https://saas-signup-0-4.maverickmade.tech`: `/api/health` 200, the web app 200, and
  `POST /api/auth/login` as the owner answers a session with `isAdmin`. The box's listing before
  (containers, images, volumes, Caddy, ports) is `~/charter-live-04/before.txt`, for 0.6. What each
  thing needed, in the order a person did it:
  - **`link:` dependencies: nothing.** The build is `docker build` on the laptop over `deploy/generated/`,
    which vendors 13 workspace packages as `.tgz` (`core/vendor.js`); the image installs from
    those. The risk above did not bite. A copied app's `node_modules` symlinks are relative and
    break, so the copy needed `bun install` (a laptop concern, not the box's).
  - **Git: the release is HEAD (`FJS-D1968`), and the generated app is not committed.** The oracle
    run leaves `api/src/` and `db/schema.lite` changes in the working tree; an uncommitted change is
    left out of the image. One hand `git add -A && git commit` before `basecamp:app`.
  - **The env file: `basecamp:app` wrote `BASECAMP_APP_ID`; nothing else was needed.** The deploy's
    set-up planned the rest from the app's own declarations: `ENCRYPTION_KEY` minted, `DATABASE_URL` and
    `AUDIT_PATH` moved to `/db`, both `FRONTIER_*_URL`s from `--domain`, `NODE_ENV`, port 3000 off
    the `EXPOSE` (`FJS-4047` is fixed: this run set it), volume `/db`, health check. Warnings only
    (moving `FROM` tags, `db/.json/` in the image).
  - **Migrations: the first release failed, `Start container … ECONNREFUSED`,** because the image's
    `CMD` runs `db:migrate` first and the history did not build the schema: `@frontierjs/auth`
    gained `session.refreshToken`/`clientId` and `credential.clientId` after the app's migration was
    written (the MCP sign-in work), so the framework moved under a generated app. The failed
    container is removed, so its log is gone; **the cause was found by running the image locally**
    (`docker run` with the Variables, no `--rm`). The fix is `litestone migrate create <label>` and a
    commit. **Phase 1:** the deploy stage must run `migrate create` (or the 0.3 history reset) on
    the final schema and commit, and a failed start should keep its last log lines in the release
    step's message.
  - **Two releases, not one.** `basecamp:deploy` releases the container App and *sets up* the static
    App `app` (it holds a 233-byte placeholder) with the Domain on it. The Domain's DNS is pushed only
    when a release lands on that App (`domain-dns`: "no release has landed"), so until the second
    run, `fli basecamp:deploy --app <the static App's id>`, the name did not resolve; the first run
    ends `✓ Released` with the hostname dead. After that run the A record, the CNAME and the
    certificate came in under a minute. **Phase 1:** the stage runs both, container first.
  - **The first owner: nothing seeded it.** The container has no `fli`, so `auth:dev-admin`
    (`FJS-D1897`) could not run there as written. Its upsert script (the `SCRIPT` in
    `commands/auth/dev-admin.md`) ran in the container instead: `ssh chartered docker exec -i -w /app
    -e FLI_INPUT=… <container> bun run -`, with a random password. It created the user, the password
    credential and `isEmailVerified`, `role: admin`; `isSystemAdmin` is not declared by this app so
    was not set; `isAdmin` came from the app's `standing()`. **Phase 1:** either `auth:dev-admin`
    gains a `--remote` that does this, or the stage owns the `docker exec`.
  - **The ssh the deploy holds is `root`** on this box (`root@159.203.150.231`), not a deploy user;
    the second risk above is therefore as wide as it can be. It also resets intermittently
    (`kex_exchange_identification`): `docker save | ssh docker load` failed on the first try of two deploys
    and a re-run recovered both, so the stage needs a retry around the load.
  - **Time:** a warm build is 3–4 s; the web build 3.5 s; the release steps each a few seconds.
- [x] 0.5 Over the public hostname, log in as the owner and make the `flows.json` move with
  `drive-browser`. Then point `access-drive.ts` at the live URL.
  **Driven 2026-11-06** against `https://saas-signup-0-4.maverickmade.tech`, owner
  `owner@charter.test` (0.4's):
  - **The browser login passes:** `/login`, the owner's email and password, then `/` reads
    *Signed in as*, `API · REACHABLE` and `SOCKET · OPEN` (so `/ws` routes back through the static
    App's Domain), with no console error, exception or failed request.
  - **The move cannot be made in a browser: the app has no screen for it.** `web/src/` is the
    scaffold's (`routes/` holds login, register, reset, account, users; `resources/` holds
    `User.mesa`), and *Your models* lists Users only; `/bookings` is the 404 page. Generate and
    feature write the schema and `api/`, never `web/`, so every preset deploys a UI that reaches
    none of its own models.
  - **The move passes over HTTP** with `builder/use.ts` pointed at the URL (1.4's stage, no
    change): owner login, then `EventType` → `Booking` made and `Booking.cancel` read back
    `scheduled` → `cancelled` on the live box. flows.json's chain names `Invitee` and
    `MeetingType`, which this app does not have; the move did not need them.
  - **`access-drive.ts` takes a directory, not a URL** (`use.ts` says so): it reads at the Data
    boundary on a scratch copy of the app, so pointed "at the live URL" it grades the image's code
    and not the box. It passes: 10 models, each refused or empty as anonymous and as another user.
    `stranger-drive.ts` likewise: 3 reads, `users.find`/`users.get` as a signed-in stranger, the
    same 3 as the local run. They are the scaffold's `User @@gate(4.4.4.5)`, a signed-in member
    reading the directory (`FJS-D47`), so the drive grades User stricter than the ruling.
  **Closed on HTTP** (owner, 2026-11-06): login in the browser and the move over HTTP, as 1.4's
  stage does. A generated app having no screen for its own models is a gap of its own, not 0.5's.
- [x] 0.6 Remove the App, then list the box's containers, Caddy routes and DNS records against
  a listing taken before 0.4. That listing is 1.5's check.
  **Done 2026-11-06** with the run key, in `live.ts` `cleanStage`'s order: the container App's
  Domains (none: the Domain is on the static App), `DELETE /apps/<container>`, `DELETE
  /projects/<project>`. Listing: `~/charter-live-04/boxlist.sh | sort` (rows, zone records,
  containers, images, Caddy route ids, Outpost's directories); `box-live.txt` with the App up,
  `box-after-clean.txt` after. The project delete took both Apps, the Domain, the container,
  the three Caddy routes and the static host files within 10 s. **Seven things stayed:**
  - **Two DNS records**, both of which Basecamp's own `edge.records` lists under `orphans`: the
    Domain's CNAME (`FJS-4055`: a Domain deleted with its project skips the `domain:dns` job
    that removes it) and the App's ingress A record (`FJS-4056`: nothing ever removes it).
  - **The API's data directory** `/var/lib/outpost/apps/<appId>/data`, its `uids.json` entry,
    and the static App's `/var/lib/outpost/static/apps/<appId>`. The data directory is kept by
    design, a Volume row deleted on its own (`FJS-D1615`).
  - **Both images** the releases loaded (`fjs-<appId>:<sha>`, one per commit).
  **For 1.5:** `cleanStage` deletes Domains by every App the run made, not the container's
  alone; deletes each Domain through its service before the project; deletes the Volume row; and
  removes its images. Its listing has to include zone records and the machine's directories and
  images, since the three Basecamp lists it takes today read clean while all seven stay.

### Phase 1 — Charter runs the cases unattended

Goal: the whole chain as one Charter script, over a matrix of charters.
Done when: `bun builder/live.ts` runs every file in `corpus/live/` with no hand step, each run's
box diff is empty, and each miss is a filed `FJS-###`.

- [x] 1.0 The designated Basecamp is an entry in `basecamps.json`, marked for runs. This needs
  `workbench-basecamps.md` 1.1 (the index) and 1.3 (`--basecamp <name>`) built first, so the URL
  and key have one origin from Phase 1 onward and Phase 2 reads the same entry.
  **Built 2026-11-04** with `workbench-basecamps.md` 1.1–1.3: the entry is `runs: true`
  (`designatedBasecamp()` in `core/basecamps.js`, one entry at most), its `apiKey` is the run
  key of Q5. It carried a `zone` for Q3 A; `FJS-D1899` (Q3 = B) retired the field the same
  day, since a run's App is named by its ingress name, the run workspace's own pair. Every
  `basecamp:*` command takes `--basecamp <name>`. Designating is writing the mark into the
  file by hand, once, when 0.1 makes the box.
- [x] 1.1 `builder/live.ts`: the six stages above, each recording outcome, time and cost into
  `runs/<date>-live-<name>.json` and a `Run` named `live`. `--keep` leaves the App standing
  (`FJS-D1893`), and the `Run` records which was chosen. A stage that fails stops the run.
  Everything after the failure is recorded as not reached.
  **Built 2026-11-04**, proved for `charter` and `generate` (`--through generate`: settled in
  5 turns, booted, $1.21, 414 s; a broken charter is refused with the rest `not reached`, exit
  1). `--through <stage>` stops early, so the local half is proved before a box exists. The
  record is rewritten after every stage; the `Run` row (phase 7) is created at the start and
  closed with cost and `finishedAt`. `deploy` and `clean` are written and never run: no entry
  is designated. They call Basecamp with no `/api` prefix (`core/basecamp.js`'s `basecamp()`):
  a `POST /servers` preflight that must answer 403 (Q5), `GET /apps` `/domains` `/projects`
  before and after, `fli basecamp:app` then `fli basecamp:deploy --domain <case>-<mmdd>.<zone>
  --yes`, and on clean `DELETE /domains/:id` (non-primary first), `/apps/:id`, then
  `/projects/:id` — the project too, since `apps.remove` leaves it and a same-day rerun would
  refuse the slug. One rule amended: `clean` runs whenever an App was made, even after a
  failed `deploy`, so a failed run leaves no App (1.2 carries the change). `feature` and
  `use` are `skipped` stubs until 1.2 and 1.4.
- [x] 1.2 The feature stage takes the charter's own `rigs` entry as the ask, through
  `behave.ts`'s writer, so the feature varies by case rather than coming from the frozen corpus.
  **Built and proved 2026-11-04:** `builder/ask.ts` `buildAsk()` is behave.ts's writer,
  migration and gates loop moved out (behave.ts calls it; its corpus run is not re-driven,
  owed). The stage runs `baselineServices`, a `ck-0` checkpoint, then the ask `rigs[0].title`;
  it passes when the gates settle and the app boots within `--turns` (default 4), a migration
  that deletes values is refused and fed back, and the pass bar does not judge whether the code
  does what the ask said. `--from <stage>` resumes from the same-date record. On
  `01-saas-signup` ("Sync with Google and Outlook calendars"): settled on turn 4 of 4, 15 files,
  booted, **$3.84 and 939 s**; a run through `feature` is $5.05. The turn cap is tight at 4;
  raising it is about $0.50 a turn. `clean` now runs after a failed `deploy` or `use` whenever an
  App was made.
- [ ] 1.3 The deploy stage runs `basecamp:app` and `basecamp:deploy` with `--basecamp <name>`
  and the run workspace's key, under an App name `<case>-<mmdd>`, on a hostname per Q3.
  **Under `FJS-D1899` (2026-11-04):** the stage makes no Domain — `basecamp:deploy --yes`
  with no `--domain` leaves the hostname unset — and the App's URL is its ingress name, which
  Basecamp neither serves nor names until `ingress-name.md` Phase 2 lands. `live.ts` records
  `hostname: null` and the use stage fails on it by name rather than driving a scratch copy.
  Order: the box (0.1), then `ingress-name.md` 0.1 probed on it and its Q1–Q6 ruled (done
  2026-11-05, `FJS-D1952`–`D1957`), then fleet-ingress Phase 3's `uploaded` push, then
  ingress-name's wildcard (its Phase 1, `FJS-D1954`) and serving (its Phase 2), then this step
  against the box.
- [x] 1.4 The use stage runs owner login, the `flows.json` move and the access and stranger
  drives against the deployed URL, the same drives Phase 6 runs locally. **Built 2026-11-04:**
  `builder/use.ts`, `use(app, { url?, owner?, flow? })` → `{ login, move, access, stranger }`,
  each `{ outcome, ms, detail }`; any failed check fails the stage. With a passed deploy the URL
  is `https://<hostname>`; without one (no box yet) the app boots on a scratch copy at the first
  free port in 17100–17199, so `--from use` runs with no deploy. Proof on `01-saas-signup`, 6 s,
  no model: login passed (`fli auth:dev-admin` on the scratch copy), move passed — the move
  derives its chain from the generated schema (EventType → Booking, `Booking.cancel`
  scheduled → cancelled over HTTP with `X-Service-Method`) and notes that flow 1 names Invitee
  and MeetingType, which the app lacks; access passed 10 models (EventType reads through by a
  declared read policy, so the stage takes the generate run's last Oracle answer as the studio
  does); **stranger failed**: 118 calls, 3 leaks, all `users.find`/`users.get` as a signed-in
  stranger. That read is the auth package's declared design (`packages/auth/db/user.lite`:
  "Read … USER: an app's own screens list its people"), not a defect — the bar is Q7. Three
  findings against the brief: `host.ts` only hosts, so the drives come from `lib.ts`; the access
  and stranger drives take a directory, not a URL, so against a deployed App they run on a
  scratch copy of the image's code (`drivesOn` in the record says so) and only login and the
  move touch the URL; and nothing seeds a first owner on a deployed App's first boot, so login
  against a real box answers 401 until Q6 is ruled.
- [ ] 1.5 The clean stage saves the App's container logs, its digest and the fli output into the
  run record. Unless the run was set to keep, it removes the App and its Domain. It writes the box
  diff from 0.6 into the `Run`: anything beyond a kept App fails the run.
  **Built 2026-11-06 under `FJS-D1976`, not yet driven on the box.** `builder/live.ts`: deploy
  keeps both fli commands' whole output under `runs/<date>-live-<case>/deploy/`; clean reads the
  container's last 500 log lines (`apps.logs`) and every release's `builtImage`/`toImage`, then
  removes each Domain of every App in the run's project through its own service, each App, the
  project, and the App's data Volume (polling up to 6 min for Outpost's report). The listing
  adds `/volumes` and `edge.records` `orphans` over every zone; a list the key cannot read
  fails the stage by name. Framework side, in this tree: `FJS-4055`, `FJS-4056`, `FJS-4057`
  closed, and `edge.zones`/`records` are declared reads so `edge:read` reaches them; a
  Domain-less App's record is `FJS-4061`. **Owed before the drive:** the owner mints the
  D1976 run key (`basecamp:key` was refused here), and Basecamp on `chartered` carries the
  three fixes (its image is `basecamp:d76ffe1db`).
- [x] 1.6 `corpus/live/`: a matrix of charters across shape (`saas` `solo` `team`), entry
  (`signup` `invite` `admin`), sign-in and one vendor. Frozen on the day it is written, like
  `prompts.json`. **Written 2026-11-04:** eight files `01-saas-signup` … `08-saas-signup`, each
  passing `checkCharter`, each with one custom `rigs[0]` as its 1.2 ask, only `ready` vendors
  (resend, telnyx, s3, stripe), and only the shape × entry pairs the catalog offers (solo has no
  invite, team no signup). `charter-file.ts` refuses a key outside its fields, so the frozen
  header lives in `corpus/live/README.md` rather than in each file.
- [x] 1.7 A Runs screen in Charter that lists the `live` runs, each stage as a cell.
  **Built and proved 2026-11-04:** `web/src/routes/runs/index.mesa` over
  `api/src/services/live-runs.service.ts` (`liveRuns.live`, gate 5, the one API reader of
  `runs/*.json`, refusing a path outside `runs/`); a Pill per stage toned by outcome, cost, kept
  or removed, the record path as text; a Runs link in the top bar. Driven in a browser: the one
  run shows charter and generate passed, four not reached, $1.21. Getting there caught Charter's
  API up with committed framework renames (`auth()`, `caravan()`, `defineJob({ handler })`,
  `root:` on `createApp`, `SYSTEM.id`). The proof ran on a scratch copy, because Charter's dev
  databases were `db push`ed and refused `fli db:migrate`. **Squashed 2026-11-04** on the
  owner's call to start fresh: the migration history and databases deleted, one `initial`
  written per database, the `Run` and `App` rows gone, the dev admin reseeded, and sign-in on
  the real dev server answers 200.

### Phase 2 — Workbench takes it over

Goal: a Workbench page that creates apps and runs the matrix, with the designated Basecamp
listed beside it.
Done when: the Phase 1 matrix runs from the Workbench page, and the reinstall toggle is the
only control on the page that touches the box.

- [ ] 2.1 Rule what leaves Charter. `charter.md`'s first open question recommends promoting the
  charter format "when a second caller of `fli new` needs it", and this page is that caller.
  Run `decision-rules` on it before anything moves.
- [ ] 2.2 The page reads the designated entry from `basecamps.json`. *Reinstall* and *New box*
  run `basecamp:reinstall` / `basecamp:create`, each with `confirm: human`, under the admin key
  `workbench-basecamps.md` holds, never the run key.
- [ ] 2.3 The page: pick a charter (the wizard or a file), a case set and *destroy when done* or
  *leave it* (`FJS-D1893`), then Run, and watch each stage arrive. A kept App is listed with a
  manual Delete.
- [ ] 2.4 Once the owner calls the runner settled, add a test that it calls only the verbs on its
  list.

## Open questions

- ~~**Q1 — Which box is the designated Basecamp?**~~ **Answered 2026-11-04 (`FJS-D1891`): B.**
  - **A** — yuma, the Basecamp already live, with a workspace for runs
  - **B** — a new small box made once, used only for runs
  - **Recommend B** — every run creates and removes Apps, and yuma serves real apps (kapp).
    A run that fails halfway leaves its mess on a box nobody else depends on.
- ~~**Q2 — What stops a run from touching more than Apps?**~~ **Answered 2026-11-04 (`FJS-D1892`): B.**
  - **A** — the runner's code: `live.ts` calls no server verb and refuses any other URL
  - **B** — Basecamp's access: a workspace of its own, with a key whose `WorkspaceRole` manages
    Apps and is refused servers and the hub
  - **Recommend B** — Invariant 6 puts access at the boundary, not in a caller, and
    `WorkspaceRole` already exists. If 0.2 finds no role that fits, file the gap rather than
    fall back to A.
- ~~**Q3 — What hostname does a run's App get?**~~ **Answered 2026-11-04 (`FJS-D1899`): B — the App's derived `<appId>.<ingress zone>` (`ingress-name.md`).**
  - **A** — `<case>-<mmdd>.<zone>`, one record per run through `basecamp:dns`
  - **B** — the App's derived `<appId>.<ingress zone>` (`ingress-name.md`)
  - **Recommend A for Phase 1** — an App has no hostname without a Domain until
    `ingress-name.md` lands. Switch to B then, because B is derived and A restates a name.
- ~~**Q4 — When is a run's App removed?**~~ **Answered 2026-11-04 (`FJS-D1893`): neither — the run's own setting, destroy when done or keep for manual deletion.**
  - **A** — always, at the end of the run, after its logs, digest and fli output are saved
    into the run record
  - **B** — on a pass; a failed one stays for a set number of days, then a sweep removes it
  - **Recommend A** — B adds a sweeper no phase builds, and a kept App holds the DNS record most
    likely to leak. Reopen B if a saved record proves too little to diagnose a failure.

- ~~**Q5 — What is the run's key, since no `WorkspaceRole` fits (0.2, `FJS-4024`)?**~~ **Answered 2026-11-04 (`FJS-D1896`): A — an API key minted by the run workspace's admin with the scopes `apps:*`, `domains:*`, `deployments:*`, `projects:*`, `environments:*` and `servers:read`; the edge refuses `/servers` writes and the hub by scope (`domain/api-key/scopes.ts`, `FJS-D916`), `scopes` is `@immutable` and `apiKeys` is outside the set, so a leaked key cannot widen itself.**
  - **A** — an API key minted by the run workspace's admin with the scopes `apps:*`,
    `domains:*`, `deployments:*`, `projects:*`, `environments:*` and `servers:read`; the edge
    refuses `/servers` writes and the hub by scope (`domain/api-key/scopes.ts`, `FJS-D916`),
    `scopes` is `@immutable` and `apiKeys` is outside the set, so a leaked key cannot widen itself
  - **B** — close `FJS-4024` first: App delete to level 4, Domain writes to `2.4.4.4`, the three
    `Server.*` grants off `developer` in `ROLE_GRANTS`; then a `developer` member's key
  - **Recommend A** (`decision-rules` 2026-11-04, 2 of 3) — the precedent is `enrollPeer`, which
    joins as `admin` narrowed by its key's scopes (the `FJS-D1188` amendment of 2026-11-03), and B
    changes what `developer` means in every workspace to serve one runner. A amends Q2's wording:
    the limit is Basecamp's access still, graded at the call rather than the Data boundary.
    `FJS-4024` stays open as the path back to B. Whichever is ruled, 1.0 adds a preflight that
    tries a `/servers` write with the run key and refuses to run unless it is refused, since
    0.2's probe left no test behind. **Phases 0–1 proceed under A until ruled.**
- ~~**Q6 — Who is the owner the use stage logs in as on a deployed App (1.4)?**~~ **Answered 2026-11-04 (`FJS-D1897`): A — the deploy stage runs `fli auth:dev-admin --email --password` on the box, with a random password per run kept only in the run record, never `test1234` on a public hostname.** Nothing seeds a
  first owner on an App's first boot, so against a real box login answers 401.
  - **A** — the deploy stage runs `fli auth:dev-admin --email --password` on the box, with a
    random password per run kept only in the run record, never `test1234` on a public hostname
  - **B** — the stage registers through `POST /api/auth/register`
  - **C** — accept the 401 until someone seeds the box by hand
  - **Recommend A** (`decision-rules` 2026-11-04, confidence 2) — `auth:dev-admin` is already the
    one first-owner path and the local half of 1.4 uses it; B is a second path that proves a
    different thing and answers 202 pending an email click wherever the app has a mailer
    (`FJS-D1310`), so it fails most `signup` charters too; C makes the live run unable to pass
    and says nothing about why. What A needs first: a way to run a command on a deployed App's
    box — the app-repl path (`FJS-3517`) or the ssh the deploy already holds — not yet confirmed.
    Reopen B for a `signup` charter on an app with no mailer.
- ~~**Q7 — What is the stranger drive's bar in the use stage (1.4)?**~~ **Answered 2026-11-04 (`FJS-D1900`): A, and C as the owner's own question.** `packages/auth/db/user.lite`
  declares `User` Read as USER on purpose, so every generated app shows the same 3 leaks on
  `users.find`/`users.get` as a signed-in stranger.
  - **A** — allow a leak only on a model whose declared read gate admits the caller, matched by
    model and method from the generated schema, printed in the record as declared exposure;
    any other leak fails
  - **B** — fail on any leak, so the exposure shows in every record
  - **C** — a framework ruling on whether a signed-in user may read other `User` rows at all,
    which for `saas` is a tenant question
  - **Recommend A, and C as the owner's own question** (`decision-rules` 2026-11-04,
    confidence 3) — the exposure is declared once, in the schema; B makes the drive disagree
    with the schema in every run and so measures nothing, and a hand-kept count of 3 would be a
    second copy of the declaration that lets a real new leak through. A is the rule the access
    check in the same stage already applies. **Until ruled the stage fails on any leak (B).**
- ~~**FJS-D1951 — Does the run key's scope set (FJS-D1896) widen to what basecamp:deploy's set-up reads and writes — domainRoutes and variables?**~~ **Answered 2026-11-05 (`FJS-D1951`): A — add `domainRoutes:*` and `variables:*` to D1896's set; `servers:write`, the hub and `apiKeys` stay refused.** Measured 2026-11-05 on `chartered`: with the
  run key the preflight skips every Variable rule (`variables:read` 403) and a first release
  stops at `GET /domainRoutes` (`domainRoutes:read` 403); the deploy's help names
  `variables:write` and `domainRoutes:write` as well.
  - **A** — add `domainRoutes:*` and `variables:*` to D1896's set; `servers:write`, the hub and
    `apiKeys` stay refused
  - **B** — Charter makes the App whole with the admin key before a run, so the run key only
    releases; a second, stronger credential in every run
  - **Recommend A** — the run workspace holds only Charter's own Apps (`FJS-D1899`), and the
    boundary D1896 draws is machines and keys, not per-App config
- ~~**Q8 — How does the clean stage (1.5) see and remove what Basecamp's App, Domain and project lists miss?**~~ **Answered 2026-11-06 (`FJS-D1976`): A — Basecamp's deletes leave no record (`FJS-4055`, `FJS-4056` fixed) and a deleted App's Volume can be removed (`FJS-4057`), and the run key gains `edge:read` (the zone's `orphans`) and `volumes:*` (a deleted App's data); the diff is the three lists, orphan records and Volumes; images and Outpost's directories are checked by hand once, not per run, and nothing watches them between. `edge:read` reads the whole ingress zone, not only the run's records; `volumes:write` removes a directory under `/var/lib/outpost/apps/` through Outpost. The deploy stage's `/servers` preflight still has to be refused after the widening.**
  Measured 2026-11-06 (0.6): those three lists read clean while seven things stayed: two zone
  records (`FJS-4055`, `FJS-4056`), the data Volume, its `uids.json` entry, the static App's
  directory and two images. The run key can read none of them, and the Volume's removal was
  refused besides (`FJS-4057`).
  - **A** — Basecamp's deletes leave no record (`FJS-4055`, `FJS-4056` fixed) and a deleted
    App's Volume can be removed (`FJS-4057`), and the run key gains `edge:read` (the zone's
    `orphans`) and `volumes:*` (a deleted App's data); the diff is the three lists, orphan
    records and Volumes; images and Outpost's directories are checked by hand once, not per
    run, and nothing watches them between. `edge:read` reads the whole ingress zone, not only
    the run's records; `volumes:write` removes a directory under `/var/lib/outpost/apps/`
    through Outpost. The deploy stage's `/servers` preflight still has to be refused after
    the widening
  - **B** — the clean stage also takes 0.6's full listing with the admin entry and ssh,
    read-only; every delete stays the run key's, but a run then holds the admin key and root
    ssh, which is what D1896 keeps off it
  - **C** — the diff stays the three lists; what lies outside them is filed and listed by hand
    from time to time
  - **Recommend A** — Basecamp is the owner of what its deletes leave, so the fix belongs there;
    `edge:read` and `volumes:*` touch neither machines nor keys, the boundary D1896 draws

## See also

`charter.md` (the plan and its features) · `zero-to-live.md` (the deploy chain, never run end
to end) · `workbench-basecamps.md` (the index and the admin key) · `basecamp-reinstall.md` (the
manual toggle) · `ingress-name.md` (Q3 B)
