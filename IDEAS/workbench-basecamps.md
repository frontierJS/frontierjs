---
id: workbench-basecamps
status: proposed
dated: 2026-11-03
---

# Workbench over Basecamps — ring 0 on a screen

**Status: PROPOSED.** Dated 2026-11-03. Nothing here is built. Do not cite this
file as describing behavior — see `VERIFYING.md`.

The want: Workbench talks to every Basecamp this laptop has made, and gives each
one a small control plane — back it up, restart it, and later create and destroy
one. Small next to being inside Basecamp: Apps, servers, people and per-App
backups stay on Basecamp's own pages.

**This is ring 0** (`deploy-plane.md` § The bootstrap ring). A control plane
cannot restart, upgrade or destroy itself — the plane never holds the knife to its
own throat — so those calls come from outside it, and ring 0 is defined as *from a
laptop*. Workbench is the laptop's app. It adds an index and a screen over verbs
fli already has; it adds no noun to Basecamp and no import between the two
packages (`packages/workbench/CLAUDE.md`).

---

## What exists

- **Every verb, as a fli command.** `basecamp:create` buys a box and runs
  `basecamp:install`; `basecamp:key` mints an admin API key over ssh into
  `~/.config/fli/.env`; `server:destroy` deletes a box `server:create` made.
  Basecamp backs itself up through `hubBackups.take`
  ([hub-backups.service.ts](../packages/basecamp/api/src/services/hub-backups/hub-backups.service.ts)),
  system-admin only. Restart has no command; deploy restarts units over ssh
  (`packages/cli/commands/deploy/_module.md`), and the API container's name is
  `apiContainerName()` in `packages/cli/core/ports.js`.
- **No index of Basecamps.** Each `fli basecamp:*` command reads one
  `BASECAMP_URL` and one `BASECAMP_API_KEY` from the environment, so a second
  Basecamp is a hand-edited env file. `demo-box.md` names the gap: nothing indexes
  the fleet of Basecamps, and `server-destroy.job` runs inside the Basecamp that
  made the box.
- **The name already exists.** `basecamp:create` writes a `Host <name>` block to
  `~/.ssh/config`. That name is the entry's key here, so no new noun is coined.
- **Workbench dials one Basecamp already**, as a signed peer for previews
  ([basecamp.ts](../packages/workbench/api/src/domain/peer/basecamp.ts)),
  from `BASECAMP_URL` and `BASECAMP_KEY_ID`. It imports `packages/cli/core/*`
  by path, as `atlas.ts` does.

## Prior art

- **Kamal** — a laptop CLI over ssh boots, restarts and removes the stack, and
  nothing on the box manages it. This paper takes that role for Basecamps.
- **Portainer** — an agent on each box answers to one console. Basecamp already
  plays that role for Apps through the Outpost; reusing the Outpost on
  Basecamp's own box would be Basecamp restarting itself.

## Security

Workbench now holds an admin key for every Basecamp this laptop made. It binds
loopback behind one pass-phrase (`WORKBENCH_KEY`), and the file is `0600`, the
same posture as `~/.config/fli/.env` today. ssh stays the root of trust: a lost
key is minted again over ssh, and Workbench never asks Basecamp for a credential
it could not get by ssh. Under Q4 an entry also holds the preview peer's key id,
so one entry carries two credentials of different power: the admin key reaches
every system-admin call, and the peer key reaches only what `FJS-D1188` grants a
peer.

## Phases

### Phase 0 — Groundwork

Goal: what each verb needs, measured against a real Basecamp.
Done when: each probe's finding is written under its step.

- [ ] 0.1 List every reader of `BASECAMP_URL` / `BASECAMP_API_KEY` and split
  the laptop's from the box's. Laptop-side: the `basecamp:*` commands,
  `ws:deps --push`, `db`, `outpost:status` and the `tutor` fixture — each moves
  to the index. Box-side: `packages/outpost/src/config.js` and Basecamp's own
  providers read the in-box env and keep it. For each laptop reader, note what
  it needs: the origin, the key, or the ssh Host.
- [ ] 0.2 Against the local dev Basecamp, `hubBackups.take` then poll `find`
  with a key `basecamp:key` minted, from outside Basecamp's process.
- [ ] 0.3 Restart Basecamp's API container over ssh on a box, and time how long
  until its health route answers again. The box is the owner's; ask first.

### Phase 1 — The index (fli)

Goal: fli knows every Basecamp by its ssh Host name.
Done when: `fli basecamp` lists the dev Basecamp and one box, each with whether
it answers, and `bun run test` in `packages/cli` is green.

- [ ] 1.1 `packages/cli/core/basecamps.js` reads and writes `basecamps.json`
  (`0600`) in the directory `core/global-env.js` owns, never a hand-spelled
  path: per name, the API origin, the ssh Host, the cloud and box id, and the
  API key (Q1, Q2). The Host is optional: the local dev Basecamp is the
  reserved name `dev`, and a CI machine adds an entry with no Host. Restart
  refuses an entry with no Host.
