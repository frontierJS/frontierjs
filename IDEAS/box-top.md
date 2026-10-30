---
id: box-top
status: proposed
dated: 2026-10-30
---

# Box top — a live process view of a managed server

**Status: PROPOSED.** Dated 2026-10-30. Nothing here is built. Do not cite this
file as describing behavior — see `VERIFYING.md`. The local half shipped as
`fli top` (`FJS-D1677`); this paper is the same screen for a box Basecamp
manages, read through its Outpost.

## What exists, and what is missing

The reference implementation is `packages/cli/native/top/src/main.rs`:
`read_stat` and `scan_procs` are the per-process reader, `sort_groups` the
cursor rule, `kill_group` the signal. The math ports to JS unchanged.

| Piece | Today | Where |
| --- | --- | --- |
| CPU, memory, disk, load from `/proc` | built, every 30 s on the heartbeat | `packages/outpost/src/vitals.js`, `report.js` |
| Series kept and drawn | `server.cpuPercent` / `memoryPercent` / `diskPercent` | `api/src/domain/host/server-metrics.ts`, `components/tiles/ServerHealthBody.mesa` |
| Live box → browser rail | built, one source: `logs` | `api/src/plugins/machine-stream.ts` `SOURCES`; Outpost `streams` in `server.js` (cap `MAX_STREAMS` = 16) |
| A gated, audited server action | `reboot`, `drain` as `@@transitions`, each writes a `ServerEvent` | `servers.service.ts`, `enum ServerEventKind` in `db/schema.lite` |
| Per-process reading | **none** — no `/proc/<pid>` read, no `ps` | — |
| A signal route on the Outpost | **none** — `POST /exec` runs anything, which is the wrong door for one click | — |
| Live graphs | `Sparkline`, `Chart`, `Table` are static; a rolling array feeds them | `packages/ui/components/display/` |

The cost of a scan is the kernel writing `/proc/<pid>/stat` — measured ~22 ms
for ~880 processes on the dev box, ~1.1% of a core at a 2 s scan. A stream
runs only while a page holds it open, so an unwatched box pays nothing.

## What a box changes about the local design

**Grouping by command name merges every app.** On a laptop `node (5)` is a
useful row; on a box every app is `bun` inside its own container, so one row
holds them all and `dd` on it stops every app at once. A box groups by owner
first — the container, which Outpost already maps to an App — and by name
inside it. `/proc/<pid>/cgroup` names the container id under cgroup v2 (0.3
confirms on a real box).

**A container's process is restarted, not killed.** Docker's restart policy
brings a SIGTERM'd app straight back, so killing it is a restart with no event
explaining why. Containers already have a lifecycle verb in Basecamp; a
process outside every container (a stray host job) is what a signal is for.

## Open questions

- ~~**Q1 — Where does the view live?**~~ **Answered 2026-10-30 (`FJS-D1679`): A — a *Processes* card on `/servers/[id]/` beside `#server-health`; the workspace's own servers, graded like the page.**
  - **A** — a *Processes* card on `/servers/[id]/` beside `#server-health`;
    the workspace's own servers, graded like the page.
  - **B** — a Hub screen under `hub/fleet/`, cross-workspace for a system
    admin. Cost: fleet rows are not links today because `/servers/:id/` is
    workspace-scoped, so it needs its own route and its own grading.
  - **Recommend A** — the person debugging a box is in its workspace; B can
    link to A later through the same route fleet would need anyway.
- ~~**Q2 — Live stream or the heartbeat?**~~ **Answered 2026-10-30 (`FJS-D1680`): A — a stream: a `processes` row in `SOURCES`, an Outpost `POST /processes/follow` that emits a frame per tick while held open.**
  - **A** — a stream: a `processes` row in `SOURCES`, an Outpost
    `POST /processes/follow` that emits a frame per tick while held open.
  - **B** — ride the 30 s heartbeat: add a top-N process list to `health`.
    Cost: a 30 s process list is not *top*, and every box pays the scan
    whether anyone watches.
  - **Recommend A** — the rail exists and its header asks for exactly this
    shape; B also grows a column every heartbeat writes.
