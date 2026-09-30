---
id: fleet-ingress
status: partial
dated: 2026-09-30
---

# Idea — a fleet server's ingress, and where its certificates come from

**Status: Phases 0–2 built; 3–5 proposed.** Dated 2026-09-30. Basecamp can hold
a certificate and has nowhere to put it: nothing on a fleet machine terminates
TLS. This puts Caddy on every machine, driven by Outpost, and names the three
places a certificate comes from. It is needed with or without an edge vendor;
`cloudflare-edge.md` D4's *fleet ingress* is this.

---

## What exists

- **Storage, finished.** `domains.uploadCert` writes the PEM pair into a
  `Secret` of kind `tls_cert` (`@encrypted`, never read back) and keeps
  `certSecretId` · `certKind` · `certExpiresAt` on the `Domain`; `certStatusOf()`
  derives the status ([domains.service.ts](../packages/basecamp/api/src/services/domains/domains.service.ts)).
- **Delivery, absent.** Nothing reads `certSecretId`. `Domain.sslMode` and
  `Domain.proxied` are displayed on `/dns/` and read by nothing else.
- **The machine has no proxy.** A container is published on a raw host port
  (`-p port:containerPort`, [docker.js:172](../packages/outpost/src/docker.js#L172));
  an `inline` app is served by host label on 8181 over plain HTTP. Outpost's
  PROJECT_STATE: *no TLS of its own (it expects to sit behind one)*.
- **The command channel is pinned TLS** — `FJS-D557`. Outpost serves 8180 with
  a certificate it made at enrollment, and Basecamp's conduit target trusts that
  one certificate and nothing else.

## The shape

**Caddy on every fleet machine, owned by Outpost through Caddy's admin API**
(`localhost:2019`, JSON). Outpost pushes a route — hostname → upstream port —
on deploy and removes it on teardown, so there is no config template and no
reload, which is the part of CapRover's nginx customization this replaces.
Basecamp's own deploy already runs behind Caddy (`packages/basecamp/CLAUDE.md`),
so the tool is not new here.

A certificate reaches that Caddy from one of three places:

| `certKind` | When | Where it comes from | Renewal |
| --- | --- | --- | --- |
| `acme` | the default — `Domain.proxied` off | Caddy's own ACME (Let's Encrypt) | Caddy's; Outpost reports the expiry back |
| `origin_ca` | `Domain.proxied` on, zone on Cloudflare | Basecamp mints it through the edge connector, stores it as a `tls_cert` Secret, pushes it | none — issued for up to 15 years |
| `uploaded` | an operator brings one | `uploadCert`, as today | by hand; `expiring_soon` warns |

`origin_ca` and `uploaded` share one push path, which is what makes
`uploadCert` more than storage.

## Owed before building

- **D1 — who runs Caddy.** **Ruled `FJS-D564`: A.** **A** — Outpost installs it at enrollment
  (`installScript()` in `providers/compute/enrollment.ts`) and owns its config.
  **B** — a container Outpost manages. **Recommend A**: B adds a layer between
  Outpost and the one process it must configure, and a restart of Docker takes
  the ingress with it.
- ~~**D2 — how the command channel gets encrypted** (`FJS-1603`).~~ **Answered
  2026-09-30 (`FJS-D557`): B, pin a self-signed certificate at enrollment.**
  Built as Phase 0. The mechanism differs from the one proposed. In Bun a
  fingerprint `checkServerIdentity` never runs under `rejectUnauthorized:
  false`, so the pin is `tls: { ca: <pem> }`, carried as conduit's
  `pinned_cert`. The ruling has the rest.
- **D3 — a private key leaves the vault to be pushed.** `origin_ca` and
  `uploaded` mean Basecamp decrypts the `tls_cert` Secret and sends it to the
  machine, where Caddy keeps it in its storage directory. The only way to keep
  every key off the wire is `acme` for every `Domain`, which gives up proxied
  zones and bring-your-own. **Recommend push, and only once D2 has shipped.**
- **D4 — flipping `proxied`.** An Origin CA cert is trusted by Cloudflare and by
  no browser, so turning `proxied` off with an `origin_ca` cert in place breaks
  the site until ACME issues. **Recommend: the cert source follows `proxied`,
  and the sync job orders a flip** — the new cert is in place before the DNS
  record changes, in both directions.
- **D5 — `certKind` becomes an enum** (`acme origin_ca uploaded`), where it is a
  free string defaulting to `'uploaded'` today. For `acme`, `certExpiresAt` is
  written by an Outpost report (Caddy knows the date), the way vitals are, and
  the row keeps no `certSecretId` — `certStatusOf()` then reads `none` for a
  valid cert, so its first line moves from *no secret* to *no expiry*.
  `IDEAS/uptime-monitoring.md`'s TLS-connect expiry check is the outside view of
  the same date, and a disagreement between the two is a finding.
- **D6 — DNS-01 and wildcards.** Would put a Cloudflare token on every machine.
  **Recommend not now**; `origin_ca` covers the proxied case without one.
  Whether HTTP-01 passes Cloudflare's proxy depends on zone settings Basecamp
  does not own, so nothing here depends on it.
- **D7 — the raw host port.** **Ruled `FJS-D565`, as recommended.** Once Caddy is the way in, `-p port:containerPort`
  still answers the internet over plain HTTP around it. **Recommend binding it to
  `127.0.0.1`** in the same change that pushes the first route — earlier, and
  nothing reaches the app. `verify-docker.mjs` asserts the port refuses a
  connection from off the machine; nothing else would notice it answering. The 8181 static origin stays its own upstream and its
  own origin (`FJS-D345`); Caddy fronts it by host like any other route.

## Phases

0. ~~**`FJS-1603`** — D2, on its own.~~ **Done 2026-09-30** (`FJS-D557`).
1. ~~**Caddy** — install at enrollment; Outpost's route push and teardown; `acme`
   only.~~ **Built 2026-09-30**, with Phase 2 in the same change as `FJS-D565`
   requires. `verify-docker.mjs` fetches the app over HTTPS by hostname through
   a real Caddy, across a Caddy restart. Routes move only on `/deploy` and
   `/stop`; a `Domain` edited between releases is `FJS-1610`.
2. ~~**Loopback bind** — D7.~~ **Built with Phase 1**, per app: an app with no
   hostname keeps its port on every interface.
3. **Push** — `uploaded` through the channel D2 secured; D5's enum and report.
4. **`origin_ca`** — waits on `cloudflare-edge.md` Phases 1–3; D4's ordering in
   its `domain-dns.job.ts`.
5. **Screen** — `/dns/` and the app's domains tab show `certKind` and where the
   date came from.

## Prior art

- **CapRover** — nginx per node from a template the operator may customize;
  Let's Encrypt through certbot; a custom cert is uploaded as files the nginx
  container mounts.
- **Kamal 2** — `kamal-proxy` on each host, told about a route by the deploy
  tool, automatic Let's Encrypt per host. The nearest shape to this one.
- **Coolify / Dokploy** — Traefik (Coolify also Caddy) in front of every app;
  Cloudflare Tunnel as the documented path for a machine with no public IP.
- **Caddy** — [admin API](https://caddyserver.com/docs/api) ·
  [automatic HTTPS](https://caddyserver.com/docs/automatic-https).
- **Cloudflare** — [Origin CA](https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/).

## Out of scope

Load balancing across machines (the `gateway` role in `ServerRole` is the word
waiting for it) · a WAF · mutual TLS beyond D2's pin.

## Cost

Phase 0 is done. Phases 1–2 are a day
or two on Outpost. 3 is small once 0 is in. 4 rides on the edge adapter.
