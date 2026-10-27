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
came through, because today a push, the button and the laptop all record
`trigger: manual`.

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

- [ ] 1.5 **A release names its door, and its commit.** `Deployment.trigger`
      takes `push`, `button` and `laptop` beside `rollback` and `rebind`: the
      push Receiver and `fli basecamp:deploy` each state theirs, and the
      Releases tab shows it. The build step hands the row the commit it built
      and the Receiver the payload's commit, author and message (`FJS-3559`).
      The App page says a laptop build is live and the next push replaces it,
      keyed on the row's trigger rather than on `liveBuild`, which 0.3 found
      reads `false` for every git release.
  - Every one of Phase 0's five rows said `manual` and `—`; the history of
    one App through three doors could not be read back.
- [ ] 1.8 **The clone follows the App** (`FJS-3560`). The Outpost's `build`
      reads the clone's `origin` and re-points or re-clones when it is not
      `source.repo`, so a repository changed after the first release is the
      one built. Refuse or follow, never a warning: Phase 0 shipped the old
      tree green twice.
- [ ] 1.6 **The laptop door takes a plain repository.** `fli basecamp:deploy`
      finds the Dockerfile where the Outpost does, by asking the Outpost's
      lookup order (`chooseDockerfile`, `packages/outpost/src/docker.js`)
      rather than holding a second `deploy/Dockerfile` default beside it;
      vendors only when a `link:` dependency exists, so a repository with no
      `package.json` builds; marks a dirty tree on the tag and the row
      (`FJS-3561`); and the Outpost refusal about `deploy/generated/` drops
      its commit sentence and names the two paths that work, the laptop
      release or a Dockerfile stored on the App. Paved road, not a flag:
      Phase 0 needed a `frontier.config.js` and a stub `package.json` to run
      at all.
- [ ] 1.4 **Creation ends in *Connect your repository*.** `fromRepo` takes
      `deployOnPush` (on when a server is picked, `FJS-D1558`); its answer carries
      the deploy public key and the push URL, secret and token URL together, and
      the create page shows them once on one panel: add these two at GitHub,
      then push. The App page keeps Rotate.
  - Phase 0 made the trip twice: the key came with `fromRepo`, the webhook
    pair from `enablePush` on another tab; and the URL is the API's own
    origin, which a person behind a tunnel rewrites by hand.
- [ ] 1.1 **The host port is Basecamp's to pick** (`FJS-D1557`). `fromRepo` and
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
- [ ] 1.3 **`containerPort` comes from the Dockerfile.** `fromRepo` parses the
      last `EXPOSE` of the seed it holds, and the Outpost reports the clone's
      when the App stored none; `3000` only when neither says.
  - `SCAFFOLD_API_PORT` is right for `fli make:deploy`'s file and wrong for
    every other; Phase 0's `EXPOSE 3000` matched it by luck.
- [ ] 1.2 **A private repository seeds a blank Dockerfile, not the template.**
      Blank already means the repository's own: the Outpost's `chooseDockerfile`
      takes `deploy/Dockerfile`, else `Dockerfile`, off the clone. The form says
      so, and *Use the repository's* after the first build is how a person gets
      a copy to edit (`apps.importDockerfile`).
  - The template is for a `link:` app and builds the wrong image for any other.
    Untested in Phase 0, which used a public repository only.
- [ ] 1.7 **Drives.** The three test files, the outpost suite and
      `verify-screens.mjs` cover 1.5 (the trigger and commit on each row, a
      push row with `commitSha` set), 1.8 (a clone re-pointed when
      `source.repo` changes), 1.6 (a plain repository passes `--dry`; a dirty
      tree marks the tag), 1.4 (the panel's four values) and 1.1 (port refused
      per server). No new files: the cases go in the suites that already own
      these screens.

### Phase 2 — Basecamp makes the GitHub trip

Goal: a person picks a repository and never copies a key or a webhook.
Done when: `fromRepo` with a connected GitHub account leaves the repository
holding the deploy key and the webhook, and a push releases with nothing added
by hand.

Deferred until Phase 1 has been used once for real; Forge's automation is what
the connection buys, and the hand-run flow has to be right first.

- [ ] 2.1 Rule Q2, the shape of the connection.
- [ ] 2.2 A `conduit-github` connector in the sibling repository
      (`FJS-D1185`): `POST /repos/{o}/{r}/keys` and `POST /repos/{o}/{r}/hooks`,
      the credential a `Secret` with `provider: github`, which already says
      which connection it is (no second ref on the Workspace). A revoked token
      refuses `connect: true` by name.
- [ ] 2.3 `fromRepo` gains `connect: true`: after the App exists it writes both
      at GitHub and the panel from 1.4 says *done* instead of *add these*.
- [ ] 2.4 `apps.importDockerfile` reads a private repository through the
      connection before the first build, closing `FJS-D1555`'s left-open item.

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
- **Q2 — How Basecamp authenticates to GitHub for Phase 2.** **A** — a GitHub
  App installed on the organization, short-lived installation tokens, scoped
  to the repositories chosen. **B** — an OAuth App acting as the person, Forge's
  shape. **C** — a token pasted as a `Secret` with `provider: github`, the
  shape DigitalOcean, Hetzner and Cloudflare already take here (`FJS-D1478`).
  **Recommend C** — the own-domain sibling, one row and no new noun; A is the
  reopen once a departed person's token has cost something. Ruled at 2.1.
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
