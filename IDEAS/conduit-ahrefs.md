---
id: conduit-ahrefs
status: proposed
dated: 2026-11-25
---

# Idea — `conduit-ahrefs`: Ahrefs API v3 over conduit

**Status: PROPOSED.** Dated 2026-11-25. Nothing here is built. Do not cite this
file as behavior; see `VERIFYING.md`. The Ahrefs facts below come from Ahrefs'
docs and its OpenAPI spec as read on that date. Nothing has been measured yet:
Phase 0 measures the facts the connector depends on.

---

## Trigger

The owner asked for GitHub and Ahrefs connectors on 2026-11-25. GitHub went
first (`IDEAS/conduit-github.md`). Ahrefs was judged doable and deferred, and
this plan takes it up.

The connector has a real caller. TPM (`KOBAMI/tpm`, live at tpm.awe.dev) already
calls Ahrefs with a raw `fetch` in `api/src/domain/actions/ahrefs.ts`, 51 lines.
That file adds a client's domain as an Ahrefs project at onboarding and deletes
it at offboarding. TPM's *Final review (Review results from Ahrefs Site audit)*
step is still done by hand. As with `conduit-github`, the plan extracts a
dialect that is already in use instead of guessing one. The parked phases of
`conduit-airtable` show what building without a caller costs (`FJS-D2056`).

---

## What exists, and must not be restated here

| Piece | Where | What it settles |
| --- | --- | --- |
| The contract | `packages/conduit/docs/CONTRACT.md` | C1–C13. This connector is graded against it. The *google-maps* amendment to C5 covers a read the vendor charges for. |
| Where connectors live | `FJS-D1559`, `FJS-D2365` | `packages/conduits/conduit-<x>/`, held out of releases unless named in `ADMITTED`. |
| The read-only shape | `conduit-plausible` | A reporting source: `bindSend`, a target builder, one `MAX_LIMIT`, reads marked `replayable: true`. |
| The paid-call shape | `conduit-dataforseo` | Pacing and the cache of a paid lookup stay the app's (C12). Cost is reported, never guessed. |
| A 403 is not always the key | `conduit-github` `translate` | Conduit reads every 401 and 403 as `auth_failed`. A connector whose vendor sends something else as a 403 re-kinds it in `translate` (C3). |

### Today's Ahrefs callers

| Caller | File | Calls | Units |
| --- | --- | --- | --- |
| TPM, the *Add to Ahrefs* action | `tpm/api/src/domain/actions/ahrefs.ts` `addProject` | `GET /management/projects`, then `POST /management/projects` | free |
| TPM, the *Remove from Ahrefs* action | `ahrefs.ts` `removeProject` | `GET`, then `DELETE /management/projects?project_ids=` | free |
| TPM, the integrations panel | `services/integrations.service.ts` | `findProject`, to show whether the domain is in Ahrefs | free |
| TPM, *Final review* | `domain/basecamp/steps.ts` `dep-ahrefs` | none: a person reads the Site Audit in Ahrefs | — |
| Marketing reports | `~/.claude/skills/marketing-request/rules.md` | none: the monthly *Search Console + Ahrefs audit* is done by hand | — |

TPM installs FrontierJS from packages.frontierjs.com tarballs, not from this
tree. It lists `@frontierjs/conduit` only under `overrides`; it has no direct dependency on it, and nothing in `api/src` imports it. It reaches Plausible
with a raw `fetch` too, though `conduit-plausible` was released at 0.1.0. So
TPM can only use this connector once the connector is released, and TPM has
to add conduit to do it.

---

## What Ahrefs presses that the connector owns

