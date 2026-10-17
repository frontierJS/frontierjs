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
| shipping-advisory dependency gate | `scripts/ci.mjs:505` | Configuration |

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
- [ ] 1.2 B13 SSRF through a caller-supplied URL (`public-url.ts`)
- [ ] 1.3 B14 oversized or flooding requests (body cap, rate limit)
- [ ] 1.4 B15 error output as an oracle (production error shape)
- [ ] 1.5 B16 a compromised dependency (CI advisory gate)

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
