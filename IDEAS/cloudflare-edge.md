---
id: cloudflare-edge
status: partial
dated: 2026-09-29
---

# Idea — Cloudflare as basecamp's first edge adapter, with DNS writes

**Status: PROPOSAL, Phases 1–5 built, and 6 for reads** (2026-09-30: a Cloudflare token is an account, the `edge` service reads
zones and records, `/dns/` shows them beside the `Domain` rows, and the connector
writes marked records and refuses unmarked ones; `edge.sync` pushes a Domain
and its App's ingress record, drift carries all four kinds, the `domain:dns`
job pushes on a Domain write, on a release and on a machine entering or
leaving `online`, and `verify:dns` drives it with nobody pressing sync; D1–D6
are ruled, and an App on no online machine keeps its record, `FJS-D567`). Not
built: `adopt`, and a screen for the ingress zone or the sync button. Dated 2026-09-29. Basecamp declares
`IEdge` with a stub behind it and `/dns/` renders a skeleton where the zone goes
(`packages/basecamp/docs/ADAPTERS.md` § `edge`). This fills it with Cloudflare, and
widens it from reading a zone to managing one — DNS is among the first connections
an operator makes.

Starting material: the legacy maid.tech client,
`KOBAMI/my.maid.tech/api/src/services/integrations/cloudflare/cloudflare.dns.js`
(94 lines) and its `providers/cloudflare.provider.js` (60).

---

## The shape: a workspace ACCOUNT, the compute pattern

The TODO in `api/src/providers/index.ts` — `cfg.edge?.api_token → CloudflareEdge` —
is the shape compute already left. One install-wide token keyed on the vendor is
`FJS-1020`: whichever workspace registered last has its token used for everyone.
`providers/compute/` is the pattern to follow instead: a vendor token is a `Secret`
of kind `provider_key`, `accounts.ts` registers it as the conduit target
`provider:<kind>:<accountId>`, and the ref `secret:<id>#token` resolves at send time.

That also answers the question maid.tech raises — its token is per CLIENT, where
conduit targets are declared with a credential. One target per account covers both
callers with no change to conduit.

**Stays in basecamp; the package waits.** `FJS-D153` names it
`@frontierjs/conduit-cloudflare` and holds promotion until a second caller argues
with the first. The maid.tech port is that caller: one fleet account reading drift
versus one token per client writing SendGrid's records.

## Owed before building

- **D1 — where the token lives.** **Ruled `FJS-D558`: a workspace account** (`Secret`,
  `provider_key`). `edge` then leaves the global `BasecampProviders` container, and
  the portal's `edge` entry reports accounts instead of `providers.edge.api_token`.
  Every tool in § Prior art holds one install-wide token, so per-workspace goes
  further than they do. Connect asks for an **account-owned** token (`cfat_`
  prefix), which outlives the person who minted it where a user token dies with
  their seat. A client's own zone can be written without holding their token at
  all through Domain Connect, which Cloudflare supports once a template is
  onboarded with them — the maid.tech case, later.
- **D2 — `ProviderKind`.** **Ruled `FJS-D559`, as recommended below.** `{ custom hetzner digitalocean }` types both
  `Server.providerKind` and `Secret.providerKind`, so adding `cloudflare` widens
  `Server`'s CHECK to a value no machine can have. **Recommend adding it with a
  `@@check("providerKind != 'cloudflare'")` on `Server`**, so the refusal sits at
  the Data boundary with the enum rather than in a service. Its cost: the next
  edge vendor has to join that check, and a forgotten one is silent. The
  alternative is a compute-only enum for `Server`, which restates three values.
