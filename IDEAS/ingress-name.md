---
id: ingress-name
status: proposed
dated: 2026-11-03
---

# Ingress name — every App answers at an address Basecamp already owns

**Status: PROPOSED.** Dated 2026-11-03. Nothing here is built. Do not cite this
file as describing behavior — see `VERIFYING.md`.

The want: an App released to a fleet machine answers over HTTPS before anybody
attaches a Domain to it, the way a Worker answers at `<name>.<account>.workers.dev`,
a Pages project at `<project>.pages.dev`, and a CapRover app at
`<app>.<root domain>`. Today an App with no Domain answers nothing: its port binds
`127.0.0.1` (`FJS-D930`) and Caddy routes only Domain hostnames.

The name already exists. `FJS-D561` gives every App an **ingress record**,
`<appId>.<ingress zone>`, holding the address of each machine it runs on, and
every Domain is a CNAME to it. This paper serves that record's name — the App's
**ingress name** — as a host of its own. No new noun, no new DNS writer.

---

## What exists

- **The name.** `ingressName(appId, zone)` builds `<appId>.<zone>`
  ([edge.service.ts:65](../packages/basecamp/api/src/services/edge/edge.service.ts#L65)).
  `push()` writes its A records first, then the Domain's CNAME to it. The id and
  not the App's name, so a rename rewrites nothing (`FJS-D561`).
- **Written only through a Domain.** The ingress record is pushed as the first
  half of a Domain's push, so an App with no Domain has no record at all.
  `domain-dns.job.ts` re-pushes on the three things that make a zone wrong — a
  Domain written, a release landing on a new machine, a machine moving in or out
  of `online` — always keyed by a `domainId`.
- **The zone is an id, not a name.** `Workspace.ingressAccountId` and
  `ingressZoneId` are a pair; the zone's NAME is fetched from the vendor on each
  push (`ingressZone()`). Caddy needs the name.
- **One reader of the hosts Caddy fronts.** `routedHosts(db, appId)`
  ([runtime.ts:47](../packages/basecamp/api/src/domain/release/runtime.ts#L47))
  reads non-redirecting Domain rows and nothing else. A release and
  `domain:dns`'s `/route` push both read it.
- **Exposure is a declared column.** `App.hasExposedPort` (`FJS-D930`) is the
  per-App statement that a raw port answers off the machine, and the posture
  grader reads it. It means a port, not a hostname.
- **Certificates are Caddy's own ACME, per hostname.** Outpost refuses a
  wildcard ([ingress.js:26](../packages/outpost/src/ingress.js#L26)): DNS-01 would
  put a vendor token on every machine (`IDEAS/fleet-ingress.md` D6). Pushing a
  certificate Basecamp holds to a machine is fleet-ingress Phase 3, not built.
- **The ingress record is DNS-only.** It is written without `proxied`, the
  Domain default `FJS-D1380` keeps.
- **The session cookie is host-only but unprefixed.** Junction's
  `serializeSetCookie` never writes a `Domain` attribute; the name is `session`,
  `SameSite=Lax` from `@frontierjs/auth`, with no `__Host-` prefix.

## Prior art

Read off the owner's own CapRover screen, 2026-11-03:

- **CapRover** answers every app at `<app>.<root>` from one wildcard record. It
  is exposed by default, with *Do not expose as web-app externally* as an opt-out
  checkbox. HTTPS is a per-app *Enable HTTPS* button, which issues an HTTP-01
  certificate for that one name. It keeps serving that name after *Connect New
  Domain*, and offers *HTTP Basic Auth* per app. Its dashboard is
  `captain.<root>`, a sibling of every app.

Re-read 2026-11-05 (step 0.4), each with its source:

- **The Public Suffix List** holds `workers.dev`, `pages.dev`, `vercel.app`,
  `onrender.com`, `fly.dev`, `github.io`, `netlify.app` and `herokuapp.com`, so a
  browser treats each project under them as its own site and one cannot set a
  cookie for another. It does not hold `sslip.io` or `nip.io`
  ([public_suffix_list.dat](https://publicsuffix.org/list/public_suffix_list.dat)).
- **Cloudflare Pages** gives every deployment a "unique, hash-based address",
  `<hash>.<project>.pages.dev`, and every branch an alias
  `<branch>.<project>.pages.dev`
  ([preview deployments](https://developers.cloudflare.com/pages/configuration/preview-deployments/)).
- **Cloudflare Workers** turns `workers.dev` off with `workers_dev = false`, and
  infers `false` on the next deploy once `routes` are set without it. A custom
  domain alone does not turn it off, and turning it off "does not disable Version
  URLs, Preview URLs, or Deployment URLs"
  ([workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)).
- **Coolify** generates `<random>.<wildcard>` from a server's *Wildcard Domain*,
  and with none set `<random>.<ip>.sslip.io`. It serves the sslip name over
  `http://` only, because Let's Encrypt rate-limits the shared `sslip.io` zone
  ([domains](https://coolify.io/docs/core/networking/domains),
  [server](https://coolify.io/docs/knowledge-base/server/introduction)).
- **GitHub Pages** moved to `github.io` in 2013 "aimed at removing potential
  vectors for cross domain attacks targeting the main github.com session", and
  against phishing that relies on the `github.com` name
  ([GitHub blog](https://github.blog/news-insights/new-github-pages-domain-github-io/)).

The pattern the hosted platforms share: **user apps live under a registrable
domain the control plane does not, and that domain is a public suffix.** The
self-hosted ones (CapRover, Coolify) do not: their apps share a registrable
domain with each other, and with the dashboard when it sits in the same zone.
That is the gap § Security 1 and `FJS-D1955` weigh. The hash in `pages.dev` is a
deployment id, not a secret.

## Security

1. **An ingress zone that holds Basecamp's own host is a cookie-tossing hole.**
   Sibling subdomains under one registrable domain are the same *site*, so
   `SameSite` does not separate them. An App at `<appId>.acme.dev` can set
   `Domain=acme.dev; Name=session` and Basecamp at `ops.acme.dev` receives it,
   which is session fixation against the control plane. Cloudflare's fix is the
   Public Suffix List, which a workspace cannot join. Basecamp's fix is to refuse
   the configuration: the ingress zone and `FRONTIER_APP_URL`'s host must not
   share a zone.
2. **Apps in one ingress zone can toss cookies at each other.** The same attack,
   App to App. A tossed cookie cannot replace a `__Host-` one, because the
   browser refuses a `__Host-` cookie that carries a `Domain` attribute. The fix
   lives in junction's one cookie writer, so every FrontierJS app gets it, and it
   needs `Secure` — so it follows `secure`, and plain-HTTP dev keeps `session`.
3. **The name is not a secret.** A per-name ACME certificate puts `<appId>.<zone>`
   in the Certificate Transparency logs within minutes, and scanners read them.
   It also leaks in `Referer` and history. Every served ingress name is public,
   and a preview that must be private needs a real gate, not an unguessable label.
4. **Serving by default publishes things nobody meant to publish.** An internal
   admin API with no auth becomes reachable because it was released. This is the
   side effect `FJS-D930` ruled against for raw ports: exposure is a declared
   fact the grader reads.
5. **One App on two origins is two security contexts.** A session on the ingress
   name is not a session on the Domain; CORS allowlists and OAuth redirect URIs
   name both or one breaks. Search engines index both. The ingress name answers
   `X-Robots-Tag: noindex` always, whether or not a Domain exists.

## Recommended setup

- **A dedicated ingress zone per workspace** — a registrable domain of its own,
  such as `acme-apps.dev`, holding no Domain a person browses with a session and
  never Basecamp's own host. The posture grader states an ingress zone that holds
  its host as a finding, a refusal once a second operator sets a pair
  (`FJS-D1955`).
- **The name is the ingress record's**, `<appId>.<zone>`, served by Caddy beside
  the App's Domains. A readable alias is a Domain row, which exists today.
- **On until a Domain attaches, one column on `App` defaulted on**
  (`FJS-D1952`), read by `routedHosts` and by the posture grader; turning it off
  hides an internal App. The App page shows the URL when it is on, the way
  CapRover's *Your app is publicly available at* does.
- **DNS-only, one `*.<zone>` certificate** minted by DNS-01 and pushed as
  `uploaded`; no ingress name is served before it exists (`FJS-D1954`), so it
  waits on fleet-ingress Phase 3's push.
- **A redirect to the primary Domain once one attaches** (`FJS-D1956`).
- **`noindex` on every ingress name.**
- **`__Host-session`** in junction wherever the cookie is `Secure`.

---

## Phases

### Phase 0 — Groundwork

Goal: the questions ruled, and the record's behavior measured rather than read.
Done when: Q1–Q6 are ruled, and 0.1's probe is written under its step.

- [x] 0.1 On a test App with a Domain, `dig <appId>.<zone>` resolves to the
      machine and `curl https://<appId>.<zone>` gets no route from Caddy — the
      gap this paper closes, measured.
      **Measured 2026-11-05 on `chartered`** (zone `maverickmade.tech`, machine
      `159.203.150.231`), App `ingress-probe` (`7410006d-…`, a busybox `httpd`
      Dockerfile) with Domain `ingress-probe.maverickmade.tech`:
      - The zone holds both records, marked: `A <appId>.maverickmade.tech →
        159.203.150.231` (`basecamp:app:<appId>`, DNS-only) and the Domain's
        `CNAME` to it. `dig` at 1.1.1.1 and 8.8.8.8 resolves both.
      - `https://ingress-probe.maverickmade.tech/` → **200**, certificate valid.
      - `https://<appId>.maverickmade.tech/` → **TLS alert internal error**, not
        a 404: Caddy holds no certificate for a name it does not route, so the
        gap shows at the handshake, before routing. `http://` → **308** to
        `https://` from Caddy's redirect, which answers any host.
      - So serving (Phase 2) is one hostname more in `routedHosts`; DNS needs nothing.
      Found on the way: `FJS-4047` (a `basecamp:deploy` release never adopts
      `EXPOSE`, so the Domain was 502 until `containerPort` was set by hand) and
      `FJS-D1951` (the run key cannot run `basecamp:deploy`'s set-up). The probe
      App stays on the box for Phase 2's drive.
- [x] 0.2 Where the zone's name comes from. `routedHosts` cannot call a vendor on
      every release. **Ruled 2026-11-05 (`FJS-D1962`, Q7 = B), built the same
      day:** a `@system` column `Workspace.ingressZone`, written by
      `resolveIngressZone` on the workspaces `validated.patch` (after the gate,
      so a refused caller never makes a vendor call) through
      `zoneNameFor()` in `edge.service.ts`. A zone the account does not open is a
      409, and one half of the pair alone is a 400. Proved by `edge.test.ts`,
      `verify:dns` 27/27 and `verify:screens` 338/338.
- [x] 0.3 Rule Q1–Q6. **Ruled 2026-11-05:** `FJS-D1952`–`FJS-D1957`. Q3 = B put
      the wildcard first, so it is Phase 1 and serving is Phase 2; Q4 = C made
      the 409 a grader finding (3.1).
- [x] 0.4 Re-read the prior art above with a source per claim. **Done
      2026-11-05.** Two claims were wrong: a Worker's custom domain does not
      turn `workers.dev` off, and Coolify's name is `<random>.<ip>.sslip.io`
      over `http://` only. `sslip.io` is not a public suffix, so the
      self-hosted tools share the gap this paper warns about.

### Phase 1 — One wildcard certificate

Goal: the machine holds `*.<zone>` before any ingress name is served
(`FJS-D1954`), so there is one certificate path and no per-name ACME to migrate
off.
Done when: a host under the zone is served by the pushed `*.<zone>` with no ACME
order on the machine, across a Caddy restart (`verify-docker.mjs`); Basecamp
mints against Pebble through the edge sink and pushes to every machine in the
workspace (`verify:dns`). Serving the ingress name itself is Phase 2.

Probed 2026-11-05 on `caddy:2.10.2`: a `load_pem` wildcard makes Caddy log
*skipping automatic certificate management because one or more matching
certificates are already loaded* for a routed host under it, serves the
wildcard, and keeps it through `caddy run --resume`. So the push suppresses
per-name ACME with no `automatic_https` setting.

- [x] 1.1 Outpost holds a pushed certificate — the push half of fleet-ingress
      Phase 3 (`FJS-D1975`). `POST /certs/load { id, cert, key }` writes one
      `apps.tls.certificates.load_pem` entry by `@id` through `ingress.js`
      (the one writer of Caddy config), refusing a key that does not match or a
      certificate already expired, and answers its names and expiry;
      `POST /certs/drop { id }` removes it. `ingress.js`'s *no wildcard* comment
      and fleet-ingress D6 amended: the machine holds the minted PEM, never the
      DNS token. Proof: outpost's test against its fake Caddy, and
      `verify-docker.mjs` serving a routed host by a pushed wildcard across a
      restart. **Built 2026-11-06:** `loadCert`/`dropCert` in `ingress.js`,
      `@id` `fjs-cert-<id>`, so an app id starting `cert-` is now refused (one
      `/id/` namespace in Caddy). Outpost 452/452, `verify:docker` 89/89. The
      key sits in Caddy's config and autosave, readable on the loopback admin
      API only, which `load_pem` cannot avoid.
- [x] 1.2 Basecamp's ACME client (`FJS-D1973`): one module under
      `providers/acme/`, WebCrypto and `fetch` only — RFC 8555 account, order,
      DNS-01 authorization, finalize with a P-256 CSR in DER, download.
      The DNS half is two callbacks, so the module knows no vendor. Proof: a
      test issuing `*.<zone>` from Pebble. **Built 2026-11-06:**
      `providers/acme/index.ts` + `csr.ts`; `acme.test.ts` 5/5 on Pebble 2.9.0
      (validation skipped), `openssl req -verify` agrees. `dns.set` ADDS a TXT:
      the apex and the wildcard share `_acme-challenge.<zone>`. A live Let's
      Encrypt staging issue is owed.
- [x] 1.3 The wildcard minted and kept (`FJS-D1974`):
      `Workspace.ingressCertSecretId` and `ingressCertExpiresAt`, `@system`, a
      `@@check` pairing them; the material — cert, key and the ACME account
      key renewal reuses — in one `tlsCert` Secret. An `ingress:cert` job mints
      through 1.2 with the edge connector writing
      `_acme-challenge.<zone>`, stores, and pushes to every machine in the
      workspace; `resolveIngressZone` enqueues it when the zone changes, and a
      daily run renews inside `certStatusOf()`'s 30 days. **Built 2026-11-06:**
      `jobs/ingress-cert.job.ts` (cron `17 3 * * *` is the sweep); `ACME_URL`
      points it at a CA, and a non-loopback one is refused unless `maySpend()`.
      `edge.test.ts` 66/66, `verify:dns` 31/31 minting from Pebble. Open:
      `FJS-4058` (a foreign `_acme-challenge` TXT), `FJS-4060` (no real-CA
      order yet).
- [x] 1.4 A release pushes the wildcard to its machine before routing, so a
      machine enrolled after the mint holds it before it serves. **Built
      2026-11-06** in `runDeployment`, before any step; a failure is logged and
      the release goes on. Unasserted: `FJS-4059`.

### Phase 2 — The name answers

Goal: an App with no Domain answers HTTPS at its ingress name, and one with a
Domain redirects there.
Done when: `verify:dns` releases an App with no Domain and fetches
`https://<appId>.<zone>` through Outpost's Caddy; attaching a Domain makes it a
redirect to the primary; turning the column off makes it refuse;
`edge.test.ts` and `compute.test.ts` grade all three.

- [x] 2.1 The column on `App`, defaulted on (`FJS-D1952`). Named for what it
      says — the App is served at its ingress name — and kept apart from
      `hasExposedPort`. **Built 2026-11-06:** `isIngressNamePublished`. It and
      Phase 1's two `Workspace` columns are migration
      `20261106081059_ingress_name.sql`, not an edit of `initial_schema.sql`
      (`FJS-D1605`); applied to a copy of the dev database, every App on.
- [x] 2.2 The ingress record pushed on its own. Split the A-record half out of
      `edge.push()` so an App with the column on and no Domain gets its record,
      dispatched on the same three triggers `domain:dns` answers. Turning the
      column off deletes the record only when no Domain CNAMEs to it. **Built
      2026-11-06:** `edge.ingressStep` and an `ingress:dns` job on the `dns`
      queue, which also re-pushes the App's routes. A release and a machine
      moving dispatch it only for an App with no Domain (`ownRecordHolders`) —
      every App on each was enough load on the one-wide queue to time out
      `edge.test.ts`. The last Domain removed dispatches it too.
- [x] 2.3 `routedHosts` adds the ingress name when the column is on and the App
      has no Domain — the one reader, no second list. With a Domain,
      `routedRedirects` sends it to the primary, falling back to the first by
      `hostname` (`FJS-D1956`); the column off drops both; the last Domain
      removed serves the App again. **Built 2026-11-06** in
      `domain/release/runtime.ts`; a Domain that only redirects does not count
      as serving. `edge.test.ts` § the ingress name grades it (80/80).
- [x] 2.4 `X-Robots-Tag: noindex` on the ingress name's route in Outpost.
      **Built 2026-11-06:** `/deploy`, `/route` and `/static/activate` take
      `noindex: [host]`, which Basecamp fills from `noindexHosts` in
      `runtime.ts`. Reading the name off the host's shape was tried first and
      dropped: an app `shop` would mark its own `shop.example.com`, and
      `fli deploy`'s app ids are names. `verify:docker` `ingressName.*` fetches
      it over HTTPS through a real Caddy under a pushed wildcard, served and
      redirected; `verify:dns` sees Basecamp state it. Overrulable call.
- [x] 2.5 The App page shows the URL when on, and the switch. **Built
      2026-11-06:** a card on the domains tab, from `ingressStateOf` on the
      App detail; `verify:screens` drives the switch (`waiting` ↔ `off`).
      `served` and `redirected` on the page are not driven: the seeded
      workspace has no zone.

### Phase 3 — Posture and the cookie

Goal: the grader states what is served, and a tossed cookie cannot replace a
session.
Done when: `posture.test.ts` lists a served ingress name as declared exposure and
an ingress zone holding Basecamp's host as a finding; junction's transport test
sees `__Host-session` under `secure` and `session` without it.

- [x] 3.1 The grader reads the column, and states an ingress zone holding
      `FRONTIER_APP_URL`'s host as a finding, not a refusal (`FJS-D1955`).
      **Built 2026-11-06:** `net.ingress-names` (`gradeIngressNames`) names the
      ingress names a machine's running Apps are served at, through the App
      page's own `ingressStateOf`, so a redirecting name is not listed. It is
      severity low and never fails. It is graded on read beside the heartbeat
      controls, because exposure is a row fact: a stale report must not hide
      it, and flipping the switch shows on the next read. `hub.ingress-zone`
      is in-process and high: it fails when a workspace's zone is
      `FRONTIER_APP_URL`'s host or a parent of it. Proved by `posture.test.ts`
      58/58, including a signed-in `latest` read that lists the name and drops it
      once a Domain serves the App. Basecamp's suite is 1277/1277.
- [x] 3.2 `__Host-` in junction's cookie writer when `secure` (`FJS-D1957`).
      **Built 2026-11-06:** `setAuthCookie(name, { secure })` is the one fact;
      `@frontierjs/auth` passes `NODE_ENV === 'production'`. The cookie is named
      when `ctx.setCookie` queues it, so a clear is `__Host-session` too, and is
      written `Secure` with `Path=/`. The reader reads only that name
      (`FJS-D1978`), and auth's own token reads (logout, support, the login
      that ends an arriving session) read `app.http.authCookie`. Proved by
      `auth-cookie.test.ts` (8 new) and auth's `routes.test.ts` under
      `NODE_ENV=production` (4 new). Junction is 3539/3539, auth 806/806.
      Every live app signs its people out once on its next deploy.

---

## Open questions

- ~~**Q1 — On or off by default.**~~ **Answered 2026-11-05 (`FJS-D1952`): B — On for every App with no Domain, off once one attaches.**
  - **A** — Off; one switch per App.
  - **B** — On for every App with no Domain, off once one attaches.
  - **Recommend A** — a wrong *on* publishes an app to the internet and a wrong
    *off* costs one click, and `FJS-D930` ruled the same way for raw ports.
- ~~**Q2 — The name's shape.**~~ **Answered 2026-11-05 (`FJS-D1953`): A — `<appId>.<zone>`, the ingress record's name as `FJS-D561` ruled it.**
  - **A** — `<appId>.<zone>`, the ingress record's name as `FJS-D561` ruled it.
  - **B** — `<slug>-<short>.<zone>`, readable with a random tail.
  - **C** — `<slug>.<zone>`, CapRover's shape.
  - **Recommend A** — one string is both the CNAME target and the URL, and a
    rename rewrites nothing. B and C bring back the rewrite `FJS-D561` avoided,
    and C collides across projects. A readable name is a Domain row today.
- ~~**Q3 — The certificate.**~~ **Answered 2026-11-05 (`FJS-D1954`): B — Wait for the wildcard before serving any ingress name.**
  - **A** — Caddy's ACME per name now; the wildcard as Phase 3.
  - **B** — Wait for the wildcard before serving any ingress name.
  - **Recommend A** — names leak to Certificate Transparency, and that is
    harmless once § Security 3 treats them as public. Let's Encrypt's limit of
    about 50 new certificates per registered domain per week binds only a
    workspace releasing that many new Apps in a week.
- ~~**Q4 — What the zone rule refuses.**~~ **Answered 2026-11-05 (`FJS-D1955`): C — Refuse nothing; the posture grader states a zone holding `FRONTIER_APP_URL`'s host as a finding, and the pair is accepted.**
  - **A** — An ingress zone that holds `FRONTIER_APP_URL`'s host.
  - **B** — A, and also any zone holding a Domain on an App marked as holding
    sessions.
  - **C** — Refuse nothing; the posture grader states a zone holding
    `FRONTIER_APP_URL`'s host as a finding, and the pair is accepted.
  - **Recommend A** — B needs a noun for *holds sessions* that nothing declares
    today; the paper's recommended setup states B as advice instead.
- ~~**Q5 — Once a Domain attaches.**~~ **Answered 2026-11-05 (`FJS-D1956`): B — A redirect to the primary Domain, so the name keeps a certificate but never serves the App.** `FJS-D1952` stops serving the App there; what
  the name answers instead is the question.
  - **A** — Nothing: Caddy drops the name, and the A record stays as the
    Domain's CNAME target.
  - **B** — A redirect to the primary Domain, so the name keeps a certificate
    but never serves the App.
  - **Recommend B** — a link shared while the ingress name was the App's only
    address keeps working, and a redirect serves nothing, so D1952's line holds.
    It is a redirecting Domain's path already: one more entry from
    `routedRedirects` (`FJS-1615`) to Outpost's `redirectsOf`. With no primary
    Domain it falls back to the first by `hostname`; the column off drops the
    redirect too; the last Domain removed serves the App again.
- ~~**Q6 — `__Host-` on the session cookie.**~~ **Answered 2026-11-05 (`FJS-D1957`): A — Junction names the cookie `__Host-session` whenever it is `Secure`.**
  - **A** — Junction names the cookie `__Host-session` whenever it is `Secure`.
  - **B** — Leave it host-only and unprefixed.
  - **Recommend A** — host-only stops a cookie being read across Apps but not
    being set; only the prefix stops a sibling replacing it. It is a junction
    change and holds for every app, not Basecamp alone.
- ~~**Q7 — Where a release reads the zone's name.**~~ **Answered 2026-11-05 (`FJS-D1962`): B — A `@system` column beside the pair, written by a workspaces `patch` hook that asks `connector.zone()` whenever `ingressZoneId` is in the patch, and refuses a zone the account does not open.** Step 0.2; serving and the
  `*.<zone>` wildcard both need the name, and a release calls no vendor.
  - **A** — A column beside the pair, sent by `/dns/` in the patch that sets it.
  - **B** — A `@system` column beside the pair, written by a workspaces `patch`
    hook that asks `connector.zone()` whenever `ingressZoneId` is in the patch,
    and refuses a zone the account does not open.
  - **C** — No column; resolve on the first release and keep it in memory.
  - **Recommend B** — the vendor stays the one origin of the name and a wrong
    one cannot be typed, as `Secret.verifiedAt` stores a probe's answer. A's
    name is checked against nothing, and a wrong one is an A record and a
    certificate request for a host the workspace does not own. A Cloudflare
    zone id never changes name, so the copy cannot go stale.
- ~~**Q8 — The ACME client that mints `*.<zone>`.**~~ **Answered 2026-11-06 (`FJS-D1973`): A — Hand-rolled in one basecamp provider module: RFC 8555 JWS over WebCrypto ES256 and a P-256 CSR in DER, proved against Pebble.** Step 1.1; Basecamp holds the
  DNS token, so DNS-01 runs there and no machine sees it (`IDEAS/fleet-ingress.md` D6).
  - **A** — Hand-rolled in one basecamp provider module: RFC 8555 JWS over
    WebCrypto ES256 and a P-256 CSR in DER, proved against Pebble.
  - **B** — The `acme-client` package.
  - **Recommend A** — `acme-client` 5.4.0 runs under Bun but brings 48
    packages, axios and node-forge among them, into the process that holds
    every private key, and last released in July 2024. The protocol is small
    and stable, and Pebble is stricter than Let's Encrypt.
- ~~**Q9 — Where the wildcard is kept.**~~ **Answered 2026-11-06 (`FJS-D1974`): A — Two `@system` columns on Workspace beside `ingressZone`, `ingressCertSecretId` and `ingressCertExpiresAt`, the material in a `tlsCert` Secret as `Domain.certSecretId` keeps it.**
  - **A** — Two `@system` columns on Workspace beside `ingressZone`,
    `ingressCertSecretId` and `ingressCertExpiresAt`, the material in a
    `tlsCert` Secret as `Domain.certSecretId` keeps it.
  - **B** — A `Certificate` model Domain's cert columns could later move onto.
  - **Recommend A** — one wildcard per workspace, derived from `ingressZone`, so
    it has no identity of its own, and `certStatusOf()` reads the pair
    unchanged. B is a new noun for a one-to-one fact until a workspace has a
    second zone.
- ~~**Q10 — What rides on the new certificate push.**~~ **Answered 2026-11-06 (`FJS-D1975`): A — The wildcard only, pushed on mint, on renewal to every machine, and on each release to its machine.** Outpost's push is generic:
  a PEM pair in, Caddy's `load_pem` holds it.
  - **A** — The wildcard only, pushed on mint, on renewal to every machine, and
    on each release to its machine.
  - **B** — A, and `uploaded` Domain certificates in the same change.
  - **Recommend A** — 1.1 waits on the push, not on Domain wiring, which brings
    its own questions (which machine a Domain is on, D4's `proxied` flip).
    `IDEAS/fleet-ingress.md` Phase 3 stays open for the Domain half.
- ~~**Q11 — Whether the reader falls back to `session`.**~~ **Answered 2026-11-06 (`FJS-D1978`): B — `setAuthCookie(name, { secure })` states the fact once, and the reader reads only the name the writer writes.** Step 3.2; junction
  cannot tell a TLS request from a plain one behind Caddy.
  - **A** — Read `__Host-session`, then `session`. A planted cookie cannot
    replace a session, and signs in a person who holds none.
  - **B** — `setAuthCookie(name, { secure })` states the fact once, and the
    reader reads only the name the writer writes.
  - **Recommend B** — the case A leaves open is the person who just signed
    out, and auth already decides `secure` in one place it can hand over.

## Out of scope

- **A private preview.** CapRover's per-app Basic Auth is the right shape for one,
  and it is a second feature with its own secret to store. The name is public
  until then.
- **Per-release names**, Pages' `<hash>.<project>`. Two labels under the zone need
  a second-level wildcard, and Basecamp has no per-release route today.
- **A proxied ingress name.** A Domain CNAMEs to the ingress record, and
  proxying the target changes what every Domain resolves through; that waits on
  `IDEAS/cloudflare-edge.md`.
