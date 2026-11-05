---
id: machine-backups
status: proposed
dated: 2026-11-03
---

# Idea — a cloud's own whole-machine backups, seen and switched from Basecamp

**Status: PROPOSED. Q1–Q4 ruled (`FJS-D1862`–`FJS-D1865`); Phase 0 done; 1.1–1.3, 2.1–2.4, 2.2a, 3.1, 3.2, 4.1 and 4.2 built; every box closed.** Probed against the tree 2026-11-03. Do not cite
this file as behavior — see `VERIFYING.md`.

**The ask** (owner, 2026-11-03): see in Basecamp whether a DigitalOcean droplet's backups are on,
and turn them on or off from there.

**Words.** A *machine backup* is the vendor's image of a whole disk, taken by DigitalOcean or
Hetzner on their schedule. It is not an `AppBackup` or a `HubBackup`, which are Basecamp's archives
of one database. The two cover different failures: an archive restores one app onto any machine;
a machine backup puts back the whole box — Basecamp's database, `/etc/outpost`, the pinned Outpost
certificate, Caddy's routes and certificates — at that vendor, at that instant, crash-consistent.

## What exists (probed 2026-11-03)

- **Create sends no backup field.** `digitalocean.ts` `create()` posts name, region, size, image,
  `user_data`, `ssh_keys`, `tags` and `monitoring: true`. DO's `backups` defaults to `false`.
- **The read drops it.** `machine()` maps status, IP, region, name, marks and `created_at` into
  `ComputeMachine`; the droplet's `features`, `backup_ids` and `next_backup_window` are discarded.
- **The connector contract** (`providers/compute/index.ts` `ComputeConnector`) has `catalog`,
  `machine`, `verify`, `create`, `sshKey`, `destroy`, `powerOff`, `marked`, `addMark`. No backup
  method on either connector.
- **Spend is a stub.** `ICloudSpend` names a `backups` line kind, but `providers/index.ts` serves
  `StubCloudSpend`, so the charge shows nowhere. `catalog()` does carry each size's price per region.
- **Who is linked to a vendor.** `Server.providerKind`, `providerId` and `providerServerId` are
  `@system`, set only by `provision`. The hub's own row is made by `host-machine.ts` with no
  provider, so it reads `custom` and nothing here reaches yuma until Q4. `fli basecamp:install`
  does mark the host droplet at its cloud (`markHost`), so the droplet already carries the
  identity a link can be derived from.
- **A link is also a destroy.** `servers.destroy` spends `providerServerId` on `connector.destroy`,
  and `sync` moves the row's status off the vendor's answer. A row linked for its backups is a row
  whose Destroy deletes the real machine.
- **Token scopes.** `packages/cli/commands/server/_module.md` lists DO custom scopes with `droplet`
  create/read/delete and `image` read. Toggling needs `droplet:update`; `backup_ids` needs `image:read`.

## The vendors (read from their OpenAPI specs 2026-11-03)