- **D3 — who owns a record.** **Ruled `FJS-D560`, as recommended, with refuse
  for the owed case.** `Domain` rows are intent, basecamp pushes. Every record basecamp writes carries a mark in Cloudflare's per-record
  `comment` (`basecamp:domain:<id>`), the way compute marks a machine it made.
  Basecamp updates and deletes marked records only; an unmarked one (MX, a
  SendGrid CNAME) is reported as drift and left as found.
  - This is external-dns's `sync` policy scoped to owned records; use its three
    names (`sync` · `upsert-only` · `create-only`) if a mode is ever argued for,
    and add none now.
  - The comment is the Cloudflare spelling of the mark, where external-dns and
    octoDNS write a sidecar TXT record. Comments exist on every plan (100 chars on
    Free) and the list call filters on `comment.startswith`, so *my records* is one
    query. Tags would be the cleaner mark but are Pro and up. The next edge vendor
    (Hetzner DNS, DigitalOcean) has no comment field and falls back to a TXT
    registry, so the mark is the connector's, never the service's.
  - **Owed: a `Domain` whose name already holds an UNMARKED record.** octoDNS
    adopts it; external-dns and Cloudflare Tunnel both refuse. **Recommend
    refuse** — report it as a conflict in drift, and give admins an explicit
    `adopt(domainId)` that writes the mark.
- **D4 — what a record points at.** **Ruled `FJS-D561`: a CNAME to a per-APP
  ingress record** (not per server or group; the ruling says why), in an ingress
  zone the `Workspace` names. A `Domain` belongs to an App whose replicas land
  on servers through `AppServer`: an A record per placement IP, or a CNAME to a fleet
  ingress. **Recommend the CNAME, over an ingress record basecamp also owns.** It is
  the consensus: external-dns publishes an ingress or load-balancer address and
  never a pod IP; Vercel, Render and Fly hand a customer a CNAME. An A per
  placement is round-robin DNS with no health check — a dead server keeps its share
  of traffic until the record is removed AND its TTL runs out — and every placement
  change rewrites every domain on it. Two levels instead: one ingress record per
  server or group holding the placement IPs, and each `Domain` a CNAME to it.
  Cloudflare flattens a CNAME at the apex, so an apex `Domain` needs nothing
  extra. A Cloudflare Tunnel (CNAME to `<uuid>.cfargotunnel.com`, the Coolify and
  Dokploy path) is the variant for a server with no public IP. The ingress
  itself — Caddy on each machine, and where its certificates come from — is
  `IDEAS/fleet-ingress.md`.
- **D5 — widening `EdgeConnector` with writes.** **Ruled `FJS-D562`, as below**;
  the connector refuses to change an unmarked record. The shape to start
  from is libdns's, the interface Caddy's DNS providers share:
  `getRecords` · `appendRecords` · `setRecords` · `deleteRecords`, where
  `setRecords` makes each given (name, type) set match its input and touches no
  other record. That replaces a per-record `upsertRecord`, and fixes the legacy
  first-by-type-and-name match at the interface rather than in the connector.
- **D6 — `proxied` for a record basecamp creates.** **Ruled `FJS-D563`, as
  recommended.** The per-record value already
  exists — `Domain.proxied`, default `false`, the external-dns default — so
  **recommend pushing it as stated, with no global flag.** On moves public TLS
  to Cloudflare's edge while `full_strict` still needs a valid origin cert, which
  is what `certStatusOf()` keeps measuring; `IDEAS/fleet-ingress.md` D4 is what a
  flip does to that cert.

## Phases

1. **Connector** — `providers/edge/cloudflare.ts` + `providers/edge/index.ts`
   (`EdgeConnector`, and `targetFor('cloudflare', accountId)` as the one place the
   target string is built). HTTP target at `api.cloudflare.com/client/v4`, bearer
   ref, its own policy. Methods: `verifyToken`, `listZones`, `listRecords`,
   `upsertRecord`, `deleteRecord`.
   - **Built, reads only:** `verify` · `zones` · `records`, with `targetFor` and
     the send half (`AccountSend`) imported from compute rather than restated.
     **Writes built** (`FJS-D562`): `appendRecords` · `setRecords` ·
     `deleteRecords`, each one batch; the caller passes a `RecordMark`
     (`domainMark(id)`) and the connector spells it in `comment` and reads it
     back as `EdgeRecord.mark`. A set already true is no request. A 4xx now
     carries Cloudflare's message, which `sendVia` had been dropping (`FJS-1611`
     is the compute half).
     `success:false` THROWS with Cloudflare's message, the DigitalOcean
     connector's convention, rather than mapping to `client_error`; a typed kind
     waits for the caller that branches on it — Phase 5's retry.
   - **Keep from legacy:** the envelope check (a `200` can carry `success:false`),
     upsert that survives a retry, zone lookup by registrable domain, scope
     Zone:Read + DNS:Edit.
   - **Change:** `success:false` maps to `client_error` rather than a thrown string;
     lists walk `result_info.total_pages`; upsert matches on the mark rather than
     first-by-type-and-name, because TXT records share names; an update carries the
     record's existing `proxied` and `ttl` forward.
   - **Write through `POST /zones/{id}/dns_records/batch`.** One transaction, run
     deletes → patches → puts → posts, and nothing applies if one fails, so a
     `sync` retries whole. Propagation is still per record. It also spends one
     request of the 1,200-per-5-minutes limit instead of one per record.
   - List with a large `per_page` — external-dns defaults to 5,000 — so most zones
     are one page and the walk is the rare path.
