---
id: provisioning
status: proposed
dated: 2026-09-07
---

# Plan — provisioning a machine: from *import a box* to *make one*

**Status: PROPOSAL. Nothing here is built.** Dated 2026-09-07. This is the plan for
the half of `ProvisionServerView` that never landed — the Forge-replacement half,
where an operator picks a provider, a region and a size, and a machine exists that
Basecamp can deploy to.

It does not restate `IDEAS/deploy-plane.md`'s bootstrap rings, which are the frame
this sits in. It **amends ring 1's mechanism** and says so in § *The hearing*.

---

## What exists, measured

| | |
| --- | --- |
| The mock | `docs/mock/BasecampUI.jsx:1178` — `ProvisionServerView`, five steps, a DigitalOcean catalog written out as three constants, and a nine-line progress list driven by `setTimeout` |
| The screen | `web/src/routes/servers/create.mesa`, 87 lines. Name, role, IP address, region — **an import form**, and its own header comment says why: the adapters are stubs, so a wizard would promise what the API cannot do |
| The column | `Server.registerMethod` defaults to `"imported"` and there is no code path that writes anything else |
| The states | `ServerStatus` ran `pending provisioning installing ready online …` with **`installing`, `ready` and `unreachable` the target of no move** — the seed was their only producer. `ready` is deleted; the other two are [FJS-1021](../../../ISSUES.md#fjs-1021) |
| The vendor seam | `api/src/services/servers/servers.service.ts:335` builds `provider:${server.providerKind}` and sends `GET /servers/<providerServerId>` through conduit. **Nothing anywhere registers that target**, so the send has a caller and no callee |
| The interfaces | `api/src/providers/index.ts` carries ten, all stubs. **None of them is compute.** DigitalOcean appears once, as a TODO for `cloudSpend` |
| The enum | `ProviderKind` is `custom hetzner`. No `digitalocean` |
| The machine's half | `@frontierjs/outpost` installs as three env vars and `bunx outpost`. Nothing in this repo puts it on a box |
| The credential | One fleet-wide `OUTPOST_SECRET`. `api/src/core/hooks.ts` names the limit in place: a compromised machine can forge any other machine's check-in, and per-server secrets need a mint and a hand-over at install time |

So the gap is not the screen. **It is that this app has never made a call that
creates something at a vendor, and has never handed a credential to a machine.**

---

## The nine questions

Answered before the first edit, per `PHILOSOPHY.md` § V.

**Another origin of truth?** Only in the version that is refused. `provider:<kind>`
is already this app's way of speaking to a cloud; adding an `ICompute` to
`BasecampProviders` beside it would make two owners of *talk to a vendor*. The
connector is a conduit target and the interface list does not grow (§ D1).

**Concept budget?** Grows by one idea — **which account a machine was made with** —
and that idea already has a column holding nothing, `Server.providerId`. No new
model. The wizard's progress, the credential and the catalog all reuse nouns this
app has: `ServerEvent`, `Secret`, the workspace channel.

**The problem's complexity, or ours?** The problem's. Making a machine is a call to
somebody else's API and a wait. The one piece that is ours is the credential
hand-over, and it is ours because we chose registration-by-heartbeat over a push.

**Predictability?** Improves. `registerMethod` reads `imported` for every row in
the fleet because that is the only door; a second door makes the column mean
something.

**Derived rather than restated?** The catalog is the test, and the mock fails it:
`DO_REGIONS`, `DO_PLANS` and `DO_IMAGES` are a vendor's price list copied into a
JSX file, already wrong. Regions, sizes, images and prices are **read from the
vendor per wizard load**. The progress list is derived the same way — `ServerEvent`
rows, not a second step model beside `DeploymentStep`.

**Exactly one owner?** After D2, yes: one function turning *(kind, account)* into a
target id, three readers — sync, provision, destroy. Today the string is built
inline at one site and cannot be right for two workspaces at once.

**Boundary named, typed, tested?** Named `provider:<kind>:<accountId>`, typed by a
connector module per vendor, tested against a sink that runs with no network and
spends no money.

**Failure proportional to the cost of being wrong?** This is the most expensive
surface in the app — a mistake here bills somebody and puts a reachable machine on
the internet. So it is the strictest: gate 5 to create and to destroy, a typed
confirmation (`docs/VISION.md` constraint 5), a stated dispatch id so a double
click cannot mint two machines, and a vendor-side tag carrying the `Server` id.

**Can it be wrong with nothing saying so?** Two ways, and both need an artefact.
**An orphan** — created at the vendor, never recorded here, billing forever — is
visible only through the tag, so a `fleet:reconcile` pass lists vendor machines by
tag against `Server` rows and **reports** rather than deletes. **A machine that
never comes back** — created, cloud-init failed, no heartbeat — looks exactly like
one still booting, so the provision job carries a deadline and says so, instead of
leaving a row at `installing` for a week.

**§ IV adjudications.** *Preservation vs. evolution* — the import form and the
producerless `ready` were both pre-alpha shapes with no users; the form becomes the
wizard's custom branch and `ready` is deleted rather than aliased. *Ergonomics vs. strictness* — resolved per surface by what a mistake destroys,
which here is money. *Doctrine vs. discovery* — held as a hearing below.

**§ VII tier.** Assessment. It carries a status and a date, it is `IDEAS/`-shaped,
and it is not citable as behavior. The rulings it asks for are `DECISIONS.md`'s.

---

## The hearing — ring 1 says SSH, the code says otherwise

`IDEAS/deploy-plane.md` § *The bootstrap ring* rules ring 1 as **Basecamp installs
the Outpost, one-shot over SSH, authenticated with a `Secret` of kind `ssh_key`**.
Two things in the tree disagree with the mechanism, though not with the ring.

**The outpost is already self-registering.** It heartbeats, and the heartbeat is
what registers the conduit target. Nothing needs a session held open from this side.

**Every vendor takes `user_data` at create.** A machine Basecamp made can be handed
its whole install at birth. SSH would mean this app holds fleet private keys, ships
an SSH client in its container, and keeps a code path whose failure mode is a hung
socket.

**Finding: keep the rings, replace ring 1's mechanism.** A **provisioned** machine
is installed by cloud-init and needs no SSH at all. An **imported** machine — the
`custom` branch, somebody else's box — is installed by one command the operator
pastes, which is the same script cloud-init would have run. `Secret` of kind
`ssh_key` stays what it is for: the recovery path an operator uses by hand.

**Ruled [`FJS-D241`](../../../DECISIONS.md#fjs-d241)** (2026-09-07), and ring 1's
SSH sentence is struck in place in `IDEAS/deploy-plane.md`.

---

## Six decisions

**D1 — a compute connector is a conduit target, and `providers/index.ts` does not
grow.** `example/api/src/providers/stripe/index.ts` (306 lines) is the worked
example and `docs/ADAPTERS.md` already rules it: a connector is a declared target
with a credential **ref**, never a `fetch()` in a service. A vendor lives at
`api/src/providers/digitalocean/` — `index.ts` for the descriptor and the
translation, `sink.ts` for the local stand-in.

**D2 — the target id carries the account: `provider:<kind>:<accountId>`.** This is
a defect in shipped code, not only a design point. `provider:${providerKind}` can
only ever name one DigitalOcean account for the whole install, so two workspaces
that both connect DO share one registration and **one workspace's token is used to
read the other's machines**. Nothing has registered such a target yet, so it is
latent — file it before building on the line. `accountId` is the id of the
`Secret` holding the vendor token, and `Server.providerId` is where it is recorded:
the column exists and holds nothing today.

**D3 — the catalog is read, never listed here.** One service method,
`servers.catalog`, answering regions, sizes and images for an account, straight off
the vendor. Money in it crosses as minor units plus a currency, which is
`docs/ADAPTERS.md`'s rule and `@frontierjs/toolbelt/units`'s.

**D4 — a machine gets its credential by enrolling, not by being told one.**
`user_data` carries a **single-use, short-lived enrollment token**, never the fleet
secret: metadata is readable by anything running on the box, so baking
`OUTPOST_SECRET` into it would hand every droplet the key to impersonate the fleet
— the concentration `core/hooks.ts` already names as the limit of today's scheme.
The outpost exchanges the token once at `POST /servers/:id/enroll` for a secret of
its own, and **the response is also where it learns its public URL**, which the
process cannot see and Basecamp knows from the create call. One route, gate 0,
guarded by the token, burning it on use — and the only route in this app that ever
returns key material.

**D5 — progress is `ServerEvent` on the workspace channel.** The mock's nine steps
were a timer; the real ones are rows, announced, so the wizard is live by default
(`docs/VISION.md` constraint 6) and the same history is on the server's detail
screen an hour later. No `ProvisionStep` model — `DeploymentStep` earns its
separate table by being a pipeline definition; this is a log.

**D6 — destroy ships with create.** `IDEAS/overview.md` says it in one line:
provisioning is easy and de-provisioning is where integrated platforms die. A
`destroy` a person asks for, a `destroying` state, and the vendor's confirmation
moving the row — plus the reconcile pass, so an orphan is findable.

---

## Schema

```
enum ProviderKind { custom hetzner digitalocean }

@@transitions(status,
  provision:          pending                       -> provisioning @gate(5),
  reportProvisioned:  provisioning                  -> installing   @system @gate(5),
  destroy:            [pending, provisioning, installing, online, unreachable,
                       draining, stopped]           -> destroying   @gate(5),
  reportDestroyed:    destroying                    -> destroyed    @system @gate(5),
  …)
```

`ready` is **deleted** (2026-09-07, [FJS-1021](../../../ISSUES.md#fjs-1021)). It was
a from-state in four moves and the target of none, and the two facts it would have
carried are already held elsewhere — *outpost up* is `lastHeartbeatAt`, *not
carrying work* is `AppServer` — while *up, but do not place work here* is
`draining`, which exists and is gated. So `installing` is what a first heartbeat
leaves, and `checkIn` moves the row from there to `online`.

Two columns, both on `Server`: `outpostSecretId String?` (a `Secret`, the way
`sshKeyId` already points at one) and `enrollExpiresAt DateTime?`. `plan` gains the
recorded size — slug, vCPU, memory, disk, price in minor units, currency — which is
what makes `/cloud-spend/` real for a provisioned row without a billing adapter.

---

## Phases

**P0 — the register, first.** File the D2 defect (S2, `basecamp`) and record the
ring-1 hearing as a ruling. Both are cheap and both go stale the moment code lands
on top of them.

**P1 — the account and the catalog. No machine is created.** `digitalocean` joins
the enum; the connector, the descriptor and the sink land; `servers.catalog`
answers; wizard steps 0 and 1 render vendor data; `sync()` is fixed to use the
account. **Ships value alone** — an imported DO box can be synced, which it cannot
be today.

**P2 — create, enroll, destroy.** They are one phase and cannot be split: a machine
that exists with no credential is worse than no machine, and one that cannot be
destroyed is a bill. Adds the `server-provision` and `server-destroy` jobs, the
enroll route, the events, the live progress, the typed confirmation, the deadline
and the `fleet:reconcile` pass.

**P3 — delete the fleet-wide fallback.** `requireOutpostSignature` reads the
per-server secret only. This is the phase that actually closes what `core/hooks.ts`
names, and it can only run once every machine in the fleet has enrolled.

**P4 — Hetzner, as the negative control.** One connector cannot show a boundary is
generic — that is `verify:stripe`'s whole argument and `FJS-D153`'s. The second
vendor is what proves the translation layer is a layer.

**P5 — the imported path.** The `custom` branch prints one command carrying an
enrollment token. SSH leaves the product entirely and stays a person's recovery
path.

---

## The drive

`verify:provision`, against the sink — **no network, no vendor account, no money**,
the same arrangement `packages/outpost`'s own suite uses.

What only it can ask:

- the wizard walks, and the row lands at `provisioning` with the account recorded;
- the sink saw **one** create, carrying the size, region, image and the tag that
  names the `Server` row;
- a second dispatch of the same id creates **nothing** — asserted against the sink's
  call count, not against a job count, because a job count is what the bug agrees
  with;
- an enroll token works once, and the replay is refused;
- a signed heartbeat with the enrolled secret moves the row to `online`, and the
  same heartbeat signed with the **fleet** secret is refused after P3;
- a machine that never enrolls is failed by the deadline and says which step it
  died at — paired with the machine that enrolls late but inside the window, or the
  deadline is indistinguishable from a broken wait;
- a caller at gate 4 is refused create and refused destroy, paired with the same
  caller still reading the fleet, or the refusal proves nothing about the gate;
- destroy moves the row and the sink saw the vendor delete;
- reconcile finds a machine the sink has and this app does not, and **reports** it.

Ports: the sink takes 8122 dev / 7122 in the drive, the next basecamp backend slot
after the mail sink at 8121 (`packages/cli/core/ports.js`, project id 2).

---

## Open

- **`ServerEvent.kind` is a free `String`** with four values in use. A provisioning
  run adds six more, which is the point where an enum and its CHECK start paying.
- **Whose account is it?** A `Secret` is workspace-scoped, so a workspace is the
  unit of vendor account. An install-wide account shared by every workspace is a
  `/hub/` question and is deliberately not answered here.
- **The vendor's rate limits and a fleet-sized reconcile** are unmeasured. DO's are
  per-token, which is per-workspace after D2, and that may be the whole answer.