| | DigitalOcean | Hetzner |
|---|---|---|
| At create | `backups: true`, optional `backup_policy` (default daily) | no field; enable after create |
| Turn on / off | `POST /v2/droplets/{id}/actions` `enable_backups` (+ `backup_policy`) / `disable_backups`; `change_backup_policy` | `POST /servers/{id}/actions/enable_backup` / `disable_backup` |
| State | `GET /v2/droplets/{id}/backups/policy` → `backup_enabled`, `backup_policy`, `next_backup_window` | server's `backup_window` (null when off) |
| Taken backups | `GET /v2/droplets/{id}/backups` | `GET /images?type=backup` filtered by `bound_to` |
| Choices | `plan` daily or weekly (five per-GiB plans beside them, 0.1), `hour` in 0/4/8/12/16/20, a weekday for weekly; `/v2/droplets/backups/supported_policies` gives window length and retention | daily only, seven slots |
| Price | 20% of the droplet weekly, 30% daily ([pricing](https://www.digitalocean.com/pricing/backups)) | +20% of the server |

DO's spec disagrees with itself: the `droplet_backup_policy` schema names `weekday`, and its
`change_backup_policy` example sends `day`. 0.1 read `weekday` back; the write's spelling is 2.1's
first push on yuma.

**Prior art.** Terraform's `digitalocean_droplet` takes `backups` and `backup_policy` at create.
Laravel Forge's DigitalOcean create form had an Enable Backups box (20%, weekly) and leaves turning
it on later to the vendor console; its own backups cover databases only
([SitePoint](https://www.sitepoint.com/setting-up-php-7-servers-with-laravel-forge-and-digitalocean/),
[Forge storage providers](https://laravel.com/forge/docs/storage-providers)). No panel found that
restores a whole machine from inside itself.

## The target

The Server screen says **Machine backups: on, daily at 20:00 UTC, last taken 6 h ago, 7 kept,
+$7.20/mo**, or **off**, with one switch. A machine Basecamp buys asks the question at create. The
host Basecamp runs on is flagged on the setup checklist while its backups are off.

## Plan

### Phase 0 — Read the real answers

Goal: the shapes are recorded from real accounts, and the four questions are ruled.
Done when: 0.1–0.3's output is recorded under each step and Q1–Q4 carry rulings.

- [x] 0.1 Read-only on yuma's droplet with the owner's token: `GET …/backups/policy`,
      `GET …/backups`, `GET /v2/droplets/backups/supported_policies`, and the droplet's
      `features`. Record which of `weekday` / `day` the policy carries.
      Read 2026-11-04. Yuma is droplet `615016604`, tags `basecamp`, `basecamp:host`; backups off:
      the policy is `{ backup_enabled: false }` and nothing else, `backups` is empty, `features`
      lacks `backups`, `backup_ids` is `[]`, `next_backup_window` null. An on policy, from the
      account's other droplets: weekly `{ plan: "weekly", weekday: "SUN", hour: 16,
      window_length_hours: 4, retention_period_days: 28 }`, daily `{ plan: "daily", hour: 20,
      window_length_hours: 4, retention_period_days: 7 }` with no weekday key. **The read carries
      `weekday`**, three capitals. A taken backup is `{ id, name, created_at, size_gigabytes,
      min_disk_size, regions, type: "backup" }`. `GET /v2/droplets/backups/policies` answers every
      droplet's policy keyed by id in one call, so `sync` need not ask per machine.
      `supported_policies` names seven plans: `weekly` (0.2 per droplet) and `daily` (0.3), plus
      `custom_weekly`, `custom_daily`, `intra_daily_12h`, `intra_daily_6h` and `intra_daily_4h`
      priced per GiB, with retention ranges, and `intra_daily_6h` on 3-hour windows at
      0/3/…/21. None of the account's droplets is on one.
- [x] 0.2 Hetzner: the same reads on a Hetzner server if one exists; otherwise record that
      Phase 1's Hetzner half is built from the spec alone.
      No `HETZNER_TOKEN` is stored (2026-11-04), so Phase 1's Hetzner half is built from the spec alone.
- [x] 0.3 Yuma's `Server` row in Basecamp: `providerKind`, `providerId`, `providerServerId`.
      Read from the code rather than the box: `host-machine.ts` creates the hub row with name,
      slug, role, region `self` and the IP, and no provider, so it is `custom`. Q4 decides whether
      this plan reaches the one box it was asked for.
- [x] 0.4 `machine backup` into `VOCABULARY.md` beside `AppBackup` and `HubBackup`, once Q1–Q4
      are ruled.

### Phase 1 — See it

Goal: every vendor-linked machine shows its backup state on the Server screen.
Done when: `cd packages/basecamp/api && bun run test` is green with the connector cases in
`compute.test.ts`, and yuma's Server screen shows what 0.1 read.

- [x] 1.1 `ComputeConnector.backups(send, id)` → `{ enabled, plan, hour, weekday, windowHours, retentionDays, taken: [{ id, at, sizeGb }] }`
      for both connectors, from 0.1's recorded answers. A plan outside `weekly`/`daily` is read
      and shown by its name; it is never a desired policy, since Basecamp offers neither its
      per-GiB price nor its retention range. A `compute.test.ts` case feeds `custom_daily`: the
      reading carries the name, `setBackups` refuses it, the estimate is null.
      Built 2026-11-04. `windowHours` rather than `window`, which reads as the next window's
      time. Null where the vendor no longer has the machine, as `machine()` is; a refused list
      (DO's `image:read`) throws rather than reading as off. `taken` is newest first. Hetzner's
      reading is the server's `backup_window` (`"22-02"` is four hours) and the images
      `type=backup&bound_to=<id>`, a `creating` one excluded. Both sinks answer *off*, and the
      two-clouds lifecycle case reads it at both. The `custom_daily` case asserts the reading;
      its `setBackups` refusal lands with 2.1 and its null estimate with 1.3, in the same test.
- [x] 1.2 Two columns on `Server` per Q1 (`FJS-D1862`): the desired policy a person sets, and the
      vendor's last reading with its `readAt`, which `sync` writes. A null desired policy is
      *not managed*: Basecamp shows the reading and pushes nothing, so linking a box (4.1) never
      changes its backups by itself. A machine kept on a per-GiB plan stays unmanaged: on a
      managed one, 2.2a puts the desired `weekly`/`daily` back over it, and the event names the
      plan it replaced. A read failure records an event and keeps the last reading,
      the way `syncFailed` does today.
      Built 2026-11-04: `backupPolicy Json? @type(BackupPolicy) @system` (plan
      `MachineBackupPlan { daily weekly }`, `hour`, `weekday`) and `backupReading Json? @system`
      (`MachineBackups` plus `readAt`), migration `20261104165708_machine_backups`. Both `@system`:
      a policy any developer could patch would be a vendor push past 2.2's gate, so 2.2 writes it
      through `asSystem()` after its own. `sync` reads backups only after the machine read
      returns a machine; a refused read records `backupsReadFailed` and keeps the reading. The
      DO sink's `sinkRefuseBackups()` is the 403 a token without `image:read` answers.
- [x] 1.3 The Server screen's line, with the monthly cost from the catalog's size price × the
      vendor's percentage, labeled as an estimate. A per-GiB plan prints *cost not estimated: custom plan*, never a blank.
      Built 2026-11-04. The price is `Server.plan.priceMinor`, the catalog's price copied at
      purchase, so the screen calls no vendor; `ComputeConnector.backupShare` holds the vendor's
      percentages (DO weekly 20, daily 30; Hetzner daily 20) and `backupCost()` answers
      `{ monthlyMinor, currency }` or `{ unestimated: 'custom plan' | 'size price unknown' }`.
      `sync` stores it on the reading as `cost`. The *Machine backups* card shows on a
      vendor-linked machine only, and says *not managed* while `backupPolicy` is null.
      `verify:provision` proves *not read yet* → *Off* across a Sync and no card on an imported
      machine; the *on* branch waits for 2.1's sink to answer on. Priced at purchase, the
      estimate runs low after a vendor price change or a resize; if that bites, `sync` re-prices
      through `priceIn` from the catalog. Nothing checks `backupShare` against the vendors' pages. Yuma's screen (Phase 1's
      Done when) waits for 4.1, since its row has no vendor link.

### Phase 2 — Switch it

Goal: a person sets a machine's backups from Basecamp, and Basecamp's setting holds.
Done when: on yuma, the switch turns backups on, a policy read after it agrees (the drive), the
DO console agrees, the audit trail has the event, and turning them off in the DO console is put
back at the next sync with a `backupsRestored` event.

- [x] 2.1 `ComputeConnector.setBackups(send, id, policy | null)`; DO enable/change/disable,
      Hetzner enable/disable.
      Built 2026-11-04. `BackupPolicy.hour` is now `Int?`, null meaning the vendor picks the
      window (`decision-rules` passed it before the code; not yet an owner ruling): Hetzner
      refuses an hour, a weekly plan and a day, and DO refuses a null hour, an hour outside
      0/4/…/20, a weekly plan with no day and a daily one with one, all before anything is
      sent. Each reads the current state first: DO picks `enable_backups`,
      `change_backup_policy` or `disable_backups` from it, Hetzner `enable_backup` or
      `disable_backup`, and a policy already kept sends nothing. False where the vendor has
      never heard of the machine, as `powerOff`. Both sinks keep a policy per machine; DO's
      refuses an enable on an enabled droplet, which no real answer has shown. The write sends
      `weekday` and is unproven against DO until Phase 2's push on yuma.
- [x] 2.2 `servers.setBackups`, gated like `powerOff`, writes the desired policy, pushes it, re-reads,
      and records an event naming the new policy. Setting it to *not managed* pushes nothing.
      Built 2026-11-04. Input `ServerSetBackups { choice on|off|unmanaged, plan, hour, weekday }`;
      Off leaves the machine not managed (`FJS-D1885`). At ADMINISTRATOR, the weight of
      `provision` and `destroy`, since `powerOff` is no service method. The vendor is told
      FIRST and the policy stored after it accepts, so a refused one is never what `sync`
      pushes; `ComputeConnector.unheldBackups` answers the refusal as a 400 before anything
      is sent. The column is written with `system: ['backupPolicy']`, not `asSystem()`, so
      the gate and `@@capabilities` still hold. Event `backupsSet`, migration
      `20261104182613_machine_backups_set`. The Server card has the switch (DO asks the hour,
      Hetzner neither hour nor weekly); `verify:provision` turns it on weekly and off, read
      back. A DO action not applied yet reads as the old state until the next sync, which
      2.2a must not read as drift to push again.
- [x] 2.2a `sync` pushes a managed policy back when the reading differs (`FJS-D1862`), and records
      an event naming what the vendor said and what was put back, so a console change is never
      undone silently. A push the vendor refuses is recorded once per sync and not retried within
      it. Hetzner has no hour or weekly plan, so a policy it cannot hold is refused when it is set.
      A null `hour` is the vendor's choice and is never compared.
      Built 2026-11-04. A change still applying is not drift (`FJS-D1888`): `MachineBackups.pending`
      is a backup action running at the vendor, DO's `/actions` `in-progress` or Hetzner's
      `/actions?status=running`, and `sync` neither compares nor pushes while it holds.
      `keepsPolicy()` in `providers/compute/index.ts` is the one comparison. `restoreBackups`
      records `backupsRestored` (*DigitalOcean had machine backups off; put back daily at 20:00
      UTC*, `metadata.found` the vendor's word) or `backupsRestoreFailed`, migration
      `20261104191248_machine_backups_restored`. Both sinks hold an action open
      (`sinkHoldBackups` / `hzSinkHoldBackups`) and refuse a second ask meanwhile, DO's 422
      *pending event* and Hetzner's 423 *locked*; the card says *a change is still applying*.
      `verify:provision` turns backups off at the stand-in behind the app's back and a Sync puts
      them back on the open page. The DO read needs `actions:read`, which 2.3's scope list
      names beside `droplet:update`.
- [x] 2.3 A vendor 403 names the missing scope (`droplet:update`, `actions:read`); the cli's scope list gains them.
      Built 2026-11-04. DO's 403 says only *not authorized*, so each request names the scope it
      needed: the policy read `droplet:read`, the taken list `image:read`, the action list
      `actions:read`, a switch `droplet:update`. Hetzner has only Read and Read & Write, so a 403
      on any write says the token needs Read & Write. `backupsReadFailed` and
      `backupsRestoreFailed` end their sentence with the vendor's reason, and a refused
      `setBackups` is a 502 carrying it (`apps`'s `BadGateway`), not a bare 500. The DO sink's
      `sinkRefuseScope(scope)` refuses the requests that need one scope. `server/_module.md`
      lists `droplet` update and `actions` read. Unproven: that a real scoped token's 403 is
      the one the sink answers.
- [x] 2.4 Off asks before it acts, with the count of taken backups the vendor deletes with it.
      Built 2026-11-04 (`FJS-D1889`). `ServerSetBackups` takes `deletes`, the count shown, and
      `confirm`, the machine's name when that count is not none. `confirmOff` reads the vendor
      again, stores the reading, and refuses a changed count with a 409 naming the new one.
      `backupsSet` says how many were deleted (`metadata.deleted`). The card replaces Save with
      a typed-name panel while backups are taken, and asks for a Sync first when nothing has
      been read. Both stand-ins take one backup when backups turn on and delete them all on
      off. `verify:provision` turns backups Off through the typed name.

### Phase 3 — Asked at create

Goal: a machine Basecamp buys starts with the backups the person chose.
Done when: a `provision` with backups on yields a droplet whose policy read says so.

- [x] 3.1 `MachineSpec.backups`; DO sends it in `create`, Hetzner enables after `poll` sees the
      machine running.
      Built 2026-11-04. `ServerProvision.backups` is a `BackupPolicy`, absent meaning none;
      `provision` refuses one the vendor cannot hold before the row is written, stores it as
      `backupPolicy`, and names it in `provisionRequested`. The `poll` step that moves the row
      to `installing` calls `setBackups` at both vendors, which turns them on at Hetzner and
      reads and sends nothing at DO, then records `backupsSet` (*…on the new machine*) and
      reads back. A refusal there is `backupsRestoreFailed` and leaves the provision standing,
      since the next sync pushes the stored policy. Stored before the vendor holds it, the
      reverse of `setBackups`, because the machine does not exist yet; `decision-rules` passed
      it (not an owner ruling). The DO stand-in keeps a policy sent at
      create. Found and fixed `FJS-4022` on the way: a type naming a later-declared type was
      unvalidated input. Unproven: DO's real create accepting `backup_policy`.
- [x] 3.2 The provision form and `fli basecamp:create` ask per Q2.
      Built 2026-11-04. Each connector's `defaults.backups` is the daily policy it holds
      (Hetzner `daily`, DigitalOcean `daily` at 20:00 UTC), so both askers put one yes or no
      and name no vendor rule. The catalog answers it with its `backupShare` as `backups`; the
      form's *Back up this machine daily* box starts unticked and prices itself on the cost
      line: no `ServerRole` names a machine that will host Basecamp, so every one the form
      buys is an app box, and Q2's *on for a hub host* is `basecamp:create`'s alone. `basecamp:create` asks yes by default, `--no-backups` skips it; `provision-host.ts`
      takes `"backups":true`, sends the policy at create and calls `setBackups` once the box
      runs, answering `backups: { plan, monthly, currency }` or `{ error }`, which `buyBox`
      prints or warns. `fli server:create` does not ask: Q2 names the two above, and the
      contract stays off. `verify:provision` ticks it on the Hetzner provision (€1.04 on €5.18,
      named on the trail). Unproven: a real vendor create through `provision-host.ts`.

### Phase 4 — The host

Goal: the box Basecamp runs on cannot have its backups off unnoticed.
Done when: a fresh `basecamp:install` on a droplet with backups off shows the checklist item.

- [x] 4.1 Adopt per Q4 (`FJS-D1865`): pick a marked machine from `reconcile`'s list (IP match only
      after the person confirms name, IP and region), write the three `@system` columns and
      `adopted`, and refuse Destroy on an adopted row. The columns' schema comment stops naming
      `provision` as their only writer.
      Built 2026-11-04. `servers.adopt` (administrator) takes `ServerAdopt` (`accountId`,
      `providerServerId`, `shown`), refuses a row already linked or destroyed, reads the machine
      with `connector.machine`, answers 409 naming the vendor's current name, IP and region when
      any differs from `shown`, refuses a machine another live row holds at that account or the
      machine's mark claims for another live row, then writes `providerKind`, `providerId`,
      `providerServerId` and `adopted` (`@system`) and the `adopted` event. It writes no mark and
      leaves `backupPolicy` null, so linking changes nothing about the machine's backups. `destroy`
      refuses an adopted row before the transition. The Server screen's *Link to a cloud machine*
      card lists `reconcile`'s orphans for the chosen account, a matching IP first and never
      linked on its own; choosing one opens a confirm panel (name, IP, region) and *Link* sends
      those as `shown`. An adopted row shows the Machine backups card and, in place of Destroy,
      a line saying Basecamp did not buy it. The confirm shape is a `decision-rules` call made by
      the main thread, not an owner ruling. Only marked machines can be adopted: the connector has
      `marked()` and no list-all, so an unmarked machine never appears. The card shows to every
      viewer (the screen does not know the caller's role); the service refuses a non-administrator.
      Unproven: a real DigitalOcean adopt of yuma's droplet.
- [x] 4.2 A setup-checklist item (`FJS-D1836`) while the hub host's backups are off or not
      managed.
      Built 2026-11-04 (`FJS-D1895`). `infra.launch` adds `host-backups` for the workspace
      that holds the host (`hostServer`), marked `advisory`: outside `done` and `total` and
      never `next`, so it cannot hold home's card open. Once the counted steps are done, home
      shows it as one warning line with *Open*. It is not done while the host is unlinked,
      not managed, or managed and read as off; the detail names which. Found and fixed
      `FJS-4027` on the way: the hub's own Project, Environment and App ticked three steps.
      The Done when is met by a host that `basecamp:install` placed: unlinked, it shows.
      Unproven: the home line in a browser (no drive enrolls a hub host), and on yuma.

## Open questions

1. ~~**Q1 — Where does the backup state live?**~~ **Answered 2026-11-04 (`FJS-D1862`): B — a desired column on `Server`, with `sync` pushing the vendor back to it.**
   - **A** — observed, written by `sync` into one `@system` Json column on `Server` with its
     `readAt`, shown as stale past a sync interval; the vendor is the truth and the switch is an
     action that re-reads.
   - **B** — a desired column on `Server`, with `sync` pushing the vendor back to it.
   - **C** — nothing stored: the Server screen reads the vendor live, as the catalog does.
   - **Recommend A (confidence 2)** — someone will flip it in the vendor console, and B would
     quietly flip it back and bill them for it. C is the reopen path if the stored copy drifts:
     it keeps no copy, but the checklist in 4.2 then calls the vendor on every load.
2. ~~**Q2 — What does a new machine default to?**~~ **Answered 2026-11-04 (`FJS-D1864`): C (confidence 2).**
   - **A** — off, as the vendors do.
   - **B** — on, daily, for every machine.
   - **C** — off in `MachineSpec` when nothing says otherwise; the provision form and
     `fli basecamp:create` ask, prefilled on for a hub host and off for an app box.
   - **Recommend C (confidence 2)** — the hub host holds the one database whose loss strands every
     box, and an app box is covered by its Litestream replica and archives. The contract stays off
     so a caller that never asked is never billed.
3. ~~**Q3 — Does Basecamp restore from a machine backup?**~~ **Answered 2026-11-04 (`FJS-D1863`): A — no: it shows the backups and links to the vendor's restore page.**
   - **A** — no: it shows the backups and links to the vendor's restore page.
   - **B** — yes: a restore action with a typed confirmation.
   - **Recommend A** — a restore rewinds the whole disk, Basecamp's own when it is the host, and
     Basecamp cannot supervise its own rewind.
4. ~~**Q4 — How does a box Basecamp did not buy get its vendor link?**~~ **Answered 2026-11-04 (`FJS-D1865`): B — as A, and the linked row carries `adopted`, which refuses Destroy: a box Basecamp did not buy is never deleted from Basecamp.**
   - **A** — adopt through the marks: `reconcile` already lists marked machines with no row, and
     the host mark `markHost` writes names the hub's droplet, so a person picks the marked machine
     and the three `@system` columns are written from it. A machine with no mark is matched by IP
     only after the person confirms its name, IP and region.
   - **B** — as A, and the linked row carries `adopted`, which refuses Destroy: a box Basecamp did
     not buy is never deleted from Basecamp.
   - **C** — only machines Basecamp bought get this feature.
   - **Recommend B** — yuma is the box this was asked for, and linking it for its backups should
     not also hand Basecamp a button that deletes the machine Basecamp runs on. `provision` stops
     being the columns' only writer, so their schema comment changes with it.

## See also

`IDEAS/backups.md` (Basecamp's archives and Litestream), `IDEAS/basecamp-reinstall.md` (backing up
Basecamp itself), `IDEAS/hetzner-host.md` (the Hetzner connector).
