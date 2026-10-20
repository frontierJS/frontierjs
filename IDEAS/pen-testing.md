---
id: pen-testing
status: proposed
dated: 2026-10-17
---

# Idea — pen testing against a standard

Not behavior; see `VERIFYING.md`. Proposes OWASP ASVS 5.0 Level 2 as the requirement list `THREATS.md` grades against, OWASP WSTG as the method, and ZAP as the dynamic scan. `docs/ASVS.md` grades every requirement in scope.

## 1. What `THREATS.md` covers today (measured)

Each row's requirements are `THREATS.md`'s *ASVS* column. A signed request (B8–B10) answers V4.1.5 (per-message signatures) and V12.3.5 (service-to-service authentication), not V9, which covers self-contained tokens. Each row names a test, so these rows are the strong half.

**Built, tested or configured, but no row:**

| Control | Where | ASVS chapter |
| --- | --- | --- |
| login/register/reset/magic-link throttles | `packages/auth/plugin.ts:50` | Authentication |
| bcrypt, cost-equalized refusal | `packages/auth/auth.ts:996` | Authentication |
| SSRF guard on outbound URLs | `packages/junction/src/core/public-url.ts`, `packages/junction/test/webhook-targets.test.ts` | Validation / Secure Coding |
| body size cap, 256 KB default | `packages/junction/src/config/index.ts:239` | API and Web Service |
| no stack in production errors | `packages/junction/src/core/errors.ts:278` | Logging and Error Handling |
| shipping-advisory dependency gate | `packages/cli/core/advisories.js` | Configuration |

**Holes found while probing:**

- **`helmet()` sends `X-XSS-Protection: 1; mode=block`** (`packages/junction/src/transport/middleware.ts:247`). OWASP's current advice is `0` or omit it, because the retired XSS auditor could itself leak data. **No CSP by default and HSTS is off by default.**
- **`rateLimitHook` counts in a process `Map`** (`packages/junction/src/core/rate-limit.ts:56`). A restart resets the login throttle, and N processes allow N× the attempts. `auth.lite` already moved TOTP and login-challenge attempts into rows for this reason. The rate limiters have not followed.

**Not probed yet:** session id rotation on login and privilege change, how Mesa escapes interpolated text and attributes, upload type/size checks on `attachments`, OAuth `state`/PKCE, TOTP replay inside one window.

## 2. Plan

### Phase 0 — Map to the standard

Goal: every ASVS L2 requirement is marked covered, partial or none.
Done when: a gap sheet exists and each `THREATS.md` row cites at least one ASVS ID.

- [x] 0.1 Read how `fli check`'s `threat-row` parses the table, then add an *ASVS* column (the column moves with its parser)
- [x] 0.2 Gap sheet: ASVS 5.0 L2, one line per requirement, covered / partial / none / n.a., each with a path
  - `docs/ASVS.md`. Each `THREATS.md` row now cites requirement IDs, and `threat-row` refuses a bare chapter.
  - The grading found 28 new defects, `FJS-3185` and `FJS-3187`–`FJS-3213`. Two are S1: the second-factor attempt ceiling and TOTP replay can both be raced (`FJS-3185`), and an open WebSocket keeps its principal after a revocation (`FJS-3187`).

**Done 2026-10-17.** Of 271 requirements, 120 were covered, 78 partial, 21 none and 52 n.a. The weakest chapters are V7 Session Management and V14 Data Protection, where most lines are partial or none. A fresh app's biggest exposures are scaffold defaults rather than missing mechanisms: `make:model`'s gate (`FJS-3194`), a public `/metrics` (`FJS-3191`), and a SPA document served with no security headers (`FJS-3190`).

### Phase 1 — Add rows for what already holds

Goal: built controls become graded rows.
Done when: `fli check` passes with the new rows.

- [x] 1.1 B12 brute force against sign-in (auth throttles + bcrypt)
  - Also covers the second-factor and magic-link miss ceilings (`FJS-3185`). Cited from V6.3.1, V6.3.8, V6.5.1, V6.6.3 and V11.4.2 in `docs/ASVS.md`. The row's *Open* cell names `FJS-D1193`, `FJS-3198` and `FJS-3197`.