Read on 2026-11-25:
[Introduction](https://docs.ahrefs.com/api/docs/introduction.md),
[Limits consumption](https://docs.ahrefs.com/api/docs/limits-consumption.md),
[Free test queries](https://docs.ahrefs.com/api/docs/free-test-queries.md),
[API keys](https://docs.ahrefs.com/api/docs/api-keys-creation-and-management.md),
[OpenAPI spec](https://docs.ahrefs.com/openapi.json).

- **One bearer key.** It is sent as `Authorization: Bearer <key>` to `https://api.ahrefs.com/v3`.
  - Only a workspace owner or admin can create a key.
  - Each key has an expiry date, up to 10 years out, and a monthly unit cap set per key.
  - A key dies when the person who created it leaves the workspace.
  - `GET /subscription-info/limits-and-usage` is free. It returns the key's expiry, the plan, and units used and left, for the key and for the workspace. It is the `verify(send)` call.
- **Spec size.** It has 155 endpoints in 15 groups. Every endpoint answers 200, 400, 401, 403, 429 or 500, and every error body is `{ "error": string }`.
- **Every call that costs units costs at least 50.** The charge is `max(50, per_row_cost × rows)`.
  - A field costs 1, 5 or 10 units a row. The per-row cost counts each field once, wherever it appears: in `select`, `where` or `order_by`.
  - The spec gives the cost of each field on each endpoint in `x-ahrefs-unit-cost`.
  - Example: 500 backlink rows with `traffic` (10 units a row) cost 6,000 units.
  - A call served from cache costs nothing. Units, once spent, are not refunded.
- **The answer says what the call cost.** Each reply carries these headers:
  - `x-api-rows`
  - `x-api-units-cost-row`
  - `x-api-units-cost-total`
  - `x-api-units-cost-total-actual`
  - `x-api-cache`: `hit`, `miss` or `no_cache`

  So the connector can report the cost of a call, where `conduit-dataforseo` had to compute it. The research summary of 2026-11-25 said otherwise, and it was wrong.
- **Some calls are free.** By the spec: `/management/*`, `/site-audit/projects` (health scores), `/subscription-info/limits-and-usage`, Rank Tracker and the public endpoints.
  - `/site-audit/issues` and `/site-audit/page-explorer` cost 50 units a request, not per row.
  - Every TPM call today is free.
- **There are free test targets.** A Site Explorer call whose `target` is `ahrefs.com`, `yep.com` or `firehose.com` costs nothing, on any paid plan. So does a Keywords Explorer or SERP call whose only keyword is `ahrefs`, `yep` or `firehose`. On a free test call, `limit` is capped at 100. The drive's fixture rows use these targets, so they reach the real API without spending units.
- **The rate limit is 60 requests a minute.** Over it, Ahrefs answers 429. Ahrefs also throttles under load, and that comes back as a 429 too. Whether a 429 carries `Retry-After` is not documented; 0.4 measures it.
- **Which plans have the API:** Lite ($129 a month, about 200k units) and above since May 2026. A Starter plan gets the free test calls only. What a Starter key gets on a paid call (403? 402? a 200 with an error?) is not documented; 0.3 measures it.
- **Projects have no idempotency key (C5), and a domain is found by its bare host (C6).**
  - `POST /management/projects` takes no key. The read that settles a lost answer is `GET /management/projects`, matched on the domain with the scheme and `www.` stripped, which is what TPM's `bare` does today.
  - A replayed POST would make a second project for the same domain. So the connector finds the project first and creates it only when none exists, and a lost answer is `indeterminate`.

---

## Open questions

- ~~**Q1 — Who is the first caller, and does TPM move onto the connector in this plan?**~~ **Answered 2026-11-25 (`FJS-D2380`): A — TPM moves. The connector covers TPM's three calls, gets a ruling adding it to `ADMITTED`, and is released at 0.1.0. TPM then adds `@frontierjs/conduit` and `@frontierjs/conduit-ahrefs`, and `ahrefs.ts` becomes an adapter that keeps TPM's sentences. TPM's raw `fetch` is deleted.**
  - **A** — TPM moves. The connector covers TPM's three calls, gets a ruling adding it to `ADMITTED`, and is released at 0.1.0. TPM then adds `@frontierjs/conduit` and `@frontierjs/conduit-ahrefs`, and `ahrefs.ts` becomes an adapter that keeps TPM's sentences. TPM's raw `fetch` is deleted.
  - **B** — Build the connector alone around TPM's calls and keep it held out. TPM stays on its raw `fetch` until a later plan moves it.
  - **C** — The first caller is a new SEO report (Site Explorer: Domain Rating, backlinks, organic keywords) for the monthly marketing audit. TPM is left alone.
  - **Recommend A.** It is the `FJS-D2367` reasoning: two copies of one dialect drift apart and nothing fails. B builds a package nobody calls, the `conduit-airtable` cost. C has no caller in code, only a manual step in a skill.
  - The price of A is a change to a live app that deploys on every push to main, plus a release before it. TPM adding conduit is new work for TPM: a target, a credential resolver and the plugin. Moving TPM's Plausible calls onto conduit at the same time is left out (see Not planned).
- ~~**Q2 — How much of the API does v1 cover?**~~ **Answered 2026-11-25 (`FJS-D2381`): A — Only the calls that have a caller: projects (list, add, delete), `verify` through limits-and-usage, and `siteAudit(send, projectId)` reading `/site-audit/projects` for TPM's *Final review* step. All of them are free. Paid reads wait until something calls them.**
  - **A** — Only the calls that have a caller: projects (list, add, delete), `verify` through limits-and-usage, and `siteAudit(send, projectId)` reading `/site-audit/projects` for TPM's *Final review* step. All of them are free. Paid reads wait until something calls them.
  - **B** — A, plus a small set of paid Site Explorer reads: `domainRating`, `metrics` and `backlinksStats`. Each takes a caller-given `maxUnits`, and the connector refuses a call locally if its estimate exceeds that (C9). The estimate comes from a cost table of the chosen fields, taken from the spec. The reply's actual cost is reported.
  - **C** — A general `query(send, endpoint, { select, where, orderBy, limit, maxUnits })` that can reach any GET endpoint, with the full cost table generated from the spec.
  - **Recommend A.** A method with no caller is untested code (`cut-one-level-simpler`), and `FJS-D2369` made the same call for GitHub. The `/site-audit/projects` read is in because TPM's *Final review* step is a real caller: TPM can show the health score beside the checkbox. Moving to B later only adds code, and A's `cost` on every answer is what B's guard is built on.
- ~~**Q3 — What happens on a 403?**~~ **Answered 2026-11-25 (`FJS-D2382`): A if 0.3 can tell the cases apart, else B.**
  - **A** — `translate` re-kinds a 403 by its `error` text: `plan_refused` (the plan has no API access), `units_exhausted` (no units left, or this key's monthly cap reached), or `auth_failed`. The patterns come from what 0.3 captures.
  - **B** — Every 403 stays `auth_failed`, and the sentence carries Ahrefs' `error` text.
  - **Recommend A if 0.3 can tell the cases apart, else B.** The drive asserts that each body 0.3 captured maps to its kind. A body that matches no pattern falls back to `auth_failed` with the vendor's text, so if Ahrefs changes a message, that case drops to B's behavior with nothing else changed. Before coining `plan_refused`, check whether conduit's `forbidden` already means it. TPM's message today, *Ahrefs refused the key*, is the wrong advice when the key is fine and the month's units are spent: the owner would remake a working key. If 0.3 finds one undifferentiated message, the plan falls back to B and records that here.
- ~~**Q4 — Whether `verify` keeps its name in `@frontierjs/conduit-ahrefs` beside `@frontierjs/litestone`.**~~ **Answered 2026-11-25 (`FJS-D2385`): A — Keep `verify` in `@frontierjs/conduit-ahrefs` beside `@frontierjs/litestone`. `verify(send)` is the account check that `conduit-github` (`FJS-D2371`), `conduit-cloudflare`, `conduit-digitalocean` and `conduit-hetzner` export. Here it answers the plan, the key's expiry, and units used and left. Litestone's `verify` checks a migration, which is a different job.** The `FJS-D2278` ratchet refuses a name that two packages export until a ruling names it. Asked 2026-11-25, after Phase 2. Ahrefs' `projects` was renamed `listProjects`, to match `findProject`, `addProject` and `removeProject`, so it no longer clashes with `conduit-37signals`.
  - **A** — Keep `verify` in `@frontierjs/conduit-ahrefs` beside `@frontierjs/litestone`. `verify(send)` is the account check that `conduit-github` (`FJS-D2371`), `conduit-cloudflare`, `conduit-digitalocean` and `conduit-hetzner` export. Here it answers the plan, the key's expiry, and units used and left. Litestone's `verify` checks a migration, which is a different job.
  - **B** — Rename it `checkKey` or `limits` in this package.
  - **Recommend A** — the owner's answer: keep a name where it matches the job. One verb across connectors is what lets a caller check any vendor's account the same way.
- ~~**Q5 — Whether `conduit-ahrefs` is admitted to releases (`FJS-D2365`'s path), and when it is first released.**~~ **Answered 2026-11-25 (`FJS-D2386`): B — Admit it now by adding `conduit-ahrefs` to `ADMITTED` in `packages/cli/core/workspace-members.js`, and hold the first 0.1.0 release until the owner runs or approves it.** Asked 2026-11-25 at step 3.1.
  - **A** — Admit it and release 0.1.0 now.
  - **B** — Admit it now by adding `conduit-ahrefs` to `ADMITTED` in `packages/cli/core/workspace-members.js`, and hold the first 0.1.0 release until the owner runs or approves it.
  - **C** — Keep it held out, so Phase 4 waits.
  - **Recommend B** — the owner's answer. Admission is what Q1's TPM move needs (TPM installs only published tarballs). A release is outward-facing, so its timing is the owner's.

---

## Phases

### Phase 0 — Groundwork

Goal: the facts the connector branches on are measured, and Q1–Q3 are ruled.
Done when: each question carries its ruling, and 0.2–0.4 record what they measured under their steps.

- [x] 0.1 Rule Q1–Q3 through the question tool, after `decision-rules` grades the recommendations. All three went as recommended (see each question).
- [x] 0.2 Owner: create an Ahrefs API key with a monthly unit cap (a few thousand units is enough), and say which plan the Kobami workspace is on. Put the key in the scratch env for the probes only, never in a committed file.
  - Given 2026-11-25. The plan is Lite (`"subscription": "Lite, billed monthly"`), with 200,000 units a month for the workspace and a reset date of 2026-12-25.
  - The key has **no unit cap** (`units_limit_api_key: null`) and **expires 2026-12-19**. TPM's production key needs a later expiry date, and a cap.
- [x] 0.3 Probe with that key, using free calls only. Record the status, headers and body of each answer:
  - limits-and-usage
  - `domain-rating` on `ahrefs.com`, for the cost headers on a free call
  - the same call with a wrong key, for the 401 body
  - `domain-rating` on a target that costs units with `select` set to one field, which costs 50 units (about $0.03 on Lite). On Starter this captures the 403 or other refusal Q3 depends on; on Lite and up it captures a billed call's headers. The owner approves the spend before it runs.
  - Measured 2026-11-25, free calls only. Every free answer carries all five `x-api-*` headers.
    - A free test target **reports what the call would have cost and what it actually cost**: `x-api-units-cost-total: 50`, `x-api-units-cost-total-actual: 0`, `x-api-units-cost-row: 2`, `x-api-rows: 1`, `x-api-cache: no_cache`.
    - So `costOf` returns both numbers, and a fixture row can check a call's estimated cost without spending units.
  - **The 401 and 403 bodies are not the spec's `{ "error": string }`.** They are JSON arrays.
    - A wrong key answers 401 `["Error","Unauthorized"]`.
    - **No `Authorization` header answers 403 `["Error","Forbidden"]`.** So a 403 is not always the plan or units, and `translate` reads both shapes.
    - A 400 does follow the spec: `{ "error": "missing argument 'date'" }`. `date` is required on `domain-rating`.
  - `GET /management/projects` answers all 81 of the workspace's projects in one page (`x-api-rows: 81`). Each row has `project_id` (a string), `url` with a trailing slash (`kobami.com/`), `mode`, `protocol`, `access`, `verified`, `owned_by` and `keyword_count`. The existing projects use `mode: subdomains`, but TPM creates `domain`.
  - **`GET /site-audit/projects` returns every project's health score and takes no project id.** Each row has `project_id`, `target_url`, `date`, `status` (`Completed`), `health_score` and the error, warning and notice counts. A project never audited has `null` in every field. So `siteAudit(send, projectId)` reads the whole list and picks one row, which is free.
  - **Paid probe, run 2026-11-25 with the owner's approval.** The owner capped the key at 50 units. Two `domain-rating` calls on different targets, so the second could not be served from cache:
    - `kobami.com` answered 200, with `x-api-units-cost-total-actual: 50`.
    - `texmexcleaning.com` answered **403 `{ "error": "API units limit reached. The limit of this API key should be increased. Expected usage: 50, API units left: 0." }`**.
    - Afterward, limits-and-usage read `units_usage_api_key: 50`. The refused call spent nothing: Ahrefs checks the estimate before it charges.
  - **So Q3 is A: the cases are distinct.**
    - 401 `["Error","Unauthorized"]` is a bad key.
    - 403 `["Error","Forbidden"]` is no key.
    - 403 `{ error: "API units limit reached…" }` means the allowance is spent.
  - The plan refusal (a Starter key) cannot be captured on Lite. Neither can the workspace's own limit being reached, as opposed to a key's cap. Whether the workspace one shares the *units limit reached* wording is unknown.
  - Kinds keep words that already exist, so none is coined:
    - `quota` for a spent allowance, conduit-resend's and conduit-quo's word.
    - `forbidden` for a plan refusal, conduit-s3's word. It is matched only once seen.
    - Any other 403 is `auth_failed`, carrying Ahrefs' text.
- [x] 0.4 Send 61 requests within a minute to limits-and-usage (free) to capture a real 429. Record whether it has `Retry-After` and what the body says.
  - Measured 2026-11-25: **no 429 could be produced on free calls.** 65 serial calls to limits-and-usage and 80 concurrent free-target `domain-rating` calls (all within 2 s) all answered 200, at 0 units actual.
  - The documented 60-a-minute limit is not enforced on free calls. A real 429 would need paid calls, at 50 units each, so it is not captured.
  - So the sink's 429 arm has no `Retry-After`. `translate` waits 60 s by default, and uses `Retry-After` when Ahrefs sends one.
- [x] 0.5 Read TPM's tests (`actions.test.ts`, `checklist.test.ts`, `preload.ts`) for how they stand in for Ahrefs today, and record which of them the adapter must keep passing.
  - Read 2026-11-25. Only `actions.test.ts` § Ahrefs touches the vendor, in five rows:
    - add a new domain: the POST body `{ project_name, url, mode: 'domain', protocol: 'both', access: 'shared' }`
    - keep an existing domain, matching on `www` and the protocol
    - remove by `project_ids`, where a missing domain answers `null`
    - a 403 says *Ahrefs refused the key*
    - `runAction`'s two messages
  - They stand in for Ahrefs with an injected `fetchImpl` (`Deps.fetchImpl` in `actions.ts`), so 4.2 swaps that for a `send` or the package's sink. The message strings and the POST body must stay as they are.
  - The *refused the key* row changes meaning: after 0.3, a 403 means no `Authorization` header was sent, and TPM's message for a bad key belongs on the 401.
  - `checklist.test.ts`, `stages.test.ts` and `templates.test.ts` cover only the `dep-ahrefs` step's template row. `preload.ts` clears `AHREFS_API_KEY`. None of them calls Ahrefs.

**Done 2026-11-25.** Every fact the connector depends on was measured with one key on Lite, for 50 units in all.
- The 403 cases differ by their body, so Q3 is A.
- Ahrefs' error bodies come in two shapes, not the spec's one.
- No 429 can be produced on free calls.
- The Site Audit health score is one free list covering every project.
- TPM's tests stand in for Ahrefs with an injected `fetchImpl`.

### Phase 1 — The package and its errors

Goal: `packages/conduits/conduit-ahrefs/` exists, with a target builder and the one reader of `error.raw`.
Done when: `bun run drive` passes the error rows against the sink, including the negative control, and `fli ws:atlas` draws the package in its ring.

- [x] 1.1 Copy `conduit-plausible`'s layout: `src/index.ts`, `src/errors.ts`, `src/types.ts`, `sink.ts`, `test/ahrefs.drive.ts`, and scripts `test`, `drive` and `typecheck`. Add a row to the Packages table in the root `CLAUDE.md`, then run `fli ws:atlas`, `ws:exports`, `ws:deps` and `ws:surface`.
  - Built 2026-11-25. `fli ws:atlas`, `ws:deps` and `ws:surface` take the package. **`fli ws:exports` refuses two new duplicate names, `projects` (with conduit-37signals) and `verify` (with litestone and the other connectors): rename one or cite a DECISIONS ruling. Left as the plan names them; the owner's call.** `test` keeps the sibling form (`tmp-run.mjs 'bun run drive'`).
- [x] 1.2 Write `ahrefsTarget({ ref?, address?, id? })` and `bindSend`. The target is a `bearer` target with `Accept: application/json`.
- [x] 1.3 Write `translate(error, meta)` (C3). It answers:
  - `auth_failed` for a 401
  - for a 403, `quota` when the `error` text says *units limit reached*, else `auth_failed` with Ahrefs' text. The body arrives in two shapes, an array and `{ error }`, and both are read.
  - `rate_limited` for a 429, with `retryAfterMs` from `Retry-After`, else 60 s
  - `refused` with Ahrefs' `error` text for a 400
  - conduit's own kinds otherwise
  - `translate(error, { status, headers }, { quota? })`: the third argument is the negative control's seam. A 400 is `refused`, the word 19 sibling connectors use; the plan first said `bad_request`, a coinage.

  The drive has one row for each body 0.3 captured. Its negative control drops the *units limit* match, and the `quota` row then reads `auth_failed`.
- [x] 1.4 Write `costOf(meta)`, which reads the `x-api-*` headers into `{ rows, perRow, total, actual, cache }`. Every call's answer carries it.
  - The refusal carries the cost too (`failure.cost`), and a header Ahrefs did not send is `null`, not 0. A call of several requests reports the last one's cost.
- [x] 1.5 Write the sink (C10): projects state for each instance, the cost headers, and fault arms for `lost`, a 429, a 403 for each case 0.3 recorded, and a 401.
  - The sink's 429 has no `Retry-After` by default (none was captured); `{ rateLimit: n, retryAfter? }` arms it. A wrong key is a second target on the same sink.

### Phase 2 — The calls

Goal: every call TPM makes goes through `send` (C2), and so does the read for TPM's *Final review* step.
Done when: the drive covers each call, a lost add is settled by its C6 read, and the fixture rows pass against the real API on free targets.

- [x] 2.1 Write `verify(send)` over limits-and-usage. It answers the plan, the key's expiry, and units used and left.
  - Answers `{ plan, expiresAt, resetsAt, key, workspace }`, each balance `{ limit, used, left }`. A bad key throws `auth_failed` rather than answering false.
- [x] 2.2 Write `projects(send)` and `findProject(send, domain)`, matching on the bare host.
- [x] 2.3 Write `addProject(send, { domain, name, access?, mode? })`. It finds the project first and creates it only when none exists, without a key. The drive proves that an add whose answer was lost is found by the list.
- [x] 2.4 Write `removeProject(send, domain)`. A domain with no project is `null`, not a failure.
- [x] 2.5 Write `siteAudit(send, projectId)` over `/site-audit/projects`. It answers the health score and the date of the last crawl, and `null` when the project has no audit yet.
  - The list's envelope is `healthscores`, not `projects`. A row for a never-audited project has `date`, `status` and every count `null`.
- [x] 2.6 Add fixture rows (C11) that run the free calls against the real API: limits-and-usage, `domain-rating` on `ahrefs.com` through the raw `send`, and checks on the cost headers. A project add and delete on the real API is not in the fixture, because it would change the owner's workspace.
  - Six fixture rows, run 2026-11-25 against api.ahrefs.com. The real list answers 81 projects slower than the sink's 800 ms patience, so the fixture has its own conduit at 20 s. The POST and DELETE answers are read from the spec and the sink; they were never sent.

### Phase 3 — Admission and release

Goal: TPM can install the connector (required by Q1 A).
Done when: `@frontierjs/conduit-ahrefs@0.1.0` is on packages.frontierjs.com.

- [ ] 3.1 Ask whether `conduit-ahrefs` joins `ADMITTED` (`FJS-D2365`'s path). Record the ruling.
- [ ] 3.2 Release it at 0.1.0 with `fli ws:pub`. Ask the owner first: a release is outward-facing.

### Phase 4 — TPM onto the connector

Goal: TPM has no Ahrefs dialect of its own, only an adapter (Q1 A).
Done when: TPM's `bun run check` passes, and the *Add to Ahrefs* and *Remove from Ahrefs* actions are driven in a browser against the package's sink.

- [ ] 4.1 Add `@frontierjs/conduit` and `@frontierjs/conduit-ahrefs` to TPM, with tarball URLs and overrides like its other packages. Declare the Ahrefs target, and have its credential read `AHREFS_API_KEY`.
- [ ] 4.2 Turn `ahrefs.ts` into an adapter. It keeps TPM's sentences, `ahrefsReady`, and the return values `actions.ts` and `integrations.service.ts` read. A `quota` refusal gets its own sentence: the key's monthly units are spent, so raise its limit in Ahrefs. TPM's *refused the key* sentence moves to the 401.
- [ ] 4.3 Show the Site Audit health score on the *Final review* step: what `siteAudit` returns, with a link to the audit.
- [ ] 4.4 Drive both actions and the health score through TPM's UI against the package's sink, using `drive-browser`.
- [ ] 4.5 Owner: push to TPM's main, which deploys to tpm.awe.dev. Then run *Add to Ahrefs* once on a real client, or on a scratch domain the owner deletes afterward.

---

## Not planned

- **Paid Site Explorer, Keywords Explorer and SERP reads**, unless Q2 is ruled B or C. Their first caller would be the monthly SEO report.
- **TPM's Plausible calls moving onto `conduit-plausible`.** It comes up at 4.1, because TPM will have conduit installed by then. It is its own change, filed as an issue when 4.1 lands.
- **Brand Radar, Web Analytics, GSC Insights, Social Media and Rank Tracker writes.** No caller uses them.
- **Outbound pacing.** The 60-a-minute limit stays the caller's, as in `conduit-dataforseo`. TPM makes a handful of calls a day.
- **Caching paid lookups.** That stays the app's (C12).

## See also

- `IDEAS/conduit-github.md`, the same extraction done for Basecamp.
- `IDEAS/conduit-connectors.md`, the test a connector must meet.
- `packages/conduits/conduit-dataforseo/README.md`, the other paid SEO source, and what overlaps with it.
