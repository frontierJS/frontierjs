---
id: local-domains
status: proposed
dated: 2026-11-23
---

# Local domains — `example.localhost` is built; trusted HTTPS on it is not

**Status: PROPOSED.** Dated 2026-11-23. Nothing here is built. Do not cite this file as behavior — see `VERIFYING.md`. The names half shipped 2026-08-29 as `fli proxy` (`IDEAS/shipped/control-surface.md` § 10.6, `IDEAS/overview.md` 5.19). What this paper adds is the three things that half does not do: **start with `fli dev`, listen on the bare port, and speak trusted TLS.**

## The ask

The owner read about Stacks.js's rpx + tlsx and wants `ela.localhost` and `api.ela.localhost` in the address bar instead of `localhost:8110`, over HTTPS the browser trusts, with no warning and no per-app setup.

## What exists (probed 2026-11-23, Ubuntu 22.04.5, X11, Bun 1.4.4)

- **The names are derived and served.** `packages/cli/core/ports.js` renders a host per surface (`hostFor`, `toolHost`; frontend takes the bare label, every other surface a subdomain, tools under `fli.localhost`). `fli proxy --list` printed 19 names from `example/`, e.g. `example.localhost :8010`, `api.example.localhost :8110`, `fli.localhost :8500`. `fli check`'s `dev-host-unique` refuses two packages reducing to one label.
- **The proxy is TCP, on purpose** (`packages/cli/core/proxy.js`, 213 lines, zero dependencies): it reads the first request head, picks the target from `Host`, then pipes bytes, because bun's `node:http` `upgrade` hands over a socket nothing written to reaches the client, which would silently kill vite HMR and junction's live layer. Host is forwarded untouched (junction reads it for subdomain tenancy). Stated stance: **strictly additive, nothing may come to depend on a name.**
- **It does not start with `fli dev`.** `rg` finds `createProxy` only in `core/proxy.js`, `commands/ports/proxy.md` and its test. A name works only while someone ran `fli proxy`.
- **It cannot take port 80 here.** `net.ipv4.ip_unprivileged_port_start = 1024`; a `node:net` bind of 80 and of 443 both returned `EACCES` as this user, and `sudo -n` wants a password. `listenWithFallback` therefore lands on 5504, so the URL is `http://example.localhost:5504` — a name with a port still on it.
- **No TLS anywhere in `fli proxy`.** Neither `mkcert` nor `caddy` is installed (`which` printed nothing for both). `certutil` is (`/usr/bin/certutil`), `openssl` is 3.0.2, `setcap` is at `/usr/sbin/setcap`, and `node:tls` exposes `createServer` and `createSecureContext` under Bun.
- **`*.localhost` resolves here without a hosts line, in three places.** `getent hosts foo.localhost` printed `::1`; `resolvectl query foo.localhost` printed `127.0.0.1` and `::1`, `Data from: synthetic`; Bun's and Node's `dns.lookup('api.ela.localhost', {all:true})` both returned `::1` and `127.0.0.1`. So it is not only the browsers: RFC 6761 § 6.3 says resolution APIs SHOULD return loopback for `.localhost`, and systemd-resolved does. Firefox hardcodes it since 84 ([bug 1220810](https://bugzilla.mozilla.org/show_bug.cgi?id=1220810)); Chrome does likewise per the same thread. A tool that calls `getaddrinfo` on a machine without systemd-resolved (macOS, a container) is the case the browsers do not cover.
- **Browsers on this box:** `google-chrome` (deb, NSS db `~/.pki/nssdb` exists, empty), `chromium` snap 157, `firefox` snap 158 with profiles under both `~/.mozilla/firefox` and `~/snap/firefox/common/.mozilla/firefox`. Trust has to reach NSS for each; the system store alone does not satisfy them.
- **Cookies: the claim holds, and one thing is worse than the claim.** RFC 6265 § 8.5: "Cookies do not provide isolation by port." `packages/auth/plugin.ts` sets a cookie literally named `session` (lines 237, 746, 775, 884) with `httpOnly`, `sameSite: 'lax'`, and `secure: process.env.NODE_ENV === 'production'`; in production junction renames it `__Host-session` (`FJS-D1957`, `http.ts` `setAuthCookie`). So two apps with `cookieAuth` on `localhost:8110` and `localhost:8120` write the **same cookie name into the same jar**, and each sign-in logs the other out. Under `example.localhost` and `basecamp.localhost` the jars are separate (host-only cookies, and different sites). Not probed in a browser yet — Phase 0.
- **Dev never exercises `__Host-session`.** `secure` follows `NODE_ENV`, not the scheme, so dev runs the un-prefixed non-Secure cookie that production never uses.

## What it would buy, and what it would not

`http://localhost` is already a secure context: MDN lists `localhost`, `127.0.0.0/8` and "a host value ending with `.localhost`" as potentially trustworthy regardless of scheme ([MDN](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts)), so service workers, WebAuthn and `crypto.subtle` already work on every name `fli proxy` serves, over plain HTTP. **HTTPS is not what unlocks them.**

| Buys | Does not buy |
| ---- | ------------ |
| A bare name (no `:port`) — needs 80/443, not TLS | Any secure-context API; `http://*.localhost` has them |
| Separate cookie jars per app — **names alone, already built** | A phone on the LAN: `*.localhost` there is the phone's own loopback. A phone needs a real DNS name and the CA installed on it; `fli dev --host` and `fli tunnel` (`FJS-D2249`, real HTTPS) already cover the two uses |
| Mixed-content and `Secure`-cookie behavior as in production; `__Host-session` finally exercised in dev (Q4) | HTTP/2: the proxy pipes HTTP/1.1 bytes after terminating TLS, so ALPN says `http/1.1`. Not lost either — each surface is already its own host, so its own connection budget |
| A place for prod-parity subdomain tenancy tests (`acme.example.localhost`) — also names alone | A change to any drive: drives use the numbers and stay on them (`FJS-740`, `strictPort`) |

Unverified and worth a line in Phase 0: whether a third-party OAuth provider accepts `https://example.localhost` as a redirect URI (several accept only literal `localhost`), and whether Safari resolves `*.localhost` (the sources found are silent).

## Prior art

| Tool | Names resolve by | Trust installed by | Root / sudo | Linux | Maturity |
| ---- | ---------------- | ------------------ | ----------- | ----- | -------- |
| [rpx](https://github.com/stacksjs/rpx) | `.localhost` needs no entry; it manages `/etc/hosts` for other TLDs (`hostsManagement: false` turns it off) | local CA, its own cert flow (tlsx per the prior pass; the README fetched today does not name it) | sudo for 443/80 and hosts; skipped when the daemon is already root | README: CLI hangs at startup on Linux (issue #2267), workaround via `startGateway`; clustering is Linux-only | 31 stars, 579 commits, 8 open issues; version not on the page (0.11.63 in the prior pass) |
| [tlsx](https://github.com/stacksjs/tlsx) | n/a | `tlsx install`: Debian `/usr/local/share/ca-certificates` + `update-ca-certificates`, RHEL `update-ca-trust`, NSS when a profile exists; `export-ca` for other devices; ACME with DNS-01 (Porkbun) | page does not say | yes | 47 stars, 431 commits, 0 forks; README hopes for the unscoped npm name |
| [mkcert](https://github.com/FiloSottile/mkcert) | n/a | `mkcert -install`: system store, plus Firefox/Chrome NSS and Java; needs `certutil` on Linux; source lists `~/.pki/nssdb`, `~/snap/chromium/current/.pki/nssdb`, `/snap/firefox` ([truststore_nss.go](https://raw.githubusercontent.com/FiloSottile/mkcert/master/truststore_nss.go)); `NODE_EXTRA_CA_CERTS` for Node | README silent on when | yes | ~60k stars; warns `rootCA-key.pem` "gives complete power to intercept secure requests from your machine" |
| [Caddy](https://caddyserver.com/docs/automatic-https) `tls internal` ([directive](https://caddyserver.com/docs/caddyfile/directives/tls)) | a Caddyfile site address; `.localhost` gets local certs, no ACME | tries the system store on first use, asks for a password, "isn't guaranteed to work"; `caddy trust` / `caddy untrust`; leaf 12h, root 3600d | privileged for 80/443; trust install may need elevation | yes | the fleet edge already (`FJS-D564`, Outpost) |
| [portless](https://github.com/vercel-labs/portless) (vercel-labs) | assigns each server a random port 4000–4999 through `PORT`, routes `<name>.localhost`; syncs `/etc/hosts` for custom TLDs | first run creates a CA and adds it to the system store; HTTPS and HTTP/2 on 443 | first run may ask for sudo, `--unprivileged` skips it | yes, Node 24+ | ~12.9k stars, pre-1.0, state changes can require `portless trust` again |
| [puma-dev](https://github.com/puma/puma-dev) | macOS: `sudo puma-dev -setup`; Linux: `.localhost` works with systemd-resolved, `.test` needs a separate resolver | macOS automatic; Linux generates a CA in `~/.puma-dev-ssl/` and you trust it yourself | Linux: `setcap`, `authbind` or `-sysbind` for ports below 1024; no background service | supported with extra steps | ~1.8k stars |
| [Laravel Valet](https://laravel.com/docs/12.x/valet) | DnsMasq for `*.test` | `valet secure <site>` | Nginx on 80 at boot | **macOS only** (Herd covers macOS and Windows) | first party, current |
| [hotel](https://github.com/typicode/hotel) | `project.localhost`, no hosts edit, falls back to `localhost:2000` | local self-signed cert | none claimed | yes | ~10k stars; fetched page shows no release date |

Two things the table says. **Every tool that gives a bare name on Linux needs one privileged step** (sudo, `setcap`, `authbind`, a sysctl) — none escapes it, so the question is where the one step lives, not whether. **portless assigns its own ports**, which is the one design that conflicts with `ports.js` being the numbers' source of truth, so it is prior art here and not a candidate.

## Options

**A — Grow `fli proxy`.** Keep Host → port in `core/proxy.js` (Invariant 4: one owner per translation). Add a TLS listener — `node:tls` with an `SNICallback` that mints a leaf per requested name from a local CA, then the same first-head-pick-target logic over plaintext. Add `fli proxy:trust` for the one-time CA install. Start the proxy from `fli dev`. Cost: a trust installer to write or borrow (Q3). No new dependency, no new noun, no caller moves.

**B — Adopt Caddy.** Generate a Caddyfile from `ports.js` (`example.localhost { reverse_proxy :8010 }` with `tls internal`) and run `caddy` from `fli dev`. Gains HTTP/2, a trust installer that exists, and the same server as the fleet edge. Loses `proxy.js` and its test, adds a binary to install on every developer machine, and puts a second reader of `ports.js` beside the first. Its trust step "isn't guaranteed to work" outside a privileged run.

**C — Adopt rpx + tlsx.** A new Bun/TS dependency tree to do what `proxy.js` already does, on a 31-star project whose README lists a Linux startup hang. It would be a second owner of Host → port unless fed from `ports.js`, at which point it is option B with less behind it.

**D — Do nothing beyond what shipped.** `http://example.localhost:5504` works today after `fli proxy`. Names, cookie separation and secure-context APIs are all already true. Cost: the port stays in the URL, no HTTPS, and a developer must remember to start the proxy.

**Recommend A, staged: names into `fli dev` first (Phase 1), TLS only if Phase 0 clears it (Phase 2), confidence 2.** The domain's own precedent decides the shape: `fli tunnel` shells to a binary the developer installs rather than owning a relay (`FJS-D2247`), and `fli proxy` is already the owner of the name. A moves no caller. **Reopen path: B**, if Phase 0.1 finds `node:tls` under Bun cannot do SNI minting or carry a websocket through the existing pipe. Most of what makes the ask attractive is option D plus Phase 1; TLS is the smaller win than it reads.

## Open questions

- **Q1 — Does `fli dev` start the proxy?**
  - **A** — always; the table follows `~/.fli/sessions.lock` slots so one machine-wide proxy serves every running app.
  - **B** — on `fli dev --names`, default off.
  - **C** — no; it stays a separate `fli proxy`.
  - **Recommend B** — strictly additive is the stated stance, and one proxy serving several app roots needs the table to follow the slots, which is Phase 1's real work. Flip the default once it has run a week unprompted.
- **Q2 — How does it reach 80 and 443?**
  - **A** — one explicit, printed sudo line the developer runs once (`sysctl -w net.ipv4.ip_unprivileged_port_start=80`, persisted in `/etc/sysctl.d/`); fli never runs sudo itself.
  - **B** — `setcap cap_net_bind_service` on the bun binary — grants it to every Bun script and breaks on a Bun upgrade.
  - **C** — never; fall back to 5504 and 5443 and leave the port in the URL.
  - **Recommend A with C as the automatic fallback** — it is what `listenWithFallback` does today, extended to 443; puma-dev's README names the same three levers and leaves the choice to the developer. Confidence 2.
- **Q3 — Who makes and trusts the CA?**
  - **A** — mkcert as an external binary, as `fli tunnel` uses cloudflared.
  - **B** — our own, `openssl` for the CA and leaves, `certutil` and `update-ca-certificates` for trust, with an X.509 name constraint limiting it to `.localhost` so a leaked CA key cannot sign `bank.com`.
  - **C** — tlsx as a dependency.
  - **D** — Caddy's local CA (option B above).
  - **Recommend B if Phase 0.2 shows Chrome and Firefox both honor the constraint on this box, else A, confidence 1.** mkcert's trust logic is the hard 80% and is proven, but its README's own warning is the exposure a constrained CA removes; nothing found says mkcert constrains names, and that is unprobed. The shipping risk of B is the snap Firefox and Chromium profile paths, which mkcert already enumerates.
- **Q4 — Does dev set `Secure` and `__Host-session` under an HTTPS name?**
  - **A** — yes: `secure` follows the request scheme, so dev exercises production's cookie.
  - **B** — no; `secure` stays `NODE_ENV === 'production'`.
  - **Recommend A, Phase 3 only, after Phase 2 lands** — it is a change in `packages/auth` and junction's `setAuthCookie` (`FJS-D1957`) and needs `api-hazards` read first; Phase 1 and 2 ship without it.
- **Q5 — Is a phone on the LAN in scope?**
  - **A** — yes: a real wildcard DNS name resolving to the LAN IP, a cert for it, the CA installed on the phone (`tlsx export-ca` and mkcert's iOS steps are the precedent).
  - **B** — no; `fli dev --host` for HTTP and `fli tunnel` for real HTTPS.
  - **Recommend B** — A needs DNS the developer owns, a second CA delivery path and a different name scheme than `.localhost`; `fli tunnel` already gives a phone a trusted HTTPS URL.

## Plan

### Phase 0 — Probes, no code

Goal: every claim above marked "unprobed" is answered by running it.
Done when: each step has its result indented under it and Q3's recommendation is settled.

- [ ] 0.1 `node:tls` under Bun 1.4.4: `SNICallback` returning a per-name context, ALPN `http/1.1` only, and a websocket carried through the existing first-head pipe (the `test/proxy.test.js` upgrade case, over TLS).
- [ ] 0.2 A throwaway name-constrained CA (`openssl`, `nameConstraints = permitted;DNS:localhost`): installed into `~/.pki/nssdb` and both Firefox profile dirs, does `google-chrome`, snap Chromium and snap Firefox accept a leaf for `example.localhost` and refuse one for `example.com`?
- [ ] 0.3 A browser run of the cookie claim: sign in on two apps at `localhost:8010` and `localhost:8020`, observe the `session` collision; repeat on `example.localhost` and `basecamp.localhost`; check `api.example.localhost` against `example.localhost` for SameSite.
- [ ] 0.4 Does `example` log in end to end at `http://example.localhost:5504`? Read the dev CORS and csrf origin list (`devCorsOrigins` in `packages/cli/core/shell-origins.js` carries shell origins only) against the API at `api.example.localhost`.
- [ ] 0.5 Read `packages/auth/oauth.ts` redirect allow-list and each provider's documented rule for a `.localhost` redirect URI.

### Phase 1 — Names inside `fli dev`

Goal: `fli dev --names` leaves `http://example.localhost` reachable with no second command.
Done when: a drive signs in through the name and `fli done` is clean.

- [ ] 1.1 A machine-wide proxy whose table follows `~/.fli/sessions.lock` slots; a second `fli dev` reuses the running one.
- [ ] 1.2 `fli dev --names` starts or joins it and prints the names beside the numbers.
- [ ] 1.3 `docs/PORTS.md` and `commands/ports/proxy.md` say it; `fli check` still refuses a name collision.
- [ ] 1.4 A drive proving the cookie jar is per app (the 0.3 result as an assertion).

### Phase 2 — Trusted HTTPS (waits on Q2, Q3 and Phase 0)

Goal: `https://example.localhost` opens in Chrome and Firefox with no warning and HMR live.
Done when: `curl --cacert` succeeds and a CDP drive reads the page with no certificate error.

- [ ] 2.1 `fli proxy:trust` — creates the CA, installs it, prints every sudo line instead of running it, and `fli proxy:trust --remove` undoes it.
- [ ] 2.2 A TLS listener in `core/proxy.js` minting a leaf per SNI name; the plaintext path is unchanged.
- [ ] 2.3 443, falling back to 5443; the printed URLs carry the port only when the fallback was taken.
- [ ] 2.4 A leaf-expiry and CA-rotation test, and `proxy.test.js` gaining a TLS case that parses the served bytes.

### Phase 3 — Prod-parity cookies (waits on Q4)

Goal: dev under an HTTPS name runs `__Host-session`.
Done when: the auth drive passes with the Secure cookie on `https://example.localhost`.

- [ ] 3.1 `secure` follows the request scheme in `packages/auth/plugin.ts`; the audit trail and `FJS-D1957` stay as they are.
- [ ] 3.2 A hazard line in `api-hazards` for the scheme-dependent cookie name.
