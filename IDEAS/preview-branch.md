---
id: preview-branch
status: proposed
dated: 2026-10-09
---

# Idea — a preview branch: a client edits the UI on live data and submits it for review

**Status: PROPOSED. Slices 1, 2, 3 and 4 are built (2026-10-10, § Game plan),
less Retire on PR close; slice 0 is not run and nothing else is built.** Do not cite this file as describing behavior — see `VERIFYING.md`. Prior art is from memory on 2026-10-09, not
fetched; each FJS claim was checked against the tree that day.

A superadmin or a client opens the app on a subdomain of its own, works in it
against the LIVE API, and from there asks for a UI change — click the thing, say
what should differ. The change lands on a branch they never see, the page
hot-reloads, and when they are happy they submit. The owner reviews the diff,
merges, deploys, and everyone has it. The ask is one sentence; the point of this
file is that the tree already holds every owner it needs, so what is left is a
composition and one new rule.

## Prior art

| Who | What they settled | Here |
| --- | --- | --- |
| Shopify theme editor | Edit an UNPUBLISHED copy against the live store's data; "publish" swaps a pointer | the UX to match — the client never sees a branch |
| Decap CMS `editorial_workflow`, Tina, CloudCannon | An editor's save is a commit on a branch; a PR is the review; merge is publish | the mechanism — git is the queue, GitHub is the inbox |
| Vercel / Netlify deploy previews | A branch is a subdomain; a comment on it lands on the PR | the preview URL IS the review link |
| Lovable | Preview and published share one database by default | the live-data choice, with its risk named |
| v0 | A developer reviews every diff before it ships | the owner's seat |
| Codespaces, Gitpod | "Check out a branch" as a hosted machine | right idea, wrong audience — a client does not want a terminal |

No one of them does all four: a non-developer editor, an agent writing the
source, live data, and a PR as the gate. The combination is the ask.

## What the tree already has (probed 2026-10-09)

| Need | Owner today | Where |
| --- | --- | --- |
| Click an element, ask Claude to change it, hot-reload, Undo | the ask panel, steps 1–3 built | [`on-page-editing.md`](on-page-editing.md), `packages/cli/core/vite-ask.js`, `ask-claude.js` |
| An edit run that can write ONLY under one directory | `askArgv({ edit })` — `Edit(<dir>/**)`, `dontAsk`, every settings source dropped | `packages/cli/core/ask-claude.js` |
| A branch in its own worktree, pinned, with its own chat, diff panel, checks strip and reviewer | the Workbench's Fork (slice A built) | [`workbench-branches.md`](workbench-branches.md), `packages/basecamp/domain/workbench/workbench-branch.ts` |
| A port block for a second checkout of an app | `FJS-D841` — N×10000 on every port, `claimSession` owns it | `packages/cli/core/ports.js` |
| A SPA that talks to an API on another origin | `VITE_API_URL` at build or dev, and the API's CORS allow-list | `packages/sierra/README.md` § the API's origin |
| A UI build that cannot escalate against the API it talks to | Invariant 6 — gates enforced at the Data boundary, `x-gate` is an affordance | — |
| A stranger's script gets an origin of its own | `FJS-D345`, `FJS-D618` — a port is an origin, Caddy fronts it by host | `packages/outpost` |
| A hosted static origin for a branch's build | outpost's second listener, `inline` apps | `packages/outpost/README.md` § Or the bytes are the app |
| A client's review of a preview: pins and threads | proposed, unbuilt | [`anchored-feedback.md`](anchored-feedback.md) |
| What a preview IS in the Release realm | an **Environment** — a named place a Release serves from, configuration only | `VOCABULARY.md`, [`release-transitions.md`](release-transitions.md) |

## Probed, 2026-10-10 — stage 1 on Basecamp

- **A dev-server preview needs no CORS.** Basecamp's `web/config/vite.config.js`
  PROXIES the API by path (`API_PORT`, else `FLI_PORT_BE`, else 8120), so the
  branch's dev server on 18020 with `API_PORT=8120` talks to the parent's live
  API same-origin; a GET with `Accept: application/json` reached junction (401
  with no token) and the shell came from the branch. `VITE_API_URL` and the CORS
  rule enter only at Freeze, where a static build has no proxy. § The design step
  1 and slice 3 are amended to say so.
- **Fork by the Workbench's own helpers works from a dirty tree.** `snapshot()`
  carried 29 files beyond HEAD into a dangling commit, `addWorktree` cut
  `wb/preview-trial` under `~/.config/basecamp/workbench/trees/hand/`, `bun
  install` there took 0.4 s, and the worktree reports clean on its branch.
- **The ask route is mounted on the branch's dev server** (`/__fjs/ask/*`), and
  its same-origin check wants `Origin`, `Host`, and a JSON content type — a curl
  without the last one is refused with *only a page this dev server served may
  ask*, which is the check doing its job.
