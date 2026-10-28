---
id: git-deploy
status: proposed
dated: 2026-10-27
---

# Git deploy — a repository wired to an App, released by a push or a button

**Status: PROPOSED.** Dated 2026-10-27. Phase 0 is a hand-run of what already
exists; nothing past it is built. Do not cite this file as describing behavior —
see `VERIFYING.md`.

The model is Laravel Forge's *site*: connect a repository, get a deploy key and
a webhook, and from then on a push to the branch releases, a **Deploy Now**
button releases, and the deploy script is edited on the site rather than in the
repository. Basecamp has every piece of that already, built across three
rulings, and what is missing is the joints between them and one trip to GitHub
that a person still makes by hand.

What exists, and where (checked against the tree on 2026-10-27):

- **Deploy Now** — the `Deploy` button at the top of the App page
  (`web/src/routes/apps/[id]/index.mesa`, `id="app-deploy"`), one
  `deployments.create`.
- **Deploy on push** — `FJS-D884`, built under `FJS-1781`: a conduit Receiver
  at `/hooks/git/{appId}` taking GitHub/Forgejo/Gitea's HMAC, and
  `/hooks/git/{appId}/{token}` for a sender that signs nothing
  (`api/src/plugins/push.ts`). A push to the App's branch releases; a delete, a
  ping and every other event is answered 200 and ignored. `apps.enablePush`
  mints the pair and the App page shows the URL and secret once.
- **The deploy script** — the App's own Dockerfile, `FJS-D1555`: seeded from
  the repository's file or the FrontierJS template, edited in Basecamp,
  snapshotted per release so a rollback builds with the file it shipped.
- **The deploy key** — `FJS-D1555`: one per App, minted on the Outpost, the
  public half up the heartbeat into `App.deployPublicKey` and onto the App page.
- **New project from a repository** — `projects.fromRepo`: project, production
  environment, App, its five Variables and an optional Domain in one call.
- **The laptop release** — `fli basecamp:deploy --app <id>` (`FJS-D942`): the
  image is built where the workspace is, shipped over SSH, and the release
  names its digest so the machine builds nothing. This is the path for an app
  whose dependencies are `link:`, and it stays.