2. **Sink** — `cloudflare-sink.ts` beside `digitalocean-sink.ts`, speaking the
   envelope, pagination and `comment`. **Built** — `providers/edge/`, port 8127
   (7127 in `api/test/edge.test.ts`); it pages at 2 so the walk is always taken.
   Writes: the batch route, all or nothing, refusing a missing id and a CNAME
   beside an A/AAAA/CNAME; each listener holds its own copy of the zones.
3. **Account registration** — `registerAccount` / `registerAllAccounts` learn edge
   connectors; connect verifies the token and that it sees at least one zone (the
   legacy `connect()` flow). **Built** — `accountConnectorFor` in
   `compute/accounts.ts` answers compute or edge, `secrets` accepts and verifies
   through it, and the machine wizard lists compute accounts only.
4. **Service** — `edge.service.ts`: `zones`, `records(zoneId)`, `drift(zoneId)`
   (a `Domain` with no record · a marked record with no `Domain` · unmarked
   records), and `sync(domainId)` for admins. This is the adapter ADAPTERS.md's
   *no service until there is an adapter* waits on. Drift is computed on read and
   never stored — `certStatusOf()` in `domains.service.ts` is the same argument.
   `drift` is the plan and `sync` the apply, the split Terraform, octoDNS and
   DNSControl all make; `sync` returns the diff it applied.
   It is visible on `/dns/` and red nowhere; an alert rule over it is the artefact
   that would make it one, and is not part of this.
   - **Built, reads only:** `zones` and `records(accountId, zoneId)`. `records`
     carries drift's first kind, the one D3 does not decide: a serving record's
     `domainId`, and `missing` — a `Domain` in the zone with no A/AAAA/CNAME.
     **Built since:** `conflicts`, `orphans` and `stale` (an App's ingress
     record against `servingAddresses`), and `sync(domainId)` at ADMINISTRATOR —
     the ingress record, then the CNAME, every refusal a 409 decided before a
     write. `adopt` is not built: taking over an unmarked record needs a
     connector method that writes a mark onto somebody else's record, which
     libdns has no word for, and drift already names the conflict. Graded at `Domain`'s read gate,
     the account read `asSystem()` confined to the workspace. `edge` left
     `BasecampProviders`, and the portal's entry reads the accounts.
5. **Job** — `domain-dns.job.ts`, dispatched on a `Domain` write with
   `id: dns:<domainId>:<version>` so a repeat is a no-op; retry follows
   `error.retryable`; a soft delete removes the marked record.
   - **Built** as `domain:dns`, calling `edge.syncStep` (internal, at READER,
     since it runs as whoever released; at the app's own standing when a
     machine moved). Dispatched by `domains`
     create · patch · remove · restore, and by a release landing
     (`dns:<domainId>:release:<deploymentId>`) — without that second trigger a
     Domain added before the first deploy is never pushed, and a release that
     moves machines leaves the ingress record naming the old one.
   - A 502 retries (5 attempts); a 4xx is terminal; *not yet* — no ingress
     zone, an App running nowhere, no connected zone, a redirect — is SKIPPED,
     so a workspace with no edge account fails no job.
   - A deleted Domain's CNAME is removed only where it carries that Domain's
     mark (`EdgeRecordRef.mark`). The App's ingress record stays.
   - The hostname became immutable on `domains.patch`: the CNAME pushed for an
     old one would stay marked as the row's, which no drift reports.
   - A machine entering or leaving `online` pushes every Domain of every App
     running on it (`FJS-1614`): a tap on the Server transition in `app.ts`,
     dispatched as the app, since the sweep and a check-in have no caller.
     An App left on no online machine keeps its record where it last ran,
     and drift names it `down` (`FJS-D567`).
   - The same job sends the App's hostnames to Caddy on every machine running
     it, as `/route` (`FJS-1610`), so a Domain written between releases is
     routed as well as published.
   - The pushes run on their own one-wide `dns` queue. An App's Domains share
     its ingress record, and two pushes at once rewrite the same set.