- [x] 1.2 B13 SSRF through a caller-supplied URL (`public-url.ts`)
  - Covers webhooks, conduit's `address_from: 'request'` and Basecamp's monitor sweep. Cited from V1.3.6, V13.2.4 and V15.3.2 in `docs/ASVS.md`. The row's *Open* cell names the denylist and `FJS-3357`, the monitor sweep's unpinned fetch.
- [x] 1.3 B14 oversized or flooding requests (body cap, rate limit)
  - Covers the HTTP body cap, the WebSocket bounds (`FJS-705`), `maxLimit` and `bulkMax`. Cited from V2.4.1, V5.2.1 and V15.2.2 in `docs/ASVS.md`. The row's *Open* cell names the throttle that is off by default, `FJS-D1193`, `FJS-3132` and `FJS-3027`, so 2.4's *Open* half is done.
- [x] 1.4 B15 error output as an oracle (production error shape)
  - Covers the 5xx sentence on both transports, protected keys in an error's `data` and a `@unique` refusal, and the 404 a hidden row answers. Cited from V13.4.2 and V16.5.1 in `docs/ASVS.md`. The row's *Open* cell names the unset-`NODE_ENV` default and the `@unique` 409, which is by design.
- [x] 1.5 B16 a compromised dependency (CI advisory gate)
  - Covers the advisories phase, the workflow's `FJS_CI_REQUIRE_AUDIT` and Basecamp's post-deploy re-check (`FJS-2715`). Cited from V15.1.1 and V15.2.1 in `docs/ASVS.md`. Writing it found the gate blind to a runtime dependency whose exports map hides `package.json` (`FJS-3370`, fixed), which had let a high advisory in `@frontierjs/mcp` pass. The row's *Open* cell names the unadvised malicious release, this tree's lockfile against an app's, `FJS-3371` and V15.1.1.

### Phase 2 — Fix the defaults

Goal: a fresh `fli new` app passes a ZAP baseline with no header warnings.
Done when: Phase 4's scan reports no header findings.

- [ ] 2.1 `X-XSS-Protection: 0`, or drop the header
- [ ] 2.2 HSTS on whenever the app is served over https in production
- [ ] 2.3 A default CSP (Q1)
- [ ] 2.4 Document that rate limits are per process and reset on restart, in junction's docs and in B14's *Open* cell (`FJS-D1193`)
- [x] 2.5 Security headers on the SPA document `fli deploy` serves, which helmet never reaches (`FJS-3190`)

### Phase 3 — Probe what is unmeasured

Goal: each item in § 1 *Not probed* becomes a row, an `ISSUES.md` defect, or n.a. with a reason.
Done when: § 1's *Not probed* list is empty.

- [ ] 3.1 Session rotation on login, password change and level change
  - Probed in 0.2. Login leaves the incoming session live (`FJS-3196`). A level change is re-read on every HTTP request but not by an open socket (`FJS-3187`).
- [ ] 3.2 Mesa output encoding in text, attributes, `href` and `style`
  - 0.2 graded V1.2.1 covered (`packages/mesa/test/render-ssr.test.js`). `{@html}` is a raw sink with no sanitizer (V1.3.1 none).
- [ ] 3.3 Upload type, size and served content-type for litestone `FileStorage` (`File` columns, `@accept`) and junction's multipart parser
- [ ] 3.4 OAuth `state` and PKCE; TOTP replay
  - Probed in 0.2. `state` and PKCE hold (`packages/auth/test/oauth-flow.test.ts`). Sequential TOTP replay is refused, but concurrent replay is not (`FJS-3185`).

### Phase 4 — Dynamic scan as a drive

Goal: a scanner hits a running app on every proving run.
Done when: `fli prove` runs it against `example/` and fails on a High finding.

- [ ] 4.1 ZAP baseline + API scan (from the OpenAPI that `generateJsonSchema` already feeds) against `example/`, registered in `DRIVES.md`
- [ ] 4.2 Nuclei templates for known-misconfiguration checks
- [ ] 4.3 Signed-in scan: ZAP with a session for each gate level, so it sees what B1 sees

### Phase 5 — External test

Goal: a third party tests a real deployment.
Done when: a report is filed and each finding has an `FJS-###`.

- [ ] 5.1 Scope one client app plus Basecamp/outpost (Q3)

## Open questions

1. ~~**Q1 — The default CSP.**~~ **Answered 2026-10-17 (`FJS-D1192`): A — strict (`default-src 'self'`) on by default; an app loosens it.**
   - **A** — strict (`default-src 'self'`) on by default; an app loosens it.
   - **B** — opt-in, as today.
   - **Recommend A** — Mesa has no inline-eval need we know of, and 2.3 measures that before the default lands.