- [ ] 1.2 `basecamp:create`, `basecamp:install` and `basecamp:key` write the
  entry; the key moves out of the global env into it.
- [ ] 1.3 Every laptop reader 0.1 found takes `--basecamp <name>`; with one
  entry it is the default, and with several and no flag the command refuses by
  name and lists them. `BASECAMP_URL` / `BASECAMP_API_KEY` leave every laptop
  reader in the same change, with no alias. `ws:deps --push` and `db` keep
  their scoped key: the entry holds the admin key for ring-0 verbs, and a
  scoped key beside it when one was issued.
- [ ] 1.4 `fli basecamp` lists the entries and whether each answers.
- [ ] 1.5 Pin the boundary in `packages/cli`: no command source reads either
  env var, the file is `0600`, and every entry with a Host names one in
  `~/.ssh/config`. The last two are `fli doctor` rows as well.

### Phase 2 — Back up and restart (fli)

Goal: both verbs work from a terminal before a screen exists.
Done when: each runs against the dev Basecamp and reports the outcome Basecamp
recorded, not the outcome it asked for.

- [ ] 2.1 Take Basecamp's own backup and wait for it to settle. The spelling is a
  new verb or a flag on `basecamp:backup`, whose default today is an App; settle it
  through `decision-rules` at the step.
- [ ] 2.2 `fli basecamp:restart` restarts the API container over ssh and waits
  until the health route answers.

### Phase 3 — The screen (Workbench)

Goal: the same verbs from Workbench.
Done when: on `/basecamps/`, signed in, Back up now and Restart run against the
dev Basecamp and the page shows each outcome.

- [ ] 3.1 A `basecamps` service in Workbench over `core/basecamps.js` and the
  Phase 2 helpers, imported by path.
- [ ] 3.2 `/basecamps/` lists each entry with whether it answers, plus Back up now
  (with the newest backup's time) and Restart behind a confirm.
- [ ] 3.3 Create is a form over `basecamp:create --yes`, run as a job whose output
  streams to the page, since a box takes minutes. The form says the box is
  billed from that moment and that undoing it is `fli server:destroy` (Q3).

## Open questions

- ~~**Q1 — How Workbench authenticates to each Basecamp.**~~ **Answered 2026-11-03 (`FJS-D1827`): A — ssh is the root; an admin API key per Basecamp is minted over ssh as `basecamp:key` does, and restart uses ssh.**
  - **A** — ssh is the root; an admin API key per Basecamp is minted over ssh as
    `basecamp:key` does, and restart uses ssh.
  - **B** — Widen the signed peer to system-admin calls.
  - **C** — ssh for everything; a backup is a command run on the box.
  - **Recommend A** — ring 0 already trusts ssh, and the peer door stays as
    narrow as `FJS-D1188` left it. C skips Basecamp's own record of its backups.
- ~~**Q2 — Where the index lives.**~~ **Answered 2026-11-03 (`FJS-D1828`): A — A fli-owned file, `~/.config/fli/basecamps.json`, read by Workbench through `cli/core`.**
  - **A** — A fli-owned file, `~/.config/fli/basecamps.json`, read by Workbench
    through `cli/core`.
  - **B** — A model in `packages/workbench/db/schema.lite`.
  - **Recommend A** — fli and the screen read one list; under B fli cannot see
    it and the two drift.
- ~~**Q3 — Destroy in the first version.**~~ **Answered 2026-11-03 (`FJS-D1829`): C — No destroy yet; it stays `fli server:destroy`.**
  - **A** — Take and verify a fresh backup, require the name typed, then
    `server:destroy`; DNS and the bucket kept.
  - **B** — A, plus removing the DNS record and the backup bucket.
  - **C** — No destroy yet; it stays `fli server:destroy`.
  - **Recommend A** — the backup-first gate is what makes destroying from a
    screen safe.
- **Q4 — Workbench's preview Basecamp.**
  - **A** — The preview peer reads its Basecamp from the index, by name, and
    `BASECAMP_URL` / `BASECAMP_KEY_ID` leave `api/src/core/env.ts`.
  - **B** — Previews keep their own env pair.
  - **Recommend A** — one list of Basecamps on this laptop, not two. The peer key
    id joins the entry.

## Out of scope

- **Destroy** — stays `fli server:destroy` (Q3). When it comes back it needs a
  ring-0 path of its own, since `server-destroy.job` runs inside the Basecamp
  that made the box (`demo-box.md`).
- **A box reboot** at the cloud — restart here is the container only.
- **Upgrading Basecamp** — `fli basecamp:deploy` already does it, as ring 0.
