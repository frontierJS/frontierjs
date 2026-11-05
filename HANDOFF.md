# Handoff

**The two most recent sessions, narrative. `fli register:archive` rotates
older ones into `docs/handoff-archive/`.** This is an assessment file (`PHILOSOPHY.md` §VII):
dated, never cited as behavior, and read cold rather than consulted.

**It names nothing a register does not also hold.** A defect gets an id in
`ISSUES.md`, a settled argument a ruling in `DECISIONS.md`, a shipped change a
commit, and a live fact a sentence in a `CLAUDE.md`.
What belongs here is the ORDER those were found in and why one led to the next —
the half a register cannot carry, and the half that costs nothing when the entry
rotates out. A session that ends with something recorded only here has not
finished.

---

# Handoff — 2026-11-05 (the 26 connectors come home)

The conduit connectors prototyped in the sibling `conduit-connectors/` repo
since 2026-10-11 moved into `packages/conduits/conduit-<x>/` as workspace
members (`FJS-D1559`; plan `IDEAS/conduits-move.md`, every box closed). The
order mattered: the sibling was committed first and renamed there (tax into
stripe, shipping to easypost, push split into apns and google's fcm module,
google-maps to google — `FJS-D1915`–`D1919`), then one workspace-membership
owner (`packages/cli/core/workspace-members.js`) replaced 27 one-level
`packages/*` walkers so a member two levels down is seen everywhere, and only
then was the code copied. They are set apart (`FJS-D1913`): ring `conduits`
in the atlas, one group row per drives table that `fli proves` expands to 28,
held out of `ws:pub` and every `ws:*` list, typecheck-ratcheted, and a CI lane
that runs only when a connector path changes (its skip path fires first after
the commit). A connector's suite is its drive; all 26 are green
from this tree with `bun run --filter './packages/conduits/*' test`. The three
prototypes that linked the sibling (chat, chatwoot, serpgrid) follow the new
path. Later the same day the group grew to 28: `conduit-sendgrid` (14 rows) and
`conduit-dataforseo` (12 rows) built as stubs from their callers
(`IDEAS/conduit-connectors.md` rows 14–15), and `toolbelt/units` gained the
declaration three baselines were waiting on. Neither new connector is adopted.

---

# Handoff — 2026-10-31 (a 19-package release, then a red CI holds the next one)

> **10-30 shipped 19 packages (cli 0.1.11, litestone 1.1.13, sierra 0.1.10)
> once `9a5d19c1` cleared the pre-push CI failures; 10-31 was parallel
> plan-and-audit sessions, committed through `f624e49a`.** The through-line: every
> release that gets stuck after tagging traces to `FJS-009` (CI has never gone
> green on a runner), so the publish-order fix is held until it closes.

**The order, and why.** Stuck releases (pre-push CI failing after `ws:pub` had
already tagged) produced `IDEAS/publish-order.md` and rulings `FJS-D1720`–`D1738`:
full `ci` gates the tag, in a worktree of the release sha. 1.1–1.2 are on dev;
1.3 and Phase 2 sit on branch `publish-order-integ`, held because a gate that
cannot pass would block every release. A beta-readiness pass the same day named
the same blocker first, ahead of the deploy-for-outsiders gaps. Alongside: a
per-call perf audit (`docs/perf-audit-2026-10-31.md`, `FJS-3742`–`3762`,
ruling `FJS-D1713`) closed every row fixed or refuted; app archives closed
(`FJS-D1735`, `FJS-3793`); the Claude Code Workbench tab reached Phase 4
(`FJS-D1708`–`D1714`, `D1733`, `D1734`); the laptop wing (workbench, atlas, decide,
autopilot, Claude tab, local git) left Basecamp for its own private app `packages/workbench`
on 5501/5508, dialing Basecamp's `apps.preview` as a signed peer (`IDEAS/workbench-package.md`,
`FJS-D1785`–`D1788`, uncommitted 2026-11-03); the clinical, expenses and pulse
stressors ran to their briefs (`FJS-D1698`–`D1700`) and seven more Tier 1
stressors got a `PLAN.md` each. ALONGSIDE.md and `alongside/` were deleted.

**Where each thread picks up** — run `fli plan <file>` for the box:

- `FJS-009`, then merge `publish-order-integ` and run `IDEAS/publish-order.md`
  Phase 2's scratch replay.
- `IDEAS/claude-code.md` Phase 5, after the owner has used Phases 1–4.
- Framework builds the three stressors owe: `FJS-3708` (`D1698`),
  `@stamps(by:)` (`D1699`), the `@@anonymous` read refusal (`D1700`).
- Stressors #29/30/34/35/38/39/40 in `fjs-prototypes/`: Phase 0, each Qn's
  recommendation to the owner before Phase 1.
- Frontier Town (`fli ws:world`) lives on branch `world`, plan and all, in the
  `frontierjs-world` worktree; it waits on the owner's review and merge call.

**What is NOT proved or still owed.** CI is red at a clean sha (`FJS-009`).
`example verify:migrate` did not run after the Workbench
migrations. Basecamp's dev db still needs the owner's `db:reset`.

---

# Handoff — 2026-10-29 (seventeen parallel sessions closed; where each thread stopped)