2. ~~**Q2 — Where rate-limit counters live.**~~ **Answered 2026-10-17 (`FJS-D1193`): B — in-process, with the per-process limit documented.**
   - **A** — a SQLite table, as login challenges already use.
   - **B** — in-process, with the per-process limit documented.
   - **Recommend A** — auth already moved its attempt counts into rows for this reason.
3. **Q3 — When the first external test runs.**
   - **A** — before the first client app holding personal data goes live, then yearly.
   - **B** — yearly, tied to no launch.
   - **C** — when a contract or an auditor asks.
   - **Recommend A** — it is the date a SOC 2 auditor asks about.
4. ~~**Q4 — The ASVS level targeted.**~~ **Answered 2026-10-17 (`FJS-D1194`): A — L2 throughout, L3 for the Authentication chapter and tenant isolation.**
   - **A** — L2 throughout, L3 for the Authentication chapter and tenant isolation.
   - **B** — L2 throughout.
   - **C** — L1 for now.
   - **Recommend A** — those two boundaries hold every other app's data.
5. ~~**Q5 — The CSP on the SPA document `fli deploy` serves (`FJS-3190`, step 2.5).**~~ **Answered 2026-10-17 (`FJS-D1205`): B — A's headers, plus a strict CSP whose `script-src 'self'` carries a `sha256-` hash of each inline script, read from the built `index.html` at deploy and written into the Caddy route. This is SvelteKit's `kit.csp` hash mode for prerendered pages, Astro's `security.csp`, and nuxt-security for SSG.** Caddy's `file_server` sends no header today. A built `index.html` holds two inline scripts: `sierra-theme`, which sets the theme class before paint, and the service-worker registration. `FJS-D1192`'s `default-src 'self'` would block both. A static file server cannot mint a nonce.
   - **A** — send the headers that need no CSP now (`nosniff`, `Referrer-Policy`, `X-Frame-Options` plus `frame-ancestors`), and add the script CSP when 2.3 lands the default.
   - **B** — A's headers, plus a strict CSP whose `script-src 'self'` carries a `sha256-` hash of each inline script, read from the built `index.html` at deploy and written into the Caddy route. This is SvelteKit's `kit.csp` hash mode for prerendered pages, Astro's `security.csp`, and nuxt-security for SSG.
   - **C** — move both scripts into files so plain `script-src 'self'` holds. The cost is a blocking request before first paint for the theme script.
   - **Recommend B** — it is what every framework with a static output does, and the hash is read off the bytes being deployed, so it cannot drift from them. A leaves the document without a script policy until 2.3, and C slows first paint for every app.
6. ~~**Q6 — Whether the SMTP client sends credentials over a connection with no TLS (`FJS-3195`, ASVS V12.3.1).**~~ **Answered 2026-10-17 (`FJS-D1210`): A — refuse AUTH over a connection that is not TLS unless the host is loopback, with no new key. The dev sink is on localhost and sends no AUTH, so it is unaffected. This is Go's `net/smtp`: `PlainAuth` refuses with "unencrypted connection" when `!server.TLS && !isLocalhost` ([auth.go](https://github.com/golang/go/blob/master/src/net/smtp/auth.go)).** `packages/junction/src/mail/smtp.ts:382` upgrades only when the server advertises STARTTLS. When it does not, or a MITM strips the line, the client goes on to AUTH in the clear. RFC 8314 §5.1 says a client MUST NOT submit credentials without a confidential TLS session. RFC 3207 §6 says a client MUST be able to be configured to require TLS, but it does not set the default. Most clients are opportunistic by default: nodemailer, Symfony Mailer, Ruby net-smtp, gen_smtp, MailKit, Python smtplib.
   - **A** — refuse AUTH over a connection that is not TLS unless the host is loopback, with no new key. The dev sink is on localhost and sends no AUTH, so it is unaffected. This is Go's `net/smtp`: `PlainAuth` refuses with "unencrypted connection" when `!server.TLS && !isLocalhost` ([auth.go](https://github.com/golang/go/blob/master/src/net/smtp/auth.go)).
   - **B** — A, plus a `requireTLS` key (the nodemailer and Symfony name) that refuses any session to a host that is not loopback without TLS, even with no AUTH. Default off.
   - **C** — keep the opportunistic default and add an opt-in `requireTLS`. This is the majority: nodemailer, Symfony (`requireTls = false`), net-smtp (`starttls: :auto`), gen_smtp (`if_available`), MailKit (`Auto`). Under the default, a stripped STARTTLS still leaks the password.
   - **Recommend A** — the password is what leaks, and RFC 8314 §5.1 forbids sending it in the clear. A closes the leak with no option to learn. The majority runs the other way, but each of those clients leaks the credential by default. Only lettre (`starttls_relay` is `Required`) and Go refuse.
