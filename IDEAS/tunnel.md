---
id: tunnel
status: shipped
dated: 2026-10-14
---

# Idea — `fli tunnel`: a dev port on a public URL, with the visitor's address intact

**Status: Phases 0–1 built 2026-11-16, uncommitted: `fli dev --tunnel` and `fli tunnel [port]`. Q1–Q4 ruled: no own relay (`FJS-D2247`), no blind tunnel until a client's data needs one (`FJS-D2248`). Phase 2 built and proved live 2026-11-17, uncommitted: with `FLI_TUNNEL_DOMAIN=awe.dev`, `fli dev --tunnel` serves example at `https://example.awe.dev` (`FJS-D2249`). Every box is closed.** Dated
2026-10-14. Do not cite this file as behavior — see `VERIFYING.md`.

**The ask.** Put a local dev server on a public HTTPS URL with one command:
for a webhook hitting a local Junction (Stripe, Telnyx), a client looking at a
dev build (`preview-branch.md` slice 0 says *tunnel the port*), a stranger
trying Haven before it is deployed.

**The owner exists.** `packages/cli/commands/utils/tunnel.md` is `fli tunnel`,
one line: `cloudflared tunnel run <name>`, a NAMED tunnel configured by hand in
`~/.cloudflared/`. This grows that command; it coins no second one.

**The claim.** Choosing a tunnel is choosing who learns the visitor's address,
and Junction keys its rate limiter, DDoS guard, login lockout and audit rows on
that address (`transport/forwarded.ts`). A tunnel that hides it turns every
visitor into `127.0.0.1`, so one stranger's failed logins lock out everyone
(the `FJS-1841` failure, rebuilt locally).

---

## The two shapes

| | cloudflared quick tunnel | OpenTunnel |
| --- | --- | --- |
| Command | `cloudflared tunnel --url http://localhost:<port>` | `opentunnel route add <port>` |
| Account | none — a `*.trycloudflare.com` URL | none — a `<random16>.opentunnel.xyz` URL |
| Who terminates TLS | Cloudflare's edge, so the relay sees plaintext | the local client, so the relay sees bytes only |
| Visitor address | `X-Forwarded-For`, appended at the edge | a PROXY protocol header, v1 or v2, opt-in |
| Under Junction | `trustProxy: 1` reads it | **Bun refuses the request** — below |
| Installed here | `/usr/local/bin/cloudflared` | no |

A third shape is ours already, and § The own relay argues it.