- **The owner's hand run, 2026-10-10.** The panel painted, one edit (a login
  heading, `src/routes/login/index.mesa:82`) landed in the worktree and nowhere
  in the parent tree, the page hot-reloaded, both servers held through it, and
  the owner committed it on `wb/preview-trial` by hand; the push and the PR were
  skipped on purpose — a real PR on the real repo for a trial heading. **One
  edit cost $0.04.** The panel's own diff was read and the Undo was there; the
  non-developer half of that question waits for stage 2.
- **The owner's one ask from the run:** the panel should feel like the
  Workbench's chat in Basecamp — a conversation, collapsible sides — rather than
  a box over the page. That is a `on-page-editing.md` move, and this file's
  slice 5 names it so the client's seat gets it.

## The design

**1. A preview is an Environment whose Release is a branch of `web/` and whose
API pointer is production's.** `preview.<app>` on a fleet machine runs the
branch worktree's Vite dev server with its API proxy pointed at the production
API (`API_PORT` in Basecamp's config) — same-origin, so no CORS while editing;
`VITE_API_URL` and a CORS rule are the frozen static build's concern. Live data costs nothing
because the preview is a client of the API everyone else uses. No new noun: an
Environment is already the mutable pointer at a Release, and the dev server is
the Release while someone is editing.

**2. The branch is a Workbench branch, cut by the owner.** Fork makes
`wb/<slug>` in a linked worktree, pinned, with its port block from `FJS-D841`
and the parent's gitignored state copied as slice B describes. The client's
subdomain points at that worktree's `web/` port. The owner's Basecamp already
shows the branch's chat, diff, checks and reviewer — that is the review seat,
and the client never logs into Basecamp.

**3. The ask panel is the client's whole interface, and its run is the `edit`
run scoped to `web/`.** Alt-click opens nothing for a client (no editor to open
into); shift+alt-click and the direct text edit are the two controls. Every run
goes through `askArgv({ edit: '<worktree>/web' })`, so a prompt that wants the
schema or a service is denied by Claude Code's own permission layer, not by a
regex over the prompt. The ledger's another-writer rule already keeps a run
from overwriting the owner's edit in the same tree.

**4. Submit is one more ask-panel control, and a PR is the submission.**
Commit the ledger's touched files on `wb/<slug>`, push, `gh pr create` with the
preview URL and the run's session ids in the body. Status — open, approved,
merged — is read from the PR, never stored: a `Proposal` model would be a second
origin for GitHub's state, and *Proposal* already names an `IDEAS/` document in
`PHILOSOPHY.md` § VII. The owner merges and `fli deploy` ships it. Land (into the
parent's dirty tree) stays what it is for the owner's own branches; a client's
branch goes through the PR because the owner must read it before it touches
anything.

**5. The one new rule: a preview branch is UI-only, and Submit refuses the diff
otherwise.** A branch that touches `db/`, `api/` or a `.lite` file cannot run
against the live API — its schema has moved and production's has not — and the
`edit` scope means it should never happen, so the refusal is the proof that it
did not. `fli check` grades it where the worktree carries a preview pin; the
Workbench's checks strip shows the red.

**6. Who may open the panel on a hosted dev server.** Today `vite-ask.js`
accepts a same-host POST and nothing else, because it is a localhost port.
Hosted, the route must know the caller: forward the production session (the
same token the page already holds for the API) to production's `account`
service and admit a principal above a named gate level, the way
`sessionGateLevel(user)` already grades one. Caddy's `forward_auth` against the
production API is the same check one layer out and is the recommendation —
the dev server then keeps its one rule, and the admitted set is the schema's.

## Hazards, named now

- **Writes are real.** The preview is not a sandbox; a client deleting a record
  there deletes it. The dev server's panel is the place for a persistent
  preview badge. A copy-of-the-database sandbox is a different product and the
  owner picked live.
- **The branch's code runs with the client's production token.** Acceptable
  while the only authors are that client and the scoped run. Two clients
  previewing each other's branches is token theft by design: one branch, one
  editor, one origin, and a branch's subdomain admits its editor only.
- **Claude on a hosted machine is code execution.** The worktree holds the
  branch and no production secret; the run is the `edit` scope, hooks off,
  MCP off, budget capped. The Workbench's `work` run (bypass) never serves a
  client — `NOT_FOR_AGENTS` already draws that line for API keys.
- **Tokens cost money per editor.** The Workbench's running-cost card is the
  meter; a per-pin budget is the cap, and `ASK_BUDGET_USD` is where it lives.
- **A dev server for a client.** One editor per dev server is fine; HMR is the
  feature. A build-per-save static preview on outpost's `inline` origin is the
  fallback if a dev server under a stranger proves fragile.

## Managing the preview deployment

Basecamp already models the Release realm: `Environment` carries a `tier` with
`preview` among its values, an `App` is the deployable unit inside one, a
`Variable` is what its process starts with, a `Domain` is the hostname it answers
on, and a `Deployment` records what ran. Outpost already speaks `/route`,
`/static/publish`, `/static/activate` and `/static/retire`. So a preview is
managed as a row set in the app that manages everything else, and the work is
the verbs between the rows, not new nouns.

| Row | For a preview | Already there |
| --- | --- | --- |
| `Environment` | `tier: preview`, `slug: wb-<slug>` — the slug is the address, so a rename leaves the URL standing | `EnvironmentTier.preview`, `@@unique([projectId, slug])` |
| `App` | one, `type: static`, `source: { kind: 'inline' }`; `port` is the worktree's `web/` port while editing | outpost's inline apps — the bytes are the release |
| `Variable` | `VITE_API_URL` = production's API origin, on the App | `Variable` scoped to an `appId` |
| `Domain` | `preview-<slug>.<app>`, `isPublic: false` | `Domain`, `/route { app_id, hosts }` |
| `Deployment` | one per Freeze, `commitSha` the branch head, `trigger: 'freeze'` | `Deployment`, `@@transitions(status)` |

**The dev server is the Workbench pin's process, not a Basecamp App.** A fourth
`source.kind` for "a worktree with a dev server" would be a noun for a state
(*concept budget*): the App is `inline` from the day the Environment is made, and
`/route` dials the pin's port until a static release is activated, after which
the route follows the release. Nothing about the App changes when the editor
stops editing except where the bytes come from.

**The verbs**, as custom methods on the `environments` service, gated at
developer, each one writing rows the machine then reads:

- **Open** — Fork cuts the branch (today), then one call makes the Environment,
  App, Variable and Domain, pushes the route to the pin's port, and adds the
  preview origin to production's CORS allow-list. Open is what Fork does when
  the pin is marked *for a client*; a developer's own branch gets no Environment.
- **Freeze** — build `web/` from the worktree with the App's Variables, publish
  the files to outpost (`/static/publish`), activate, and write the Deployment
  with the branch head's sha. The URL now serves the proposed UI with no dev
  server and no Claude running — the state a branch sits in while the owner
  reviews the PR, and the one that costs nothing per hour.
- **Thaw** — route back to the pin's port; the editor is working again. No row
  changes but the route.
- **Retire** — `/static/retire`, `/route` with no hosts, the CORS entry removed,
  the Environment soft-deleted (its App, Variables, Domain and Deployments
  cascade). Workbench Archive keeps the branch. Retire runs itself when the PR
  closes — merged or not — on a GitHub webhook through junction's webhooks
  battery, or a Caravan job reading `gh pr view` where no webhook reaches the
  machine.

**The preview's state is derived, never stored.** Editing is *the route dials a
pin's port*; frozen is *a static release is active*; retired is *the Environment
is soft-deleted*. A `status` column on Environment would be a second origin for
what the route and the release already say, and would be wrong the first time a
dev server died without telling it.

**Promote does not apply, and the record should say so.** `Promote` deploys a
digest that already served elsewhere. A frozen preview's digest was built with
the preview's `VITE_API_URL` inlined, so production's build is a different
artifact by construction; the merge is what carries the change, and production's
Deployment is an ordinary one. The preview's Deployment row still names the sha
production later deployed, which is the audit line from a client's ask to a
production release.

**The UI-only rule has a Release-realm half.** A preview-tier Environment holds
one App and it is `static`: `apps.service` refuses a `container`, `database` or
`worker` App under a preview Environment, in the same place `checkRuntime`
already refuses a `port`-less health path. That is the Submit refusal's twin —
one guards the diff, one guards what the preview may run — and together they are
what makes "it runs on live data" a safe sentence.

**Added to the nine.** *Origin* — the Environment's state is the route plus the
release, nothing stored twice. *Concept* — no fourth `source.kind`; Open, Freeze,
Thaw, Retire are methods, not nouns. *Owner* — `environments.service` for the
verbs, outpost for the machine, `claimSession` for the port; CORS gains an owner
it lacks today: production's allow-list is a config file, and Open must write it,
so either the list becomes rows (`Domain` already is one) or Open fails there.
**Recommend the list derives from `Domain` rows of preview Environments in the
project** — the API reads it at boot and on a change event, and there is no second
list to drift. *Silence* — *stays true:* a retired preview answers nothing on its
hostname. *What fails:* a drive case under `verify:provision` that opens, freezes
and retires one against the stand-in machine, and then GETs the hostname — owed
with the first slice, `none` until then.

## Game plan

Six slices, each one proved by a drive before the next starts, and the first one
is a measurement with no code. Facts the plan leans on, checked 2026-10-09:
`vite-ask.js`'s edit root is Vite's `config.root`, which in a Sierra app is
`web/`, so the scope exists; junction's `cors.origins` accepts a function, so an
allow-list can be a hostname rule; `deployment-run.job.ts` already publishes and
activates an `inline` release, so Freeze is a build feeding a path that exists;
the `workbench` service already has `fork`, `land`, `archive` and `configure`.

### Before any of it

- `workbench-branches.md` slice B — the gitignored state a worktree lacks
  (`.env`, dbs). A preview worktree needs its `web/` env only, but the copy is the
  same code.
- A wildcard DNS record, `*.preview.<app>`, and a certificate for it. One record,
  made once, so Open never touches DNS.
- `gh` authenticated on whichever machine holds the worktree, as the owner.

### Slice 0 — prove the premise by hand (half a day, no code)

Fork a branch of a real app in the Workbench. In its worktree run `web/`'s dev
server with `VITE_API_URL` pointing at the production API, allow the origin by
hand, tunnel the port, and hand the URL to one client with the two ask-panel
controls. Measures: whether a dev server under a stranger holds for an afternoon,
the token cost of a client's session, and whether the client ever wants the diff.
*Where:* two stages, because no FJS app serves a client in production yet
(2026-10-10). **Mechanics on Basecamp itself** — its Workbench forks its own
worktree, the branch's `web/` dev server points at the running API on 8120 and
`CORS_ORIGINS` already exists to allow the origin; the editor is the owner and
the live data is the fleet. **The non-developer on ELA** — `db/app.prod.db` is a
copy of production, Phase 2 already live-fired on a scratch copy, and a real ELA
person exists to hand the URL to; a wrong write there costs nothing. maid.tech is
the fallback client. `example/` is for the drives in slices 1–4, never for this.
*Done when:* one real UI change reached a PR by this road, and the three numbers
are in this file's § Probed.

### Slice 1 — the panel admits a principal, and Submit (cli) — built 2026-10-10

**As built, where it departs from the bullets below:**

- **The rule is told, not detected.** `ASK_ADMIT_URL` (the app's `account/me`)
  and `ASK_ADMIT_LEVEL` (a name from the gate's `LEVELS`) in the dev server's
  environment; unset is localhost and same-origin alone. `VITE_API_URL` cannot
  be the trigger: a dev-server preview proxies the API (§ Probed), so there is
  no other origin to notice. A URL with no valid level refuses everyone.
- **The level is the API's, and it is the person's `standing`.** `account/me`
  carries `standing` when the app passes `services: { standingLevel }` or
  `{ level }` to `auth`; without either every caller is refused by
  name. Not `level`: that is what the browser's buttons read, and Basecamp,
  graded per workspace, publishes none. Basecamp's `standingLevel` answers 7
  for the hub, so its rule is `ASK_ADMIT_LEVEL=SYSADMIN`; ELA passes `level`,
  which `standing` falls back to.
- **Submit is offered on a `wb/*` branch, token or not.** Under the rule every
  route already wants the token, so *branch + token* was one condition twice.
- The panel sends the token under Sierra's `junction.tokenKey`.
- The UI-only refusal is slice 2's; Submit refuses a non-`wb/*` branch and any
  dirty file no un-undone run changed.
- § 6's `forward_auth` stays open as the edge's half; it would read the same
  `account/me`.
- *Proved:* `verify:ask` gained six checks (no token, below level, Submit to a
  bare origin through a stand-in `gh`); cli's `vite-ask.test.js` fourteen.

The plan as written:


- `packages/cli/core/vite-ask.js` — the `/__fjs/ask/*` routes take the page's
  Bearer token and, where `VITE_API_URL` names another origin, ask that API for
  the session's principal before running anything; a caller below the configured
  level, or with no token, is refused. Same-host stays the rule on localhost.
- `/__fjs/ask/submit` — commit the ledger's touched files on the current branch,
  push, `gh pr create` with the preview URL and the run's session ids in the
  body; answer with the PR URL. Refuse on a branch not under `wb/`, on a dirty
  tree outside the ledger's files (another writer), and on the UI-only rule
  (slice 2).
- `packages/cli/core/vite-ask-client.js` — a Submit control beside Undo, shown
  only when the server says it may (branch + token both present).
- *Proof:* `website` `verify:ask` gains three cases — no token refused, a
  principal below level refused, Submit against a stand-in `gh` writes the commit
  and names the PR. `DRIVES.md` row for the ask panel extends.

### Slice 2 — the UI-only rule (cli) — built 2026-10-10

**As built, where it departs from the bullets below:**

- **The marker is `fjs-preview` in the worktree's PRIVATE git directory**
  (`git rev-parse --git-path fjs-preview`, so `.git/worktrees/<name>/` in a
  linked one), and it is empty. Not in the tree: there it is an untracked file
  Submit's another-writer rule refuses, or one it commits into the PR. Removing
  the worktree removes it. Slice 3's Open writes it; by hand it is a `touch`.
- **The base is derived, not carried**: `merge-base HEAD origin/HEAD`. The
  Workbench's fork base was the alternative, and it is the wrong diff — a fork
  of a dirty parent carries its files in the snapshot commit, and that commit
  is in the PR. Grading from what the PR merges into grades what the reviewer
  reads, unpushed parent commits included. No `origin/HEAD` is a red naming
  `git remote set-head origin --auto`, never a guess at `main`.
- **Submit passes `--base` to `gh pr create`** — the branch the grade used — so
  the PR is opened against exactly the diff that passed.
- The scope is a directory the caller names: `fli check` passes `<app>/web`,
  Submit its Vite root, which is also the `edit` scope. One function,
  `core/preview.js` `previewScope`.
- No marker is a skip, not a pass, and the rule does not ask the branch's name:
  Open writes the marker only on a `wb/*` branch, and Submit already refuses
  any other.
- *Proved:* `test/preview.test.js` (six, real git — clone, linked worktree,
  marker: no marker skips, `.mesa` passes, `.lite` fails uncommitted, committed
  or untracked, an unpushed parent commit fails, no `origin/HEAD` fails);
  `vite-ask.test.js` one (Submit refuses a committed `db/` file with the file
  named, then opens the PR with `--base main`); `checks.test.js`'s clean app is
  a preview worktree now, so the rule RUNS there rather than skipping.
  `verify:ask` unchanged and green — its scratch repo has no marker.
- **The nine, answered before the code:** origin — none; the base is git's
  and the PR's target is the same ref. Concept — none; a marker file. Complexity
  — one function, two callers. Predictability — a rule that skips where it has
  nothing to grade, like every other. Derived — the base. Owner —
  `core/preview.js`; Open (slice 3) owns writing the marker. Boundary —
  `previewScope(dir, scope)` answers one of three named shapes. Failure — a
  refusal, because merging a schema change behind a UI review is the cost.
  Silence — *stays true:* a preview's PR carries only `web/`; *what fails:*
  `preview-ui-only` and Submit's 409, pinned in the two test files. Adjudication
  — ergonomics vs. strictness, resolved strict by what a mistake destroys.

The plan as written:

- A `fli check` rule, `preview-ui-only`: in a linked worktree on a `wb/*` branch
  that carries a preview marker, the diff against the branch's base must stay
  under `web/`; a file outside is named in the red. The marker is the pin's
  `preview` flag written as a file the worktree carries (slice 3 writes it, slice
  0's hand run writes it by hand).
- Submit calls the same rule and refuses on red — one implementation, two
  callers.
- *Proof:* cli's check tests — a worktree with a `.lite` edit fails, with a
  `.mesa` edit passes.

### Slice 3 — Open (basecamp) — built 2026-10-10

**As built, where it departs from the bullets below:**

- **The settings are the CHECKOUT's, the flag is the fork's.** `configure
  { preview: { projectId, app, domain, apiUrl, serverId } }` on a pin that is
  not a branch; `fork { slug, preview: true }` refuses without them. A
  `preview` boolean on the branch's pin had nowhere to say which project,
  which app in a monorepo, which machine, which wildcard or which API, and
  they are the same for every client a checkout serves. The branch records
  what Open made as `opened` (port, Environment, App, hostname, route).
- **Open lives in the workbench's `fork`, not an `environments` method.** It
  needs the worktree and its port, which only the workbench knows and only
  behind `localMachineRefusal`. The rows are written through each row's own
  service as the caller — `environments`, `apps`, `variables`, `domains`,
  `apps.place` — so a preview meets every check a person's create meets.
  `domain/workbench/workbench-preview.ts` is the owner.
- **The port is claimed at the cut**, through fli's `portFor` on the pin's
  sessions lock, so the route names the port `fli dev` will bind in that
  worktree; Archive gives it back. The marker is written there too, by fli's
  new `markPreview`, so the name has one spelling.
- **The App is `inline` with a placeholder `index.html`** — an inline source
  must hold one. It answers only when no route and no release does.
- **A preview's slug is one hostname label** (letters, digits, inner `-`), or
  the one wildcard certificate does not cover it; refused before the cut.
- **All or nothing, except the route.** The project and machine are read in
  the caller's workspace when set and again before the cut; a failed row
  removes the Environment (its children cascade) and archives the branch,
  keeping `wb/<slug>`. A machine refusing `/route` is reported in
  `opened.route` in its words and undoes nothing — the rows are right, and
  Thaw is the same push.
- **`/route { port }` — ruled here, not asked**: a stated port is for an app
  with no container on the machine, and is refused beside one, whose own
  published port is the only truth. A machine with no docker counts as no
  container. § Rulings strikes it; a `DECISIONS.md` row only if the owner
  disagrees.
- **CORS moves to slice 4.** Nothing crosses origins until Freeze builds a
  static `web/`; the proxy serves while editing (§ Probed).
- **Not built:** a *Fork for a client* control and the hostname on the
  branch's card (the API is the whole surface today); `apps.service`
  refusing a non-static App under a preview Environment (§ Managing, the
  Release-realm half); sierra's README line for the CORS rule.
- *Proved:* `api/test/workbench.test.ts` one test (the settings refusals, the
  marker outside the tree with the tree clean, the port equal to `portFor`'s
  and held in the lock until Archive, no preview on a plain fork);
  `verify:provision` eleven checks — a stand-in machine on the command port's
  TLS with the certificate enrollment pinned, settings refused for another
  workspace's project, a fork before settings cuts nothing, then Open's four
  rows read back through the API and `/route` read off the wire with the
  hostname and the branch's port. Sending `port + 1` turned exactly that
  check red. Outpost's suite two (a stated port routes an app with no
  container, and is refused beside one).
- **The nine:** origin — the Environment's state is still the route and the
  release; `opened` records what Open made, never what is serving. Concept —
  none; `opened` is a field. Complexity — one function writing through five
  existing services. Predictability — a preview's rows are the rows a person
  would make. Derived — the port is `fli dev`'s, the hostname the slug's.
  Owner — `domain/workbench/workbench-preview.ts`; the marker's name stays fli's. Boundary — the
  caller's workspace, read twice. Failure — refused before the cut, rolled
  back after it; the route reported. Silence — *stays true:* a preview's
  hostname is routed only to its branch's port; *what fails:* the `/route`
  check in `verify:provision`.

The plan as written:

- `Pin` gains `preview: boolean`; `configure` sets it. `fork` with `preview`
  does what it does today, then Open: an `Environment` (`tier: preview`,
  `slug: wb-<slug>`), one `App` (`static`, `inline`, `port` the worktree's
  `web/` port from `FJS-D841`), a `Variable` `VITE_API_URL` on it, a `Domain`
  `<slug>.preview.<app>`, and `/route` to the pin's port. The marker file is
  written into the worktree here.
- The proxy serves while editing; the rule below is for the FROZEN build only.
  The app's production API allows the preview origin by RULE, not by list:
  `cors.origins: o => o === own || o.endsWith('.preview.<app>')`, one line in the
  app's config, documented in sierra's README beside `VITE_API_URL`. No rows, no
  restart, nothing for Open to write; the hostname convention is the allow-list,
  and CORS is not an access control here (the token is a Bearer the page already
  holds). This replaces § Open's CORS question — see there.
- `/route` today dials a running container's port; a dev server is a process on
  a port the row names, so `/route` takes an explicit `port` where the App is
  `inline` with none active. Small outpost change, graded by its own tests.
- *Proof:* `basecamp` `verify:provision` — Open against the stand-in machine
  writes the four rows and the route call carries the pin's port.

### Slice 4 — Freeze, Thaw, Retire (basecamp) — built 2026-10-10, PR-close poll not built

**As built, where it departs from the bullets below:**

- **The build never enters a row.** *Hand `dist/` to `inlineFilesFor`* was
  measured before it was built and does not fit: the Sierra builds in this
  workspace run 25–180 files and 0.5–3.8 MB, against an inline source's 20
  files and outpost's 50. Raising both still stores megabytes in `App.source`
  and again in `Deployment.configSnapshot` on every Freeze, both trailed, and a
  Deployment is pushed whole to every browser in the workspace on each step.
  So Freeze publishes the build to the machine ITSELF (`/static/publish`,
  through `resolveExecutor`, the machine the job will pick) and releases the
  digest: `deployments.create { builtImage, trigger: 'freeze', commitSha,
  branch }`. A release of an inline App that names a digest snapshots
  `{ kind: 'inline', files: [] }` and runs Validate, Activate, Health check —
  no upload, so the App's placeholder is never sent over the build, and a
  rollback to it re-activates the digest. The commit names the bytes; a
  rollback past outpost's keep window says the machine no longer holds them.
- **The build** mirrors fli's desktop surface: `bun --bun vite build -c
  <web>/config/vite.config.js --outDir <tmp> --emptyOutDir` from `web/`
  (a plain `web/vite.config.*` is probed after Sierra's), with the App's
  plain `VITE_` variables, and the same refusal when no file carries
  `VITE_API_URL`. Text goes as `content`, anything else as `content_base64`,
  which outpost already read.
- **`commitSha` is HEAD only when the worktree is clean**, else null: the
  build is of the tree, and the deploy job's rule is that a release which
  cannot say which bytes ran says null rather than a plausible sha.
- **Activate routes the hostnames — for every inline app, not only a
  preview.** `/static/activate { hosts }` is `/deploy`'s shape: the route
  moves to the static origin first, then the symlink swaps. The job sends the
  live Domain rows. Caddy dials the origin with the Host set to
  `<app_id>.localhost`, and `activate` links the ID as a host label beside
  the slug — routed by SLUG, the second preview activated on a machine (every
  preview App is slugged `web`) would take over the first one's hostname.
  This closes the release-time half of `FJS-1615`'s inline case;
  `routeDomainApp` still skips an inline App between releases.
- **Outpost's limits are sized for a built SPA**: 500 files, 4 MB a file,
  24 MB a release.
- **Thaw is `/route { port }` again**, the push Open made — with the port read
  off the App row and the hostnames off its Domain rows, never off `opened`,
  which records what Open made. The static release stays on the machine;
  which of the two serves is what the route dials.
- **Retire is what Archive does to a preview, first, and it is
  `environments.remove` alone.** Removing an Environment retires each live
  App through `retireFromMachine` — the one owner of *deleting an app retires
  it from the machine*, which `apps.remove` calls too — and `/static/retire`
  takes the files AND the route off (whichever port it dialed); then the
  cascade stamps the App, Variables and Domain. A cascade alone told no
  machine (`FJS-2536`), and the delete stays the cascade so a restore brings
  the App back, stopped. It runs
  BEFORE the worktree goes, because Archive releases the port: a route left
  dialing a released port serves whichever branch claims it next. Archive's
  refusal (work not landed) is asked before anything is retired. A machine
  that cannot be reached does not keep the rows; it is reported in
  `retired.machine`, in its words.
- **Not built: Retire on PR close** — § Open questions. The poll is a cron
  with no caller, and every write here goes through a service as the caller,
  in their workspace. Owed after slice 0, not with it: `apps.service` refusing a non-static App under
  a preview Environment, and the *Fork for a client* control.
- *Proved:* `verify:provision` 13 checks beyond slice 3's, against outpost's
  own server and static store on the command port's TLS (docker and Caddy
  stand in): the hostname dials the dev server after Open; Freeze answers the
  digest, file count and HEAD; the release runs as `freeze` with three steps;
  the static origin, asked with the Host the route sets, serves the built page
  and its bundle carries `https://api.example.test`; Thaw dials back; Freeze
  on a plain checkout is refused; Thaw follows an edited App port; Archive retires with the machine's
  agreement, the hostname is unrouted, the files 404 by ID, the Environment
  404s and `wb/client` stays. Dropping `hosts` from the job's Activate turned
  exactly the two serving checks red. `inline-app.test.ts` one test (three
  steps, empty snapshot, a non-digest refused); outpost three (the route and
  the origin answering it, a second app taking the slug and not the
  hostname, refused with no static origin, retire unrouting a dev-server
  route).
- **The nine, answered late** (after the code was green — a check, not the
  decision; the owner question moved Retire's machine call into
  `apps.remove`): origin — the bytes are the commit's and the machine's, never
  a row's; the state is still the route and the release. Concept — none; a
  digest release is a Deployment, Retire is Archive's first step. Complexity —
  one build, one publish, one ordinary release. Predictability — Activate takes
  `hosts` as `/deploy` does. Derived — `VITE_` variables from the App's rows,
  the hostname set from Domain rows. Owner — the release is the deploy job's,
  the machine retire `apps.remove`'s, the build `domain/workbench/workbench-preview.ts`'s, the route
  outpost's. Boundary — every read and write as the caller. Failure — the
  build and the bundle check refuse before the machine is touched; a machine
  refusing the publish refuses Freeze; an unreachable machine at Retire is
  REPORTED rather than refused, since the stale route needs a later fork to
  claim that exact port on that machine to serve anything, and refusing would
  strand rows nobody can retire once the machine is gone. Silence — *stays
  true:* a preview's hostname reaches only its own App's files or its own
  branch's port, and a retired one answers nothing; *what fails:* the serving
  and unrouted checks in `verify:provision`, and outpost's
  second-app-same-slug test. Adjudications: *preservation vs. evolution*
  (`/static/activate`'s body grew `hosts` and every inline release sends it,
  no old shape kept); *batteries vs. smallness* (the preview stays in
  `domain/workbench/workbench-preview.ts` and the workbench; what reached the release path is
  `FJS-1615`'s fix, which every inline app needed); *ergonomics vs.
  strictness* (Retire's unreachable machine, above). Tier: Assessment.

The plan as written:

- **Freeze**: build `web/` in the worktree with the App's Variables, hand the
  `dist/` files to `inlineFilesFor` and dispatch an ordinary `Deployment`
  (`trigger: 'freeze'`, `commitSha` the branch head); `deployment-run.job.ts`
  publishes and activates as it does for any inline app, and the route follows.
- **Thaw**: `/route` back to the pin's port. **Retire**: `/static/retire`, route
  off, Environment soft-deleted; Workbench Archive keeps the branch.
- Retire on PR close: a job on Caravan cron reading `gh pr view --json state`
  for every open preview; a GitHub webhook through junction's `webhooks` battery
  is the upgrade where the machine is reachable. Poll first — it needs no inbound
  route and the number of open previews is small.
- *Proof:* `verify:provision` — open, freeze, GET the hostname and see the built
  UI, retire, GET and see nothing. This is the § Silence artefact the nine owed.

### Slice 5 — after it works

- Anchored feedback (`anchored-feedback.md`) on the frozen preview: a pin's
  thread becomes the next ask-panel message. Needs the preview mode that stamps
  `data-fjs-loc` in a build.
- The panel as a chat: the Workbench's conversation layout in Basecamp —
  collapsible side panes, a thread rather than a box — brought to the ask panel,
  which is what a client sits in all day.
- Cost: the Workbench's running-cost card per preview pin, and a per-pin budget
  the client cannot raise.
- The fleet-machine host (§ Open's option B) if slice 0's measurement says a
  dev box and a tunnel do not hold.

### Rulings this will ask for

- ~~`/route` taking a port for an inline App with no active release~~ —
  answered in slice 3's *as built*; a ruling only if the owner disagrees.
- ~~The marker file's name and place in a worktree~~ — answered in slice 2's
  *as built*; a ruling only if the owner disagrees.
- Relaxing the Workbench's `LOCAL_MACHINE` refusal for a worktree a fleet
  machine owns — only if slice 5's host question lands on B.

## Against the nine (§ V), before any edit

1. **Origin** — none new: status is the PR's, the branch is git's, the port
   block is `claimSession`'s, the Environment is the Release realm's word.
2. **Concept** — none new. *Preview* is an Environment, the branch is a
   Workbench branch, Submit is a control. `Proposal` was considered and cut
   (§ VII already spends the word).
3. **Complexity** — the problem's: the field converged on branch + preview +
   PR independently (Decap, Vercel, Shopify), and each half here is already
   named.
4. **Predictability** — a preview behaves as a second checkout of the app does
   everywhere else (`FJS-D841`), and its panel as the dev server's does.
5. **Derived** — PR status derived, never stored; the UI-only rule derived from
   the `edit` scope and graded rather than restated.
6. **Owner** — each piece has one and it exists: `vite-ask.js` the panel,
   `askArgv` the scope, `workbench-branch.ts` the branch, `claimSession` the
   ports, `fli check` the rule. The one addition is a control and a check inside
   those owners, not beside them.
7. **Boundary** — the dev server admits a principal by the schema's gate level;
   the run's scope is a path; the refusal names the files.
8. **Failure** — a diff outside `web/` is REFUSED at Submit (destructive if
   merged), a long-running or over-budget run WARNS on the card, a pick that
   resolves to no source lists as unpicked.
9. **Silence** — *stays true:* a preview branch's diff is under `web/` only;
   the panel on a hosted preview admits no anonymous caller. *What fails:* a
   `fli check` rule for the first; for the second a drive case against the
   hosted dev server with no session, `none` until the drive exists — owed with
   the first slice.

Adjudications: *batteries vs. smallness* (the whole thing is a battery over
the Workbench and the panel; Sierra's core gains nothing), *ergonomics vs.
strictness* (a client's run is scoped and refused, the owner's is bypass — cost
decides, not temperament), *paved road vs. the workaround* (a client emailing
screenshots of what to change is the workaround this measures). Tier:
Assessment (`IDEAS/`).

## Open questions

- **Where the preview machine runs.**
  - **A** — the owner's dev machine, under `LOCAL_MACHINE=1`, exposed through
    a tunnel.
  - **B** — a fleet machine outpost runs, with the Workbench's local-machine
    refusal relaxed for a worktree it owns.
  - **Recommend A** — first: it is what exists, and B is a ruling about the
    refusal that should wait for slice 0's measurement.
- **CORS.**
  - **A** — production's allow-list stays a config file and Open edits it
    over ssh.
  - **B** — the API derives it from preview `Domain` rows at boot and on
    change.
  - **C** — a hostname rule, `o.endsWith('.preview.<app>')`, since
    `cors.origins` takes a function.
  - **Recommend C** — no list at all, so nothing to drift; A and B each keep
    one. § Game plan slice 3 assumes C.
- **Whether the client sees a diff at all.** Shopify shows none; Vercel shows
  comments.
  - **A** — none.
  - **B** — the diff, beside the preview.
  - **Recommend A** — the preview is the diff a client can read; slice 0
    measures whether a client asks for more.
- **Retire when the pull request closes.**
  - **A** — record who opened the preview at Open, and a Caravan cron reads
    `gh pr view --json state` and retires as them in that workspace, through
    `app.runAs(userId, fn)`.
  - **B** — no automatic retire. Archive already retires, and the Workbench
    card shows the pull request's state so a person archives it.
  - **C** — a GitHub webhook through junction's `webhooks` battery; it needs a
    machine reachable from outside.
  - **Recommend B** — few previews are open and Archive covers it. A is a
    job acting as a user who is not present, a new boundary that needs
    slice 0's numbers before it is worth building; revisit A when the number
    of open previews grows.