- ~~**Q3 — How are rows grouped?**~~ **Answered 2026-10-30 (`FJS-D1681`): A — by owner then name: one row per App (its container), expandable to its process names; host processes grouped by name as in `fli top`.**
  - **A** — by owner then name: one row per App (its container), expandable
    to its process names; host processes grouped by name as in `fli top`.
  - **B** — by name only, as `fli top` does.
  - **Recommend A** — B makes `bun` one row holding every app on the box.
- ~~**Q4 — What does the action on a row do, and how is it gated?**~~ **Answered 2026-10-30 (`FJS-D1682`): C — no action in the first cut; a read-only view.**
  - **A** — a container row offers the existing restart; a host row sends
    SIGTERM through a new Outpost signal route (allow-list: refuses pid 1, the
    Outpost, `dockerd`, `containerd`, and anything in a container), gated as a
    `servers` action at developer level and written as a `ServerEvent`
    (new kind `signal_sent`, a migration).
  - **B** — SIGTERM any row, container or not, same gate and event.
  - **C** — no action in the first cut; a read-only view.
  - **Recommend A** (confidence 2) — it keeps the one action that is honest
    per row; how `reboot` is gated (0.1) may change the gate's spelling.
- ~~**Q5 — What is the noun?**~~ **Answered 2026-10-30 (`FJS-D1683`): A — *Processes* on the page, `processes` as the stream source; no new word, the reader is a `processes.js` beside the Outpost's `vitals.js`.**
  - **A** — *Processes* on the page, `processes` as the stream source; no new
    word, the reader is a `processes.js` beside the Outpost's `vitals.js`.
  - **B** — *Top*, after the tool.
  - **Recommend A** — it names what is shown; *top* is a program, not a thing.

## Phases

### Phase 0 — Groundwork

Goal: know the scan's cost in Bun on a box, and that cgroups name the container.
Done when: each step below has its finding written under it.

- [~] 0.1 Read how `servers.reboot` is gated and audited end to end (schema `@@transitions`, `servers.service.ts`, `recordServerEvent`), and whether a non-transition action has a precedent.
  - Dropped: the first cut is read-only (`FJS-D1682`), so there is no action to gate; it returns with Phase 4.
- [ ] 0.2 Time a full `/proc` scan in Bun on a real box (yuma or thod) against `fli top`'s native one; set the tick from it.
- [ ] 0.3 Confirm `/proc/<pid>/cgroup` names the docker container id on a box, and how Outpost maps container id → App.

### Phase 1 — The reader on the Outpost

Goal: the Outpost streams grouped process frames to a signed caller.
Done when: a signed `POST /processes/follow` against a local Outpost prints frames, and closing the request stops the scan.

- [ ] 1.1 A `processes.js` beside `outpost/src/vitals.js`: the `fli top` reader in JS, injectable like `vitals.js`; delta CPU per pid with the start-time check; grouping per Q3.
- [ ] 1.2 `POST /processes/follow` in `server.js`'s `streams`: vitals each tick, processes each scan, stopped by the abort signal.

### Phase 2 — The rail through Basecamp

Goal: the browser receives frames over the existing socket.
Done when: `WS /ws/stream/processes/<serverId>` delivers frames to a member and is refused for a non-member.

- [ ] 2.1 A `processes` row in `machine-stream.ts` `SOURCES`, `accessor: 'server'`.

### Phase 3 — The card

Goal: the Processes card on `/servers/[id]/`.
Done when: a `drive-browser` run shows both graphs moving and the table re-sorting by CPU and memory.

- [ ] 3.1 Two `Sparkline`s over a rolling buffer, the grouped `Table` with a CPU/memory sort, the cursor rule from `sort_groups`.

### Phase 4 — The action

Goal: the row action per Q4, gated and audited.

Deferred: Q4 ruled the first cut read-only (`FJS-D1682`). Its option **A** — restart
an app row, SIGTERM a host row through an allow-listed Outpost route — is the
reopen path once the card is in use; 0.1 comes back with it.
Done when: a developer's signal lands and is in the server's events; a viewer's is refused at the Data boundary; a container pid is refused by the Outpost.

- [~] 4.1 Outpost signal route with the allow-list.
- [~] 4.2 The gated `servers` action, the `ServerEventKind` value and its migration.
- [~] 4.3 The row's action and confirmation on the card.
