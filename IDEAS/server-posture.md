---
id: server-posture
status: proposed
dated: 2026-10-05
---

# Idea — Server posture: Basecamp grades the machine, not only the app on it

**Status: IDEA.** Probed against the tree 2026-10-05 (`VERIFYING.md`). Do not cite
this file as behavior.

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
  (`FJS-D565`, deliberately), so adding ufw alone would leave that port open while
  `ufw status` reads closed. Filtering belongs in `DOCKER-USER`, or at the provider.
- **`outpost.service` runs as root with no sandboxing**: no `User=`, no
  `ProtectSystem`, no `NoNewPrivileges`. Docker access is root-equivalent anyway,
  so the gain is in narrowing what a compromised Outpost can write, not in the user.
  [`FJS-1761`](../ISSUES.md#fjs-1761).
- **The install is unpinned**: `get.docker.com | sh` and `bun.sh/install` run
  whatever those servers return that day, and `bunx` resolves the Outpost at each
  restart. [`FJS-1762`](../ISSUES_ARCHIVE.md#fjs-1762).
- **Nothing installs or checks time sync**, and both sides refuse a signed
  request past 300 seconds of skew. The refusal names the skew, but the operator
  sees a machine that stopped answering. [`FJS-1763`](../ISSUES_ARCHIVE.md#fjs-1763).

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
  the static origin is on), plus the port of each app on this server that has **no
  hostname** (`AppServer` + `Domain`). An app with a hostname must be on loopback
  only. Anything else listening on a public address is a finding by name.
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

### Harden at install, each step paired with a control

Added to `installScript()`:

| Step | Control it satisfies |
| --- | --- |
| `unattended-upgrades`, security origin only, **`Automatic-Reboot "false"`** | `patch.auto-updates-on` |
| sshd drop-in `/etc/ssh/sshd_config.d/10-basecamp.conf`: password off, root `prohibit-password`, `MaxAuthTries 3` | `ssh.*` |
| nftables: input default drop, allow the expected set, 8180 from Basecamp only; `DOCKER-USER` drop of non-established traffic to container ports not in the expected set | `net.*` |
| `chrony` | `time.synced` |
| `outpost.service`: `NoNewPrivileges`, `ProtectSystem=strict` with `ReadWritePaths` for its own dirs, `PrivateTmp` | `outpost.sandbox` |
| provider cloud firewall, created by `server-provision.job.ts` with the server | `net.reachable-unexpected` |
| fail2ban: **open**, see below | — |

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
- **The click is a run**, shaped like `CleanupRun`: `server-patch.job.ts` drains the
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
   cleanup word). Whether `PatchRun` is its own model or `CleanupRun` widens into
   maintenance runs is open (Q2).
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

**Tier:** Assessment. Becomes rulings for Q1–Q4 before phase 3.

---

## Phases

1. **Readings + grader + a Posture tab on the server page**, read-only.
   *Proves:* a fresh DigitalOcean box enrolled today shows `net.firewall-default-deny`
   and `ssh.password-off` failing (or `ssh.password-off` passing, if the image
   already ships it that way — that is worth knowing too).
2. **The outside probe + cloud firewall read.** *Proves:* an app deployed with no
   hostname is reported reachable on its port from outside.
3. **Harden at install + the Harden action**, with the pairing test. *Proves:* the
   phase-1 box after Harden grades clean, and the outside probe agrees.
4. **The patch run.** *Proves:* a box with `reboot-required` is drained, upgraded,
   rebooted, back online, undrained, and the run row lists the packages.
5. **Second opinions, on demand:** Lynis index, docker-bench, Trivy over the images
   in use.

## Open questions (owner)

- **Q1 — Host firewall: nftables directly, or ufw?** **Recommend nftables**: one ruleset
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
- **Q3 — fail2ban?** **Recommend no**: with password auth off, brute force cannot
  succeed, and `MaxAuthTries` plus the provider firewall cover the noise. One fewer
  daemon to grade.
  - **A** — No fail2ban: password auth off, `MaxAuthTries 3`, and the provider
    firewall.
  - **B** — fail2ban on the sshd jail, installed by `installScript()` and graded as
    a control.
  - **Recommend A** — with password auth off, a brute force cannot succeed, so B
    adds a daemon to install, grade and keep running against noise rather than risk.
- **Q4 — A no-hostname app on `0.0.0.0` (`FJS-D565`).** Keep it and let the firewall
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
- **Q5 — Pin the installs?** Docker and Caddy from their apt repos with a pinned
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

## See also

`IDEAS/production-grading.md` (the same *does what runs match what was declared*,
for the app) · `IDEAS/uptime-monitoring.md` (the outside vantage) ·
`IDEAS/deploy-plane.md` (the install rings) · `IDEAS/shipped/restore-verify.md` (the backup
half of the owner's question).
