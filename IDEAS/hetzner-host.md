---
id: hetzner-host
status: proposed
dated: 2026-10-22
---

# Idea — Hetzner as a flag on `fli basecamp:*`

**Status: PROPOSED. Phase 0 is ruled; nothing else is built.** Probed against the tree 2026-10-22. Do not
cite this file as behavior — see `VERIFYING.md`.

**The ask** (owner, 2026-10-22): one easy flag runs the zero-to-live chain off
Hetzner instead of DigitalOcean. The reason is price: a Hetzner box with 4 GB is
about a third of DigitalOcean's `s-2vcpu-4gb` ($24/mo). That figure is from
memory, so step 2.1 checks it against the live catalog.

This changes one line of `zero-to-live.md`, which said that plan "neither uses
nor proves" Hetzner. Its phases are otherwise unchanged. This paper adds the
second cloud to ring 0 and proves both rings on it.

---

## What exists (probed 2026-10-22)

| Piece | State |
| --- | --- |
| Ring 1 on Hetzner | `providers/compute/hetzner.ts` implements every method of `ComputeConnector`: `catalog`, `create` (with `user_data`, `ssh_keys` and `labels`), `sshKey`, `powerOff`, `destroy`, `marked` and `verify`. The provision wizard already offers Hetzner, and `verify:provision` drives the Hetzner stand-in on 8124. **It has never run against the real Hetzner API.** |
| Ring 0 | **Works with DigitalOcean only.** `api/src/core/provision-host.ts` reads `DIGITALOCEAN_TOKEN`, calls `connectorFor('digitalocean')`, imports `reservedIps` and `RESERVED_EGRESS` from `digitalocean.ts`, and has DigitalOcean's name in its progress lines (`BOOTING`). |
| fli commands | `basecamp:create`, bare `basecamp`, `basecamp:stop` and `basecamp:destroy` each declare `requires: DIGITALOCEAN_TOKEN` in their frontmatter. `create` defaults to `--region nyc3` and `--image ubuntu-24-04-x64`, and its `--size` help names a DigitalOcean slug. `_module.md` describes them as working on "droplets". |
| Enrollment cloud-init | Reads the distro from `$ID`, but the unattended-upgrades origin is hard-coded to `origin=Ubuntu`, so it supports Ubuntu only. Hetzner's `ubuntu-24.04` image is enough for it. |
| Tests | No test runs `provision-host.ts`. It was checked by hand against the 8122 stand-in. |

**Three traps the probe found:**

- **Architecture.** `ComputeSize` has no architecture field, and Hetzner sells
  arm64 types (CAX) beside x86 (CX, CPX). `pickSize('4gb')` takes the cheapest
  size with 4 GB, which is probably an ARM type. `basecamp:deploy` ships an
  amd64 image built on the laptop (`docker save | ssh docker load`), and that
  image cannot run on an ARM box. The provision wizard in ring 1 has the same
  gap.
- **The Hetzner stand-in has no `/v1/ssh_keys` route** and no primary-IP
  routes. Ring 0 calls `sshKey()`, so the Hetzner stand-in cannot run ring 0
  today.
- **The reserved IP setup works only on DigitalOcean.** `RESERVED_EGRESS` reads
  DigitalOcean's metadata service (`169.254.169.254/metadata/v1`). Hetzner's
  equivalent is different (Q3).

## The target

```
fli basecamp:create --cloud hetzner --domain ops.acme.com --admin me@acme.com
fli basecamp            # lists the boxes at every cloud that has a token
fli basecamp:stop <id> && fli basecamp:destroy <id>
```

With Q1 as ruled, a person who has stored only `HETZNER_TOKEN` never
types `--cloud`.

---

## Plan

### Phase 0 — Rule the flag

Goal: no step after this waits on a question.
Done when: Q1–Q3 are rulings in `DECISIONS.md`.