6. **Screen** — `/dns/` renders records and drift in place of the skeleton;
   analytics keeps its skeleton. **Built** for records, `missing` and
   `stale` (red when an App is `down`);
   `verify:screens` connects an account at the sink and asserts both.
7. **Proof** — **built**: `edge.test.ts` and `verify:dns` (7120 + 7128). Planned as: an API test over the sink (the `compute.test.ts` shape);
   `verify-screens.mjs`'s *the edge adapter reports its real state* asserts against
   the sink (ADAPTERS.md § *What wiring one will break*); a `verify:dns` drive or an
   extension of `verify:provision`, with its `DRIVES.md` row; the sink's port from
   `docs/PORTS.md`.
8. **Docs** — ADAPTERS.md § `edge`, SCREENS.md, basecamp `CHANGES.md`, the portal
   entry, and the TODO in `providers/index.ts` removed.

## Prior art

Researched 2026-09-29; the conclusions are in the D-items above, and these are
where to re-check them.

- **external-dns** (Kubernetes) — reconciles a zone from cluster state; ownership
  by TXT registry keyed on `--txt-owner-id`; the three policies. Its Cloudflare
  provider carries `--cloudflare-proxied`, `--cloudflare-record-comment`, batch
  sizing and custom hostnames.
  [TXT registry](https://kubernetes-sigs.github.io/external-dns/latest/docs/registry/txt/) ·
  [Cloudflare](https://kubernetes-sigs.github.io/external-dns/latest/docs/tutorials/cloudflare/)
- **octoDNS** — zones as YAML, plan then apply; an ownership processor marks what
  it manages with `_owner` TXT records and adopts what it is told to.
  [ownership](https://octodns.readthedocs.io/en/stable/api/processors/octodns.processor.ownership.html)
- **DNSControl** — zones as JS; shares a zone by declaring what is foreign
  (`IGNORE`, `NO_PURGE`, `IGNORE_EXTERNAL_DNS`) rather than marking what is its own.
  [IGNORE](https://docs.dnscontrol.org/language-reference/domain-modifiers/ignore)
- **Terraform** — ownership is the state file; drift is `plan`.
- **libdns** — the provider-neutral record interface.
  [package](https://pkg.go.dev/github.com/libdns/libdns)
- **Cloudflare** —
  [comments and tags](https://developers.cloudflare.com/dns/manage-dns-records/reference/record-attributes) ·
  [batch changes](https://developers.cloudflare.com/dns/manage-dns-records/how-to/batch-record-changes/) ·
  [account-owned tokens](https://blog.cloudflare.com/account-owned-tokens-automated-actions-zaraz/) ·
  [Domain Connect spec](https://github.com/Domain-Connect/spec/blob/master/Domain%20Connect%20Spec%20Draft.adoc)
- **Coolify / Dokploy** — self-hosted PaaS; an instance-wide Zone:DNS:Edit token,
  and Cloudflare Tunnel with a wildcard CNAME as the documented path.
  [Coolify tunnels](https://coolify.io/docs/knowledge-base/cloudflare/tunnels/) ·
  [Dokploy DNS](https://docs.dokploy.com/docs/core/dns-providers/cloudflare)

## Out of scope

Analytics (Cloudflare's is GraphQL, a step of its own) · cache purge (rate-limited
hard) · writing SSL mode · extracting the package.

## Cost

Phases 1–3 are about a day on the compute pattern. 4–5 are ruled (D3, D4); 5's pointing waits on `IDEAS/fleet-ingress.md` Phase 1. The sink
and the drive are most of the rest.

## Found on the way

`cloudflare.dns.js:12` in maid.tech logs every client's plaintext token —
`console.log({ apiToken })` on each call. A fix in maid.tech, independent of this.
