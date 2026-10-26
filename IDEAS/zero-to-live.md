---
id: zero-to-live
status: proposed
dated: 2026-10-18
---

# Idea — zero to live: a DigitalOcean account to an FJS app on a Cloudflare domain

**Status: PROPOSED. Phase 1 is ruled; nothing else is built.** Probed against the
tree 2026-10-18. Do not cite this file as behavior — see `VERIFYING.md`.

**The ask** (owner, 2026-10-18): make creating a server, installing Basecamp and
Outpost, creating a web app, deploying it and setting up Cloudflare as automated
as possible. **The cloud is DigitalOcean.** `hetzner-host.md` adds Hetzner as a
second cloud and proves it on real boxes.

This sits inside `deploy-plane.md`'s three rings and restates none of them: ring 0
`fli deploy` installs Basecamp, ring 1 Basecamp installs Outpost, ring 2 Outpost
deploys apps.

---

## What exists (probed 2026-10-18)

Every piece exists as code. **The whole chain has never run end to end on real
machines.**

| Piece | State |
| --- | --- |
| Ring 0 | `fli deploy` installs Basecamp. It has run on one real box (the run behind `FJS-D1191`). It needs a framework checkout, because Basecamp is `private`. |
| Basecamp's own box as a fleet machine | Built: `fli deploy` enrolls it by default (`FJS-D1202`, `FJS-D1241`) |
| Ring 1 on DigitalOcean | `providers/compute/digitalocean.ts`: catalog, create with `user_data`, enroll, destroy, reconcile (`docs/PROVISIONING.md` P1–P5). **Driven only against the stand-in on 8122. Cloud-init has never run on a real droplet** (`FJS-1397`; step 0.3). |
| Ring 2 | `/pull` → `/deploy` → `/health-check`, put-back on failure, Caddy routes, and a digest already on the machine skips the pull (`FJS-2645`). `verify:outpost` fails 4 of 48 checks on the loopback bind (`FJS-3325`). |
| App release from a laptop | `fli basecamp:deploy`: build here, `docker save \| ssh docker load`, release that digest (`FJS-D942`). It needs an App id copied out of the UI. |
| Cloudflare | Basecamp's `edge` service: the token is a workspace account, records are marked, a CNAME goes to the ingress record, `domain:dns` syncs it (`cloudflare-edge.md` Phases 1–5). There is no screen for the ingress zone. |
| Certificates | Caddy ACME. A Cloudflare origin certificate is not built (`fleet-ingress.md` Phase 4). |
| Docs | `packages/cli/docs/deploy.md` still says nginx, "clone repo" and "ssh in and populate .env". `FJS-D598`, `FJS-D1187` and `FJS-D1186` replaced all three. |

**The seed already holds DigitalOcean provider keys.** A drive that takes the first
account in the picker reaches someone else's credential (`PROVISIONING.md` § Four
things the drive found), so choose the account by name.

## The target

```
# once: a box, Basecamp on it, its DNS, both tokens handed in
fli basecamp:create --do-token $DO --cf-token $CF --domain ops.acme.com --admin me@acme.com

# per app
fli new myapp && cd myapp && fli make:deploy --server app.acme.com --domain app.acme.com   # a --basecamp flag is not built; 2.2 decides it
fli basecamp:deploy     # App + Domain if missing, env seeded, release, CNAME, certificate
```

Prior art, from memory and not fetched: Laravel Forge creates the server through
the vendor API and then manages it. Kamal's `setup` assumes the box exists. Coolify
and Dokploy are a `curl | bash` on a box you already have. This plan takes Forge's
front door and Kamal's laptop build.

---

## Plan

### Phase 0 — Prove what exists on real machines

Goal: the chain runs once on a real droplet with no new feature, and every hand
step is written down.
Done when: an FJS app answers over HTTPS at a Cloudflare hostname, released by
Basecamp onto a droplet Basecamp created, and § 0.4's list of hand steps exists.

- [x] 0.1 The owner supplies a DigitalOcean API token and a Cloudflare zone with a token scoped to it (`FJS-1397`; nothing in the tree can do this)
- [x] 0.2 Fix the four `verify:outpost` loopback-bind checks (`FJS-3325`, closed). `FJS-3183` and the missing git in the Basecamp image (`FJS-3280`) are closed
- [ ] 0.3 Create a real droplet through `/servers/provision/`: cloud-init runs, Outpost enrolls, the row reaches `online`. The install script (Docker, Bun, the sandboxed systemd unit, the enrollment exchange) has only been `sh -n`-parsed, and Outpost's `build`, `run` and `logs` have never met a real daemon; 0.4's release is their first (was `FJS-257`)
- [ ] 0.4 Release one real FJS app to it with `fli basecamp:deploy` on a Cloudflare hostname, and list every step done by hand: that list is Phases 2 and 3's backlog
- [ ] 0.5 Rewrite `packages/cli/docs/deploy.md` from what 0.3 and 0.4 actually did
- [ ] 0.6 Destroy the droplet through Basecamp and run `servers.reconcile`, so nothing is left billing

