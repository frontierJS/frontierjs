---
id: server-posture
status: proposed
dated: 2026-10-05
---

# Idea — Server posture: Basecamp grades the machine, not only the app on it

**Status: IDEA.** Probed against the tree 2026-10-05, the Security route and
Basecamp's own host 2026-10-12 (`VERIFYING.md`). Do not cite this file as behavior.
Filed: [`FJS-2712`](../ISSUES.md#fjs-2712) (harden at install) ·
[`FJS-2713`](../ISSUES.md#fjs-2713) (readings, grader, screens) ·
[`FJS-2714`](../ISSUES.md#fjs-2714) (Basecamp's own host) ·
[`FJS-2715`](../ISSUES.md#fjs-2715) (a vulnerable dependency notifies nobody).

Prompted by the owner: *creating an app is no big deal; it is once it is live —
updates to the server, db pushes, backups — that it gets tricky.* This record is
the first half of that, the machine. The update flow it ends on is the hinge to
the second half.

**Posture** is the word the repo already uses for *standing against known risk*
(`ci.mjs`'s dependency posture, `IDEAS/tooling-decisions.md` 5). This is the same
question asked of a machine instead of a lockfile.

---

## What exists (probed)

| Piece | Where | Reused as |
| --- | --- | --- |
| The install, one script both ways a machine gets it | `basecamp/api/src/providers/compute/enrollment.ts` `installScript()` | **where hardening goes**: docker, caddy, bun, the cert, enrollment, `outpost.service`. Nothing else is configured |
| The one place a command runs on the box, injectable runner | `outpost/src/docker.js` `createInspector` | **where the readings go**, beside `disk()` and `volumes()` |
| Outbound reports on their own clocks, one signed POST | `outpost/src/report.js` | a fourth report, `posture`, on a slow clock |
| A report becoming a row and a screen | `/cleanup report` → `DiskUsage` → `CleanupRun` | **the shape to copy**: reading, then a run that acts and records what it did |
| A pure grader, no db and no clock, `no-data` ≠ fine | `basecamp/api/src/core/alerting.ts` | **the shape of `gradePosture`** |
| Drain / undrain on a server | `ServerStatus.draining`, `servers` service | the step before a patch that restarts docker |
| Delivery | `NotificationChannel`, `notifyPeople`, the metric store + `AlertRule` | posture failures, unchanged |
| The outside view | `IDEAS/uptime-monitoring.md` probes from the Basecamp process | the same vantage for the port probe |

**What is absent:** no firewall, no unattended upgrades, no sshd settings, no
provider cloud firewall at provision, and no reading of any of it. The heartbeat
carries `outpost_version` and nothing about the OS.

### Found while probing

- **Docker gets around a host firewall.** A published port is DNAT'd in
  PREROUTING and forwarded through Docker's own chains. ufw's INPUT rules never
  see it. `docker.js` publishes an app with no hostname on every interface
  (`FJS-D565`, deliberately, until `FJS-D930` lands), so adding ufw alone would leave that port open while
  `ufw status` reads closed. Filtering belongs in `DOCKER-USER`, or at the provider.
- **`outpost.service` runs as root with no sandboxing**: no `User=`, no
  `ProtectSystem`, no `NoNewPrivileges`. Docker access is root-equivalent anyway,
  so the gain is in narrowing what a compromised Outpost can write, not in the user.
  [`FJS-1761`](../ISSUES.md#fjs-1761).
- ~~**The install is unpinned**~~ — closed, [`FJS-1762`](../ISSUES_ARCHIVE.md#fjs-1762).
- ~~**Nothing installs or checks time sync**~~ — closed: the install sets up
  `chrony`, [`FJS-1763`](../ISSUES_ARCHIVE.md#fjs-1763). `time.synced` still grades it.

---

## Prior art

| Who | Model | What transfers |
| --- | --- | --- |
| [Laravel Forge](https://laravel.com/forge/docs/servers/security.md) | hardens at provision | ufw deny-all + 22/80/443, key-only SSH, fail2ban, weekly `unattended-upgrades`. The default floor |
| [Coolify server patching](https://coolify.io/docs/core/infrastructure/servers/server-patching) | checks, a person applies | weekly check + notify, update per package or all. Warns that a docker update restarts every app |
| [dev-sec](https://github.com/dev-sec/ansible-collection-hardening) (`devsec.hardening` + InSpec `linux-baseline`/`ssh-baseline`) | hardening paired with a check | **every hardening step has a control that grades it** — the pairing this design keeps |
| [CIS / Ubuntu USG](https://ubuntu.com/security/certifications/docs/cis) | hundreds of rules, L1/L2 | a catalog to draw controls from, not the product; USG needs Ubuntu Pro |
| Lynis | agentless, a hardening index | a cheap second opinion run on demand |
| [Wazuh SCA](https://documentation.wazuh.com/current/user-manual/capabilities/index.html), osquery + Fleet | agent reports, server grades | **the split Outpost/Basecamp already have** |
| docker-bench-security, Trivy | Docker CIS checks; image CVEs | containers are surface too; later phase |
| [Vigil](https://github.com/VigilOSS/Vigil) (Apache-2.0, read 2026-10-12) | AI pentest harness: specialist agents in a Kali container, each finding verified by a second agent | **an attacker's view, not a posture check** — run by hand, under authorization, against Basecamp's own surface. Never a dependency: it needs a cyber-cleared model and a person approving each exploit |

---

## Design

### Outpost reads, Basecamp grades

The Outpost reports **facts** and never a verdict. What a machine *should* look
like is derived from Basecamp's rows — which apps it runs, which have a
hostname, where Basecamp itself is — so a grader on the box would be a second
owner of that, and a stale one until the Outpost is upgraded.

**`inspector.posture()`** in `docker.js`, every command an argv array:

| Group | Reading | Source |
| --- | --- | --- |
| os | id, version, codename | `/etc/os-release` |
| patching | running vs newest installed kernel, reboot-required (+ since when), pending updates and how many are security | `uname -r`, `/var/run/reboot-required`, `apt-get -s upgrade` |
| patching | unattended-upgrades enabled, last run | `apt-config dump`, its log |
| versions | docker, caddy, bun | `--version` |
| network | listening sockets with address and process | `ss -tlnpH` |
| network | published container ports with host ip | `docker ps --format` |
| network | firewall ruleset, `DOCKER-USER` contents | `nft -j list ruleset` |
| ssh | effective config subset: `passwordauthentication`, `permitrootlogin`, `pubkeyauthentication`, `maxauthtries` | `sshd -T` |
| ssh | authorized key fingerprints per user | `ssh-keygen -lf` |
| accounts | uid-0 users, `NOPASSWD` sudo rules | `/etc/passwd`, `/etc/sudoers.d` |
| runtime | time sync active, offset | `timedatectl show` |
| runtime | outpost unit exposure score | `systemd-analyze security outpost --json=short` |
| runtime | privileged containers, `docker.sock` mounts | `docker inspect` |
| files | `/etc/basecamp` modes, cert expiry | `stat`, `openssl x509 -enddate` |

A reading whose command fails is **`unknown`**, not absent and not passing. That is
`alerting.ts`'s *no-data ≠ resolved*, for the same reason.

**Reported** by `report.js` as `post('/posture', 'report', …)` on a slow clock
(6h, plus once at start) and on demand through a signed `POST /posture` for the
screen's *check now*.

### `core/posture.ts` — the one grader

`gradePosture(readings, declared) → Control[]`, each
`{ id, group, ok: true|false|'unknown', severity, message }`. It is pure and
exported, and it is where the tests go.

**`declared` is derived, never typed in:**

- **Expected listening set** = 22 (or `Server.sshPort`), 80, 443, 8180 (8181 when
  the static origin is on), plus the port of each app on this server that **declares raw-port
  exposure** (`FJS-D930`). Every other app must be on loopback only. Anything else listening on a public address is a finding by name.
- **The command port's allowed source** = Basecamp's own egress address.
- **Authorized keys** = the `ssh_key` `Secret` that `Server.sshKeyId` names. A key
  on the box Basecamp does not know is a finding. The column holds one key, so
  a box several people reach needs either more of them or a way to acknowledge a
  key, which phase 1 settles by reading what is actually there.

Controls start as a short list, each a line in the code with its CIS or dev-sec id
in a comment:

`ssh.password-off` · `ssh.root-key-only` · `ssh.unknown-key` ·
`net.firewall-default-deny` · `net.unexpected-listener` ·
`net.container-public` (published on `0.0.0.0` with no matching `DOCKER-USER`
rule) · `net.caddy-admin-loopback` · `patch.security-pending` ·
`patch.auto-updates-on` · `patch.reboot-pending` (graded on age) · `os.eol` ·
`time.synced` · `outpost.sandbox` · `outpost.cert-expiry` ·
`accounts.extra-uid0` · `docker.privileged`.

### The outside view

The box can misreport, and Docker can make it misreport innocently. Basecamp
also **connects from outside** to the server's public address on a fixed list of
ports (the expected set plus common leaks: 2019, 2375, 3000–3999, 5432, 6379,
8000–8999), on the uptime monitor's vantage. Where the server has a provider
(`providerKind` hetzner/digitalocean), it also **reads the cloud firewall** through
the existing Conduit target.

A port that answers from outside and is not in the expected set is the strongest
finding this design produces. `net.reachable-unexpected` is graded from this probe
and never from the box's own readings.

### Storage and delivery

- **`ServerPosture`** — one row per report: `serverId`, `at`, `readings Json`,
  `controls Json`, `failing Int`. Pruned by `retention.job.ts` like `MetricPoint`.
- A control changing state writes a **`ServerEvent`**, `posture_failed` or
  `posture_restored`, naming the control. That is the history that answers *when
  did this stop holding*. No new event model.
- `server.posture.failing{serverId}` goes into the metric store, so an `AlertRule`
  covers thresholds unchanged. A new notification kind `posture_failed` follows
  `server_unreachable`'s two addressees.
- **A failing control never refuses a deploy.** It is a warning on the server row
  and a notification. Refusing deploys on an sshd setting would turn a hygiene
  finding into an outage (*ergonomics vs. strictness*: strictness follows what the
  mistake destroys).

### Where it is seen — the Security route

A Posture tab on one server page answers *is this box sound*. Nothing answers
*which of my boxes is not*. **`/security/`** does, and it covers a workspace's machines
and its code together, because an operator asking whether they are exposed means both:

- **Machines, worst first** — one row per server: failing controls, `unknown`
  controls, and the age of the last report. A report older than twice its interval
  reads **stale**, never clean. Findings from the outside probe sort above
  everything the box reported about itself, because they are the strongest evidence.
  A row opens the server's Posture tab, where *Check now*, *Harden* and the patch run
  live. This screen reads; acting stays on the server page, at the gate the action
  already has.
- **Code** — the `vulnerable` count from `Dependency`, linking to `/dependencies/`
  filtered to it. The advisories are already there. What is missing is the push:
  a dependency turning vulnerable sends no notification
  ([`FJS-2715`](../ISSUES.md#fjs-2715)). The fix is a `dependency_vulnerable`
  notification kind, sent when an installed version first gains an advisory and
  not again each day.

The route reads `ServerPosture` and `Dependency` at the caller's level. Both are
workspace-scoped, so the tenancy block keeps a workspace to its own rows without
the screen doing anything.

### Basecamp's own host

**The box most worth grading is the one this design never reaches.** Ring 0
(`fli deploy`) installs Basecamp, and no Outpost runs there, so nothing ever
reads that box ([`FJS-2714`](../ISSUES.md#fjs-2714)). It is also the box with
`ENCRYPTION_KEY`, every workspace's `Secret` rows and the command key for the whole
fleet. The API runs in a container, which cannot see the host's `sshd -T` or its
nftables ruleset, so the readings must come from outside the container.

**The same readings, run in a report-only mode.** `fli deploy` installs the Outpost
on the host with its command listener **off**: `report.js` posts `posture` to the
API over loopback on its clock and nothing listens. That is one implementation of
the readings and no second command port on the control plane. The rows are
`ServerPosture` with **`serverId` null**: a null means *the installation's own host*,
which only the hub reads. That is `AuditEvent`'s null-workspace reading
(`FJS-D141`) applied to the same kind of row.

**Some controls only the host has:** `hub.backup-recent` (the newest `Backup`
row, graded on age, in process) · `hub.db-mode` and `hub.env-mode` (the database
volume and the file holding `ENCRYPTION_KEY` are not world-readable, from the
reading). A setting that already refuses itself under production is not graded
again: `localMachineRefusal`, devtools with no gate, and a missing `ENCRYPTION_KEY`
each stop the boot, so a control for them could never fail.

**The outside probe needs a vantage that is not on the box.** Basecamp probing its
own public address goes out and comes straight back to the same machine, so it
proves nothing. An enrolled fleet Outpost probes the host instead. With no fleet
machine, `net.reachable-unexpected` is `unknown` and the screen says why.

**The host is graded and never acted on through ring 2.** *Harden* and the patch run
are refused on it: draining the plane drains the thing running the drain, and
*the plane never upgrades itself through ring 2* (`IDEAS/deploy-plane.md`). Its fixes go
through ring 0. The screen shows the `fli deploy` command to run.

**`/hub/security/`** shows the host's controls under the same grading and states as
`/security/`, behind `isSystemAdmin` like every other `/hub/` screen. It is a second
route, not a section of `/security/` ([`FJS-D924`](../DECISIONS.md#fjs-d924)), and
the readings leave the box through the report-only Outpost
([`FJS-D925`](../DECISIONS.md#fjs-d925)).

### Harden at install, each step paired with a control

Added to `installScript()`:

| Step | Control it satisfies |
| --- | --- |
| `unattended-upgrades`, security origin only, **`Automatic-Reboot "false"`** | `patch.auto-updates-on` |
| sshd drop-in `/etc/ssh/sshd_config.d/10-basecamp.conf`: password off, root `prohibit-password`, `MaxAuthTries 3` | `ssh.*` |
| nftables ([`FJS-D928`](../DECISIONS.md#fjs-d928)): input default drop, allow the expected set, 8180 from Basecamp only; `DOCKER-USER` drop of non-established traffic to container ports not in the expected set | `net.*` |
| `chrony` | `time.synced` |
| `outpost.service`: `NoNewPrivileges`, `ProtectSystem=strict` with `ReadWritePaths` for its own dirs, `PrivateTmp` | `outpost.sandbox` |
| provider cloud firewall, created by `server-provision.job.ts` with the server | `net.reachable-unexpected` |
| Docker and Caddy pinned to a major by apt preference; the versions beside `BUN_VERSION` in `enrollment.ts`, installed versions reported in the heartbeat ([`FJS-D931`](../DECISIONS.md#fjs-d931)) | — |
| No fail2ban ([`FJS-D929`](../DECISIONS.md#fjs-d929)) | — |

**The pairing is a test**: every control marked `hardenedAtInstall` names a marker
the install script contains, and `installScript()` contains no hardening marker
without a control. Without that test, the script and the grader are two
statements of one setting and drift apart.

An imported machine, or one enrolled before this lands, gets a **Harden** action
on its server page. It runs the same steps through the Outpost, shows the diff of
findings before and after, and is never automatic. Basecamp did not build that box.

### Patching: automatic for security, by hand for anything that restarts

- **Security updates apply themselves** (unattended-upgrades, as Forge does). They
  do not reboot and they hold back docker.
- **Everything else is shown, then applied on a click**, as Coolify does. That
  covers a kernel, a pending reboot, docker, caddy and the release upgrade.
  `patch.reboot-pending` turns from `low` to `high` severity after a set number of
  days.
- **The click is a run**, a `MaintenanceRun` of kind patch (`FJS-D825`): `server-patch.job.ts` drains the
  server, has the Outpost run `apt-get upgrade` (a signed `POST /system/upgrade`, the
  argv owned by the Outpost and not a caller string), reboots if required, waits for
  the heartbeat, re-reads posture, undrains, and records **what was upgraded,
  from what version to what**. That record is a row because *what changed on this box
  last Tuesday* is the question the next incident asks.
- **One server running an app means draining takes it down.** The screen says that
  before the click, with the apps that will be down.

---

## The nine

1. **Origin.** The expected state is derived from rows Basecamp already holds. The
   one second statement is install step vs. control, and the pairing test closes it.
2. **Concept.** One noun, *posture*, already in the repo with this meaning. The
   readings are a *report* (the Outpost's word) and the patch is a *run* (the
   cleanup word). The patch run widens `CleanupRun` into `MaintenanceRun`
   (`FJS-D825`).
3. **Complexity.** It belongs to the problem: CIS, dev-sec and Wazuh SCA all
   converged on *an agent reports, a server grades, each control pairs with a fix*.
4. **Predictability.** It copies the disk report's path and the alerting grader's
   purity. Nothing here behaves unlike its sibling.
5. **Derived.** The listening set, the allowed source and the known keys are derived.
   The controls are code, not a table, because each one is a reading plus a rule.
6. **Owner.** Commands → `createInspector` (exists). Grading → `core/posture.ts`
   (new, beside `alerting.ts`). Delivery, metrics, events → existing owners.
7. **Boundary.** One signed report and two signed routes, snake_case on the wire like
   the others. The upgrade argv is the Outpost's, so no caller text reaches a shell.
8. **Failure.** It warns and never refuses. An unknown reading is distinct from a
   pass. The patch run is the only destructive step and it is gated (`@gate(5)`,
   drain's level) and confirmed with a named list of affected apps.
9. **Silence.** *What must stay true:* a machine that stopped reporting posture never
   reads as clean. *What fails when it stops:* the grader marks every control
   `unknown` past twice the interval, with a test, and the server row shows the age.
   *Install and grader agreeing:* the pairing test. *The box lying:* the outside
   probe, which needs nothing on the box.

Adjudications in tension: *ergonomics vs. strictness* (warn, not refuse; above),
and *batteries vs. smallness*. The Outpost grows a read-only inspector method and
two routes, which stays severable inside the one file that already runs commands.

**Tier:** Assessment. Every question is ruled; nothing blocks a phase.

---

## Phases

### Phase 0 — Read the box before writing the reader

Goal: every reading's real output, captured, and the tree re-checked against
§ What exists.
Done when: `packages/outpost/test/fixtures/posture/` holds one capture per row of
the readings table, from a fresh enrollment image, with the commands that need
root or fail marked.

- [ ] 0.1 Run each readings command on a fresh box from `server-provision.job.ts`
  (a droplet-hour, the owner's call) and on the dev host; save the outputs as
  fixtures and note which ones exit non-zero, because those grade `unknown`.
- [x] 0.2 Re-probe the tree for the rows this plan leans on.
  - `CleanupRun` is still `CleanupRun`: `FJS-D825`'s `MaintenanceRun` is ruled and
    unbuilt, so it is step 5.1.
  - `Dependency` has no vulnerable column. The count is derived from
    `advisories`, keyed by installed version, which is what 1.9 reads.
  - `Server.sshKeyId` names one `ssh_key` `Secret`, as `declared` assumes.
  - Outpost has no posture code and Basecamp has none outside the word.

### Phase 1 — Readings, grader and screens, read-only

Goal: every fleet machine reports posture and `/security/` ranks the workspace's
machines and code ([`FJS-2713`](../ISSUES.md#fjs-2713), [`FJS-2715`](../ISSUES.md#fjs-2715)).
Done when: a fresh DigitalOcean box enrolled today shows `net.firewall-default-deny`
and `ssh.password-off` failing (or `ssh.password-off` passing, if the image already
ships it that way — that is worth knowing too), and it sorts to the top of
`/security/`.

- [ ] 1.1 The raw-port exposure declaration on `App` (`FJS-D930`), the half the
  grader reads. An app with no hostname that does not declare it is an
  unexpected listener, which until 3.1 is the truth.
- [ ] 1.2 `inspector.posture()` in `docker.js`: the readings table, every command
  an argv array, a failing command `unknown`; tested against the 0.1 fixtures.
- [ ] 1.3 The `posture` report in `report.js` (6h, plus once at start) and the
  signed `POST /posture` for *check now*.
- [ ] 1.4 `core/posture.ts`: `gradePosture` and the derived `declared`, with the
  test that a report older than twice its interval grades every control `unknown`.
- [ ] 1.5 `ServerPosture`, the report endpoint, `posture_failed`/`posture_restored`
  `ServerEvent`s, the `server.posture.failing` metric and its retention.
- [ ] 1.6 The `posture_failed` notification kind, with `server_unreachable`'s two
  addressees.
- [ ] 1.7 The Posture tab on the server page.
- [ ] 1.8 `/security/`: machines worst first, outside findings above the box's own,
  stale never clean, plus the vulnerable count linking to `/dependencies/`.
- [ ] 1.9 The `dependency_vulnerable` notification, sent once when an installed
  version first gains an advisory.

### Phase 2 — Basecamp's own host

Goal: the box holding `ENCRYPTION_KEY` is graded ([`FJS-2714`](../ISSUES.md#fjs-2714)).
Done when: the `bun run image:up` stack shows its host's readings on
`/hub/security/`, and `hub.backup-recent` fails on a stack with no backup.

- [ ] 2.1 The Outpost's report-only mode: the command listener off, `posture`
  posted over loopback (`FJS-D925`).
- [ ] 2.2 `fli deploy` installs it on the host.
- [ ] 2.3 `ServerPosture` rows with `serverId` null, read by the hub alone.
- [ ] 2.4 `hub.backup-recent`, `hub.db-mode` and `hub.env-mode`.
- [ ] 2.5 `/hub/security/` behind `isSystemAdmin` (`FJS-D924`), refusing *Harden*
  and the patch run and showing the `fli deploy` command instead.

### Phase 3 — The outside view

Goal: what answers from outside is graded from outside.
Done when: an app declaring raw-port exposure is reported reachable on its port
from outside and one that does not is refused, and the host is probed from a
fleet Outpost rather than from itself.

- [ ] 3.1 Every published port binds `127.0.0.1` and a declared raw port is
  published on every interface (`FJS-D930`, amending `FJS-D565`), with
  `verify-docker.mjs` asserting both.
- [ ] 3.2 The port probe from the uptime monitor's vantage, grading
  `net.reachable-unexpected`.
- [ ] 3.3 A fleet Outpost probes Basecamp's own host; with no fleet machine the
  control is `unknown` and the screen says why.
- [ ] 3.4 The provider cloud firewall read through the existing Conduit target.

### Phase 4 — Harden at install, and the Harden action

Goal: a box Basecamp builds grades clean, and one it did not can be brought there
on a click ([`FJS-2712`](../ISSUES.md#fjs-2712)).
Done when: the phase-1 box after *Harden* grades clean, and the outside probe agrees.

- [ ] 4.1 `unattended-upgrades`, security origin only, no automatic reboot.
- [ ] 4.2 The sshd drop-in.
- [ ] 4.3 The nftables ruleset and the `DOCKER-USER` drop (`FJS-D928`).
- [ ] 4.4 The `outpost.service` sandbox ([`FJS-1761`](../ISSUES.md#fjs-1761)).
- [ ] 4.5 Docker and Caddy pinned to a major, the versions in `enrollment.ts`,
  installed versions in the heartbeat (`FJS-D931`).
- [ ] 4.6 The provider cloud firewall, created by `server-provision.job.ts`.
- [ ] 4.7 The pairing test: every `hardenedAtInstall` control names a marker in
  `installScript()`, and no marker is without a control.
- [ ] 4.8 The *Harden* action through the Outpost, showing findings before and
  after, never automatic.

### Phase 5 — The patch run

Goal: anything that restarts is applied by a person and recorded.
Done when: a box with `reboot-required` is drained, upgraded, rebooted, back online,
undrained, and the run row lists the packages.

- [ ] 5.1 Widen `CleanupRun` into `MaintenanceRun` with a `kind` (`FJS-D825`).
- [ ] 5.2 The Outpost's signed `POST /system/upgrade`, its argv the Outpost's own.
- [ ] 5.3 `server-patch.job.ts`: drain, upgrade, reboot if required, wait for the
  heartbeat, re-read posture, undrain, record each package from and to.
- [ ] 5.4 The screen: what is pending, the apps a drain takes down, and
  `patch.reboot-pending` rising to `high` with age.

### Phase 6 — Second opinions, on demand

Goal: a check this design did not write.
Done when: each runs from the server page and its result is stored beside the
posture report.

- [ ] 6.1 Lynis hardening index.
- [ ] 6.2 docker-bench-security.
- [ ] 6.3 Trivy over the images in use.
- [ ] 6.4 An authorized Vigil engagement against Basecamp itself, run by hand.

## Open questions (owner)

- ~~**Q1 — Host firewall: nftables directly, or ufw?**~~ **Answered 2026-10-12 (`FJS-D928`): A — nftables directly: one ruleset written by `installScript()`, read by the Outpost as `nft -j list ruleset`.** **Recommend nftables**: one ruleset
  the Outpost reads as JSON, and `DOCKER-USER` is plain iptables-nft anyway. ufw is
  more familiar but adds a layer the grader would have to see through.
  - **A** — nftables directly: one ruleset written by `installScript()`, read by the
    Outpost as `nft -j list ruleset`.
  - **B** — ufw, whose rules the grader reads through `ufw status` and the
    iptables-nft tables beneath it.
  - **Recommend A** — the grader reads one layer, not two, and `DOCKER-USER` is
    plain iptables-nft whichever is chosen, so ufw adds a translation the pairing
    test would have to grade as well.
- ~~**Q2 — `PatchRun` model, or widen `CleanupRun` into a maintenance run?**~~ **Answered 2026-10-09 (`FJS-D825`): B — Widen `CleanupRun` into a `MaintenanceRun` with a `kind` and both payloads.**
  **Recommend its own model**: a cleanup records bytes freed and a patch records
  package versions, so one row type would carry two half-empty shapes.
  - **A** — Its own `PatchRun` model, shaped like `CleanupRun` and recording
    package, from-version and to-version.
  - **B** — Widen `CleanupRun` into a `MaintenanceRun` with a `kind` and both
    payloads.
  - **Recommend A** — a cleanup records bytes freed and a patch records versions, so
    B is one row type with two half-empty shapes and a `kind` every reader has to
    branch on. `RunStatus` is already shared, which is the part that is common.
- ~~**Q3 — fail2ban?**~~ **Answered 2026-10-12 (`FJS-D929`): A — No fail2ban: password auth off, `MaxAuthTries 3`, and the provider firewall.** **Recommend no**: with password auth off, brute force cannot
  succeed, and `MaxAuthTries` plus the provider firewall cover the noise. One fewer
  daemon to grade.
  - **A** — No fail2ban: password auth off, `MaxAuthTries 3`, and the provider
    firewall.
  - **B** — fail2ban on the sshd jail, installed by `installScript()` and graded as
    a control.
  - **Recommend A** — with password auth off, a brute force cannot succeed, so B
    adds a daemon to install, grade and keep running against noise rather than risk.
- ~~**Q4 — A no-hostname app on `0.0.0.0` (`FJS-D565`).**~~ **Answered 2026-10-12 (`FJS-D930`): B — Every published port binds `127.0.0.1`, and exposure on a raw port is an explicit per-app declaration on `App` that the grader reads.** Keep it and let the firewall
  allow its declared port, or publish everything on loopback and make exposure an
  explicit per-app declaration? **Recommend the second**: exposure becomes a stated
  fact the grader reads, not a side effect of having no domain.
  - **A** — Keep `FJS-D565` as ruled: an app with no hostname publishes its port on
    every interface, and the firewall allows that declared port.
  - **B** — Every published port binds `127.0.0.1`, and exposure on a raw port is an
    explicit per-app declaration on `App` that the grader reads.
  - **Recommend B** — exposure becomes a stated fact rather than a side effect of
    having no domain, and an app reachable around Caddy is exactly what `FJS-D565`
    exists to stop. It amends that ruling's no-hostname clause, so it lands as a
    ruling naming it.
- ~~**Q5 — Pin the installs?**~~ **Answered 2026-10-12 (`FJS-D931`): B — Also pin a major for Docker and Caddy with an apt preference, keep every version beside `BUN_VERSION`, and report the installed versions in the heartbeat.** Docker and Caddy from their apt repos with a pinned
  major, and Bun by version. **Recommend yes**, with the versions in `config.js` and
  reported, so the screen can say which machines are behind.
  - **A** — As built: Bun and the Outpost pinned in `enrollment.ts`
    (`BUN_VERSION`, `OUTPOST_VERSION`), Docker and Caddy whatever their signed apt
    repositories serve on the day.
  - **B** — Also pin a major for Docker and Caddy with an apt preference, keep every
    version beside `BUN_VERSION`, and report the installed versions in the heartbeat.
  - **C** — Pin exact versions for all four.
  - **Recommend B** — two machines enrolled a month apart should differ only by
    patches, and the heartbeat report is what lets the screen say which are behind.
    The versions belong in `enrollment.ts`, where the install script is and where
    the two pinned today already live, not in the Outpost's `config.js`. C makes
    every security patch a code change.

- ~~**Q6 — One Security route, or one per tier?**~~ **Answered 2026-10-12 (`FJS-D924`): B — Two routes on the existing tier split: `/security/` for a workspace's machines and code, `/hub/security/` for the installation's host and its `hub.*` controls.**
  - **A** — One `/security/`: the workspace's machines and code, plus a section for
    Basecamp's own host that renders for `isSystemAdmin` alone.
  - **B** — Two routes on the existing tier split: `/security/` for a workspace's
    machines and code, `/hub/security/` for the installation's host and its `hub.*`
    controls.
  - **Recommend B** — every installation-level screen is under `/hub/` behind one
    guard, and the host's rows are hub-read at the Data boundary. A puts two
    audiences on one page, and a workspace admin who is not a system admin would get a
    section that is present for one person and absent for the next. A matches the ask
    word for word. B is two routes for the same reason the hub is a tier.
- ~~**Q7 — How does the host's readings leave the box?**~~ **Answered 2026-10-12 (`FJS-D925`): A — The Outpost, installed by `fli deploy` with its command listener off, reporting over loopback.**
  - **A** — The Outpost, installed by `fli deploy` with its command listener off,
    reporting over loopback.
  - **B** — A full Outpost, enrolled as an ordinary server row with a hub flag.
  - **C** — Bind-mount `/etc`, `/proc` and `docker.sock` into the API container and
    read in process.
  - **Recommend A** — one implementation of the readings and nothing listening. B puts
    a signed command port on the box that holds the fleet's command key, and a server
    row invites the deploy and drain this record refuses on the host. C gives the
    control plane's own container root on its host to read a config file.

## See also

`IDEAS/production-grading.md` (the same *does what runs match what was declared*,
for the app) · `IDEAS/uptime-monitoring.md` (the outside vantage) ·
`IDEAS/deploy-plane.md` (the install rings) · `IDEAS/shipped/restore-verify.md` (the backup
half of the owner's question).