**Two doors, one App.** A git-wired App takes a laptop release too, and the
next push replaces it: a release is a release, the newest is live, and nothing
here makes a laptop build sticky. That is the owner's stated intent and this
plan keeps it; what it adds is that the Releases tab says which door each one
came through (1.5: `Deployment.trigger` is an enum of the seven doors, where
Phase 0's five rows all read `manual`).

Out of scope here: how a `link:` app builds on a machine (the template
Dockerfile's framework clone, a published `dev` tag, split repositories). That
is its own question and this plan does not depend on its answer.

---

### Phase 0 — Prove the pieces by hand

Goal: the existing flow run once end to end on a dev Basecamp against a public
test repository, so Phase 1 fixes what was seen and not what was read.
Done when: a Deployment row exists that a push created, one the button created
and one `fli basecamp:deploy` created, on one App, and the App page shows the
last one live.

- [x] 0.1 `fli dev` + `bun run dev:outpost`; `fromRepo` a public repository
      holding a plain `Dockerfile`; press Deploy; note what the Releases tab
      shows and what the first-release preflight (`FJS-3525`) complains about.
  - Run 2026-10-27 on the dev Basecamp, workspace `skunkworks`, server
    `dev-outpost`. The repository was a LOCAL clone standing in for the public
    one (creating a public repository is the owner's act); `fromRepo` was
    handed the repository's own `Dockerfile` as `dockerfile`, which is what the
    public read would have returned, so `seeded` said `none` and the public
    read is unexercised until 0.2. Everything from the App on was the real path.
  - The button release went green in 4.6 s: Validate, Build image, Back up
    volume, Start container, Health check; busybox httpd answered on the host
    port. The App page's `Deploy` is one `deployments.create({ appId })`.
  - The Releases tab shows one row, trigger `manual`, commit `—`: the row's
    `commitSha` and `branch` are null though the step output says `built
    2903b27 with Dockerfile.basecamp` — `FJS-3559`, one dropped field in the
    build step; it belongs with 1.5.
  - `port` had to be typed (1.1 stands); `containerPort` was 3000 by the
    constant and happened to match the file's `EXPOSE 3000` (1.3 stands).
    `deployPublicKey` was minted and on the App before the first release.
  - The laptop preflight never ran until told where the file is: `fli
    basecamp:deploy --dry` refuses `Dockerfile not found: deploy/Dockerfile`
    for a repository whose Dockerfile is at the root, the place the Outpost
    looks second, and needs `deploy.api.dockerfile` in a `frontier.config.js`
    the repository does not have. With one, 0 errors and 2 warnings: nothing
    routes to the App (no Domain, port not exposed) and `FROM busybox:1.36`
    is a moving tag; and it would *vendor `deploy/generated/`* for a
    repository with no `link:` dependency (1.6's neighbor). `FJS-3525`'s
    walkthrough did not fire: the App had a port and a release already.
  - The dev database lacked `app.deployPublicKey` (one initial migration,
    edited after apply); added by `ALTER TABLE` rather than `db:reset`, which
    wipes fleet data no seed recreates.
- [x] 0.2 Enable push, add the webhook at GitHub by hand, push a commit; confirm
      the release and that a push to another branch is ignored.
  - Run 2026-10-27 against `github.com/jdkdev/fjs-git-deploy-test` (public,
    made by the owner), the dev API behind a quick `cloudflared` tunnel.
    `apps.readRepoDockerfile` on the public URL returned the root
    `Dockerfile`, so the public seed path works; the App's `source.repo` was
    patched from the local stand-in to the URL.
  - `apps.enablePush` answered `url`, `tokenUrl`, `secret`, `token` in one
    call. The `url` is the API's own origin (`http://localhost:8120/...` here),
    which a person behind a tunnel rewrites by hand; in production it is the
    right one. GitHub's ping was answered 200.
  - The push released: a second row, success in 14.6 s, and the host port
    served v2. The row says `trigger: manual` and `triggeredBy` is the
    `pushActorId` (1.5 stands); `commitSha`, `branch`, `author` and
    `commitMessage` are all null though the payload carries `after`,
    `head_commit.author` and `head_commit.message` (`FJS-3559`'s neighbors;
    the Receiver reads only `ref`, `after`, `deleted`, `default_branch`).
  - A push to a branch `side` was answered 200 with a null body and made no
    row; the live page stayed v2.
  - One 502 on the first delivery was the laptop's doing, not the door's: two
    `bun --watch` API processes were fighting for 8120 and one was mid-restart
    when GitHub called. Redelivered from GitHub's hook page, it released.
- [x] 0.3 `fli basecamp:deploy --app <id>` onto the same App; push again;
      confirm the push replaced the laptop build and the history reads right.
  - Run 2026-10-27 from a checkout under `~/code/FRONTIER/fjs-git-deploy-test`
    with `--server localhost` (the dev Outpost is this daemon, so nothing
    ships). The laptop build released: a row with `commitSha`, `branch` and
    `toImage` set, the only one of the five rows that names a commit, and the
    host port served the laptop's tree.
  - Three refusals before it ran, none of them about the App: `Dockerfile not
    found: deploy/Dockerfile` (a `frontier.config.js` naming the root file
    fixed it, as in 0.1); `no package.json` from the vendoring step, which runs
    for every repository (a stub fixed it); and `docker build` refusing a
    context under `/tmp`, which is the snap daemon and not ours. A plain
    repository cannot be laptop-released as it is: 1.6 grows to cover the
    first two.
  - The tree was dirty and the row says `a2c190d`, the last commit, which
    does not hold what shipped — `FJS-3561`.
  - The push after it made a row and the page did not change: the Outpost's
    clone still had `origin` at the local stand-in path from 0.1, so the
    fetch returned the stale tree and the release was green with the earlier
    push's digest — `FJS-3560`. Replaying the same delivery from GitHub made
    no row (the receipt dedupes, which is right); the clone directory
    dropped and a fresh push released v5 from a GitHub clone and replaced
    the laptop build. The two doors replace each other as intended; the
    history shows five `manual` rows (1.5 stands).
  - `apps.get` answered `liveBuild: false` after the laptop release as well
    as after the push, though it is derived to be true for any live release
    whose snapshot holds no inline files; whichever way that resolves, the
    alert 1.5 wants (*a laptop build is live*) has no column to key on, and
    the laptop row is told apart only by `toImage` being set.
- [x] 0.4 Write what 0.1–0.3 found under each step, and re-order Phase 1 by it.

**Done 2026-10-27.** Five rows on one App: button, push, laptop, push, push.
Every door works and the newest release is live; what is wrong is what the
rows say (`FJS-3559`), a clone that does not follow the App (`FJS-3560`), the
laptop door's three refusals of a plain repository (`FJS-3561` and 1.6), and
the two trips of 0.2. Phase 1 below is in the order those were felt, numbers
kept; the rulings behind the order are in `decision-rules`' run of 0.4.
The test repository `github.com/jdkdev/fjs-git-deploy-test` and the dev App
`git-deploy-test` in `skunkworks` are still there for Phase 1's drives.

### Phase 1 — The hand-run Forge flow

Goal: creating an App from a repository ends in one panel that says what to add
at GitHub, and every joint a person hit in Phase 0 is closed.
Done when: `bun run test` (`from-repo.test.ts`, `push.test.ts`, `servers.test.ts`)
and `bun run verify:screens` are green with the steps below covered, and a
repository wired by hand releases on push, on the button and from a laptop.

- [x] 1.5 **A release names its door, and its commit.** `Deployment.trigger`
      takes `push`, `button` and `laptop` beside `rollback` and `rebind`: the
      push Receiver and `fli basecamp:deploy` each state theirs, and the
      Releases tab shows it. The build step hands the row the commit it built
      and the Receiver the payload's commit, author and message (`FJS-3559`).
      The App page says a laptop build is live and the next push replaces it,
      keyed on the row's trigger rather than on `liveBuild`, which 0.3 found
      reads `false` for every git release.
  - Every one of Phase 0's five rows said `manual` and `—`; the history of
    one App through three doors could not be read back.
  - Built 2026-10-27. The column was a free String with seven spellings in
    the tree (`manual`, the seed's `webhook`, `rollback`, `rebind`, and
    `publish` and `freeze` the owner-editing and workbench paths had added);
    it is `enum DeployTrigger { button push laptop rollback rebind publish
    freeze }`, default `button`, so a misspelled door is refused at the Data
    boundary, and `manual`/`webhook` are renamed in every caller (the seed,
    four tests, the fleet tutor's release step). `Job.trigger` is another
    noun and stays a String; the enum comment says so.
  - `liveBuild` is gone from `apps.get` with the second `configSnapshot` read
    it cost; the page derives the notice from the first `success` row's
    trigger, which `recent_deployments` already carried, and shows it as a
    Callout (`#app-live-build`) on the overview and the Releases tab, not only
    in Deploy's confirm. A git App's sentence says the next push replaces it.
  - The button path fills `branch` from `source.branch` at create, so a
    button row reads `main` rather than `—` before the build step reports.
    The dev database's 85 seeded rows were re-spelled by `UPDATE`; the
    `CHECK` lives in the regenerated migration only, since the dev database
    is one initial migration edited in place (`db:reset` wipes fleet data).
  - `db/schema.json` was already stale against `schema.lite` (`deployPublicKey`,
    `ProjectFromRepo`) before this step; regenerated with it.
  - Drives: `push.test.ts` asserts the door and the payload's four fields on
    the push row; 1.7 still owes the button and laptop rows.
- [x] 1.8 **The clone follows the App** (`FJS-3560`). The Outpost's `build`
      reads the clone's `origin` and re-points or re-clones when it is not
      `source.repo`, so a repository changed after the first release is the
      one built. Refuse or follow, never a warning: Phase 0 shipped the old
      tree green twice.
  - Built 2026-10-27. `build` reads `git remote get-url origin` off
    `work/<appId>`; an origin that is not `source.repo`, or no origin, removes
    the directory and clones fresh. Remade rather than re-pointed
    (`decision-rules`, question 8): `remote set-url` keeps the old repository's
    objects and untracked files in the build context, which is the silent
    class `FJS-3560` is about, and `siteBuild` in the same file already
    remakes its checkout every run. A matching origin is fetched, reset and
    `clean -fdx`, since `reset --hard` alone leaves a file the last checkout
    had in the context `docker build` ships.
  - Drives: three cases under *a clone on this machine follows source.repo*
    in `outpost.test.js` assert the argv (same origin fetched, never recloned;
    different origin `rm -rf` then `clone`; no origin remade). The live
    re-run of 0.3's trip, a `git-deploy-test` App patched from the stand-in
    path to GitHub, is owed to 1.7's drive pass; `verify:docker` did not run
    here (`/var/run/docker.sock` refused this user).
- [x] 1.6 **The laptop door takes a plain repository.** `fli basecamp:deploy`
      finds the Dockerfile where the Outpost does, by asking the Outpost's
      lookup order (`chooseDockerfile`, `packages/outpost/src/dockerfile.js`)
      rather than holding a second `deploy/Dockerfile` default beside it;
      vendors when the chosen Dockerfile names `deploy/generated/`
      (`needsGenerated`, the same file), so a repository with no
      `package.json` builds; marks a dirty tree on the tag and the row
      (`FJS-3561`); and the Outpost refusal about `deploy/generated/` drops
      its commit sentence and names the two paths that work, the laptop
      release or a Dockerfile stored on the App. Paved road, not a flag:
      Phase 0 needed a `frontier.config.js` and a stub `package.json` to run
      at all.
  - Built 2026-10-27, `FJS-D1560`. The order and the predicate moved out of
    `createDocker` into `src/dockerfile.js`, a new `./dockerfile` entry of
    outpost with no `Bun` global at import, and `@frontierjs/cli` depends on
    outpost (`core/vendor.js` re-exports the two). The plan's *when a `link:`
    dependency exists* was a proxy that broke the `--source npm` scaffold, whose
    template still `COPY`s the folder; the Dockerfile's text is the authority
    (`decision-rules`, question 5), and `vendor.js`'s header says so now.
  - The Outpost's refusal is on the same predicate, stored copy included: an
    `apps.importDockerfile` of the template into a private App would have
    failed deep inside `bun install`; `deploy/Dockerfile` with no
    `deploy/generated/` beside it builds when the file installs from the
    repository.
  - The laptop honors a Dockerfile stored on the App, as the push does, writing
    it as `Dockerfile.basecamp` for the build and removing it in `finally`; a
    `frontier.config.js` `deploy.api.dockerfile` is *told* and still wins.
  - Dirty: `git status --porcelain` before anything is written; the tag is
    `fjs-<app>:<sha12>-dirty`, the row's `commitSha` is `<sha>-dirty`, the
    command warns, and `shortSha` in the console keeps the suffix after the
    seven-char cut on the App page, the Releases tab, the release page and the
    failure notice.
  - Drives: four cases in `outpost.test.js` (the refusal's words, a
    repository's own `deploy/Dockerfile` with no folder, a stored copy read by
    the same rule, `needsGenerated` on the template and a comment); the laptop
    `--dry` on a plain repository and a dirty tag are 1.7's.
- [x] 1.4 **Creation ends in *Connect your repository*.** `fromRepo` takes
      `deployOnPush` (on when a server is picked, `FJS-D1558`); its answer carries
      the deploy public key and the push URL, secret and token URL together, and
      the create page shows them once on one panel: add these two at GitHub,
      then push. The App page keeps Rotate.
  - Phase 0 made the trip twice: the key came with `fromRepo`, the webhook
    pair from `enablePush` on another tab; and the URL is the API's own
    origin, which a person behind a tunnel rewrites by hand.
  - Built 2026-10-27. `ProjectFromRepo.deployOnPush Boolean?`; the mint is
    `enablePushOn(appId)` in `apps.service.ts`, which `enablePush` and
    `fromRepo` both call, so there is one and it is the rotation. `fromRepo`
    answers `push: { url, tokenUrl, secret, token } | null` beside
    `dockerfile`; with a server and nobody saying `false` it is on, without a
    server it is never on. The create page shows a *Deploy on push* switch once
    a server is picked (on; `false` is sent only when turned off) and, when the
    answer carries a key or a push, replaces the form with the `#connect-repo`
    panel: the key with Copy (or the machine's reason), the three push values,
    the shown-once callout, *Open the app*. Without a server it leaves for the
    App page as before. The form is now `novalidate`, as the other create forms
    are: the kit warns on a native constraint in a form that is not.
- [x] 1.1 **The host port is Basecamp's to pick** (`FJS-D1557`). `fromRepo` and
      `apps.create` take no port; `placeApp` (`apps.service.ts`), the one place
      a replica lands on a server, allocates the next free one from the Apps
      already placed there and refuses a duplicate per server the way `fromRepo`
      refuses a duplicate hostname, and `apps.update` patching `port` on a
      placed App runs the same check per `AppServer`. `checkRuntime` holds no
      server and stays out of it (Invariant 4). The form shows the number it
      got; a person may change it only for an App with no hostname, where the
      number is the address (`FJS-D930`).
  - Today the form demands a number a person cannot know. Two Apps on one
    server with the same port fail at `docker run`, after the old container is
    gone (`db/schema.lite` § App, the runtime columns).
  - Built 2026-10-27. The refusal half was already in the tree under
    `FJS-3563` (`domain/release/host-port.ts`: patch, place and fromRepo
    refuse a taken port naming the App; the detail carries `portsTaken`). The
    allocation half: `allocatePort(serverId)` in the same file hands out the
    lowest port from `HOST_PORT_BASE` (10000, above every `docs/PORTS.md`
    slot and any scaffold's listen port, since a Basecamp or Outpost on the
    same box is not an App and the reader cannot see it); `placeApp` calls it
    when the App publishes nothing and its type is one the release starts as
    a container — `CONTAINER_TYPES` in `domain/release/runtime.ts`, the one
    list the release's no-image refusal reads too (`decision-rules`, question
    9: the gate had spelled one type where the release spelled three). A port
    the App holds is checked, never moved, so a second placement keeps it.
    `ProjectFromRepo` drops `port` outright; the create form asks for none
    and the Server picker says the server picks it. The App page's edit
    drawer withholds `port` once a hostname exists (`FJS-D930`), and the
    Runtime card says which case the App is in. The CLI preflight's `no-port`
    fix stays for a placed App that predates this, and its patch is graded
    by the same refusal.
  - Drives: `from-repo.test.ts` (two Apps placed take 10000 and up with no
    sharing; an unplaced App publishes nothing until placed, then keeps its
    port across a second placement; a `database` App is given one and a
    `static` App is not; a stated port taken on the machine refuses the
    place and the patch by name); `push.test.ts` posts no port; the screens
    drive asserts the create form has no port field and the made App's port
    is the machine's pick. Basecamp suite 1050 pass, typecheck 7 = baseline.
- [x] 1.3 **`containerPort` comes from the Dockerfile.** `fromRepo` parses the
      last `EXPOSE` of the seed it holds, and the Outpost reports the clone's
      when the App stored none; `3000` is the template's own `EXPOSE` and is
      held nowhere else.
  - `SCAFFOLD_API_PORT` is right for `fli make:deploy`'s file and wrong for
    every other; Phase 0's `EXPOSE 3000` matched it by luck.
  - Built 2026-10-27, `FJS-D1567`. One parser, `exposedPort` in
    `@frontierjs/outpost/dockerfile` beside `chooseDockerfile`: the last
    `EXPOSE`, its first port, `8080/tcp` read as 8080, null for none or a
    variable. `fromRepo` stores what the seed says (null for a blank or silent
    one) and writes `FRONTIER_PORT_BE` only then, since a guessed number
    overrides the image's own `ENV`; `SCAFFOLD_API_PORT` is gone. `/build`
    answers `exposed_port` off the file it built with; the runner's build step
    adopts it onto an App that stores none (`adoptContainerPort`,
    `domain/release/runtime.ts`, through `recordStep`) and uses it for the
    start step of the same run, and names the disagreement in the step's
    output when the App states another number — the health check is what
    fails. `configSnapshot` is `@immutable`, so the adopted port is not
    written back into the release; `runtimeFor` reads the App's for a
    snapshot that holds none, which is what a rollback to that release needs.
    `fli make:deploy`'s Dockerfile sets `ENV FRONTIER_PORT_BE=3000` beside its
    `EXPOSE`, so a blank-seeded scaffold app binds what its file exposes. The
    Runtime card says the first build fills a git App's empty container port.
  - Drives: outpost suite (`exposedPort`'s cases; `/build` answers the stored
    copy's, the clone's `deploy/Dockerfile`'s, null); `from-repo.test.ts`
    (the seed's last `EXPOSE` on the App and the variable; the template's
    3000; a blank or silent seed stores none and no variable);
    `push.test.ts` (the build step adopts onto an App with none and never
    moves a stated one). Live on the dev stack, `dev:outpost` restarted for
    the new route: `fromRepo` of the test repository with a blank Dockerfile
    stored no container port and no `FRONTIER_PORT_BE`; the button release
    went green with `built b4b6b25 with Dockerfile, EXPOSE 3000` on the build
    step, the App read `10000 → 3000` after, busybox answered on 10000, and
    the scratch project was removed.
- [x] 1.2 **A private repository seeds a blank Dockerfile, not the template.**
      Blank already means the repository's own: the Outpost's `chooseDockerfile`
      takes `deploy/Dockerfile`, else `Dockerfile`, off the clone. The form says
      so, and *Use the repository's* after the first build is how a person gets
      a copy to edit (`apps.importDockerfile`).
  - The template is for a `link:` app and builds the wrong image for any other.
    Untested in Phase 0, which used a public repository only.
  - Built 2026-10-27, `FJS-D1570`. Wider than the box: a private repository
    and a public one with no file read the same off a forge (404 both), so the
    server never seeds the template at all — `seeded` is `repo` or `none`, and
    the template is the create form's button. The Outpost's `build` refuses a
    context holding no Dockerfile by name before `docker build` (commit one, or
    store one on the App), where docker's own words named no way out. Drives:
    `from-repo.test.ts` (a forge nothing reads stores no file, no port, no
    `FRONTIER_PORT_BE`), `outpost.test.js` (the refusal, and under a
    `source.path`); the six older build cases plant the file the faked clone
    never had.
- [x] 1.7 **Drives.** The three test files, the outpost suite and
      `verify-screens.mjs` cover 1.5 (the trigger and commit on each row, a
      push row with `commitSha` set), 1.8 (a clone re-pointed when
      `source.repo` changes), 1.6 (a plain repository passes `--dry`; a dirty
      tree marks the tag), 1.4 (the panel's four values) and 1.1 (port refused
      per server). No new files: the cases go in the suites that already own
      these screens.
  - Run 2026-10-27 for the steps built so far; 1.4's and 1.1's halves follow
    their steps. Live, on the dev stack (`dev:outpost` restarted, since the
    daemon up predated 1.8's code and its `.outpost/` home was gone): two
    button releases of `git-deploy-test`, the second after the clone's origin
    was re-pointed at a path that does not exist — both green, both rows
    `button`/`main`/GitHub's HEAD, the clone back at `source.repo`; `fli
    basecamp:deploy --dry` on the plain checkout (the 0.3 stubs moved aside)
    built the stored copy as `Dockerfile.basecamp`, vendored nothing, left no
    file, and a scratch file in `www/` marked the tag `-dirty` with the warning.
  - In the suites: `push.test.ts` gains the button row (`button`, the App's
    branch, the presser), `recordStep` handing a row the commit the build
    reported, and the laptop row (`laptop`, a `-dirty` commit, no build step);
    `cli/test/vendor.test.js` drives `basecamp:deploy --dry` as a process
    against a stub Basecamp on a repository made outside the tree (fli takes
    the nearest `frontier.config.js` above as root, and under `packages/cli`
    that is the workspace's), spawned asynchronously since the stub answers on
    the loop a `spawnSync` would block; the seed now draws `laptop` and
    `verify-screens.mjs` reads the overview's `#app-live-build` and each door
    on the Releases tab.
  - 1.1's half, 2026-10-27: the cases above in `from-repo.test.ts`, and
    `verify-screens.mjs`'s *connect your repository* pass fills no port and
    reads the allocated one back off the row. The box closes.
  - 1.4's half, 2026-10-27. Live on the dev stack with the real Outpost:
    `fromRepo` onto `dev-outpost` answered an `ssh-ed25519` key and the three
    push values together, the row read back with neither credential, and
    `deployOnPush: false` answered no push. In the suites: `from-repo.test.ts`
    (the credentials on the answer, the row carrying neither, `false` leaves
    it off), `push.test.ts` (creation's secret verifies at the forge and
    releases; token URL too; an App with no server is never `deployOnPush`
    and its door is 401), and `verify-screens.mjs` drives `/projects/create/`
    through the switch to the panel's four values and *Open the app*. 1.1's
    half is left.

### Phase 2 — Basecamp makes the GitHub trip

Goal: a person picks a repository and never copies a key or a webhook.
Done when: `fromRepo` with a connected GitHub account leaves the repository
holding the deploy key and the webhook, and a push releases with nothing added
by hand.

Deferred until Phase 1 has been used once for real; Forge's automation is what
the connection buys, and the hand-run flow has to be right first.

- [x] 2.1 Rule Q2, the shape of the connection.
    *Ruled* `FJS-D1571`: **C** — a fine-grained token as a `Secret` with
    `kind: provider_key, providerKind: github`. Its permissions are
    Administration write, Webhooks write and Contents read. Phase 1's live
    private-repository drive is still owed (the deferral above); the ruling
    is paper and does not wait for it.
- [x] 2.2 A GitHub connector, basecamp's own as Cloudflare's is
      (`api/src/providers/source/`; it moves with the rest at `FJS-D1559`'s
      session, since a `link:` on the sibling repository does not survive the
      image build): `POST /repos/{o}/{r}/keys` and `POST /repos/{o}/{r}/hooks`,
      the credential a `Secret` with `kind: provider_key, providerKind: github`
      (`FJS-D1571`), which already says which connection it is (no second ref
      on the Workspace). `github` joins `ProviderKind`, `Server` gains
      `@@check("providerKind != 'github'")` as it has for `cloudflare`
      (`FJS-D559`), `Secret.providerKind`'s comment says vendor rather than
      cloud, and `accountConnectorFor` names the source connector beside
      compute and edge. A revoked token refuses `connect: true` by name.
    *Built:* `source/index.ts` (`SourceConnector`, `sourceConnectorFor`),
    `source/github.ts` and `source/github-sink.ts` (8126, `GITHUB_URL`).
    The two writes are `setDeployKey` and `setPushHook`, each repeatable: a
    key already on the repository (compared without its comment) is answered,
    and a hook at the same URL is PATCHed so its secret is current. Each
    refusal names its cause — 401 *revoked or has expired*, 403 the grant to
    add, 404 *not found, or the token was not given it*, 422 a deploy key
    already on another repository (GitHub allows one). `verify` reads
    `/user`, so a token given no repository verifies and is refused at the
    connect that names one. The descriptor pins `X-GitHub-Api-Version` and
    sends a `User-Agent`. Writes meet `sendVia`'s spend guard. The secrets
    form's *Cloud* label reads *Vendor*. Drives: `api/test/source.test.ts`
    14/14 (dialect against a hand-written send, the seam through the sink,
    the `Server` check); `edge`, `compute`, `servers` 283/283; typecheck at
    baseline. Left for 2.3: one parser from a remote URL to `{owner, name}`,
    shared with `dockerfile-template.ts`'s `GITHUB` pattern.
- [x] 2.3 `fromRepo` gains `connect: true`: after the App exists it writes both
      at GitHub and the panel from 1.4 says *done* instead of *add these*.
    *Built:* `ProjectFromRepo.connect Boolean?`. Before any row: no server,
    a remote that is not GitHub, no GitHub account the caller can read
    (`Secret` is `@@gate(5)`, so a member below administrator finds none), or
    every token refused by `verify` refuses by name (`connectableAccounts` in
    `apps.service.ts`; an unreachable forge is a 502). After placement,
    `connectRepository` writes the key and the hook with the first account the
    repository is visible to, in name order — a 404 (`RepoUnseen`) moves to the
    next (owner's call, 2026-10-27: *first that sees it*, no account field).
    A refusal after the App exists never throws: it is the answer's `note` and
    `connected: { account, key, hook }` says which half landed. One parse of a
    remote, `forgeRepo` in `dockerfile-template.ts`, feeds the raw read and the
    connect. The create page shows *Connect at GitHub* (on) when a server is
    picked, the workspace holds a GitHub token and the remote looks like
    GitHub; the panel says *Done* per half and drops the shown-once callout
    when the hook landed. Drives: `from-repo.test.ts` 31/31 (eight connect
    rows against the sink), `source`/`push` 28/28, `verify:screens` 300/300
    with the GitHub sink on the slot's `3` (the hook at the sink, the panel's
    done state); typecheck at baseline. The live half (a real token, a real
    repository) is the owner's, with Phase 1's private-repository drive.
- [x] 2.4 `apps.importDockerfile` reads a private repository through the
      connection before the first build, closing `FJS-D1555`'s left-open item.
    *Ruled* `FJS-D1573` (`decision-rules`): the forge first, the clone after.
    *Built:* `readFile` on `SourceConnector` (`GET /repos/{o}/{r}` first, so a
    missing file is never an unseen repository, then each path's contents;
    Contents › Read-only named on a 403), and `readForgeDockerfile` in
    `apps.service.ts` — the public raw read, then each GitHub account in name
    order, read as the caller and never refusing, a refused token passed over.
    `importDockerfile` asks it before the machine's clone and answers `from`;
    `fromRepo`'s seed asks it too, so a private repository an account sees
    seeds `repo` with its port. The editor says *in the repository at
    <branch>* or *in the machine's clone*. Drives: `source.test.ts` 17/17,
    `from-repo.test.ts` 35/35 (seed through the account, import before any
    build, unseen falls to the machine with both reasons, a developer not
    refused), `push` 14/14, `verify:screens` 301/301 (Import on an App no build
    has run); typecheck at baseline. The live half is the owner's, with 2.3's.

---

## Open questions

Each is ruled through `decision-rules` and the answer is cited by its `Q`.

- **Q1 — Who picks the host port.** Ruled `FJS-D1557`: **A**.
  **A** — Basecamp allocates per server and
  refuses a duplicate; the form shows it, overridable only with no hostname.
  **B** — keep the typed field, add the per-server refusal only. **C** — keep
  as built. **Recommend A** — the number is plumbing between Caddy and the
  container that a person has no way to know; Dokku assigns it and Coolify
  has none. B is the one-level-simpler cut if A's allocator turns out to need
  a machine read.
- **Q2 — How Basecamp authenticates to GitHub for Phase 2.** Ruled `FJS-D1571`: **C**.
  **A** — a GitHub
  App installed on the organization, short-lived installation tokens, scoped
  to the repositories chosen. **B** — an OAuth App acting as the person, Forge's
  shape. **C** — a token pasted as a `Secret` with `kind: provider_key,
  providerKind: github`, the
  shape DigitalOcean, Hetzner and Cloudflare already take here (`FJS-D559`).
  **Recommend C** — the own-domain sibling, one row and no new noun; A is the
  reopen once a departed person's token has cost something.
- **Q3 — Is deploy-on-push on by default at creation.** Ruled `FJS-D1558`: **A**.
  **A** — on when a
  server is picked, off otherwise. **B** — off, a switch on the create form,
  Forge's *Quick Deploy* which is a click after the site exists. **Recommend
  A** — a git-sourced App with a server and no push is an App waiting for a
  button, and the panel in 1.4 shows the webhook either way.

## Sources

- Laravel Forge, *Sites — Deployments* and *Quick Deploy*: a deploy hook URL
  per site, push-to-deploy on the chosen branch, an editable deploy script,
  and the deploy key and webhook written to the repository through the
  connected source-control provider. https://forge.laravel.com/docs/sites/deployments.html
- `FJS-D884` (the push door), `FJS-D942` (the laptop build), `FJS-D1555` (the
  deploy key and the App's Dockerfile), `FJS-3525` (the first-release
  preflight), `IDEAS/paas-parity.md` § 2.
