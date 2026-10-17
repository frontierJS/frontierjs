---
id: pen-testing
status: proposed
dated: 2026-10-17
---

# Idea — pen testing against a standard

Not behavior; see `VERIFYING.md`. Proposes OWASP ASVS 5.0 Level 2 as the requirement list `THREATS.md` grades against, OWASP WSTG as the method, and ZAP as the dynamic scan. Chapter names below are from ASVS 5.0; Step 0.2 checks every ID against the published text before one is cited.

## 1. What `THREATS.md` covers today (measured)

Each row's chapter is `THREATS.md`'s *ASVS* column. A signed request (B8–B10) sits under V4 (4.1.5, per-message signatures) and V12 (12.3, service-to-service authentication), not V9, which covers JWT and SAML only. Each row names a test, so these rows are the strong half.

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
- [ ] 0.2 Gap sheet: ASVS 5.0 L2, one line per requirement, covered / partial / none / n.a., each with a path

### Phase 1 — Add rows for what already holds

Goal: built controls become graded rows.
Done when: `fli check` passes with the new rows.

- [ ] 1.1 B12 brute force against sign-in (auth throttles + bcrypt)
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

### Phase 3 — Probe what is unmeasured

Goal: each item in § 1 *Not probed* becomes a row, an `ISSUES.md` defect, or n.a. with a reason.
Done when: § 1's *Not probed* list is empty.

- [ ] 3.1 Session rotation on login, password change and level change
- [ ] 3.2 Mesa output encoding in text, attributes, `href` and `style`
- [ ] 3.3 Upload type, size and served content-type for `attachments`
- [ ] 3.4 OAuth `state` and PKCE; TOTP replay

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
