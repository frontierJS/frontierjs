---
id: tunnel
status: proposed
dated: 2026-10-14
---

# Idea — `fli tunnel`: a dev port on a public URL, with the visitor's address intact

**Status: PROPOSED. Phase 0's Bun probe is run; nothing is built. Q3 recommends our own relay (Phase 3) over a third party's.** Dated
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
`FJS_TRUST_PROXY=1` is right behind cloudflared and **wrong behind OpenTunnel**:
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
   `FJS_TRUST_PROXY` (`FJS-D617`).
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
- [ ] 0.2 Run a quick tunnel to a Junction app under `trustProxy: 1` and read
  the logged client address — outward-facing, so the owner runs it

### Phase 1 — `fli tunnel <port>` is a quick tunnel

Goal: one command, no account, the visitor's address intact.
Done when: 0.2's check passes through `fli tunnel`, not by hand.

- [ ] 1.1 The positional is a port, defaulting to the app's `FLI_PORT_BE`; a
  named tunnel moves to `--name`
- [ ] 1.2 `fli dev --tunnel` starts the API with `FJS_TRUST_PROXY=1` and the
  quick tunnel together, so the setting and the proxy cannot drift apart
- [ ] 1.3 The startup line prints the public URL and the trust setting it chose

### Phase 2 — A blind tunnel, for plaintext that must not cross a relay

Goal: `preview-branch.md` over production data without Cloudflare reading it.
Done when: Q1 and Q2 are ruled and the chosen half runs. Q3 may make this
phase unnecessary.

- [ ] 2.1 `fli tunnel --blind` runs `opentunnel route add`, with
  `trustProxy: false` forced and the startup line saying the limiter is global
- [ ] 2.2 Visitor address behind a blind tunnel — whichever Q2 picks

### Phase 3 — The own relay, on a fleet machine

Goal: no third party sees plaintext, and the visitor's address survives.
Done when: `fli tunnel --via <box>` serves a dev API on
`<name>.tunnel.<domain>` and 0.2's check passes through it.

- [ ] 3.1 By hand: `ssh -R` to a fleet box, `POST /route` with a bare port,
  `*.tunnel.<domain>` in DNS; measure first-certificate time and whether a
  WebSocket holds
- [ ] 3.2 `fli tunnel --via <box>` opens the `ssh -R`, claims the route, and
  unroutes it on exit
- [ ] 3.3 The remote port comes from the ports schema (`core/ports.js`), so two
  developers on one box cannot collide

## Open questions

- **Q1 — Is the blind tunnel worth a dependency now?**
  - **A** — yes, Phase 2 after Phase 1.
  - **B** — no; Phase 1 only, and Phase 2 waits for a client whose data
    rules out Cloudflare seeing it.
  - **Recommend B** — every listed use is dev data except preview-branch, and
    that one has not run its slice 0 yet. If Q3 is A, B is final: the own
    relay covers the plaintext case with no new dependency.
- **Q2 — Where a blind tunnel's visitor address comes from.**
  - **A** — wait for `Bun.serve` to read PROXY protocol, and keep loopback
    until then.
  - **B** — a local shim on `Bun.listen` that strips the header and records
    which loopback source port carries which visitor, read inside
    `clientAddress`.
  - **Recommend A** — B is a second listener and a port map in front of the
    transport for a dev tool; re-probe on each Bun upgrade (`bun-natives.md`).
- **Q3 — Build our own relay?**
  - **A** — yes, Phase 3: `ssh -R` into a fleet machine's Caddy through
    Outpost's `/route`.
  - **B** — no; cloudflared for everything, OpenTunnel where plaintext matters.
  - **C** — a full OpenTunnel clone: blind, its own protocol and certificates.
  - **Recommend A** — private, keeps the visitor's address, and no new
    protocol. C is all seven pieces to protect us from ourselves.
- **Q4 — Who signs the `/route` a tunnel claims?**
  - **A** — Basecamp: `fli` asks Basecamp, which signs as it does for a
    deploy.
  - **B** — `fli` holds a signing key of its own that Outpost accepts.
  - **Recommend A** — one signer for the fleet protocol; B is a second
    credential on every developer's machine.