7. ~~**FJS-D1207 — Q7 — Which WebSocket upgrades check Origin (`FJS-3189`, ASVS V4.4.x).**~~ **Answered 2026-10-17 (`FJS-D1207`): A — check every upgrade that carries an Origin against the app's csrf origin list (`combineOrigins` in `transport/middleware.ts`). With no list configured, Origin's host must equal `Host`. An upgrade with no Origin passes, because a client that is not a browser sends none. This is Phoenix (`check_origin`, against the endpoint `:url` host), ActionCable (`allow_same_origin_as_host` plus `allowed_request_origins`), gorilla/websocket (`checkSameOrigin`), coder/websocket and Spring (`OriginHandshakeInterceptor`, same-origin by default). Every one of them lets a missing Origin through.** The upgrade in `packages/junction/src/transport/http.ts` reads no Origin and runs before csrf. With `cookieAuth` on, the session cookie authenticates a socket that any same-site page opens (CSWSH). Today the only protection is that the default bearer subprotocol is not ambient. Probed: in a `cookieAuth` app, an upgrade with `origin: https://evil.example.com` and `sec-fetch-site: same-site` opens with `ctx.user` set to the session's user. A POST with the same headers is 403.
   - **A** — check every upgrade that carries an Origin against the app's csrf origin list (`combineOrigins` in `transport/middleware.ts`). With no list configured, Origin's host must equal `Host`. An upgrade with no Origin passes, because a client that is not a browser sends none. This is Phoenix (`check_origin`, against the endpoint `:url` host), ActionCable (`allow_same_origin_as_host` plus `allowed_request_origins`), gorilla/websocket (`checkSameOrigin`), coder/websocket and Spring (`OriginHandshakeInterceptor`, same-origin by default). Every one of them lets a missing Origin through.
   - **B** — check Origin only when the credential came from a cookie, so bearer sockets are unchecked. No framework found does this.
   - **C** — a cookie never authenticates a socket, only the bearer subprotocol or a token in the first frame. This is the OWASP WebSocket cheat sheet's preference for a browser client, but no framework found makes it the default. It breaks every `cookieAuth` app's socket, and the cookie-refresh handling (`FJS-1503`) goes with it.
   - **Recommend A** — it is the default in five frameworks, and the origin list it reads is one the app already writes for csrf.
8. ~~**Q8 — What `/metrics` answers when no token is configured (`FJS-3191`, ASVS V13.4.5).**~~ **Answered 2026-10-17 (`FJS-D1211`): A — `/metrics` answers 404, as if it were absent, unless a `token` or `authFn` is configured. A wrong token is 401. `/health` stays public and unchanged. In-process readers (devtools, `collectMetrics()`) are unaffected. Boot logs one line saying `/metrics` is off until a token is set, so a scraper's 404 has a cause somebody can read. This is Spring Boot Actuator, which exposes only `health` over HTTP by default ([endpoints.adoc](https://github.com/spring-projects/spring-boot/blob/main/documentation/spring-boot-docs/src/docs/antora/modules/reference/pages/actuator/endpoints.adoc)). Rails `/up` and Laravel `/up` likewise reveal only up or down.** `health` (`packages/junction/src/transport/health.ts:396`) is open unless `token` or `authFn` is passed, and the scaffold mounts it with `health: true`. That exposes the pid, the runtime version, every service with its methods, and request stats. `/health` is read by the deploy to decide a rollback, so it must stay reachable. ASVS V13.4.5: monitoring endpoints are "not exposed unless explicitly intended".
   - **A** — `/metrics` answers 404, as if it were absent, unless a `token` or `authFn` is configured. A wrong token is 401. `/health` stays public and unchanged. In-process readers (devtools, `collectMetrics()`) are unaffected. Boot logs one line saying `/metrics` is off until a token is set, so a scraper's 404 has a cause somebody can read. This is Spring Boot Actuator, which exposes only `health` over HTTP by default ([endpoints.adoc](https://github.com/spring-projects/spring-boot/blob/main/documentation/spring-boot-docs/src/docs/antora/modules/reference/pages/actuator/endpoints.adoc)). Rails `/up` and Laravel `/up` likewise reveal only up or down.
   - **B** — the scaffold generates `METRICS_TOKEN` in `.env` and passes it, and the plugin default stays open. No precedent found, and an app not cut from the scaffold stays exposed.
   - **C** — `/metrics` moves to a management port the edge does not route. This is Quarkus (port 9000, opt-in), Spring's `management.server.port` and ASP.NET's `RequireHost`. It costs a second listener, a `ports.js` slot, and the readiness caveat Spring documents, where a probe on another port passes while the app's port is broken.
   - **Recommend A** — it is Spring's default, the token is the "explicitly intended" ASVS asks for, and it takes no port.
