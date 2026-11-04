---
id: machine-backups
status: proposed
dated: 2026-11-03
---

# Idea — a cloud's own whole-machine backups, seen and switched from Basecamp

**Status: PROPOSED. Q1–Q4 open; 0.1 next.** Probed against the tree 2026-11-03. Do not cite
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
| Choices | `plan` daily or weekly, `hour` in 0/4/8/12/16/20, a weekday for weekly; `/v2/droplets/backups/supported_policies` gives window length and retention | daily only, seven slots |
| Price | 20% of the droplet weekly, 30% daily ([pricing](https://www.digitalocean.com/pricing/backups)) | +20% of the server |

DO's spec disagrees with itself: the `droplet_backup_policy` schema names `weekday`, and its
`change_backup_policy` example sends `day`. 0.1 settles it on a real droplet.

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

- [ ] 0.1 Read-only on yuma's droplet with the owner's token: `GET …/backups/policy`,
      `GET …/backups`, `GET /v2/droplets/backups/supported_policies`, and the droplet's
      `features`. Record which of `weekday` / `day` the policy carries.
- [ ] 0.2 Hetzner: the same reads on a Hetzner server if one exists; otherwise record that
      Phase 1's Hetzner half is built from the spec alone.
- [x] 0.3 Yuma's `Server` row in Basecamp: `providerKind`, `providerId`, `providerServerId`.
      Read from the code rather than the box: `host-machine.ts` creates the hub row with name,
      slug, role, region `self` and the IP, and no provider, so it is `custom`. Q4 decides whether
      this plan reaches the one box it was asked for.
- [ ] 0.4 `machine backup` into `VOCABULARY.md` beside `AppBackup` and `HubBackup`, once Q1–Q4
      are ruled.

### Phase 1 — See it

Goal: every vendor-linked machine shows its backup state on the Server screen.
Done when: `cd packages/basecamp/api && bun run test` is green with the connector cases in
`compute.test.ts`, and yuma's Server screen shows what 0.1 read.

- [ ] 1.1 `ComputeConnector.backups(send, id)` → `{ enabled, plan, hour, weekday, window, retentionDays, taken: [{ id, at, sizeGb }] }`
      for both connectors, from 0.1's recorded answers.
- [ ] 1.2 `servers.sync` reads it and stores it per Q1; a read failure records an event and keeps
      the last answer, the way `syncFailed` does today.
- [ ] 1.3 The Server screen's line, with the monthly cost from the catalog's size price × the
      vendor's percentage, labeled as an estimate.

### Phase 2 — Switch it

Goal: a person turns a machine's backups on, off, or to another schedule from Basecamp.
Done when: on yuma, the switch turns backups on, a policy read after it agrees (the drive), the
DO console agrees, and the audit trail has the event.

- [ ] 2.1 `ComputeConnector.setBackups(send, id, policy | null)`; DO enable/change/disable,
      Hetzner enable/disable.
- [ ] 2.2 `servers.setBackups`, gated like `powerOff`, re-reads after the vendor answers, and
      records an event naming the new policy.
- [ ] 2.3 A vendor 403 names the missing scope (`droplet:update`); the cli's scope list gains it.
- [ ] 2.4 Off asks before it acts, with the count of taken backups the vendor deletes with it.

### Phase 3 — Asked at create

Goal: a machine Basecamp buys starts with the backups the person chose.
Done when: a `provision` with backups on yields a droplet whose policy read says so.

- [ ] 3.1 `MachineSpec.backups`; DO sends it in `create`, Hetzner enables after `poll` sees the
      machine running.
- [ ] 3.2 The provision form and `fli basecamp:create` ask per Q2.

### Phase 4 — The host

Goal: the box Basecamp runs on cannot have its backups off unnoticed.
Done when: a fresh `basecamp:install` on a droplet with backups off shows the checklist item.

- [ ] 4.1 Per Q4, the hub's own row is linked to its droplet.
- [ ] 4.2 A setup-checklist item (`FJS-D1836`) while the hub host's backups are off, per Q3.

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