### Phase 1 — Rule the blockers

Goal: no step after this waits on a question.
Done when: every row below is in `DECISIONS.md`.

- [x] 1.1 One hostname reaches two Apps — [`FJS-D1040`](../DECISIONS.md#fjs-d1040) **A**: path routes on a Domain, longest prefix first, prefix kept
- [x] 1.2 Who creates Basecamp's own box — [`FJS-D1253`](../DECISIONS.md#fjs-d1253) **A**: `fli`, from a vendor token, with the cloud-init `enrollment.ts` serves and an existing compute connector (never a third copy)
- [x] 1.3 Basecamp's own DNS record — [`FJS-D1254`](../DECISIONS.md#fjs-d1254) **A**: the token is pasted once, and Basecamp's connector writes and marks the record
- [x] 1.4 A push starts a release — [`FJS-D884`](../DECISIONS.md#fjs-d884) **B**: a Conduit Receiver, with a per-App token URL as a second verification on the same Receiver

**Done 2026-10-18.** D1253 and D1254 were filed and ruled in the same session.

### Phase 2 — The app half is one command

Goal: from a scaffolded app to a live release with no click in Basecamp's UI.
Done when: Phase 0.4's app releases again from a clean Basecamp with
`fli basecamp:deploy` alone, and the list from 0.4 has nothing left in this phase.

- [ ] 2.1 `FJS-D1040` A: a Domain's path routes. **Engine built, `FJS-2647` closed**: `DomainRoute`, the `domain-routes` service and `ingress.js` prefix matching, proved against a real caddy:2. Left: a control for routes on the Domains screen, and routes across two machines (both Apps must sit on one today)
- [ ] 2.2 `basecamp:deploy` finds or creates the App and its Domains from the `frontier.config.js` deploy block, so no App id is copied out of the UI
- [ ] 2.3 An App's env reaches Basecamp seeded once from `.env.production`, the rule `FJS-D1186` set for ring 0
- [x] 2.4 A proxied Domain is never served under Flexible, where Caddy's HTTPS redirect loops: `domain:dns` writes a Full (strict) Configuration Rule for its host before the CNAME turns proxied, and the zone setting is never read (`FJS-D1522`, extending `FJS-D1422`)
- [ ] 2.5 App backups on a schedule and a screen (`FJS-3179`), checkpointed before the tar (`FJS-3178`). This step must land before any client's data is on the fleet.

### Phase 3 — Basecamp from zero

Goal: a DigitalOcean token and a Cloudflare token become a running Basecamp on
its own hostname.
Done when: one command, run against an empty DigitalOcean project, leaves
Basecamp answering at its hostname with an admin, both tokens stored as
Secrets, and its own box `online` in its fleet.

- [x] 3.1 Name the command — owner 2026-10-20: `fli provision`, Basecamp's own word for making a machine (`/servers/provision/`), over a flag on `deploy:setup` · renamed 2026-10-22: the namespace is `basecamp:*` (`create`, `install`, `dns`, `stop`, `destroy`, bare = list) and `deploy:basecamp` is `basecamp:deploy` — namespace names what is on the other end
- [ ] 3.2 `FJS-D1253`: create the droplet through an existing DigitalOcean connector, then run ring 0 on it. **Box half built**: `fli basecamp:create` / `basecamp:destroy` run `packages/basecamp/api/src/core/provision-host.ts`, which drives `providers/compute/digitalocean.ts` (new `sshKey()`, `MachineSpec.sshKeys`) and prints the ssh block; proved on the 8122 sink only. No `user_data`: `install.sh` is served by a running Basecamp, so this box cannot boot from it, and `fli deploy:setup` installs over SSH. Ring 0 from the same command is built: at a terminal, `fli basecamp:create` asks whether to install Basecamp once the box answers ssh, then runs `deploy:setup --auto-install` and `deploy` with `--server root@<ip>` from `packages/basecamp`, and `fli basecamp:install <server> --domain <host> [--admin <email>]` is that half alone, from any directory, for a box that already exists; a run with no token opens the DigitalOcean token page, takes the paste and stores it (`core/requires.js`). Left: one real droplet (0.1)
- [ ] 3.3 A non-interactive first run: `ENCRYPTION_KEY` generated locally and seeded with the env file, the admin made through `POST /setup`. **Built** ([`FJS-D1381`](../DECISIONS.md#fjs-d1381)): `deploy:setup` makes the key into the local `.env.production` on a box with none (`fillKey`), `--auto-install` asks nothing (the Caddy routes too), and `fli basecamp:create --approved --admin <email>` installs with no terminal and makes the admin over ssh, the password asked at a terminal and generated otherwise. Proved: the refusals and the `/setup` script against a stand-in. Left: one real droplet (0.1)
- [ ] 3.4 `FJS-D1254`: a script in the container (the `enroll-host.ts` shape) stores the DigitalOcean and Cloudflare tokens as the first workspace's Secrets, makes the Domain row for Basecamp's host, and runs `edge.sync`. **Blocked as ruled** (Q2): `edge.sync` cannot push Basecamp's own host on a fresh box. **Interim, owner 2026-10-21**: `fli basecamp:dns <ip>` (run by `fli basecamp:create` and `basecamp:install` themselves once Basecamp is up, owner 2026-10-22; the command alone is for a record that could not be written then) runs `api/src/core/host-record.ts` from the checkout, the `provision-host.ts` shape, and writes `A <web.domain> → <ip>` DNS-only through `providers/edge/cloudflare.ts` under the fleet's mark, so Basecamp reads the record as its own; a hand-made record at that name is refused. `CLOUDFLARE_TOKEN` is acquired at a terminal like `DIGITALOCEAN_TOKEN`. Proved against the Cloudflare stand-in only. Left: the tokens as Secrets and the ingress zone (Q2)
- [ ] 3.5 Grade the host on the real box: `/hub/security/` shows `hub.db-mode` and `hub.env-mode` graded rather than unknown, beside the `basecamp-host` row's fleet controls (built under `FJS-2714`)
- [ ] 3.6 `FJS-D1380`, `FJS-D1422`: once Basecamp is up, `fli basecamp:create` and `basecamp:install` write the record DNS-only, fetch `https://<host>` until it answers on a valid certificate, and at a terminal offer the flip: a Configuration Rule sets Full (strict) for that host alone, then the record turns proxied (`strictOrigin` in `providers/edge/cloudflare.ts`, `"proxied":true` to `core/host-record.ts`, `fli basecamp:dns --proxied` alone). A rerun keeps the record's proxy state. No terminal, or a no, leaves it DNS-only. **Built**; proved against the Cloudflare stand-in. Left: the flip on a real zone, with a token holding *Zone › Config Rules › Edit*
- [ ] 3.7 [`FJS-D1526`](../DECISIONS.md#fjs-d1526): Basecamp published as an image and installed by digest through `fli deploy --image`, with the cloud and DNS calls `provisionScript()` runs from the checkout moved into the cli, so `npm i -g @frontierjs/cli` alone runs `basecamp:create`. Done when it does, from a machine with no checkout. Then remove the not-yet note and the checkout block from `website/site/content/routes/start/basecamp.mesa`.

### Phase 4 — Continuous

Goal: a push releases without a laptop.
Done when: a push to the App's branch produces one `Deployment`, and a wrong
signature, a wrong token or another branch produce none.

- [ ] 4.1 `FJS-D884`: the Receiver, with a GitHub/Forgejo HMAC check and a per-App token URL (stored hashed like `enrollTokenHash`) as its two ways to verify a push (closes `FJS-1781`)
- [ ] 4.2 Build off the laptop (`deploy-plane.md` step **b**). Once an app depends on published packages rather than `link:`, Outpost's git build serves it with no laptop at all.

### Phase 5 — The gate

Goal: `frontier-cloud.md` step 7.
Done when: maid.tech or ELA runs on the fleet for a month of deploys, backups and
a restore drill with no hand SSH.

- [ ] 5.1 Move one client app off `fli deploy` onto the fleet

---

## Open questions

- ~~**Q1 — Proxied or DNS-only for Basecamp's own hostname.**~~ **Answered 2026-10-21 (`FJS-D1380`): A — DNS-only: step 3.4's script makes Basecamp's Domain row without naming `proxied`, so it takes the schema's `false` (`FJS-D563`, `Domain.proxied` in `packages/basecamp/db/schema.lite`); the A record points straight at the droplet and Caddy's HTTP-01 certificate is what the browser sees. The command's last step then verifies HTTPS answers at the hostname with a valid certificate, and at a terminal offers the flip to proxied — which sets the zone to Full (strict) first (step 2.4), since the origin now has the certificate strict mode needs.** Proxied hides the
  droplet's address. DNS-only keeps the operator console off Cloudflare's path,
  and Caddy's ACME HTTP-01 works either way. `FJS-D563` makes the bit
  per-record, so this is only a default.
  - **A** — DNS-only: step 3.4's script makes Basecamp's Domain row without
    naming `proxied`, so it takes the schema's `false` (`FJS-D563`, `Domain.proxied`
    in `packages/basecamp/db/schema.lite`); the A record points straight at the
    droplet and Caddy's HTTP-01 certificate is what the browser sees. The
    command's last step then verifies HTTPS answers at the hostname with a
    valid certificate, and at a terminal offers the flip to proxied — which
    sets the zone to Full (strict) first (step 2.4), since the origin now has
    the certificate strict mode needs.
  - **B** — Proxied: the 3.4 script writes `proxied: true` for Basecamp's own row
    only, so the droplet's address stays behind Cloudflare and the console's
    traffic crosses Cloudflare's edge; an operator flips it per record either way.
  - **Recommend A** — the schema already defaults `false`, so A writes no
    override and keeps one origin for the value (`FJS-D563`'s reason for refusing a
    global flag); the operator console staying off a third party's TLS
    termination outweighs hiding an address the fleet's own enrollment already exposes.
- **Q2 — Who writes Basecamp's own host record, given `edge.sync` cannot.** `FJS-D1254` has the container script make a Domain row and run `edge.sync`, but a Domain needs an App, and `push` (`services/edge/edge.service.ts`) writes only for an App `running` on an `online` server. The host's Outpost comes online only after fetching `install.sh` over HTTPS from Basecamp's own hostname (`installCommand`, `providers/compute/enrollment.ts`, TLS required), which needs the record first. Deferred by the owner 2026-10-21 until after a real deploy; step 3.4's interim writes the record under the fleet's mark alone, which A would keep.
  - **A** — an installation record: the script stores both tokens as Secrets and writes `A <host> → <ip>` through Basecamp's Cloudflare connector under a new `installMark()`, DNS-only, and sets the workspace's ingress zone to that zone when none is set. No App, no Domain; 3.6's flip to proxied rewrites the same marked record. Cloudron's shape: setup writes the `my.` record from the DNS token, apart from app records, and *Sync DNS* re-adds it ([docs](https://docs.cloudron.io/domains/)).
  - **B** — Basecamp as an App: an `image` App placed on the `basecamp-host` Server with a Domain on it, and `servingAddresses` counting the host Server's address while it is still `pending`. Keeps the ruling's words; puts a release no fleet step can act on into the App model.
  - **Recommend A** — it keeps the ruling's reason (Basecamp's connector writes and marks the record) and needs no exception in the push path.  Confidence 2: the open part is whether Basecamp shows the record anywhere, which A leaves to `edge.records`.
- ~~**Q3 — How the flip to proxied makes the edge strict for Basecamp's host.**~~ **Answered 2026-10-22 (`FJS-D1422`): A — a per-host Configuration Rule, marked like a record, written before the record turns proxied; the zone setting is never touched. The token needs *Zone › Config Rules › Edit*.** `FJS-D1380` says the flip "sets the zone to Full (strict) first", but SSL mode is a zone setting: kobami.cloud, the first real zone, carries about 40 other proxied hosts, and any whose origin has no valid certificate answers 526 the moment the zone turns strict. Cloudflare's own override for one host is a Configuration Rule (`set_config` with `ssl: "strict"`, [docs](https://developers.cloudflare.com/rules/configuration-rules/settings/)).
  - **A** — a per-host Configuration Rule, marked like a record, written before the record turns proxied; the zone setting is never touched. The token needs *Zone › Config Rules › Edit*.
  - **B** — flip only when the zone is already Full (strict), and otherwise stay DNS-only and say why. Never changes the zone; needs *Zone Settings* read.
  - **C** — set the zone to Full (strict), as `FJS-D1380` is written.
  - **Recommend A** — strict for exactly the host whose certificate was just proven, and nothing else in the zone moves. Confidence 3.
- Basecamp's own distribution is `FJS-D1526`: a published image pulled by
  digest, through the same `fli deploy` mode build-once uses. Not built; until
  it is, ring 0 runs from a framework checkout, and an npm-installed `fli`
  cannot run `basecamp:create`.

## See also

`deploy-plane.md` (the rings) · `packages/basecamp/docs/PROVISIONING.md` (ring 1) ·
`cloudflare-edge.md` · `fleet-ingress.md` · `go-live.md` (what is checked before an app is live, by category) · `paas-parity.md` § Deploying an FJS app
through the fleet · `frontier-cloud.md` (steps 4–7) · `server-posture.md`