[OpenTunnel](https://github.com/anomalyco/opentunnel): a Rust relay on Fly.io
that routes on the TLS ClientHello's hostname alone and forwards the still
encrypted stream over a WebSocket to the client holding the key. MIT. It takes
no pull requests, and it has no authentication: the random name is the only
lock. A TypeScript SDK, `@opentunnel/client`, runs on Bun.

## What the probe found

Bun 1.4.2, `Bun.serve` on `127.0.0.1`, raw TCP sockets writing one HTTP/1.1
request three ways:

- **Plain request**: `200`, `server.requestIP(req)` is `127.0.0.1`.
- **PROXY v1 line before it** (`PROXY TCP4 203.0.113.7 127.0.0.1 51234 80`):
  `400 Bad Request`, connection closed.
- **PROXY v2 binary header before it**: `400 Bad Request`, connection closed.

`bun-types` names no option for it in `serve()`. **So `Bun.serve` cannot read
PROXY protocol at all, and Junction is `Bun.serve`.** OpenTunnel then has two
modes and neither works for an app with strangers on it: with
`--proxy-protocol` every request is a 400; without it every visitor is
loopback.

The blind relay also gets one setting wrong in a way nothing reports.
`FRONTIER_TRUST_PROXY=1` is right behind cloudflared and **wrong behind OpenTunnel**:
nothing in front appends to `X-Forwarded-For`, so the visitor's own header is
the "trusted" hop, and a forged header buys a fresh rate-limit bucket per
request (`FJS-744`). Behind a blind tunnel `trustProxy` must stay `false`.

## The own relay

Rebuilding OpenTunnel whole is seven pieces: a public relay on wildcard DNS,
routing by the ClientHello's server name, a multiplexed client channel, a
certificate per subdomain whose key the CLIENT holds, a route registry, route
auth, and a client binary with a background service. Blindness is what costs
most of that, and blindness only matters when the relay is somebody else's.
**On a fleet machine we run, the relay may see plaintext**, and the build
collapses onto pieces that exist:

- **The relay is Caddy, and Outpost already drives it** (`fleet-ingress.md`,
  `FJS-D564`). `POST /route` with `app_id`, `hosts` and a bare `port` routes a
  hostname to a port with no container behind it, and the route dials
  `127.0.0.1:<port>` (`packages/outpost/src/ingress.js`).
- **The channel is `ssh -R 127.0.0.1:<remote>:localhost:<local> <box>`.** SSH
  already multiplexes, carries a WebSocket upgrade (Haven runs on one) and
  authenticates with the developer's key, and binding to loopback means only
  Caddy reaches the forwarded port.
- **The certificate is Caddy's own HTTP-01, one per hostname.** The ingress
  refuses a wildcard certificate (`fleet-ingress.md` D6); what a tunnel needs
  is a wildcard DNS RECORD, `*.tunnel.<domain>` pointing at the box, which
  puts no DNS token on it. A stable name per developer and port
  (`jordan-8110.tunnel.<domain>`) keeps under Let's Encrypt's weekly limit.
- **The visitor's address survives**: Caddy's `reverse_proxy` appends
  `X-Forwarded-For`, so the API runs under `trustProxy: 1` exactly as behind
  cloudflared.

Unknown until 3.1 runs: who signs the `/route` call. Outpost answers
Basecamp's signed requests (`signRequest()` / `verifyRequest()`), and a
developer's `fli` holding that key is a second signer the fleet protocol was
not built for (Q4).

```js
// The probe: run with bun; prints 200 / 400 / 400 on Bun 1.4.2.
import { connect } from 'node:net'
const server = Bun.serve({ port: 0, hostname: '127.0.0.1',
  fetch: (req, srv) => Response.json({ ip: srv.requestIP(req)?.address }) })
const send = raw => new Promise(res => {
  let buf = ''
  const s = connect(server.port, '127.0.0.1', () => s.write(raw))
  s.on('data', d => { buf += d })
  s.on('close', () => res(buf.split('\r\n')[0]))
})
const req = 'GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'
const sig = [0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a]
const v2 = Buffer.concat([Buffer.from([...sig, 0x21, 0x11, 0x00, 0x0c,
  203, 0, 113, 7, 127, 0, 0, 1, 0xc8, 0x22, 0x00, 0x50]), Buffer.from(req)])
console.log(await send(req))
console.log(await send('PROXY TCP4 203.0.113.7 127.0.0.1 51234 80\r\n' + req))
console.log(await send(v2))
server.stop(true)
```

## The nine, answered before any edit

1. **Origin** — one: the command that starts the tunnel is the only thing that
   knows a proxy is in front, the same reasoning as the deploy's
   `FRONTIER_TRUST_PROXY` (`FJS-D617`).
2. **Concept** — no new noun; `fli tunnel` exists. OpenTunnel is a dependency
   charged to the same budget; the own relay (Phase 3) charges nothing new,
   since SSH, Caddy and Outpost's `/route` are already there.
3. **Complexity** — the problem's: every tunnel product answers *which address*
   and the field already names both answers (`X-Forwarded-For`, PROXY protocol).
4. **Predictability** — a tunnel that silently makes everyone loopback reads
   identically to one that does not. 1.3 makes the difference visible.
5. **Derived** — the trust setting comes from the tunnel kind, not from the
   developer remembering it.
6. **Owner** — `utils/tunnel.md` for the tunnel, `forwarded.ts` for which
   address is believed, Outpost's ingress for a fleet machine's routes. A PROXY shim (Q2) would be a second answer to *which
   address* beside `clientAddress`, so it goes inside that owner or not at all.
7. **Boundary** — the hand-off is one env var Junction already reads.
8. **Failure** — the wrong trust setting is destructive (lockout, forged
   buckets), so the mismatch is a refusal, not a warning.
9. **Silence** — true: a visitor behind a tunnel is keyed on their own address.
   Fails: nothing today. 0.2's test and 1.3's line are the artifacts.

Adjudications: **paved road vs. the workaround** (one default tunnel, the
others behind a flag), and **batteries vs. smallness** (each tunnel stays
severable: a binary or a host on the path, never an import). Tier: Assessment.

---

## Plan

### Phase 0 — Who sees the visitor

Goal: know what each tunnel hands Junction.
Done when: a request through each tunnel shows its `clientAddress` result.

- [x] 0.1 Probe `Bun.serve` with PROXY v1 and v2 headers
  - Both are a 400 on Bun 1.4.2; the probe is above.
- [x] 0.2 Run a quick tunnel to a Junction app under `trustProxy: 1` and read
  the logged client address
  - Through `fli tunnel` → a Vite proxy → Junction's own `extractIP`: Cloudflare
    sends `X-Forwarded-For: <visitor>`, the Vite hop passes it untouched, and
    trust 1 reads the visitor while trust 0 reads 127.0.0.1. A forged header
    arrives as `<forged>, <visitor>` and trust 1 still reads the visitor.
    The example's own sessions could not show it: `FJS-4402`.

### Phase 1 — `fli tunnel <port>` is a quick tunnel

Goal: one command, no account, the visitor's address intact.
Done when: 0.2's check passes through `fli tunnel`, not by hand.

- [x] 1.1 The positional is a port
  - The default is the app's WEB port, not its API's: vite proxies `/api` and
    `/ws`, so the web port serves the whole app; the API's only without one.
- [x] 1.2 `fli dev --tunnel` starts the API with `FRONTIER_TRUST_PROXY=1` and the
  quick tunnel together, so the setting and the proxy cannot drift apart
  - It also sets `FRONTIER_APP_URL` to the tunnel's URL, and Sierra's vite config
    allows that host (vite 8 answers an unknown Host 403). Driven on example:
    page, `/api`, `/ws` and a sign-in through the URL; another host still 403.
- [x] 1.3 The startup line prints the public URL and the trust setting it chose
  - And the summary's title carries the URL, so it survives the scroll.

### Phase 2 — A fixed hostname, through a Cloudflare named tunnel

Goal: the same `https://<app>.<domain>` every run, on a zone the person's `cf`
login reaches, with the visitor's address intact.
Done when: `fli dev --tunnel` with `FLI_TUNNEL_DOMAIN=awe.dev` serves example at
`https://example.awe.dev` twice in a row, and a name another record holds is refused.

Measured 2026-11-17 by hand: `cf tunnels create --config-src local` answers the
run token; a proxied CNAME `<host>` → `<id>.cfargotunnel.com` and `cloudflared
tunnel run --token … --url http://localhost:<port>` served a header echo at
`https://example.awe.dev` with Cloudflare's certificate, `X-Forwarded-For` the
visitor and a forged one kept in front of it — the quick tunnel's shape, so
trust 1 holds. The laptop's `~/.cloudflared/cert.pem` is a DIFFERENT account
from `cf`'s, which is why this goes through `cf` and a token, never
`cloudflared tunnel route dns`.

- [x] 2.1 `core/cloudflare.js` gains the tunnel verbs (list, create, token); the
  hostname is `--tunnel=<host>`, else `<package.json name>.<FLI_TUNNEL_DOMAIN>`,
  else a quick tunnel — a set domain or a given host never degrades to one
  - Built: `tunnels`, `createTunnel`, `tunnelToken` in `core/cloudflare.js`;
    `tunnelLabel`/`tunnelHost` in `core/public-tunnel.js` (`--tunnel` is now a
    string flag, bare `--tunnel` arriving as `'true'`); a bad host or a domain
    that cannot label one throws instead of choosing the quick shape.
- [x] 2.2 One tunnel per hostname, `fli-<host, dots as dashes>`, reused; a record
  on the name that is not this tunnel's CNAME is refused by name
  - Built: `prepareNamedTunnel` (zone, tunnel, CNAME; any `cf` failure throws) and
    `openNamedTunnel` (token in `TUNNEL_TOKEN`, up on `Registered tunnel
    connection`); `fli dev --tunnel` names its shape on the startup line.
- [x] 2.3 `fli tunnel --name` goes; `fli tunnel [port] --host <host>` shares a
  running server the same way
  - Built: `--name` removed with no alias; `--host`, else `FLI_TUNNEL_DOMAIN` with a
    `package.json` in the directory, else the quick tunnel.
  - Proved 2026-11-17: two runs of `fli dev --tunnel` in example served
    `https://example.awe.dev` — page, `/api/health` and a `/ws` upgrade (101) —
    through one tunnel `fli-example-awe-dev` and one CNAME, the second run
    reusing both through `tunnelToken`; Ctrl-C left no cloudflared or port behind.
    `--tunnel=my-site.awe.dev` refused on its A record, before any server or
    tunnel was made.

### Not built

- **A blind tunnel** (`fli tunnel --blind` over OpenTunnel) waits for a client
  whose data Cloudflare must not see (`FJS-D2248`); its visitor address is
  then Q2's question again.
- **The own relay** (`ssh -R` to a fleet box behind Outpost's `/route`) is
  not built (`FJS-D2247`): each run gets a new trycloudflare.com link.

## Open questions

- ~~**Q5 — How is a fixed tunnel hostname chosen?**~~ **Answered 2026-11-17 (`FJS-D2249`): A — `FLI_TUNNEL_DOMAIN` through `loadFliEnv` (machine `.env`, a project's `.env` over it), the label from `package.json` `name` with its scope stripped, and `--tunnel=<host>` for one run.**
  - **A** — `FLI_TUNNEL_DOMAIN` through `loadFliEnv` (machine `.env`, a project's
    `.env` over it), the label from `package.json` `name` with its scope
    stripped, and `--tunnel=<host>` for one run.
  - **B** — a `config.json` key and a `fli tunnel:domain` command to set it.
  - **C** — the hostname typed on every run.
  - **Recommend A** — one origin, the env layering `FLI_PROFILE` already rides;
    B is a second writer of what `.env` carries, C restates the domain each run.

- ~~**Q1 — Is the blind tunnel worth a dependency now?**~~ **Answered 2026-11-17 (`FJS-D2248`): B — no; Phase 1 only, and Phase 2 waits for a client whose data rules out Cloudflare seeing it.**
  - **A** — yes, Phase 2 after Phase 1.
  - **B** — no; Phase 1 only, and Phase 2 waits for a client whose data
    rules out Cloudflare seeing it.
  - **Recommend B** — every listed use is dev data except preview-branch, and
    that one has not run its slice 0 yet. If Q3 is A, B is final: the own
    relay covers the plaintext case with no new dependency.
- ~~**Q2 — Where a blind tunnel's visitor address comes from.**~~ **Answered 2026-11-17 (`FJS-D2248`): no blind tunnel is built, so no visitor address to recover.**
  - **A** — wait for `Bun.serve` to read PROXY protocol, and keep loopback
    until then.
  - **B** — a local shim on `Bun.listen` that strips the header and records
    which loopback source port carries which visitor, read inside
    `clientAddress`.
  - **Recommend A** — B is a second listener and a port map in front of the
    transport for a dev tool; re-probe on each Bun upgrade (`bun-natives.md`).
- ~~**Q3 — Build our own relay?**~~ **Answered 2026-11-17 (`FJS-D2247`): B — no; cloudflared for everything, OpenTunnel where plaintext matters.**
  - **A** — yes, Phase 3: `ssh -R` into a fleet machine's Caddy through
    Outpost's `/route`.
  - **B** — no; cloudflared for everything, OpenTunnel where plaintext matters.
  - **C** — a full OpenTunnel clone: blind, its own protocol and certificates.
  - **Recommend A** — private, keeps the visitor's address, and no new
    protocol. C is all seven pieces to protect us from ourselves.
- ~~**Q4 — Who signs the `/route` a tunnel claims?**~~ **Answered 2026-11-17 (`FJS-D2247`): no own relay, so no route to sign.**
  - **A** — Basecamp: `fli` asks Basecamp, which signs as it does for a
    deploy.
  - **B** — `fli` holds a signing key of its own that Outpost accepts.
  - **Recommend A** — one signer for the fleet protocol; B is a second
    credential on every developer's machine.
