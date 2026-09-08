---
id: provisioning
status: building — P0 and P1 done, P2 done 2026-09-08; P3–P5 open
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

**P0 — the register, first. — DONE.** [FJS-1020](../../../ISSUES.md#fjs-1020) is
the D2 defect and [`FJS-D241`](../../../DECISIONS.md#fjs-d241) is the ring-1
ruling. [FJS-1021](../../../ISSUES.md#fjs-1021) came out of the same reading and
is why `ready` is gone from `ServerStatus`.

**P1 — the account and the catalog. No machine is created. — BUILT 2026-09-07.**
`digitalocean` joined the enum; `providers/compute/` holds the boundary, the
connector and a stand-in on 8122; `servers.catalog` and `servers.providers`
answer; the add-server screen offers an account and renders that cloud's regions
and sizes; `sync()` reaches an ACCOUNT. **It shipped value alone** — an imported
DigitalOcean box can be synced, and `secrets.verify` asks the vendor instead of
setting a flag.

**One deviation from this plan, and it is in § D2's favour.** An account needed
somewhere to say WHICH cloud a token opens. This document said no new model, and
that held — but the answer is a column, `Secret.providerKind`, reusing
`ProviderKind` rather than growing a second vendor vocabulary on `SecretKind`.
Two enums listing clouds is two lists to keep in step. The alternative was a
vendor name inside `Secret.data`, which is `@encrypted`: *which DigitalOcean
accounts does this workspace have* would then mean decrypting every secret in
the workspace to answer.

**P2 — create, enroll, destroy. — DONE 2026-09-08.** They are one phase and cannot
be split: a machine that exists with no credential is worse than no machine, and
one that cannot be destroyed is a bill.

**Landed**: the guard (below); `provision`/`destroy`/`destroying`/`reportProvisioned`
on `@@transitions` with `reportDestroyed` narrowed to `destroying` alone;
`Server.enrollTokenHash`/`enrollExpiresAt`/`outpostSecretId`; the connector's
`create`, `destroy` and `tagged`; a stand-in that makes and deletes droplets;
`providers/compute/enrollment.ts` — the token, the hash, the constant-time
compare and the cloud-init; `servers.provision` and `servers.provisionStep`;
`server-provision.job.ts`; and `POST /servers/:id/enroll`.

Then the rest of it: `servers.destroy` with its typed confirmation,
`destroyStep` and `server-destroy.job.ts`; `servers.reconcile`; and the wizard's
Provision button with the monthly cost beside it.

And the three that closed it. **The size's PRICE is read from the vendor at
provision and copied onto `plan`** — `vcpu` and `ramGb` are the two sums
`view fleetByProvider` already made, and `priceMinor`/`currency` are what turn
`/cloud-spend/`'s money half from a skeleton into a figure. It is the VENDOR's
number, never the caller's: a client posting `priceMinor` would be reporting its
own arithmetic back to the person paying the bill. The same read refuses a size
the account is not offered, and a size that region does not have, at the moment
somebody asked rather than inside a job.

**The detail screen follows a machine that is being built.** The row is watched,
so a status change arrives over the socket with nothing asking; the TRAIL is a
custom method no announcement carries, so it is polled — and only while
something is in flight. A poll rather than a subscription because there is
nothing to subscribe to: giving `ServerEvent` a channel would broadcast an audit
trail to every member of the workspace, which is a wider change than a progress
strip should make.

**`verify:provision` is the drive**, and it is registered in the root
`CLAUDE.md` in both tables. 29 checks; § The drive below says what only it can
ask.

**One gap is left open on purpose.** The per-machine secret enrollment mints is
verified by nothing: `requireOutpostSignature` still reads the fleet-wide
`OUTPOST_SECRET`. That is P3, and it is stated in the test file rather than left
for a reader to infer from a suite that looks complete.

### Four things the drive found that no unit test could

Every one of them was invisible to a green suite, and three were not in the code
this phase wrote.

**The enrollment route had never been reachable.** Junction's router parses
`{id}`; `:id` registers a LITERAL path segment, so the route answered 405 to
everything while the constant-time compare, the single-use burn and the
fifteen-minute window behind it were all correct. Found by the first request
that went down real HTTP — [`FJS-349`](../../../ISSUES.md#fjs-349)'s shape one
layer out, and filed as [`FJS-1024`](../../../ISSUES.md#fjs-1024). A second
defect sat in the same handler: a raw route's parsed body is `ctx.body`, and it
was read as `ctx.data`, so the token was never read and every caller was refused
identically.

**A `@@check` that only the schema could satisfy.** Adding `providerKind` as
required-on-a-provider-key gave `/secrets/` a kind somebody can choose and never
save: the boundary refused correctly and the form had no field to fix it with.
A check with no way to answer it is worse than no check.

**A reactive dependency with an optional chain does not compile, and the cost is
paid two layers away.** `$: (server?.status, …)` emits a watch signal the
component never declares; the module then fails to LOAD; sierra's `_navigate`
awaits that dynamic import and rejects; and `goto` is async with no caller
awaiting it. What a person sees is a Provision button that does nothing —
no console error, no failed request, the write already committed in the
database. [`FJS-1025`](../../../ISSUES.md#fjs-1025) and
[`FJS-1026`](../../../ISSUES.md#fjs-1026); the second is the one that cost the
hour.

**The seed already holds DigitalOcean provider keys**, so a drive taking the
first account in the picker drives the whole rest of the file against somebody
else's credential and fails at the vendor with an opaque 401. Choose by NAME.
Two things came out of chasing that: the stand-in now says what authorization it
refused, and `core/credentials.ts` names which of its six silent `null`s it
answered — a credential that does not resolve is a send with no credential, and
every one of those arrives at the caller as the vendor's own 401.

### Three things the build measured

**A capability model's grant table is hand-kept, and nothing held it to the
schema.** `provision` and `destroy` landed, were gated, and refused every caller
BY NAME — an owner included — because `ROLE_GRANTS` had never heard of them.
There is a tripwire now, and the row that matters is the CONTROL beside it: the
first version read `attributes[].name` where the parse says `kind`, found zero
moves, and passed vacuously. A tripwire that fires on nothing is the failure it
exists to catch, one level up. Measured with the two grants removed: it reds.

**`@guarded` refused the write, and the refusal was right.** `provision` wrote
`enrollTokenHash` through the caller's client and the Data boundary declined —
that column is system-context on write as well as read. The row is the caller's
write; the credential artifact is a second statement, as the application. The
schema saying so is what made the split obvious.

**A vendor's tag filter is an EXACT match, not a prefix.** `basecamp:server:<id>`
alone can only be searched for by somebody who already knows the id, which is
exactly what a reconciliation sweep does not have. Every machine carries two
tags: `basecamp`, which makes one sweep cover everything, and the identity tag,
which turns a found machine back into a row.

### The guard, and why it is on the transport

A connector's address falls back to the REAL vendor when nothing overrides it.
For a catalog read that is three harmless 401s. For a create it is a droplet on
somebody's real bill, and the way that happens is not a bug in a connector — it
is a test, a script or a `bun run dev` that meant to be pointed at a stand-in and
was not. P1 measured exactly that: three tests sent their reads to the real
DigitalOcean because an environment variable did not apply in the order they ran,
and *reads were all that saved it*.

**So a POST or a DELETE is refused unless the process has said it means to**, and
the check is in `sendVia` rather than in each connector method — which is what
makes it complete: a spending call somebody adds next year is covered without
anybody remembering it exists. Three ways through, and a GET needs none of them:

- the target's address is **loopback** — a stand-in on this machine;
- `NODE_ENV=production` — a deployed control plane, doing its job;
- `ALLOW_CLOUD_SPEND=1` — a developer on their own account, on purpose.

**The test is fail-closed and is not *is this a known vendor origin*.** That
question has to enumerate every vendor correctly forever, and the one it gets
wrong is the one that bills somebody. An address nobody recognizes is treated as
real.

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

`api/test/compute.test.ts` runs in `bun run test` — 56 checks against the
stand-in, **no network, no vendor account, no money**. Two tiers,
because they answer different questions: the DIALECT is graded against a
hand-written `send` (given these bytes from DigitalOcean, what does this app
believe), and the SEAM through the real app, where conduit resolves the token
out of an `@encrypted` column and a real listener on a real port checks the
header it wrote.

**Where the stand-in is, is a parameter and not an environment variable.**
`core/env.ts` snapshots `process.env` at module load, so a variable set inside
`beforeAll` is invisible once any other test file has imported the app — and
three of these tests sent their reads to the real DigitalOcean until
`registerAccount(…, { address })` existed. Nothing about import order can now
change what a send reaches.

`verify:provision` is the browser half — 29 checks, and it starts everything
itself: a scratch database in a temp directory, the DigitalOcean stand-in, the
API, the web server and Chrome.

**Four things it can ask that nothing else can.**

The picker is offering the **vendor's** list. Every unit test hands the connector
a canned answer, so *the catalog reached a `<select>`* is a claim no test on
either side can make — the service could answer correctly and the screen could
render a hardcoded list, and both halves would be green. Asked as pairs: a region
the vendor marks unavailable is not offered, and a size `nyc3` has and `fra1`
does not disappears when the region moves.

**The spend guard is not in the way of the thing it protects.** `sendVia` refuses
a POST at anything but loopback, and a guard that also refused the stand-in would
look exactly like a working one to every test that only asks about the refusal.
This drive provisions for real, through it.

**The machine arrives on its own.** The sink runs as a separate process with
`DO_SINK_BOOT_MS` set, so a created droplet comes up a few seconds later the way
a real one does — the row moves `provisioning → installing` because a job polled
a vendor and found an address, with nothing in the browser asking, which is the
whole claim the progress strip makes. `sinkBoot` stays the deterministic door the
unit tests use; nothing in-process depends on a timer.

**The enrollment route is reachable at all**, asked with a real POST carrying a
wrong token and answered 401 rather than 405.

Plus: a provider key that names no cloud is refused and the message names the
field, paired with the same form saving once it does; the submit is refused while
the machine is half chosen and offered once it is not; the cost line quotes the
vendor's own price before anything is spent; and `/cloud-spend/` sums what was
committed while still saying, in its own words, that this is not a bill.

**What it does not cover, and where that is covered instead.** Destroy,
reconcile, the gate ladder and the enrollment window are the unit file's — they
need a clock stood at, a vendor answer arranged, or a caller at a standing, and
none of the three is what a browser is for. The enrolled secret signing a
heartbeat is nobody's yet: it is P3, because nothing verifies against it.

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