- [x] 0.1 Q1: how the cloud is chosen — [`FJS-D1478`](../DECISIONS.md#fjs-d1478) **B**
- [x] 0.2 Q2: the name of the token key — [`FJS-D1479`](../DECISIONS.md#fjs-d1479) **A**: `HETZNER_TOKEN`
- [x] 0.3 Q3: the address that outlives a Hetzner box — [`FJS-D1480`](../DECISIONS.md#fjs-d1480) **A**: a Primary IPv4, `auto_delete: false`

**Done 2026-10-23.** All three rulings follow the paper's recommendations.

### Phase 1 — Ring 0 speaks either cloud, on the stand-ins

Goal: `provision-host.ts` and the `basecamp:*` commands contain no vendor's
name.
Done when: create, list, stop, destroy and release run by hand against both
stand-ins (8122 and 8124), and `rg -i 'digitalocean|droplet'` finds nothing in
`provision-host.ts` or `commands/basecamp/`, except in a per-cloud token page.

- [x] 1.1 Add `GET`/`POST /v1/ssh_keys` to the Hetzner stand-in, plus the primary-IP routes Q3 needs
- [x] 1.2 Add `ComputeSize.arch` (`x86` | `arm`). DigitalOcean fills in `x86` for every size, and Hetzner reads `architecture` from the server type. `pickSize` and the provision wizard pick only x86 unless they are asked for ARM, and ARM boxes themselves are out of scope (§ After this)
- [x] 1.3 Move the held address behind the connector: optional `address` methods (`hold`, `reuse`, `list`, `release`, and `userData` for any egress script). DigitalOcean's methods are today's `reservedIps` and `RESERVED_EGRESS`, and Hetzner's are Q3's answer. After this, `provision-host.ts` imports no vendor file
- [x] 1.4 Add a `defaults: { region, image }` field to each connector. DigitalOcean's is `nyc3` and `ubuntu-24-04-x64`. Hetzner's is `ash` and `ubuntu-24.04`: Ashburn keeps the box in the US like `nyc3`. `--region` and `--image` default to empty, which falls through to the connector's defaults
- [x] 1.5 Make `provision-host.ts` take `cloud` in its input. It reads the token from that cloud's key (Q2), calls `connectorFor(cloud)`, and takes its progress lines from `connector.label`
- [x] 1.6 Add `--cloud` to `basecamp:create`, bare `basecamp`, `basecamp:stop` and `basecamp:destroy`, resolved as Q1 rules. Drop the token from their frontmatter `requires:`. `_module.md` fetches the token for the chosen cloud, the way `cloudflareToken` already does: a `requires:` list is static and cannot depend on a flag. Rewrite the help and docs text to say "box" where it now says "droplet"

**Done 2026-10-23.** Each command ran by hand through `fli` against both
stand-ins, and the `rg` check finds vendor names only in `_module.md`'s
`CLOUDS` table and its Setup section, which together are the per-cloud token
page. Four departures from the steps:

- The connector field is `reservedIps`, not `address`, because `address` is
  already the vendor URL a stand-in overrides. Its methods are `list`, `get`,
  `reserve`, `release`, an optional `assign` and an optional `egress`.
- The address is held BEFORE the box is bought. Hetzner assigns a Primary IP
  only at create or while the box is off, and holding it first means a refusal
  leaves nothing billing.
- On Hetzner the box's own address IS the held one, so `basecamp:destroy`
  dedupes the two before listing what is left over.
- Under `--yes` the cloud is never asked: Enter's answer would buy at whichever
  cloud is listed first, the shape that makes `--yes` refuse without `--name`.
  Unless exactly one token is stored, `--cloud` is required. A token for the
  named cloud is still asked for at a terminal.

Facts Phase 2 will meet:

- A Hetzner Primary IPv4 bills €0.50/mo plus VAT whether or not a box holds it.
  It is bound to one location, and it must be unassigned before it can be
  deleted (422 `must_be_unassigned`).
- Reuse still goes by the hostname's DNS record. Without `CLOUDFLARE_TOKEN`, or
  with `--region` in another location, a create holds a fresh address and the
  kept one goes on billing.

### Phase 2 — One real Hetzner box, both rings

Goal: the chain runs on a real Hetzner account.
Done when: Basecamp answers over HTTPS on a box made by `fli basecamp:create
--cloud hetzner`, a second box made from Basecamp's provision wizard reaches
`online`, and both are destroyed with `servers.reconcile` clean.

- [ ] 2.1 The owner supplies a Hetzner Cloud project token with Read & Write. Check the live catalog's x86 4 GB price against DigitalOcean's before going further: that price is the reason for this paper
- [ ] 2.2 `fli basecamp:create --cloud hetzner --admin …`: the box, the install, the DNS record and the Outpost enrollment of the box itself. List every step done by hand
- [ ] 2.3 Provision a second box from `/servers/provision/` with Hetzner chosen. This is the first real cloud-init enrollment on either cloud, so it also answers `zero-to-live.md` 0.3 on Hetzner
- [ ] 2.4 Release one app to it with `fli basecamp:deploy` (`zero-to-live.md` 0.4)
- [ ] 2.5 Stop and destroy both boxes, run `servers.reconcile`, and confirm the held address is kept or released as Q3 rules

---

## After this (not in this plan)

- **ARM boxes** (Hetzner CAX) need a multi-arch image build in `basecamp:deploy`
  and Outpost's builds. Chromium in the image also needs checking on arm64.
- **Debian 13** needs only `origin=Debian` in the enrollment script's
  unattended-upgrades block and one real run. `--image debian-13` would then
  work on either cloud.
- **A golden snapshot** with Docker, Caddy and chrony baked in would skip most
  of cloud-init's apt work on both clouds.

## Open questions

- ~~**Q1 — How the cloud is chosen.**~~ **Answered 2026-10-23 (`FJS-D1478`): B — The same flag, but its default comes from the tokens in the global fli env. With exactly one cloud's token, use that cloud. With both, ask at a terminal and refuse without one. With neither, ask at a terminal which cloud to use, then ask for its token. Bare `basecamp` lists the boxes at every cloud that has a token, and `stop`/`destroy <id>` look the id up among the fleet-tagged boxes at each cloud.**
  - **A** — Every `basecamp:*` command that calls a vendor takes `--cloud <kind>`, which defaults to `digitalocean`.
  - **B** — The same flag, but its default comes from the tokens in the global
    fli env. With exactly one cloud's token, use that cloud. With both, ask at a
    terminal and refuse without one. With neither, ask at a terminal which cloud
    to use, then ask for its token. Bare `basecamp` lists the boxes at every cloud
    that has a token, and `stop`/`destroy <id>` look the id up among the fleet-tagged
    boxes at each cloud.
  - **C** — A, plus a stored default (`fli eset FLI_CLOUD hetzner --global`).
  - **Recommend B.** It is the flag the owner asked for, and there is nothing
    else to set, because the token a person has already says which cloud they
    use. C stores the same answer in a second place, and it can disagree with
    the token. Confidence 2: an account with both tokens has to answer the
    question every time. The flag is called `--cloud` rather than
    `--provider` because its values are only the compute kinds of
    `ProviderKind` (`digitalocean`, `hetzner`), and `cloudflare` is a Provider
    too.
- ~~**Q2 — The name of the token key.**~~ **Answered 2026-10-23 (`FJS-D1479`): A — `HETZNER_TOKEN`, named like `DIGITALOCEAN_TOKEN`.**
  - **A** — `HETZNER_TOKEN`, named like `DIGITALOCEAN_TOKEN`.
  - **B** — `HCLOUD_TOKEN`, the key that Hetzner's `hcloud` CLI and its
    Terraform provider already read.
  - **Recommend A.** Match the siblings: the tree's keys are `<VENDOR>_TOKEN`,
    and `CLOUDFLARE_TOKEN` already departs from Cloudflare's own
    `CLOUDFLARE_API_TOKEN`. Basecamp's env has `HETZNER_URL` beside it too, so a
    person who knows one key can predict the next. B is the reopen path if
    reusing an existing `hcloud` setup turns out to matter. Confidence 2.
- ~~**Q3 — The address that outlives a Hetzner box (`--reserved-ip`).**~~ **Answered 2026-10-23 (`FJS-D1480`): A — A Primary IPv4 with `auto_delete: false`, given to the server at create (`public_net.ipv4`). It IS the server's own address, so outbound traffic already leaves from it and Hetzner needs no egress script. Reuse means the hostname's record holds a Primary IP in the same location that no server holds.**
  - **A** — A Primary IPv4 with `auto_delete: false`, given to the server at
    create (`public_net.ipv4`). It IS the server's own address, so outbound
    traffic already leaves from it and Hetzner needs no egress script. Reuse
    means the hostname's record holds a Primary IP in the same location that no
    server holds.
  - **B** — A Floating IP plus an egress script, the same arrangement as on
    DigitalOcean. Hetzner also needs the address configured inside the box
    before the box receives anything on it.
  - **C** — No held address on Hetzner: `--reserved-ip` is refused there.
  - **Recommend A.** It is Hetzner's own mechanism for keeping an address
    across a rebuild, and it removes a script rather than porting one.
    Confidence 2: the Primary IP's price, and whether it is bound to a location
    or a datacenter, are from memory and not fetched, so 1.1 checks them against
    Hetzner's API docs.

## See also

`zero-to-live.md` (the chain this runs on) · `packages/basecamp/docs/PROVISIONING.md` (ring 1) ·
`packages/basecamp/api/src/providers/compute/index.ts` (the `ComputeConnector` boundary)