9. ~~**FJS-D1208 — Q9 — Which account changes revoke the other sessions (`FJS-3192`, ASVS V7.4.3).**~~ **Answered 2026-10-17 (`FJS-D1208`): A — the `changePassword` shape on every change to how the account signs in: TOTP enable, TOTP disable, recovery-code regeneration and a confirmed email change each revoke every other session and keep the current one. This is Django for a password (`update_session_auth_hash`) and Ory Kratos's `revoke_active_sessions` hook, which is opt-in there.** `changePassword` revokes every other session and keeps the current one (`packages/auth/services.ts:395`, `exceptSessionId`). TOTP enable, TOTP disable and an email change revoke nothing. ASVS V7.4.3 (L2) asks only that the app OFFER to terminate other sessions after a factor changes, and `sessions` already offers it (`services.ts:525`). Several products do nothing here: Laravel Fortify's `EnableTwoFactorAuthentication`, and Better Auth's two-factor enable and disable, which replace only the current session.
   - **A** — the `changePassword` shape on every change to how the account signs in: TOTP enable, TOTP disable, recovery-code regeneration and a confirmed email change each revoke every other session and keep the current one. This is Django for a password (`update_session_auth_hash`) and Ory Kratos's `revoke_active_sessions` hook, which is opt-in there.
   - **B** — a per-call flag, `revokeOtherSessions`, off by default. This is Better Auth `changePassword`.
   - **C** — nothing automatic. V7.4.3 is met by the existing `sessions` service, and the row's first clause closes as met.
   - **Recommend A** — it is the rule this package already applies to the password, so a factor change reads the same as a password change. The precedent is thinner than for the other questions: ASVS asks only for C, and two of the five products checked do nothing.
10. ~~**FJS-D1209 — Q10 — How a sensitive account change re-authenticates (`FJS-3192`, ASVS V7.5.1).**~~ **Answered 2026-10-17 (`FJS-D1209`): A — sudo mode. The session carries `reauthenticatedAt`, set at login and by a `reauthenticate` call that takes the password plus, when TOTP is enrolled, a code. `setupTotp`, `disableTotp`, `regenerateRecoveryCodes`, `requestEmailChange`, `changePassword`, `connections.remove` and `api-keys.create` refuse by name outside a window, defaulting to 1h (the Kratos default). `requireCurrentPassword` (`auth.ts:494`) becomes that freshness check rather than a second gate beside it, and the methods stop taking `currentPassword`. This is GitHub sudo mode (2h), Laravel `password.confirm` (3h, password only), Ory Kratos `privileged_session_max_age` (1h), Clerk reverification (10 min, `strict_mfa`) and Better Auth `freshAge` (1 day).** `disableTotp` and `requestEmailChange` ask for the password only, even when TOTP is enrolled (`packages/auth/auth.ts:1220`, `:2047`). `connections.remove` and `api-keys.create` ask for nothing beyond the session (`services.ts:563`, `:599`). V7.5.1 asks for "full re-authentication" before a change to the email, MFA settings or recovery.
    - **A** — sudo mode. The session carries `reauthenticatedAt`, set at login and by a `reauthenticate` call that takes the password plus, when TOTP is enrolled, a code. `setupTotp`, `disableTotp`, `regenerateRecoveryCodes`, `requestEmailChange`, `changePassword`, `connections.remove` and `api-keys.create` refuse by name outside a window, defaulting to 1h (the Kratos default). `requireCurrentPassword` (`auth.ts:494`) becomes that freshness check rather than a second gate beside it, and the methods stop taking `currentPassword`. This is GitHub sudo mode (2h), Laravel `password.confirm` (3h, password only), Ory Kratos `privileged_session_max_age` (1h), Clerk reverification (10 min, `strict_mfa`) and Better Auth `freshAge` (1 day).
    - **B** — per call: each of those methods takes `currentPassword` and, when TOTP is enrolled, a code, through the `requireCurrentPassword` that already exists (`auth.ts:494`). This is Better Auth's two-factor enable and disable (password per call) and Supabase (AAL2 with MFA). A person changing three things types both factors three times.
    - **C** — per call, password only, extended to the two methods that ask nothing today. The second factor is never asked, so V7.5.1's "full" is not met when TOTP is enrolled.
    - **Recommend A** — it has the most precedent of the three (GitHub, Laravel, Kratos, Clerk, Better Auth), it asks for both factors once per window rather than once per change, and the window is one number on the session row. It costs a session column, one endpoint and one config key, where B costs no schema change.