> **A day of parallel sessions ended with the 21-package release, Outpost
> 0.1.8 and toolbelt 0.1.7 / litestone 1.1.12 on npm, and nearly every change
> committed in the `updates` commits through `34c763c4`.** The through-line:
> one publish (`FJS-3592`) gated four plans, and `FJS-3616` came out of it.
> Every thread below now lives in a register or a plan box; this entry only
> says where to pick each one up.

**The order, and why.** `FJS-3592` (`./env` added to toolbelt without a version
bump) blocked package-host 3.1's `auth:install` proof and box-layout 4.1's
Outpost publish, so three sessions converged on one `ws:pub`. That release made
every GitHub Release before pushing its commit and all 21 were refused;
`FJS-3616` swapped push before publish and moved `gh` to `--verify-tag`; it closed
on a `ws:pub` run against a bare remote and a `gh` that refuses as GitHub does. The CI sweep afterwards
closed `FJS-3592`, bumped `OUTPOST_VERSION` to 0.1.8 and rewrote `tutor:fleet`
for key pairs. Alongside: server render without a DOM shipped (`FJS-D1649`,
the plan is `shipped`), Web Push closed with `verify:push` (`FJS-D1641`),
app-platforms reached 1.4, basecamp-dogfood reached 2.4 (Outpost key pairs,
`FJS-D1644`–`D1646`), `fli db:reset --seed` landed, and `fli deploy`'s reconcile
(`FJS-D1599`) got its routes half (`FJS-3529`).

**Where each thread picks up** — run `fli plan <file>` for the box:

- `IDEAS/basecamp-dogfood.md` 2.5. Then 2.6, whose failure is probably one of
  `FJS-3627`'s three; the whole 0.9 drive list reruns after Phase 2.
- `IDEAS/app-platforms.md` 1.5. The peer edit to `apps/[id]/index.mesa` it
  waited on is committed. The live drive against `fjs-platform-probe` needs the
  owner to say where the `cfat_` token lives.
- `IDEAS/package-host.md` 3.2, behind Q1 and Q2.
- `IDEAS/box-layout.md` 4.2: the owner reinstalls Outpost on yuma.
- `IDEAS/zero-to-live.md` Phase 0 (0.3 needs a real droplet); `IDEAS/backups.md`
  5.4 waits on it.
- `FJS-3529`: remove `neverReleased` so preflight and setup share `releasePlan`.

**What is NOT proved or still owed.** `fli db:reset --test --seed` rebuilds
the test database but the seeder probably writes the dev one. The cli suite's
`repo-rings` › *every route renders* found `undefined` on the Decisions page
once and was never run again. Outpost `verify:docker` failed three disk/volume
checks (`FJS-3557` covers one). Basecamp's dev `basecamp.db` predates the
latest rewrite of `initial_schema.sql`, so four snapshot checks need the
owner's `db:reset`. The Survey theme moved to Catppuccin Mocha purples and is
uncommitted; its two new tokens (`--surface-depth`, `--app-depth`) owe a
`decision-rules` pass. The tpm ui-kit Phase C tickets were still being
drafted when this was written.

---

# Handoff — 2026-10-24 (backups go continuous, Basecamp's own database included)

> **Started at `IDEAS/backups.md` 2.1 and ended with Phase 2 closed: every
> enrolled box runs a pinned Litestream under its own unit, Basecamp sends each
> box the list of apps to replicate, the lag reaches the App screen and
> `backup.replica-lag`, and Basecamp's own box replicates its database through
> its own Outpost.** The through-line: one list, one sender. Every write that
> changes what a box replicates queues the same sync job, and the hub's own
> database rides that list as a `host` entry rather than a second mechanism.

**The order, and why.** 2.1 moved the Litestream pin and installer into
`@frontierjs/litestone/replicate`, so `deploy:setup` and the fleet install
cannot disagree on a build. 2.2 gave Outpost `/replicate`. 2.3 began on
Litestream's `addr` metrics and the probe said they cannot measure bucket lag
(0.5.17); the control socket's `GET /list` `last_sync_at` can, so the heartbeat
carries that. The exit drive needed an S3 stand-in, MinIO's free edition is
archived, and the owner picked SeaweedFS; it ran 10/10 from a scratch script
(not committed). 2.4 found two things. First, `basecamp-host` is a slug unique
per workspace and reserved nowhere, so the host entry goes only to the host row
in the destination's own workspace; the grade's lookup has the same gap,
`FJS-3488`. Second, a `@@tenant(none)` HubConfig naming a tenant-owned
destination fails the hidden-parent check, which `backupDestinationId` through
`save` already did; the pointers are now written at system, alone, after the
scoped save.

**What is NOT proved.** Nothing ran under systemd on a box: not the unit, not
the `host.conf` drop-in (`fli deploy` writes it; run twice against a fake root),
not whether `ReadWritePaths` lifts `ProtectHome=read-only`. The App screen's
replication badge was compiled, never seen in a browser. `verify:screens` still
stops at `FJS-3477`; outpost `verify:docker` was not rerun after 2.2–2.4. Which
vendor Basecamp should recommend as the default destination was never
researched; B2 is only the first one tested. The cli suite's four reds are
`FJS-3479`–`FJS-3481`, already filed. Nothing from 1.5 on is committed, and the
owner's dev `basecamp.db` still needs their `db:reset`.
