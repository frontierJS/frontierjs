# ASVS 5.0 — the gap sheet

Every OWASP ASVS 5.0.0 requirement in `FJS-D1194`'s scope, graded against this tree: Levels 1 and 2 throughout, and Level 3 as well for V6 Authentication and V8 Authorization, where tenant isolation is graded. That is 271 requirements. `THREATS.md` cites them by ID and `fli check`'s `threat-row` refuses a row that cites none. Phase 0 of `IDEAS/pen-testing.md` produced this sheet, and its later phases work through the gaps.

**What is graded is the framework as a fresh app gets it**: what a `fli new` app ships with, plus what the framework provides for the app to turn on. The grades:

- **covered** — on by default, the enforcing code found, and a test cited where one exists.
- **partial** — built but opt-in, off by default, missing part of the requirement, or untested. The note says which.
- **none** — not built. *Where* names the nearest seam, the file that would own it.
- **n.a.** — the framework has no such surface. A note starting `app:` means the requirement is the app author's alone.

A gap with a defect behind it links its `FJS-###`. When that row closes, regrade the line in the same change. The requirement text is in the standard; look an ID up in [`OWASP_Application_Security_Verification_Standard_5.0.0_en.flat.json`](https://github.com/OWASP/ASVS/tree/master/5.0/docs_en). Graded 2026-10-17 at `d4e29b24`, from code and from probes against the real packages. Another session's uncommitted `packages/junction/src/transport/router.ts` change was excluded: in the tree at the time it detached helmet, csrf and cors, so the V3.4 and V3.5 lines grade HEAD.


## V1 Encoding and Sanitization

| ID | L | Grade | Where | Note |
| --- | --- | --- | --- | --- |
| V1.1.1 | 2 | covered | `packages/junction/src/transport/static.ts`, `packages/junction/test/fixtures/served-path-vectors.json`, `packages/junction/test/static-root.test.ts` | Served paths decode once; `%2e%2e`, `%5c`, malformed escapes refused. Query values have one decoder (`toolbelt/query`) |
| V1.1.2 | 2 | covered | `packages/mesa/src/runtime.js:1385`, `packages/mesa/src/render.js:179`, `packages/litestone/src/core/query.js:491` | Mesa writes via DOM text nodes/setAttribute; SQL values bound; the interpreter does the encoding |
| V1.2.1 | 1 | covered | `packages/mesa/src/render.js:179`, `packages/mesa/test/render-ssr.test.js:94` | Text and attribute escaping proved, SSR included; header values go through `Headers`, mail CRLF refused |
| V1.2.2 | 1 | partial | `packages/mesa/src/runtime.js:1385`, `packages/mesa/test/url-scheme.test.js`, `packages/junction/src/client/index.ts:509` | `javascript:`/`data:text/html` refused on href/src/action. Client puts ids into URL paths unencoded (see Findings) · [FJS-3188](../ISSUES.md#fjs-3188) |
| V1.2.3 | 1 | covered | `packages/sierra/src/build/prerender.js:331`, `packages/sierra/src/build/mcp-build.js:266` | JSON-LD escapes `<`; inlined script/style escape closing tags; wire is `JSON.stringify` |
| V1.2.4 | 1 | covered | `packages/litestone/test/identifier-refusals.test.ts`, `packages/litestone/test/unknown-args.test.ts` | THREATS B3. Bound params; names refused; `db.sql` throws once access rules exist |
| V1.2.5 | 1 | covered | `packages/cli/core/machine.js`, `packages/cli/test/machine.test.js`, `packages/litestone/src/tools/replicate.js:333` | App runtime makes no shell calls; tooling spawns argv arrays or script on stdin |
| V1.2.6 | 2 | n.a. | — | No LDAP anywhere |
| V1.2.7 | 2 | n.a. | — | No XPath anywhere |
| V1.2.8 | 2 | n.a. | — | No LaTeX; print-kit renders through headless Chromium |
| V1.2.9 | 2 | covered | `packages/litestone/src/core/query.js:487`, `packages/litestone/test/like-escape.test.ts` | LIKE `%`/`_`/`\` escaped with ESCAPE; channel patterns escaped; no caller regex operator |
| V1.3.1 | 1 | none | `packages/mesa/src/compiler.js:5669` | No HTML sanitizer ships; `{@html}` is a raw sink. Markdown is the safe alternative (V1.3.5) |
| V1.3.2 | 1 | covered | `packages/orion/CLAUDE.md:84`, `packages/orion/src/engine/nodes/code-worker-pool.ts` | No eval on the request path. Orion's `vm` code node is not a sandbox; gated SYSADMIN by ruling FJS-D272 |
| V1.3.3 | 2 | covered | `packages/junction/test/mail-injection.test.ts`, `packages/litestone/test/identifier-refusals.test.ts` | Dangerous sinks refuse rather than strip: CRLF in mail, names in SQL, URL schemes in Mesa |
| V1.3.4 | 2 | partial | `packages/toolbelt/src/mime/mime.js:253`, `packages/junction/src/transport/static.ts:261` | SVG never sanitized. It is sniffed and served as attachment only under `static: { untrusted: true }`; an S3 bucket serves it inline |
| V1.3.5 | 2 | covered | `packages/toolbelt/src/markdown/markdown.js:10`, `packages/toolbelt/test/specs/markdown.spec.js` | Raw HTML never passed; link schemes allowlisted; entities in URLs not decoded |
| V1.3.6 | 2 | covered | `packages/junction/src/core/public-url.ts`, `packages/junction/test/webhook-targets.test.ts` | Already in pen-testing § 1. Webhooks graded at registration and every attempt; helper exported for apps |
| V1.3.7 | 2 | covered | `packages/litestone/test/untrusted-schema.test.ts` | Templates compile from app files at build. Untrusted `.lite` text refuses dangerous words (FJS-1633) |
| V1.3.8 | 2 | n.a. | — | No Java/JNDI |
| V1.3.9 | 2 | n.a. | — | No memcache; cache drivers are an in-process Map and SQLite with bound values |
| V1.3.10 | 2 | n.a. | — | No format-string interpreter on input; logger writes JSON via `process.stdout.write` |
| V1.3.11 | 2 | covered | `packages/junction/test/mail-injection.test.ts` | CRLF refused at builder and at `sendMessage()` (FJS-677) |
| V1.4.1 | 2 | n.a. | — | Managed runtime (Bun/JS); no native code authored |
| V1.4.2 | 2 | covered | `packages/litestone/src/core/validate.js:756`, `packages/litestone/test/exact-numbers.test.ts`, `packages/litestone/test/big-int.test.ts` | Unsafe integers refused; `_sum` past 2^53 refused |
| V1.4.3 | 2 | n.a. | — | Garbage-collected runtime; no manual memory management |
| V1.5.1 | 1 | n.a. | `packages/junction/src/transport/body.ts:328` | No entity-resolving XML parser: XML bodies stay text; orion's regex reader resolves no entities |
| V1.5.2 | 2 | covered | `packages/toolbelt/src/query/query.js:100`, `packages/junction/test/unknown-keys.test.ts` | JSON only; `__proto__`/`constructor` keys refused in queries; unknown body keys refused |

## V2 Validation and Business Logic

| ID | L | Grade | Where | Note |
| --- | --- | --- | --- | --- |
| V2.1.1 | 1 | covered | `packages/litestone/docs/reference.snapshot.md`, `packages/junction/src/plugins/openapi/index.ts` | `db/schema.lite` is the declared rule set; JSON Schema/OpenAPI derive from it |
| V2.1.2 | 2 | covered | `packages/litestone/docs/reference.snapshot.md` | `@@check`/`@@arc` declare cross-field rules in the schema. External lookups (ZIP vs suburb) are the app's |
| V2.1.3 | 2 | partial | `packages/junction/src/config/index.ts`, `IDEAS/pen-testing.md` 2.4 | Rate limits and `bulkMax` are config, not documented limits; per-process behavior undocumented (known) |
| V2.2.1 | 1 | covered | `packages/junction/src/core/litestone.ts` (`autoValidate`), `packages/junction/test/unknown-keys.test.ts`, `packages/litestone/test/valuesets.test.ts` | Server validates against generated schema; `@values` allowlists; unknown keys refused |
| V2.2.2 | 1 | covered | `packages/junction/test/real-litestone-client.test.ts`, `packages/litestone/test/validate-rows.test.ts` | Client validation in `createResource` is convenience; Data boundary re-validates (Invariant 6) |
| V2.2.3 | 2 | covered | `packages/litestone/test/litestone.test.ts`, `packages/litestone/test/arc.test.ts` | `@@check`/`@@arc` enforced at write by both compilers |
| V2.3.1 | 1 | covered | `packages/litestone/test/transition-race.test.ts`, `packages/litestone/test/transition-entry.test.ts` | `@@transitions` refuses skipped moves even under `asSystem()`; CAS on the state |
| V2.3.2 | 2 | partial | `packages/junction/src/core/rate-limit.ts:56` | Limiter off by default, counts per process (known); auth throttles on |
| V2.3.3 | 2 | partial | `packages/junction/src/core/service.ts:1441`, `packages/junction/test/transactional.test.ts` | Single and nested writes atomic; a multi-write method needs `transactional:` opt-in |
| V2.3.4 | 2 | covered | `packages/litestone/test/transition-race.test.ts`, `packages/litestone/test/stamp-after-lock.test.ts` | `@version` optimistic lock, transition CAS, `@@unique`; writes serialized per database |
| V2.4.1 | 2 | partial | `packages/junction/src/core/rate-limit.ts:56`, `packages/auth/plugin.ts:50` | Already in pen-testing § 1. Only auth routes throttled by default; rest opt-in, per process |

## V3 Web Frontend Security

| ID | L | Grade | Where | Note |
| --- | --- | --- | --- | --- |
| V3.2.1 | 1 | partial | `packages/junction/src/transport/static.ts:261`, `packages/junction/test/static-root.test.ts`, `packages/cli/core/checks.js:1152` | Upload attachment disposition needs `untrusted: true` (fli check warns); S3 objects get none |
| V3.2.2 | 1 | covered | `packages/mesa/src/compiler.js:1809`, `packages/mesa/test/render-ssr.test.js:108` | Interpolation is a text node; `innerHTML=` attribute inert, refused in spreads |
| V3.3.1 | 1 | partial | `packages/auth/plugin.ts:748` | Secure only when `NODE_ENV=production`; no `__Host-`/`__Secure-` prefix on `session` |
| V3.3.2 | 2 | covered | `packages/auth/plugin.ts:748`, `packages/auth/test/routes.test.ts:309` | Session Lax, login challenge Strict, OAuth state Lax (callback is cross-site) |
| V3.3.3 | 2 | none | `packages/auth/plugin.ts:748` | Cookies named `session`, `login_challenge`, `fjs_oauth_state`; no `__Host-` |
| V3.3.4 | 2 | partial | `packages/auth/plugin.ts:735`, `packages/junction/test/auth-cookie.test.ts` | Cookie mode is HttpOnly and strips the token from the body; scaffold default is bearer in the body |
| V3.4.1 | 1 | partial | `packages/junction/src/transport/middleware.ts:248` | Already in pen-testing § 1. HSTS off by default; option takes 1y and includeSubDomains |
| V3.4.2 | 1 | covered | `packages/junction/src/transport/middleware.ts:130`, `packages/junction/test/index.test.ts` | Allowlist; `*` with credentials refused at construction (FJS-689). Scaffold `*` is credential-less |
| V3.4.3 | 2 | partial | `packages/junction/src/transport/middleware.ts:259` | Already in pen-testing § 1. `csp` is a free string option; no default policy |
| V3.4.4 | 2 | partial | `packages/junction/test/index.test.ts:4763`, `packages/cli/core/edge.js:230` | API routes, static and the SPA document (Caddy) set nosniff. An unrouted 404/405 does not · [FJS-3231](../ISSUES.md#fjs-3231) |
| V3.4.5 | 2 | covered | `packages/junction/src/transport/middleware.ts:247`, `packages/cli/core/edge.js:230`, `packages/cli/test/edge.test.js` | `no-referrer` on API responses; `strict-origin-when-cross-origin` on the SPA document, since `no-referrer` sends `Origin: null` on a POST |
| V3.4.6 | 2 | covered | `packages/cli/core/edge.js:230`, `packages/cli/test/edge.test.js` | SPA document: `frame-ancestors 'none'` plus X-Frame-Options DENY; API responses DENY |
| V3.5.1 | 1 | covered | `packages/junction/src/core/app.ts:2444`, `packages/junction/test/index.test.ts:3103` | THREATS B4. Bearer default needs preflight; cookie mode installs csrf (Origin/Sec-Fetch-Site) |
| V3.5.2 | 1 | covered | `packages/junction/src/transport/middleware.ts:520`, `packages/junction/test/index.test.ts:3416` | Cookie mode checks Origin/Referer/Sec-Fetch-Site on mutating verbs regardless of Content-Type |
| V3.5.3 | 1 | partial | `packages/junction/src/transport/bridge.ts:86` | Auth routes are POST. A GET carrying `X-Service-Method` runs any custom method (probed); csrf skips GET · [FJS-3203](../ISSUES.md#fjs-3203) |
| V3.5.4 | 2 | covered | `packages/outpost/test/static.test.js`, `packages/cli/core/edge.js` | Each app gets its own hostname; a hostname another route holds is refused; inline apps on own origin |
| V3.5.5 | 2 | covered | `packages/sierra/src/mcp/host.js:66`, `packages/sierra/test/mcp-relay.test.js:173` | Only `event.source === host` and `jsonrpc: '2.0'` read; forged source ignored |
| V3.7.1 | 2 | n.a. | — | No plugin technologies; plain JS/HTML/CSS output |
| V3.7.2 | 2 | covered | `packages/auth/oauth.ts:286`, `packages/auth/test/audit-oauth-returnto.test.ts`, `packages/sierra/test/router-hardening.test.js` | OAuth `returnTo` allowlisted, `//` and `/\` refused; router redirects stay on origin |

## V4 API and Web Service

| ID | L | Grade | Where | Note |
| --- | --- | --- | --- | --- |
| V4.1.1 | 1 | partial | `packages/junction/src/transport/http.ts:103`, `packages/junction/src/transport/static.ts:153`, `packages/junction/src/transport/http.ts:792` | ctx.text/html carry utf-8; junction static server and 413/400 text/plain omit charset (sierra/outpost pass `charset: true`) · [FJS-3211](../ISSUES.md#fjs-3211) |
| V4.1.2 | 2 | none | `packages/cli/core/edge.js:47` | Caddy auto-redirects every path to https, API paths and /ws included · [FJS-3210](../ISSUES.md#fjs-3210) |
| V4.1.3 | 2 | covered | `packages/junction/src/transport/forwarded.ts:60`, `packages/junction/test/forwarded.test.ts` | socket address by default; XFF read right-to-left by declared hops; deploy states one hop |
| V4.2.1 | 2 | covered | `packages/junction/src/transport/http.ts:690`, `packages/cli/core/edge.js:149` | Bun 1.4.2 answers 400 to CL+TE and duplicate CL (probed); Caddy in front; no repo test |
| V4.3.1 | 2 | partial | `packages/toolbelt/src/query/query.js:77`, `packages/junction/src/core/service.ts:2062` | no GraphQL; URL filter depth/keys/items capped, page max 100; WS-frame JSON query not bounded by LIMITS |
| V4.3.2 | 2 | n.a. | — | no GraphQL surface |
| V4.4.1 | 1 | covered | `packages/junction/src/client/index.ts:2461`, `packages/cli/core/edge.js:127` | client picks wss from an https origin; Caddy terminates TLS for /ws |
| V4.4.2 | 2 | none | `packages/junction/src/transport/http.ts:1241`, `packages/junction/src/transport/channels.ts:1572` | upgrade bypasses csrf and checks no Origin; per-route `upgrade` hook exists, /ws sets none · [FJS-3189](../ISSUES.md#fjs-3189) |
| V4.4.3 | 2 | covered | `packages/junction/src/transport/http.ts:1274`, `packages/junction/test/realtime-grading.test.ts` | socket reuses the standard session via subprotocol; bad token closes 4001 |
| V4.4.4 | 2 | covered | `packages/junction/src/transport/http.ts:1691`, `packages/junction/test/credentials-ws.test.ts` | token minted by HTTPS login, verified through verifySession at socket open |

## V5 File Handling

| ID | L | Grade | Where | Note |
| --- | --- | --- | --- | --- |
| V5.1.1 | 2 | partial | `packages/litestone/docs/file-storage.md:87` | `@accept` and the body bound documented; no per-feature size doc, nothing on malicious-file behavior |
| V5.2.1 | 1 | covered | `packages/junction/src/transport/body.ts:253`, `packages/junction/test/body-limit.test.ts` | Already in pen-testing § 1. 256 KB body cap, bounded streaming read; Blob not read whole |
| V5.2.2 | 1 | partial | `packages/litestone/src/storage/file-storage.js:64`, `packages/litestone/test/file-type.test.ts` | `@accept` grades sniffed magic bytes; opt-in per field, any type without it; no image rewriting |
| V5.2.3 | 2 | n.a. | — | Nothing decompresses or unpacks archives (no gunzip/unzip in request or storage path) |
| V5.3.1 | 1 | covered | `packages/junction/src/transport/static.ts`, `packages/junction/test/static-root.test.ts` | Static servers only read bytes; key extension follows sniffed type, not the upload name |
| V5.3.2 | 1 | covered | `packages/litestone/test/file-key.test.ts`, `packages/litestone/test/file-from-path.test.ts`, `packages/junction/test/static-root.test.ts` | Key is uuid plus sanitized name; a string never read as a path (FJS-2061); served path held in root |
| V5.4.1 | 2 | partial | `packages/junction/src/transport/static.ts:261` | Disposition filename from stored key, not caller; only under `untrusted: true` and only for non-inline types |
| V5.4.2 | 2 | partial | `packages/junction/src/transport/http.ts:1104`, `packages/junction/src/mail/smtp.ts:682` | HTTP names sanitized or RFC 5987. Mail attachment filename refuses CRLF but not `"`, and non-ASCII is not RFC 2231 · [FJS-3204](../ISSUES.md#fjs-3204) |
| V5.4.3 | 2 | none | `packages/litestone/src/storage/file-storage.js` (`serialize`) | No antivirus scan or scan hook before `provider.put` |

## V6 Authentication

| ID | L | Grade | Where | Note |
| --- | --- | --- | --- | --- |
| V6.1.1 | 1 | partial | `packages/auth/types.ts:491`, `packages/junction/README.md:743` | Option types give the limits and defaults. THREATS B12 names the throttle and the bcrypt cost. Nothing written on credential stuffing or malicious lockout |
| V6.1.2 | 2 | none | `packages/auth/auth.ts:337` | No context-specific word list anywhere |
| V6.1.3 | 2 | partial | `packages/auth/README.md:115`, `packages/auth/CLAUDE.md:223` | Pathways are spread across README sections. No single list of pathway against strength |
| V6.2.1 | 1 | covered | `packages/auth/auth.ts:336`, `packages/auth/test/password-policy.test.ts:20` | Default minimum 8. One grader serves register, reset and change |
| V6.2.2 | 1 | covered | `packages/auth/services.ts:387`, `packages/auth/test/audit-services-password-change.test.ts:45` | `account.changePassword`. Scaffold `/account/` page calls it |
| V6.2.3 | 1 | covered | `packages/auth/auth.ts:2202`, `packages/auth/test/credential-events.test.ts:70` | Current password is checked against the hash and rate-limited per account |
| V6.2.4 | 1 | none | `packages/auth/auth.ts:337` | Length is the only check. Probe: `password` accepted |
| V6.2.5 | 1 | covered | `packages/auth/auth.ts:338`, `packages/auth/test/password-policy.test.ts:35` | Length is the only rule. No composition rules |
| V6.2.6 | 1 | covered | `packages/cli/commands/project/new.md:1942`, `packages/cli/test/generators-run.test.js:200` | Scaffold and ui `Input` use type=password. ui adds a reveal toggle |
| V6.2.7 | 1 | covered | `packages/cli/test/generators-run.test.js:200`, `packages/ui/README.md:261` | autocomplete current/new-password set. No paste blocking found |
| V6.2.8 | 1 | covered | `packages/auth/plugin.ts:698`, `packages/auth/crypto.ts:13` | No trim or case change. Bun bcrypt pre-hashes past 72 bytes (probe). No test |
| V6.2.9 | 2 | covered | `packages/auth/crypto.ts:13`, `packages/junction/src/config/index.ts:239` | Only the 256 KB body cap limits length. 200 chars verified by probe. No test |
| V6.2.10 | 2 | covered | `packages/auth/auth.ts:337` | Passwords never expire and are never forced to rotate |
| V6.2.11 | 2 | none | `packages/auth/auth.ts:337` | There is no word list to apply |
| V6.2.12 | 2 | none | `packages/auth/auth.ts:337` | No breached-password check |
| V6.3.1 | 1 | partial | `packages/auth/plugin.ts:50`, `packages/junction/src/core/hooks-resilience.ts:150`, `packages/auth/test/audit-routes-ratelimit.test.ts:23` | THREATS B12. 10 per 15 min per IP only, per process (FJS-D1193). No per-account budget. Lockout is left to `onLoginFailed` · [FJS-3198](../ISSUES.md#fjs-3198) |
| V6.3.2 | 1 | covered | `packages/cli/commands/auth/dev-admin.md:132`, `packages/cli/commands/project/new.md:447` | A fresh app seeds no user. `dev-admin` refuses production |
| V6.3.3 | 2 | partial | `packages/auth/auth.ts:415`, `packages/auth/test/totp-login.test.ts:160` | TOTP is opt-in per person, with no switch to require it. No FIDO or passkey for L3 |
| V6.3.4 | 2 | covered | `packages/auth/auth.ts:415`, `packages/auth/test/magic-link.test.ts:187`, `packages/auth/test/oauth-routes.test.ts:339` | Password, magic link and OAuth all end at `firstFactorProven`, so TOTP is owed on each |
| V6.3.5 | 3 | none | `packages/auth/auth.ts:433` | `login.challenged` and `login.failed` go to the trail. Nobody is notified |
| V6.3.6 | 3 | partial | `packages/auth/auth.ts:754`, `packages/auth/README.md:200` | Off by default. Turning on magic link makes the mailbox the only factor |
| V6.3.7 | 3 | partial | `packages/auth/auth.ts:180`, `packages/auth/test/credential-events.test.ts:68` | `onCredentialChanged` is built, but the scaffold never wires it, so a fresh app tells nobody · [FJS-3200](../ISSUES.md#fjs-3200) |
| V6.3.8 | 3 | partial | `packages/auth/auth.ts:994`, `packages/auth/test/flows.test.ts:79`, `packages/auth/test/audit-routes-reset-timing.test.ts:50`, `packages/auth/test/routes.test.ts` (register where the app mails a verification) | THREATS B12. Login, reset and register are equalized where `onEmailVerificationRequested` is set (`FJS-D1310`): register answers 202 `{ ok: true }` for every address. An app with no verification mail has no mailbox to equalize with and keeps 201/409. |
| V6.4.1 | 1 | covered | `packages/auth/auth.ts:1834`, `packages/auth/test/audit-data-token-lifecycle.test.ts:60` | No generated passwords. An invitation is a 256-bit token, single-use, 1 hour |
| V6.4.2 | 1 | covered | `packages/auth/db/user.lite` | No hint or secret-question column or flow exists |
| V6.4.3 | 2 | covered | `packages/auth/auth.ts:1929`, `packages/auth/test/audit-data-token-lifecycle.test.ts:96` | A reset issues no session, so the next login still owes TOTP. No test combines reset with TOTP |
| V6.4.4 | 2 | partial | `packages/auth/services.ts:631`, `packages/auth/test/account-recovery.test.ts` | `resetTotp` is SYSADMIN-only. Identity proofing is neither defined nor documented |
| V6.4.5 | 3 | none | `packages/auth/auth.ts:2091` | No reminder before an API key expires. Nothing else expires |
| V6.4.6 | 3 | partial | `packages/auth/services.ts:741` | No admin-started reset for an existing person. `people.invite` gives the operator the token that sets the first password |
| V6.5.1 | 2 | covered | `packages/auth/auth.ts:1090`, `packages/auth/test/totp-login.test.ts` § concurrent attempts | THREATS B12. The step is spent by a conditional update, so of two concurrent requests with one code only one signs in. `verifyTotp` inside a session does not consume, by design (`packages/auth/CLAUDE.md`) · [FJS-3185](../ISSUES.md#fjs-3185) |
| V6.5.2 | 2 | partial | `packages/auth/auth.ts:379` | Recovery codes (~49 bits) are stored as keyed HMAC-SHA256, not a salted password hash |
| V6.5.3 | 2 | covered | `packages/auth/totp.ts:68`, `packages/auth/test/audit-data-token-lifecycle.test.ts:129` | `randomBytes` / `randomInt` for every secret, seed and code |
| V6.5.4 | 2 | covered | `packages/auth/totp.ts:191`, `packages/auth/crypto.ts:104` | Recovery codes ~49 bits. Magic-link code is 6 digits |
| V6.5.5 | 2 | covered | `packages/auth/auth.ts:105`, `packages/auth/test/magic-link.test.ts:58` | Magic link defaults to 10 min. `totpDrift: 1` accepts a code for about 90s · [FJS-3209](../ISSUES.md#fjs-3209) |
| V6.5.6 | 3 | covered | `packages/auth/auth.ts:1204`, `packages/auth/test/totp-login.test.ts:393`, `packages/auth/test/account-recovery.test.ts` | TOTP disable and reset, API-key revoke, OAuth unlink and session revoke all exist |
| V6.5.7 | 3 | n.a. | — | No biometric mechanism |
| V6.5.8 | 3 | covered | `packages/auth/auth.ts:1083`, `packages/auth/CLAUDE.md:85` | Uses the server clock `sys.$now()`. A caller-supplied `at` is refused by rule |
| V6.6.1 | 2 | n.a. | — | No SMS or phone OTP, so the L3 absence holds |
| V6.6.2 | 2 | covered | `packages/auth/auth.ts:669`, `packages/auth/test/magic-link.test.ts:128` | One live link per address. The code is checked against the row its address names |
| V6.6.3 | 2 | covered | `packages/auth/plugin.ts:354`, `packages/auth/auth.ts:708`, `packages/auth/test/magic-link.test.ts` § concurrent codes | THREATS B12. Per-IP limiter plus a 5-miss ceiling, each guess claimed by a conditional update before the code is compared, so a burst cannot pass it · [FJS-3185](../ISSUES.md#fjs-3185) |
| V6.6.4 | 3 | n.a. | — | No push MFA |
| V6.7.1 | 3 | n.a. | `packages/auth/PROJECT_STATE.md:129` | No certificate or WebAuthn authenticator. Passkeys are listed as open |
| V6.7.2 | 3 | n.a. | — | No challenge-response authenticator |
| V6.8.1 | 2 | covered | `packages/auth/auth.ts:1459`, `packages/auth/test/oauth-resolve.test.ts` | Credential is keyed on `oauth:<provider>` plus the provider subject, never the email |
| V6.8.2 | 2 | n.a. | `packages/auth/oauth.ts:37` | `id_token` is never read. Identity comes from userinfo over a TLS back channel |
| V6.8.3 | 2 | n.a. | — | No SAML |
| V6.8.4 | 2 | covered | `packages/auth/auth.ts:444`, `packages/auth/README.md:278` | A provider sign-in always counts as one first factor, so TOTP is still owed (FJS-D915). acr/amr unread |

## V7 Session Management

| ID | L | Grade | Where | Note |
| --- | --- | --- | --- | --- |
| V7.1.1 | 2 | partial | `packages/auth/auth.ts:768`, `packages/auth/types.ts:52` | The 30-day absolute lifetime is stated in code only. No idle timeout, no NIST justification |
| V7.1.2 | 2 | none | `packages/auth/auth.ts:280` | Concurrent sessions are unlimited and undocumented |
| V7.1.3 | 2 | none | `packages/auth/README.md:381` | App session is independent of the IdP session, and nothing documents it |
| V7.2.1 | 1 | covered | `packages/auth/auth.ts:771`, `packages/auth/test/audit-data-token-lifecycle.test.ts:32` | Every token is looked up against its Session row on the server |
| V7.2.2 | 1 | covered | `packages/auth/auth.ts:312`, `packages/auth/test/audit-data-token-lifecycle.test.ts:50` | A fresh reference token per login. API keys are machine credentials, not sessions |
| V7.2.3 | 1 | partial | `packages/auth/crypto.ts:133`, `packages/auth/test/flows.test.ts:242` | `randomUUID`: CSPRNG and unique, but 122 bits, under the 128 required. A test pins the shape · [FJS-3199](../ISSUES.md#fjs-3199) |
| V7.2.4 | 1 | partial | `packages/auth/plugin.ts:230`, `packages/auth/test/audit-routes-session-lifecycle.test.ts:32` | New token on every login. The session presented at login stays live (probe) · [FJS-3196](../ISSUES.md#fjs-3196) |
| V7.3.1 | 2 | none | `packages/auth/auth.ts:768` | No idle timeout. No sliding expiry, by design |
| V7.3.2 | 2 | covered | `packages/auth/auth.ts:318`, `packages/auth/test/expiry.test.ts:55` | `sessionTtl` of 30 days, checked at verify through `@@expires` |
| V7.4.1 | 1 | covered | `packages/auth/auth.ts:1769`, `packages/auth/test/audit-routes-session-lifecycle.test.ts:93` | Logout deletes the row. A lapsed row cannot be read |
| V7.4.2 | 1 | partial | `packages/auth/auth.ts:1861`, `packages/auth/test/people.test.ts:106` | Deleting an account revokes its sessions. There is no disabled state, so a suspended person keeps live sessions |
| V7.4.3 | 2 | partial | `packages/auth/auth.ts:2215`, `packages/auth/test/audit-services-password-change.test.ts:45` | Password change and reset end other sessions. Enabling TOTP or changing email ends none and offers nothing · [FJS-3192](../ISSUES.md#fjs-3192) |
| V7.4.4 | 2 | covered | `packages/cli/commands/project/new.md:1574` | The scaffold Shell puts a sign-out on every page |
| V7.4.5 | 2 | covered | `packages/auth/services.ts:717`, `packages/cli/commands/auth/revoke-sessions.md`, `packages/auth/test/people.test.ts:106` | `people.signOut` for one person. `fli auth:revoke-sessions --all` for everyone |
| V7.5.1 | 2 | partial | `packages/auth/services.ts:403`, `packages/auth/services.ts:599` | Email and TOTP changes ask for the password, never the second factor. OAuth unlink and minting a key ask nothing · [FJS-3192](../ISSUES.md#fjs-3192) |
| V7.5.2 | 2 | partial | `packages/auth/services.ts:495`, `packages/cli/commands/project/new.md:2263` | Listing and revoking sessions is built and scaffolded. No re-authentication before ending one |
| V7.6.1 | 2 | none | `packages/auth/auth.ts:1447` | No maximum time since the IdP sign-in. The session lasts `sessionTtl` regardless |
| V7.6.2 | 2 | partial | `packages/auth/plugin.ts:519`, `packages/auth/plugin.ts:352` | Magic-link and email links are spent only by POST. The OAuth begin route is a GET any page can start |

## V8 Authorization

| ID | L | Grade | Where | Note |
| --- | --- | --- | --- | --- |
| V8.1.1 | 1 | covered | `packages/litestone/src/access.js`, `example/db/access.snapshot.md`, `packages/litestone/test/litestone.test.ts` | the `.lite` schema plus the generated access snapshot (gates, row policies, levels) is the authorization document |
| V8.1.2 | 2 | covered | `packages/litestone/src/access.js:413`, `packages/litestone/src/access.js:435` | snapshot lists field `@allow`, protection attributes and gated state transitions per model |
| V8.1.3 | 3 | none | `packages/junction/src/core/app.ts` (`principal`) | no doc names time, IP, location or device as decision inputs; claim resolver is the seam |
| V8.1.4 | 3 | none | `packages/junction/src/core/app.ts` (`principal`) | no risk thresholds or allow/challenge/step-up actions documented |
| V8.2.1 | 1 | partial | `packages/junction/src/core/litestone.ts:3209`, `packages/junction/test/custom-method-gate.test.ts`, `packages/litestone/src/plugins/gate.js:145` | enforced where declared; a model with no `@@gate` or a modelless custom method is open to everyone · [FJS-3193](../ISSUES.md#fjs-3193) |
| V8.2.2 | 1 | partial | `packages/litestone/src/core/policy.js`, `packages/litestone/test/verbs-rules.test.ts`, `packages/cli/commands/make/model.md:64` | row policies enforced on every path; `make:model` default has no ownership policy, any user may delete any row · [FJS-3194](../ISSUES.md#fjs-3194) |
| V8.2.3 | 2 | covered | `packages/litestone/src/core/field-policy.js`, `packages/litestone/test/field-policy-compose.test.ts`, `packages/litestone/test/guarded-disclosure.test.ts` | field `@allow` strips reads/declines writes; `@guarded` refused by name, also in where/orderBy |
| V8.2.4 | 3 | none | `packages/junction/src/core/app.ts` (`principal`) | no adaptive controls; IP is used only for rate limiting |
| V8.3.1 | 1 | covered | `packages/litestone/src/plugins/gate.js`, `packages/litestone/test/gate-per-client.test.ts`, `packages/sierra/test/static-safety-real.mjs` | Invariant 6: Data boundary enforces, client `x-gate` is affordance only |
| V8.3.2 | 3 | covered | `packages/auth/auth.ts:818`, `packages/junction/src/transport/http.ts` `_wsReverify`, `packages/junction/test/ws-revoked-session.test.ts` | HTTP re-reads the user per request and a socket re-asks per frame, so a call is never made as a stale principal. A socket that only receives is re-asked every `http.ws.reverifySeconds` (60), the window a broadcast can still reach it (`FJS-D1201`) · [FJS-3187](../ISSUES.md#fjs-3187) |
| V8.3.3 | 3 | covered | `packages/auth/auth.ts:848`, `packages/junction/test/request-scope.test.ts`, `packages/mcp/test/principal-standing.test.ts` | internal calls carry the caller's frozen principal; jobs re-read the user; agent graded as its person |
| V8.4.1 | 2 | covered | `packages/litestone/src/tenant.js`, `packages/litestone/test/tenant-isolation.test.ts`, `packages/mcp/test/audit-withhold-tenant.test.ts` | one database or row scope per tenant; cache key carries tenant segment too |
| V8.4.2 | 3 | partial | `packages/junction/src/plugins/devtools/index.ts:37`, `packages/auth/CLAUDE.md` (reauthenticate) | devtools loopback by default with optional key check; no device posture or continuous verification |

## V9 Self-contained Tokens

| ID | L | Grade | Where | Note |
| --- | --- | --- | --- | --- |
| V9.1.1 | 1 | covered | `packages/toolbelt/src/signature/signature.js:588`, `packages/toolbelt/test/specs/signature.spec.js:442` | mintToken/readToken (reply tags) is the only self-contained token; MAC checked before id returned |
| V9.1.2 | 1 | covered | `packages/toolbelt/src/signature/signature.js:526`, `packages/toolbelt/src/signature/signature.js:356` | algorithm fixed, no header to pick it; request verifier states hmac OR ed25519, never both |
| V9.1.3 | 1 | covered | `packages/junction/src/mail/received.ts:119` | key is the app's configured secret; token names no key source |
| V9.2.1 | 1 | covered | `packages/toolbelt/src/signature/signature.js:590`, `packages/toolbelt/test/specs/signature.spec.js:465` | ULID time is the expiry; readReplyTag requires ttlSeconds (readToken's is optional) |
| V9.2.2 | 2 | covered | `packages/toolbelt/src/signature/signature.js:529`, `packages/toolbelt/test/specs/signature.spec.js:452` | MAC covers `purpose:id`; purpose required on mint and read |
| V9.2.3 | 2 | covered | `packages/toolbelt/src/signature/signature.js:552` | purpose is the audience; tokens never cross to another service |
| V9.2.4 | 2 | covered | `packages/junction/src/mail/received.ts:57` | one secret, a distinct required purpose per use, no default |

## V10 OAuth and OIDC

| ID | L | Grade | Where | Note |
| --- | --- | --- | --- | --- |
| V10.1.1 | 2 | covered | `packages/auth/auth.ts:1415`, `packages/auth/plugin.ts:584` | provider tokens stay server-side, discarded after userinfo; browser receives only our session |
| V10.1.2 | 2 | covered | `packages/auth/auth.ts:1389`, `packages/auth/test/oauth-flow.test.ts:127` | 256-bit state bound to httpOnly cookie, single-use row, 10-min TTL, verifier server-side |
| V10.2.1 | 2 | covered | `packages/auth/oauth.ts:355`, `packages/auth/test/oauth.test.ts:105` | PKCE S256 on every flow plus browser-bound state |
| V10.2.2 | 2 | covered | `packages/auth/plugin.ts:562`, `packages/auth/test/oauth-flow.test.ts:182` | distinct callback per provider plus flow.provider check; `iss` itself not validated |
| V10.3.1 | 2 | n.a. | — | not an OAuth resource server; accepts only its own sessions, API keys, signed requests |
| V10.3.2 | 2 | n.a. | — | not an OAuth resource server |
| V10.3.3 | 2 | n.a. | — | not an OAuth resource server |
| V10.3.4 | 2 | n.a. | — | not an OAuth resource server |
| V10.4.1 | 1 | n.a. | — | not an authorization server; sessions/keys/grants are not OAuth tokens |
| V10.4.2 | 1 | n.a. | — | not an authorization server |
| V10.4.3 | 1 | n.a. | — | not an authorization server |
| V10.4.4 | 1 | n.a. | — | not an authorization server |
| V10.4.5 | 1 | n.a. | — | not an authorization server |
| V10.4.6 | 2 | n.a. | — | not an authorization server |
| V10.4.7 | 2 | n.a. | — | not an authorization server |
| V10.4.8 | 2 | n.a. | — | not an authorization server |
| V10.4.9 | 2 | n.a. | — | not an authorization server |
| V10.4.10 | 2 | n.a. | — | not an authorization server |
| V10.4.11 | 2 | n.a. | — | not an authorization server |
| V10.5.1 | 2 | n.a. | `packages/auth/oauth.ts:37` | ID token never accepted or read; identity from userinfo via back-channel token; no nonce sent |
| V10.5.2 | 2 | covered | `packages/auth/oauth.ts:432`, `packages/auth/test/oauth-credential-unique.test.ts:39` | identity keyed `(provider, sub)`, never email; empty subject refused |
| V10.5.3 | 2 | n.a. | `packages/auth/oauth.ts:174` | no discovery metadata consumed; endpoints pre-configured |
| V10.5.4 | 2 | n.a. | `packages/auth/oauth.ts:37` | ID token not read |
| V10.5.5 | 2 | n.a. | — | no OIDC back-channel logout |
| V10.6.1 | 2 | n.a. | — | not an OpenID Provider |
| V10.6.2 | 2 | n.a. | — | not an OpenID Provider |
| V10.7.1 | 2 | n.a. | — | consent belongs to the authorization server |
| V10.7.2 | 2 | n.a. | — | consent belongs to the authorization server |
| V10.7.3 | 2 | n.a. | — | consent belongs to the authorization server |

## V11 Cryptography

| ID | L | Grade | Where | Note |
| --- | --- | --- | --- | --- |
| V11.1.1 | 2 | partial | `packages/litestone/docs/encryption.md:254` | rotation and per-tenant keys documented; no key-management policy, lifecycle or sharing rules |
| V11.1.2 | 2 | none | `packages/litestone/docs/encryption.md` | no inventory of keys, algorithms, certs (ENCRYPTION_KEY, webhook, signing, outpost cert, TOTP) |
| V11.2.1 | 2 | covered | `packages/litestone/src/host/node.js:44`, `packages/toolbelt/src/signature/signature.js:229`, `packages/auth/crypto.ts:14` | node:crypto, WebCrypto, Bun.password; no hand-rolled primitive |
| V11.2.2 | 2 | partial | `packages/litestone/src/core/encryption.js:37`, `packages/litestone/test/key-rotation.test.ts` | key ids, `$rotateKey`, key ring, password rehash; algorithms fixed per version, not configurable |
| V11.2.3 | 2 | partial | `packages/toolbelt/src/signature/signature.js:512` | AES-256, HMAC-SHA256, P-256, Ed25519; plus-address token MAC truncated to 80 bits · [FJS-3201](../ISSUES.md#fjs-3201) |
| V11.3.1 | 1 | covered | `packages/litestone/src/core/encryption.js:125` | AES-GCM only; no ECB, no RSA padding anywhere in framework src |
| V11.3.2 | 1 | covered | `packages/litestone/src/core/encryption.js:125` | AES-256-GCM is the one cipher |
| V11.3.3 | 2 | covered | `packages/litestone/src/core/encryption.js:220`, `packages/litestone/test/write-claims.test.ts` | GCM tag checked on read and on a client-supplied envelope at write |
| V11.4.1 | 1 | covered | `packages/toolbelt/src/signature/signature.js:77`, `packages/auth/totp.ts:94` | SHA-256 throughout; HMAC-SHA1 only in RFC 6238 TOTP; cli SHA-1 is cache keys |
| V11.4.2 | 2 | covered | `packages/auth/crypto.ts:11`, `packages/auth/test/flows.test.ts:105` | THREATS B12. bcrypt cost 12, rehashed at login when cost differs |
| V11.4.3 | 2 | covered | `packages/toolbelt/src/signature/signature.js:77` | SHA-256 for body hash, HMAC and Ed25519; truncated token MAC graded under V11.2.3 |
| V11.4.4 | 2 | n.a. | — | no key is derived from a password; keys are random hex |
| V11.5.1 | 2 | partial | `packages/auth/crypto.ts:133`, `packages/junction/src/core/litestone.ts:4478` | state, API keys, reset tokens 256-bit; session token UUIDv4 122 bits, grant cuid about 124 · [FJS-3199](../ISSUES.md#fjs-3199) |
| V11.6.1 | 2 | covered | `packages/toolbelt/src/signature/signature.js:414`, `packages/outpost/src/cert.js:21` | Ed25519 via WebCrypto, P-256 via openssl; no RSA key generation |

## V12 Secure Communication

| ID | L | Grade | Where | Note |
| --- | --- | --- | --- | --- |
| V12.1.1 | 1 | covered | `packages/cli/core/edge.js:44` | Caddy defaults (TLS 1.2 min, 1.3 preferred), no tls policy override; no repo test |
| V12.1.2 | 2 | covered | `packages/cli/core/edge.js:44` | Caddy default suites are ECDHE AEAD only |
| V12.1.3 | 2 | n.a. | — | no mTLS client-certificate authentication |
| V12.2.1 | 1 | covered | `packages/cli/core/edge.js:46`, `packages/cli/commands/deploy/_module.md:537`, `packages/cli/test/edge.test.js` | Caddy auto-HTTPS plus redirect; API container bound to loopback; HSTS off (known) |
| V12.2.2 | 1 | covered | `packages/cli/core/edge.js:87`, `packages/cli/test/edge.test.js:51` | Caddy ACME certificates; a stated ssl key is refused |
| V12.3.1 | 2 | partial | `packages/junction/src/mail/smtp.ts:382`, `packages/junction/src/core/public-url.ts:171` | request-addressed and webhook URLs https-only; SMTP STARTTLS opportunistic; fixed targets, OIDC endpoints may be http · [FJS-3195](../ISSUES.md#fjs-3195), [FJS-3202](../ISSUES.md#fjs-3202) |
| V12.3.2 | 2 | covered | `packages/conduit/src/transports/http.ts:170` | Bun default certificate validation; no `rejectUnauthorized: false` in framework src |
| V12.3.3 | 2 | partial | `packages/cli/core/edge.js:154`, `packages/outpost/src/index.js:41` | Basecamp to outpost is TLS; Caddy to API plaintext over loopback; conduit targets not forced https |
| V12.3.4 | 2 | covered | `packages/conduit/src/transports/http.ts:177`, `packages/conduit/conduit.test.ts` | outpost self-signed cert pinned by SHA-256 fingerprint |

## V13 Configuration

| ID | L | Grade | Where | Note |
| --- | --- | --- | --- | --- |
| V13.1.1 | 2 | partial | `packages/conduit/src/transports/http.ts:310` | conduit targets declare third parties in one config; no generated inventory, raw `fetch` unlisted |
| V13.2.1 | 2 | partial | `packages/junction/src/auth/credentials.ts`, `packages/junction/test/credentials.test.ts` | signed requests for inbound services; SQLite in-process; API keys are long-lived static secrets |
| V13.2.2 | 2 | partial | `packages/junction/src/core/litestone.ts`, `packages/junction/test/method-scopes.test.ts` | scoped clients and key scopes exist; auth and jobs write via `asSystem()` by design |
| V13.2.3 | 2 | covered | `packages/cli/commands/project/new.md:2776`, `packages/junction/src/core/env.ts:228` | scaffold ships no default account; ENCRYPTION_KEY generated random into gitignored `.env` · [FJS-3206](../ISSUES.md#fjs-3206) |
| V13.2.4 | 2 | partial | `packages/conduit/src/transports/http.ts:314`, `packages/junction/src/core/public-url.ts`, `packages/junction/test/webhook-targets.test.ts` | conduit binds each target to declared origins; stranger URLs get a private-range denylist, not an allowlist |
| V13.2.5 | 2 | partial | `packages/conduit/src/transports/http.ts:314` | same seam; no process-wide egress allowlist |
| V13.3.1 | 2 | partial | `packages/junction/src/core/env.ts`, `packages/cli/core/checks.js` (`battery-raw-secret`) | `.env` plus `defineEnv`, kept out of git and image; no vault or HSM seam |
| V13.3.2 | 2 | none | `packages/junction/src/core/env.ts` | one `.env` read whole by every process; no per-secret access control |
| V13.4.1 | 1 | covered | `packages/cli/commands/make/deploy.md:261` | generated `.dockerignore` drops `.git`; Dockerfile copies `api/` and `db/` only |
| V13.4.2 | 2 | covered | `packages/junction/src/core/errors.ts:275`, `packages/cli/commands/deploy/_module.md:545`, `packages/junction/test/wire-safety.test.ts` | deploy sets NODE_ENV=production; debug fails open whenever NODE_ENV is anything else · [FJS-3207](../ISSUES.md#fjs-3207) |
| V13.4.3 | 2 | covered | `packages/junction/src/transport/static.ts:135`, `packages/junction/test/static-root.test.ts` | a directory answers its index file or 404; no listing exists |
| V13.4.4 | 2 | covered | `packages/junction/src/transport/http.ts:757` | no route answers TRACE; it gets 405 or 404 |
| V13.4.5 | 2 | covered | `packages/junction/src/transport/health.ts:468`, `packages/junction/test/health-probes.test.ts`, `packages/junction/src/plugins/manifest/index.ts:93` | manifest dev-only; `/metrics` is not mounted in production without a `token` or `authFn`, while `/health` stays public for the deploy's health check · [FJS-3191](../ISSUES.md#fjs-3191) |

## V14 Data Protection

| ID | L | Grade | Where | Note |
| --- | --- | --- | --- | --- |
| V14.1.1 | 2 | partial | `packages/litestone/src/core/personal.js`, `packages/litestone/src/access.js:413` | closed `@personal` categories and protection attributes; parse warns on unmarked personal names; no data map generator · [FJS-3213](../ISSUES.md#fjs-3213) |
| V14.1.2 | 2 | partial | `packages/litestone/docs/encryption.md`, `packages/litestone/docs/trail.md`, `packages/litestone/src/core/catalog.js` | each attribute's regime documented; no per-level requirement set (integrity, retention, logging) |
| V14.2.1 | 1 | partial | `packages/junction/src/client/index.ts:181`, `packages/cli/commands/project/new.md:1140` | session rides header or WS subprotocol; reset, verify and magic-link tokens ride the query string |
| V14.2.2 | 2 | covered | `packages/junction/src/core/service.ts:37`, `packages/junction/src/transport/http.ts:1014`, `packages/junction/test/cache-conformance.test.ts` | service cache opt-in, keyed per user and tenant; authenticated reads `private` |
| V14.2.3 | 2 | partial | `packages/sierra/src/analytics/index.js:112`, `packages/sierra/src/analytics/tag.js:25` | analytics opt-in, pathname only from `track`; vendor tag's own auto-pageview still reads the full URL · [FJS-3205](../ISSUES.md#fjs-3205) |
| V14.2.4 | 2 | partial | `packages/litestone/src/core/audit-log.js`, `packages/litestone/src/core/encryption.js`, `packages/litestone/test/unique-redaction.test.ts` | encryption, audit redaction and declared retention built; no documented level to grade against |
| V14.3.1 | 1 | covered | `packages/sierra/src/resource/index.js:166`, `packages/sierra/test/resource-identity.test.js` | sign-out clears token, prefetch, live stores and OPFS tables, even offline; no Clear-Site-Data |
| V14.3.2 | 2 | partial | `packages/junction/src/transport/http.ts:1017` | authenticated reads get `private, no-cache`, not `no-store`; Vary Authorization misses cookie mode · [FJS-3208](../ISSUES.md#fjs-3208) |
| V14.3.3 | 2 | partial | `packages/junction/src/client/index.ts:212`, `packages/litestone/src/device-schema.js` | bearer in localStorage (allowed); device OPFS tables hold app rows until sign-out |

## V15 Secure Coding and Architecture

| ID | L | Grade | Where | Note |
| --- | --- | --- | --- | --- |
| V15.1.1 | 1 | none | `docs/CI.md`, `scripts/ci.mjs:505` | no remediation time frames written anywhere |
| V15.1.2 | 2 | partial | `bun.lock`, `deps.snapshot.md` | lockfile with integrity hashes; no SBOM, and the deps snapshot is the repo's not an app's |
| V15.1.3 | 2 | partial | `packages/junction/README.md`, `packages/junction/src/config/index.ts:239` | limits documented per feature; no list of expensive functions with their defenses |
| V15.2.1 | 1 | partial | `scripts/ci.mjs:505`, `packages/cli/core/app-config.js` | repo CI fails a shipping advisory; scaffolded app's workflow runs no audit |
| V15.2.2 | 2 | partial | `packages/junction/src/config/index.ts:239`, `packages/junction/src/core/litestone.ts:228`, `packages/conduit/src/resilience.ts:17` | body cap, list max 100, bulkMax, WS bounds on; rate limiter and DDoS gate off by default |
| V15.2.3 | 2 | partial | `packages/cli/commands/make/deploy.md:278`, `packages/junction/src/plugins/manifest/index.ts:80` | dev tools dev-only; `.dockerignore` `*.test.ts` is root-only, so `api/test/` ships in the image · [FJS-3212](../ISSUES.md#fjs-3212) |
| V15.3.1 | 1 | covered | `packages/litestone/src/core/client.js` (`read()`), `packages/litestone/test/guarded-disclosure.test.ts`, `packages/mcp/test/projection.test.ts` | one row shaper strips protected and field-policied columns; `$select` narrows further |
| V15.3.2 | 2 | covered | `packages/junction/src/plugins/webhooks/index.ts:603`, `packages/conduit/src/transports/http.ts:533`, `packages/junction/test/webhook-targets.test.ts` | webhooks refuse redirects; conduit follows only when a target opts in, bounded |
| V15.3.3 | 2 | covered | `packages/junction/src/core/litestone.ts:2197`, `packages/junction/test/unknown-keys.test.ts`, `packages/litestone/test/system-column.test.ts` | unknown keys refused; `@system`, `@guarded`, `@immutable`, field `@allow` bound writes |
| V15.3.4 | 2 | covered | `packages/junction/src/transport/forwarded.ts`, `packages/junction/test/forwarded.test.ts` | socket address by default; XFF read right to left under declared trust |
| V15.3.5 | 2 | covered | `packages/junction/src/core/litestone.ts:2197`, `packages/litestone/test/policy-interpreters.test.ts` | bodies validated against generated JSON Schema; policy JS compares with SQLite affinity |
| V15.3.6 | 2 | covered | `packages/toolbelt/src/query/query.js:100`, `packages/toolbelt/test/specs/query.spec.js` | query parser refuses `__proto__`/`constructor`/`prototype`, null-prototype accumulator |
| V15.3.7 | 2 | covered | `packages/toolbelt/src/query/query.js:251`, `packages/junction/src/transport/bridge.ts` | query, body and headers stay separate; a repeated key is deterministically an array |

## V16 Security Logging and Error Handling

| ID | L | Grade | Where | Note |
| --- | --- | --- | --- | --- |
| V16.1.1 | 2 | partial | `packages/litestone/docs/trail.md`, `packages/cli/commands/project/new.md:1266` | audit trail documented with declared 90d retention; no inventory covering request and app logs |
| V16.2.1 | 2 | partial | `packages/junction/src/transport/middleware.ts:367`, `packages/litestone/src/core/audit-log.js` | request line has time, ip, path, status, correlation id but no user; trail carries actor |
| V16.2.2 | 2 | covered | `packages/junction/src/core/logger.ts:200` | every timestamp `toISOString()` UTC; clock sync is the host's |
| V16.2.3 | 2 | partial | `packages/junction/src/core/logger.ts:250` | stdout and the declared audit database only, but no inventory to check against |
| V16.2.4 | 2 | covered | `packages/junction/src/core/logger.ts:168` | JSON lines in production |
| V16.2.5 | 2 | covered | `packages/junction/src/core/logger.ts:106`, `packages/junction/src/core/errors.ts:262`, `packages/litestone/test/unique-redaction.test.ts` | Invariant 7 in trail; logger redacts secret-named keys; errors redact schema-protected fields |
| V16.3.1 | 2 | covered | `packages/auth/auth.ts:289`, `packages/auth/test/credential-events.test.ts` | login succeeded, failed, challenged and reauthentication failed are trail rows |
| V16.3.2 | 2 | partial | `packages/junction/src/transport/middleware.ts:367` | gate refusal shows only as a 401/403 request line without user; row-policy filtering logs nothing |
| V16.3.3 | 2 | partial | `packages/junction/src/transport/middleware.ts:367` | refused `$` keys and validation failures leave a 400 line only; no security-event class |
| V16.3.4 | 2 | covered | `packages/junction/src/core/errors.ts:297`, `packages/junction/test/wire-safety.test.ts` | 500s logged with stack and correlation id; conduit reports transport failures |
| V16.4.1 | 2 | covered | `packages/junction/src/core/logger.ts:118`, `packages/junction/test/logger-pretty.test.ts` | JSON encoding in production; pretty mode quotes values carrying CR/LF |
| V16.4.2 | 2 | partial | `packages/litestone/src/core/audit-log.js` (`@@gate(8)`) | trail is system-only to callers; operator can rewrite it, no hash chain (B11 by ruling) |
| V16.4.3 | 2 | partial | `packages/junction/src/core/logger.ts` (`addWriter`) | writer seam exists; only a console writer ships, trail stays on the app's disk · [FJS-3213](../ISSUES.md#fjs-3213) |
| V16.5.1 | 2 | covered | `packages/junction/src/core/errors.ts:283`, `packages/junction/test/wire-safety.test.ts` | 5xx becomes generic message with correlation id in production |
| V16.5.2 | 2 | covered | `packages/conduit/src/resilience.ts`, `packages/conduit/conduit.test.ts` | per-target circuit breaker and concurrency gate on by default; `circuitBreaker` hook for services |
| V16.5.3 | 2 | covered | `packages/junction/test/around-forgot-next.test.ts`, `packages/litestone/test/policy-interpreters.test.ts` | `@@deny` fires on UNKNOWN, missing result is 500, validation halts the write |

## V17 WebRTC

| ID | L | Grade | Where | Note |
| --- | --- | --- | --- | --- |
| V17.1.1 | 2 | n.a. | — | no WebRTC or TURN in the tree |
| V17.2.1 | 2 | n.a. | — | no WebRTC media server |
| V17.2.2 | 2 | n.a. | — | no WebRTC media server |
| V17.2.3 | 2 | n.a. | — | no WebRTC media server |
| V17.2.4 | 2 | n.a. | — | no WebRTC media server |
| V17.3.1 | 2 | n.a. | — | no WebRTC signaling server |
| V17.3.2 | 2 | n.a. | — | no WebRTC signaling server |

## By ruling, not filed

These read as gaps against the standard, but a ruling chose them. Reopening one means a new ruling, not a fix.

- **V8.2.3: any signed-in user reads every `User` row, email included.** `FJS-D47` set `User` to `@@gate("4.4.4.5")` so that member lists stay off `asSystem()`, and the scaffold's test asserts it (`packages/cli/commands/project/new.md`).
- **V10.5.1: the OIDC client sends no nonce.** `FJS-D796`: v1 reads identity from userinfo and never accepts an `id_token`.
- **V6.4.6: `people.invite` hands the operator the first-password token** (`packages/auth/services.ts`), for an app with no mailer. An admin can therefore pick the invitee's password.
- **V8.2.1 in part: a model with no `@@gate` reads at level 0.** `FJS-D516` rules this for reads. Writes are not covered by it, and [FJS-3193](../ISSUES.md#fjs-3193) is filed for them.

## Judgment calls

A line where a reasonable grader could pick the neighboring grade. Each says what would move it.

- **V2.1.1, V2.1.2 (covered)** read `db/schema.lite` as the app's validation documentation. A grader who wants prose would mark them partial.
- **V2.3.3, V2.3.4.** Schema-declared controls (`@version`, `@@transitions`) are graded covered, and the `transactional:` service option partial.
- **V1.3.2 (covered).** Orion's code node is a `vm` "sandbox" that does not contain its author. It is graded covered because it is gated SYSADMIN by ruling and absent from a fresh app.
- **V3.5.4 (covered)** turns on whether `web/` and `api/` under one domain count as one application.
- **V4.2.1 (covered)** rests on Bun's own parser, which a raw-socket probe on Bun 1.4.2 saw refuse CL+TE and duplicate CL. No test here pins it, and Caddy-to-Bun desync was not probed.
- **V4.3.1 (partial).** It is unconfirmed whether a `where` sent in a WS frame or a JSON body escapes the query-string `LIMITS` depth cap.
- **V9.x (covered)** is graded against toolbelt's `mintToken`/`readToken`, the framework's one self-contained token. Read V9 as JWT and SAML only, and all seven lines are n.a.
- **V12.1.1, V12.1.2 (covered)** rest on Caddy's documented TLS defaults, unprobed on a live box. Outpost's 8180 listener uses Bun's.
- **V8.2.2 (partial)** is graded on the `make:model` default. The row-policy mechanism itself is complete and tested.
- **V8.3.2 (partial)** rests on the comment at `packages/junction/src/transport/channels.ts:1075` and a call-site search, not on a running probe.
- **V13.4.2 (covered)** holds only where `fli deploy` sets `NODE_ENV=production` ([FJS-3207](../ISSUES.md#fjs-3207)). V16.5.2 (covered) holds only when the call goes through conduit.
- **V14.2.3 (partial)** depends on Plausible's and GTM's scripts reading the full `location.href`. That is recalled, not measured.
- **V6.3.6 (partial).** The magic link is off by default but ships as a sole email factor.
- **V6.5.5 (covered)** is graded on the magic-link TTL. TOTP's ±1 step is accepted by most readers.