11. ~~**FJS-D1206 — Q11 — What a model or model-less method with no access declaration allows (`FJS-3193`, ASVS V8.2.1).**~~ **Answered 2026-10-17 (`FJS-D1206`): A — deny by default, reads included. A model with no gate and no policy refuses every operation below the system principal, and a written `@@gate("0.…")` is how a model says public, so no new word is needed. A model-less custom method with no `gate:` refuses below system, and `gate: 0` (the spelling `warnFloorRefusal` already prints, `packages/junction/src/core/litestone.ts:3342`) says open. This amends `FJS-D516`'s "an ungated model reads at 0". It is ZenStack (no `allow` means deny, [policy-handler.ts](https://github.com/zenstackhq/zenstack-v3/blob/dev/packages/plugins/policy/src/policy-handler.ts)), PocketBase (a `null` rule is superusers only), Payload (`defaultAccess` requires a logged-in user), Amplify Gen 2 ("deny-by-default"), Hasura (no permissions until added), Directus and Firestore production mode.** `buildAccessMap` skips a model with no `@@gate` (`packages/litestone/src/plugins/gate.js:145`). With no policy either, the model takes anonymous reads, creates, updates and deletes. A custom method over no model with no `gate:` runs for anyone, and `packages/junction/test/custom-method-gate.test.ts:231` pins that. `FJS-D516` rules that an ungated model reads at 0. Measured 2026-10-17: 0 of the 114 models in example, basecamp, haven, orion, auth and notifications lack a gate or a policy, because the scaffold writes `@@gate("0.4.4.6")`.
    - **A** — deny by default, reads included. A model with no gate and no policy refuses every operation below the system principal, and a written `@@gate("0.…")` is how a model says public, so no new word is needed. A model-less custom method with no `gate:` refuses below system, and `gate: 0` (the spelling `warnFloorRefusal` already prints, `packages/junction/src/core/litestone.ts:3342`) says open. This amends `FJS-D516`'s "an ungated model reads at 0". It is ZenStack (no `allow` means deny, [policy-handler.ts](https://github.com/zenstackhq/zenstack-v3/blob/dev/packages/plugins/policy/src/policy-handler.ts)), PocketBase (a `null` rule is superusers only), Payload (`defaultAccess` requires a logged-in user), Amplify Gen 2 ("deny-by-default"), Hasura (no permissions until added), Directus and Firestore production mode.
    - **B** — deny writes only, with reads public as `FJS-D516` keeps them. No product found does this.
    - **C** — keep it open but make it loud: a `fli check` error and a production boot warning naming each ungated model, silenced by a written gate. This is Supabase, whose lint `rls_disabled_in_public` is ERROR, and DRF, whose docs advise against its own `AllowAny` default.
    - **D** — refuse to build: a model with no gate is a parse error. No product found makes this a build error, because Amplify denies rather than refusing.
    - **Recommend A** — it is what nearly every schema-to-API product does, it costs no app in the tree a line, and the spelling for "public" (`@@gate("0…")`, `gate: 0`) already exists. The ruling it amends, `FJS-D516`, rested on a fresh model reading at 0, and the scaffold's written gate still gives a fresh model that.
