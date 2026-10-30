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

---

# Handoff — 2026-10-23 (backups leave the box, on the day three real boxes enrolled)

> **Started from `IDEAS/backups.md` with six questions open and nothing past a
> local `backup:run`, and ended with Phase 1 closed: a hub archive and an app
> archive each land in a bucket by a pre-signed PUT, retention prunes both
> sides, a refused upload keeps the file and says so, and the operator's recipe
> exists.** The through-line: every question was ruled before its step was
> built, and every step reused a door that already existed — `backup:run`,
> Outpost's `/backup`, `NotificationChannel`'s credential shape — so the day
> was eleven steps rather than a design.

**What is recorded where.** The six rulings are `FJS-D1485`–`FJS-D1488`,
`FJS-D1490` (Q5: basecamp LIFTS `conduit-s3` into `providers/storage/`, since
`FJS-D1185` rules a `link:` on the sibling out) and `FJS-D1491` (Q6:
`BackupDestination` is workspace-owned). Five more fell out of building:
`FJS-D1493` (a rescanned archive is `found`), `FJS-D1494` (one delete helper),
`FJS-D1495` (`AppBackup.kind` gains `release`), `FJS-D1496` (the pre-swap
*Back up volume* step is fatal with no opt-out) and `FJS-D1497` (a copy of
`ENCRYPTION_KEY` off the box is a person's attestation, graded by
`hub.key-escrowed`). The recipe is `packages/basecamp/docs/BACKUPS.md`;
`packages/basecamp/PROJECT_STATE.md` § Backups leave the box is the build
record. Steps 1.1–1.4 are committed (`038bce79`); 1.5–1.9 are in the
working tree.

**The same day, by hand, on real machines.** `fli basecamp:create` ran three
times (ops, ops2, ops3) and each fresh Ubuntu 24.04 box found a failure the
stand-ins could not: the security pass's systemd re-exec raced the Docker
install (`FJS-3469`), the upgraded openssh left `/run/sshd` gone so `sshd -t`
refused (`FJS-3473`), a box enrolled unpatched (`FJS-3462`), a download-only
apt pass read as an upgrade (`FJS-3463`), the sandbox score and the static
origin's bind (`FJS-3464`, `FJS-3465`), every app as host uid 1000
(`FJS-3474`, ruled `FJS-D1484`: SSH and Outpost stay root, the isolation owed
is a uid per app), and a rollback that lost the secrets directory
(`FJS-3476`). All closed the same day. `FJS-D1481`–`FJS-D1483` settled how a
static App built on a laptop reaches a box. Hetzner as a flag got its Phase 0
and 1 on stand-ins (`FJS-D1478`–`FJS-D1480`); 2.1, a real token, is the
owner's.

**Also ruled that day.** `FJS-D1492`: local speech-to-text is Parakeet through
sherpa-onnx, not whisper.cpp, off a 45-minute call measured on CPU (RTF 0.115
against 0.65); the plan is `IDEAS/transcription.md`, Q1–Q3 open. The Frontier
network's Haven side closed: a login is the chain (`FJS-D1476`), and a Haven
takes nothing else (`FJS-D1477`).

**The night pass, 2026-10-23/24.** `fli done` on the tree named two rows with
an invalid status and a tracked build cache; `fli close` moved `FJS-3469` and
`FJS-3473`, the cache is now ignored. The drives it named ran: `verify:provision`
243/243, `verify:outpost` 48/48, `verify:pages` 24/24, outpost `verify:docker`
54/54 — the last only ALONE, since two drives sharing Outpost's port read as 32
failures. Seven tests red on COMMITTED main were filed rather than fixed:
`FJS-3479` (example/desktop drifted from `make:desktop`), `FJS-3480` (`fli ask`
at 21 of 24), `FJS-3481` (a verb-ended term candidate), `FJS-3482` (sierra's
`composed: true` warning never fires); all four deterministic and dated to the
10-21/22 renames.

**What is NOT proved.** `verify:screens` stops at the path-route check, which
is `FJS-3477`, filed that morning and open. The hand run against a real B2
bucket that Phase 1's done-when asks for has not happened. The owner's dev
`basecamp.db` predates the new tables and needs a reset. Nothing after
`038bce79` is committed on the date above.
