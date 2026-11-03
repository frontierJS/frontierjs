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

From memory, not re-read for this paper (step 0.4 re-reads each with a source):

- **Cloudflare** — `workers.dev` and `pages.dev` are on the Public Suffix List, so
  browsers treat each project as its own site and one cannot set a cookie for
  another. Pages also serves `<deployment hash>.<project>.pages.dev`, a fixed URL
  for one build. A Worker's `workers.dev` route can be turned off once a custom
  domain is attached.
- **Coolify** defaults to `<app>.<ip>.sslip.io`, a third-party wildcard resolver.
- **Vercel, Render, Fly** each serve every project under a platform-owned
  registrable domain (`vercel.app`, `onrender.com`, `fly.dev`), never under the
  platform's own `vercel.com`. GitHub Pages moved to `github.io` from
  `github.com` for the same reason.

The pattern every one of them shares: **user apps live under a registrable domain
the control plane does not.** The hash in `pages.dev` is a deployment id, not a
secret.

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
  never Basecamp's own host. Basecamp refuses an ingress zone that holds its host.
- **The name is the ingress record's**, `<appId>.<zone>`, served by Caddy beside
  the App's Domains. A readable alias is a Domain row, which exists today.
- **Off by default, one column on `App`**, read by `routedHosts` and by the
  posture grader. The App page shows the URL when it is on, the way CapRover's
  *Your app is publicly available at* does.
- **DNS-only, Caddy's ACME per name** — what Outpost does for every Domain today.
  A wildcard certificate waits on fleet-ingress Phase 3.
- **`noindex` on every ingress name.**
- **`__Host-session`** in junction wherever the cookie is `Secure`.

---

## Phases

### Phase 0 — Groundwork

Goal: the questions ruled, and the record's behavior measured rather than read.
Done when: Q1–Q6 are ruled, and 0.1's probe is written under its step.

- [ ] 0.1 On a test App with a Domain, `dig <appId>.<zone>` resolves to the
      machine and `curl https://<appId>.<zone>` gets no route from Caddy — the
      gap this paper closes, measured.
- [ ] 0.2 Where the zone's name comes from. `routedHosts` cannot call a vendor on
      every release; recommend storing the name beside `ingressZoneId` when the
      pair is set, under the same `@@check`.
- [ ] 0.3 Rule Q1–Q6.
- [ ] 0.4 Re-read the prior art above with a source per claim.

### Phase 1 — The name answers

Goal: an App with the column on answers HTTPS at its ingress name, with or
without a Domain.
Done when: `verify:dns` releases an App with no Domain and fetches
`https://<appId>.<zone>` through Outpost's Caddy; turning the column off makes it
refuse; `edge.test.ts` and `posture.test.ts` grade both.

- [ ] 1.1 The column on `App`, default per Q1. Named for what it says — the App
      is served at its ingress name — and kept apart from `hasExposedPort`.
- [ ] 1.2 The ingress record pushed on its own. Split the A-record half out of
      `edge.push()` so an App with the column on and no Domain gets its record,
      dispatched on the same three triggers `domain:dns` answers. Turning the
      column off deletes the record only when no Domain CNAMEs to it.
- [ ] 1.3 `routedHosts` adds the ingress name when the column is on — the one
      reader, no second list.
- [ ] 1.4 The refusal where the ingress pair is set: a zone that holds
      `FRONTIER_APP_URL`'s host is a 409 saying why, decided before anything is
      written.
- [ ] 1.5 `X-Robots-Tag: noindex` on the ingress name's route in Outpost.
- [ ] 1.6 The App page shows the URL when on, and the switch.

### Phase 2 — Posture and the cookie

Goal: the grader states what is served, and a tossed cookie cannot replace a
session.
Done when: `posture.test.ts` lists a served ingress name as declared exposure and
an ingress zone holding Basecamp's host as a finding; junction's transport test
sees `__Host-session` under `secure` and `session` without it.

- [ ] 2.1 The grader reads the column and the zone rule from 1.4.
- [ ] 2.2 `__Host-` in junction's cookie writer when `secure`, per Q6.

### Phase 3 — One wildcard certificate

Goal: the ingress zone's names stop appearing in Certificate Transparency one by
one.
Done when: a fresh App's ingress name is served under `*.<zone>` with no new ACME
order on the machine.

- [ ] 3.1 Basecamp mints `*.<zone>` by DNS-01 with the token it already holds,
      and pushes it as an `uploaded` certificate. Waits on fleet-ingress Phase 3.

---

## Open questions

- **Q1 — On or off by default.**
  - **A** — Off; one switch per App.
  - **B** — On for every App with no Domain, off once one attaches.
  - **Recommend A** — a wrong *on* publishes an app to the internet and a wrong
    *off* costs one click, and `FJS-D930` ruled the same way for raw ports.
- **Q2 — The name's shape.**
  - **A** — `<appId>.<zone>`, the ingress record's name as `FJS-D561` ruled it.
  - **B** — `<slug>-<short>.<zone>`, readable with a random tail.
  - **C** — `<slug>.<zone>`, CapRover's shape.
  - **Recommend A** — one string is both the CNAME target and the URL, and a
    rename rewrites nothing. B and C bring back the rewrite `FJS-D561` avoided,
    and C collides across projects. A readable name is a Domain row today.
- **Q3 — The certificate.**
  - **A** — Caddy's ACME per name now; the wildcard as Phase 3.
  - **B** — Wait for the wildcard before serving any ingress name.
  - **Recommend A** — names leak to Certificate Transparency, and that is
    harmless once § Security 3 treats them as public. Let's Encrypt's limit of
    about 50 new certificates per registered domain per week binds only a
    workspace releasing that many new Apps in a week.
- **Q4 — What the zone rule refuses.**
  - **A** — An ingress zone that holds `FRONTIER_APP_URL`'s host.
  - **B** — A, and also any zone holding a Domain on an App marked as holding
    sessions.
  - **Recommend A** — B needs a noun for *holds sessions* that nothing declares
    today; the paper's recommended setup states B as advice instead.
- **Q5 — Once a Domain attaches.**
  - **A** — The ingress name keeps serving, `noindex`.
  - **B** — The ingress name redirects to the primary Domain.
  - **Recommend A** — it is the address that skips the Domain's proxy and DNS,
    which is what a person debugging a Domain wants, and `noindex` covers search.
- **Q6 — `__Host-` on the session cookie.**
  - **A** — Junction names the cookie `__Host-session` whenever it is `Secure`.
  - **B** — Leave it host-only and unprefixed.
  - **Recommend A** — host-only stops a cookie being read across Apps but not
    being set; only the prefix stops a sibling replacing it. It is a junction
    change and holds for every app, not Basecamp alone.

## Out of scope

- **A private preview.** CapRover's per-app Basic Auth is the right shape for one,
  and it is a second feature with its own secret to store. The name is public
  until then.
- **Per-release names**, Pages' `<hash>.<project>`. Two labels under the zone need
  a second-level wildcard, and Basecamp has no per-release route today.
- **A proxied ingress name.** A Domain CNAMEs to the ingress record, and
  proxying the target changes what every Domain resolves through; that waits on
  `IDEAS/cloudflare-edge.md`.
