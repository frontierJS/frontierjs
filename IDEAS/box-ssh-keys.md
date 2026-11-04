---
id: box-ssh-keys
status: proposed
dated: 2026-11-04
---

# Idea — whose SSH key a new box carries

**Status: PROPOSED. Q1–Q2 open; 0.1 next.**
Probed against the tree 2026-11-04. Do not cite this file as behavior — see `VERIFYING.md`.

**The ask** (owner, 2026-11-04): when a box is created for Basecamp, what decides whose SSH
keys go on it? The answer is two paths that do not agree, and a column that looks as if it
decides and does not.

## What exists (probed 2026-11-04)

- **A box `fli` buys carries the public key of whoever runs it.** `fli basecamp:create` and
  `fli server:create` both call `publicKey()` (`packages/cli/core/cloud.js:251`): `--key
  <file.pub>`, else `~/.ssh/id_ed25519.pub`, else `~/.ssh/id_rsa.pub`. Exactly one key.
  `buyBox()` hands it to `provision-host.ts`, whose `create()` (`:170`) puts it on the cloud
  account through `connector.sshKey()` (reused when the key body already matches, else named
  `fli <name>`) and orders the box with `sshKeys: [handle]`. The vendor's own cloud-init
  writes it into root's `authorized_keys`.
- **A box Basecamp's API makes carries no key.** `servers.service` `provisionStep('create')`
  (`servers.service.ts:895`) sends `userData` (the enrollment cloud-init) and no `sshKeys`.
  That follows `FJS-D241` — a machine Basecamp made is installed by cloud-init, never reached
  over SSH — and the `MachineSpec` comment (`providers/compute/index.ts:210`) names Basecamp's
  own box as the one machine with `sshKeys`. The Provision screen
  (`web/src/routes/servers/provision.mesa`) asks for no key.
- **`Server.sshKeyId` installs nothing.** It names an `sshKey` Secret, editable on the
  server's page since `FJS-D1834`, and only `ssh.unknown-key` reads it
  (`server-postures.service.ts:61` → `domain/host/posture.ts:215`): each fingerprint in
  `authorized_keys` that the Secret does not hold is a stranger. Nothing in the CLI or the
  API writes the column, so a new box's control reads `unknown` until a person sets it by hand.
- **No key on the box keeps password login on.** The enrollment script turns password login
  off only when some `authorized_keys` holds a line (`providers/compute/enrollment.ts:328`),
  and otherwise prints *no authorized ssh key on this machine: password login is left on*.
  So every API-made box keeps password login on.

**The gap.** `FJS-D241` struck SSH as Basecamp's way *in*, and kept `ssh_key` "as a person's
recovery path" (`IDEAS/deploy-plane.md` § ring 1). On an API-made box that recovery path is
never laid. On a `fli`-made box it is laid, but Basecamp does not know which key it was.

## Open questions

- **Q1 — Does a box Basecamp's API makes get a key at create?**
  - **A** — Install the public half of the `sshKeyId` Secret at create: `connector.sshKey()`
    once per public key line, then `sshKeys` on `connector.create`. Basecamp still never
    connects. The vendor writes the key, and the app uses no private key.
    The Provision screen gains the `sshKeyId` picker. If the workspace has exactly one `sshKey`
    Secret, the picker defaults to it. If nothing is picked, the screen says the box will carry
    no key and will keep password login on, so a keyless box is never created silently.
  - **B** — No key. Recovery goes through the vendor's console or a root password, and the
    Provision screen says so.
  - **C** — Every `sshKey` Secret in the workspace goes on every box, with no per-box choice.
  - **Recommend A** — It lays the recovery path `FJS-D241` kept, through a connector method
    that already exists (`sshKey()`, used by ring 0). It turns password login off on fleet
    boxes, because the enrollment script's check then finds a key. And `ssh.unknown-key` grades
    from the first heartbeat instead of reading `unknown`. C installs a key on boxes its owner
    never meant it for, and `FJS-D1834` already made the choice per box.

- **Q2 — Does a `fli`-bought box record the key it carried?**
  - **A** — When the box becomes a Server, store the public key as an `sshKey` Secret (or reuse
    one holding the same key body) and set `sshKeyId`.
  - **B** — Leave it. The person picks the Secret on the server's page.
  - **Recommend A, if 0.2 finds a Server row to write** — the key is known at that moment and
    lost after it. B leaves `ssh.unknown-key` at `unknown` on Basecamp's own box, the box
    whose keys matter most. **The catch for Basecamp's own box:** `fli basecamp:create` runs
    before any Basecamp exists to hold a Secret, so the key would have to be handed over later,
    at enroll or the first heartbeat. That opens a second path into the Secret, which
    Invariant 4 argues against. If 0.2 finds no clean place, take B, and have the `unknown`
    row's `fix:` say why. Depends on Q1 = A, which makes the Secret the one origin.

## Plan

### Phase 0 — Probes

Goal: what a keyless box really gets, and where a `fli` box becomes a Server.
Done when: each step below has its answer written under it.

- [ ] 0.1 What DigitalOcean and Hetzner do on a create with no `ssh_keys` (a root password
  emailed, a console-only login?), and whether the two stand-ins (`digitalocean-sink.ts`,
  `hetzner-sink.ts`) model it
- [ ] 0.2 Whether `fli basecamp:create` / `fli server:create` ever write a Server row, and
  which step does
- [ ] 0.3 Whether an `sshKey` Secret holding only a private key yields a public key line, not
  only a fingerprint (`privateKeyBlobs` in `posture.ts` has the blob; the type prefix is what
  is owed)

### Phase 1 — Key at create (Q1 = A)

Goal: an API-made box carries the keys its `sshKeyId` Secret names.
Done when: a `compute.test.ts` row asserts the create body carries the key, and a box the
stand-in made grades `ssh.unknown-key` pass.

- [ ] 1.1 `publicKeyLines(data)` beside `publicKeyFingerprints`: every public key line in a
  Secret, plus the line for each private key's public half
- [ ] 1.2 `provisionStep('create')` resolves `sshKeyId` (scoped to the workspace, as
  `refuseForeignAccount` already does), calls `connector.sshKey()` per line, passes `sshKeys`
- [ ] 1.3 The `sshKeyId` picker on the Provision screen. It defaults to the workspace's only
  `sshKey` Secret when there is one, and warns that the box will carry no key and keep
  password login on when nothing is picked
- [ ] 1.4 The stand-ins write the created machine's `ssh_keys` into the posture reading they
  serve

### Phase 2 — `fli` records its key (Q2 = A)

Goal: Basecamp's own box names the key `fli` put on it.
Done when: after `fli basecamp:create` against a stand-in, the box's Server row has an
`sshKeyId` whose Secret holds the key from `--key`.

- [ ] 2.1 At the step 0.2 names, store or reuse the `sshKey` Secret and set `sshKeyId`

## See also

`IDEAS/server-posture.md` (Q12, `ssh.unknown-key`) · `IDEAS/deploy-plane.md` (the install
rings, `FJS-D241`) · `IDEAS/zero-to-live.md` (ring 0, `FJS-D1253`)
