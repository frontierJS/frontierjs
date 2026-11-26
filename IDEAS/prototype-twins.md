---
id: prototype-twins
status: partial
dated: 2026-11-26
---

# Prototype twins — delete the app copies, promote the shared ones

**Status: PARTIAL.** The 2026-11-26 audit of `../fjs-prototypes/` found that copy-paste is small (72 jscpd clones, about 2% of app code) and that most duplication is an app rebuilding something the framework ships, or two apps building the same thing. The owner picked Do on all fourteen findings. Finding ids (T1–T7, P1–P5, S1–S2) are the audit page's; the page and its inputs are saved at `../fjs-prototypes/catalog/twins/` (`twins.html`, `drift.mjs`, `jscpd-report.json`).

**How to run it.** One phase per session; inside a phase, 2–4 Sonnet agents, one per repo. A framework change runs on the main tree with its app migrations in the same change, because the prototypes `link:` this tree ([[fjs-prototypes-link-this-tree]]). Before and after each step, per touched repo: `bun build api/src/app.ts --target=bun --outdir <scratch>`, `bun run typecheck`, `bun run test` (tests skipped in ela, thod, capture: live data).

**Pins.** `ela` and `portal` install published tarballs for most `@frontierjs/*` packages. ela already `link:`s its conduits, so T3 and P5 add conduit-anthropic and conduit-microsoft the same way. portal pins `@frontierjs/ui@0.1.9`, so its P3 conversion waits on a ui release.

## Open questions

- ~~**Q1 — Where Telnyx voice lives (P1).**~~ **Answered 2026-11-26 (`FJS-D2406`): A — grow `conduit-telnyx` into call control, credentials and media stream beside SMS.**
  - **A** — grow `conduit-telnyx` into call control, credentials and media stream beside SMS.
  - **B** — a separate `conduit-telnyx-voice`.
  - **Recommend A** — one client, one `translate`, one invalid-destination set; the carrier codes the apps learned apply to both halves.
- ~~**Q2 — The home of the retention job helper (P2).**~~ **Answered 2026-11-26 (`FJS-D2407`): A — `@frontierjs/caravan`, a `retentionJob({ cron, client })` beside `defineJob`.**
  - **A** — `@frontierjs/caravan`, a `retentionJob({ cron, client })` beside `defineJob`.
  - **B** — `@frontierjs/junction`, handing back a plain job object.
  - **Recommend A** — caravan owns `defineJob` and sits above junction; the helper needs only a client with `$retain`, so it adds no dependency, and the scaffold's reason (the clock belongs to the queue) stays true.
- ~~**Q3 — quo's dead Quo provider (T7).**~~ **Answered 2026-11-26 (`FJS-D2408`): A — delete `quo/api/src/providers/quo/` and its test; repoint the two domain importers at `conduit-quo`.**
  - **A** — delete `quo/api/src/providers/quo/` and its test; repoint the two domain importers at `conduit-quo`.
  - **B** — keep it.
  - **Recommend A** — its own header says "NOT THE PRODUCT'S DIRECTION … Do not extend it", and conduit-quo holds the half worth keeping.
- ~~**Q4 — serpgrid's per-agency DataForSEO login (T6, step 2.7).**~~ **Answered 2026-11-26 (`FJS-D2409`): A — convert to the conduit's `perCaller: true` and a `getFor(ref, who)` resolver; `engine.test.ts`'s pins move with it.** serpgrid's resolver reads the tenant ambiently (`tenantInScope()`), the pre-conduit contract `engine.test.ts` pins.
  - **A** — convert to the conduit's `perCaller: true` and a `getFor(ref, who)` resolver; `engine.test.ts`'s pins move with it.
  - **B** — keep the ambient resolver.
  - **Recommend A** — it is the conduit README's way, a per-caller answer cannot be cached across agencies the way a by-ref one can, and Phase 3's serpgrid Telnyx takes the same answer.
- ~~**Q5 — Does conduit-quo export `QUO_WEBHOOK_PATH` (T7, step 2.8)?**~~ **Answered 2026-11-26 (`FJS-D2410`): A — no; quo's `domain/doors.ts` owns the constant.**
  - **A** — no; quo's `domain/doors.ts` owns the constant.
  - **B** — conduit-quo exports it as a default path.
  - **Recommend A** — no conduit exports a webhook path; where the door lives is the app's choice.
- ~~**Q6 — Where the full address check runs once transit's mailer goes (T4, step 2.2).**~~ **Answered 2026-11-26 (`FJS-D2411`): A — junction's `mail()` plugin runs `assertMessageAddresses` and `assertContentId` on every `send`/`batch` in the wrapper it already installs, so every mailer is checked at one owner; conduit-resend keeps its CRLF check for direct `sendEmail` calls.** conduit-resend checks CRLF only and imports nothing from junction on purpose; no conduit imports junction.
  - **A** — junction's `mail()` plugin runs `assertMessageAddresses` and `assertContentId` on every `send`/`batch` in the wrapper it already installs, so every mailer is checked at one owner; conduit-resend keeps its CRLF check for direct `sendEmail` calls.
  - **B** — conduit-resend takes junction as a peer dependency and calls the check itself.
  - **C** — conduit-resend carries its own copy of the rules.
  - **Recommend A** — one owner (invariant 4), every adapter covered, and no first conduit→junction edge.

## Plan

### Phase 0 — Groundwork

Goal: the rulings are recorded, the guard against new twins is in place, and every repo the plan touches has a baseline.
Done when: Q1–Q3 carry `FJS-D` ids, `../fjs-prototypes/CLAUDE.md` exists, and the baseline table below is filled.

- [x] 0.1 Rule Q1–Q3 with `fli decide`.
- [x] 0.2 Write `../fjs-prototypes/CLAUDE.md` (loads for every session under it): before writing a provider, mailer, sink or job inside an app, check `frontierjs/packages/conduits/`, the framework package for the job, and `catalog/CATALOG.json`; extend the shared one rather than copy it. Add the same line to the scaffold's app `CLAUDE.md` template.
- [x] 0.3 Baseline the touched repos (build, typecheck, test) so a later failure is attributable: thod, ela, transit, serpgrid, quo, sstime, linear, notion, calendly, grouppi, remnant, portal, fiddle, plus the 28 T1 apps and 20 P2 apps.
  - All 42 repos with an `api/src/app.ts`, 2026-11-26, before any change. Already red: build — charter. Typecheck — ela (22 TS errors), statuspage, swatchbook (6). Tests (fail/pass) — calendly 1/116, charter 4/263, connectteam 11/63, jazzhr 1/28, lago 6/220, notion 5/8, page-performer (no summary), saas-starter 4/2, sstime 8/16, transit 12/240. Every other repo green; tests not run in capture, chat, ela, maidtech, thod.

**Done 2026-11-26.** Rulings `FJS-D2406`–`FJS-D2408`; the guard is in `../fjs-prototypes/CLAUDE.md` and the scaffold's AGENTS.md (`packages/cli/core/app-config.js`).

### Phase 1 — Delete app copies of shipped code (Wave 1, app-only)

Goal: no app carries a copy of `dt`, `rank`, the Anthropic target or the DataForSEO client, and quo's dead provider is gone.
Done when: `rg -l "now: Date.now" ../fjs-prototypes/*/web/src/lib/datetime.js` is empty, no app has `rank.js`, and each touched repo matches its 0.3 baseline.

- [x] 1.1 **T1** — delete the 28 identical `datetime.js` and import `dt`/`at`/`ago` from `@frontierjs/mesa/browser`. Scripted: assert each file is byte-identical to the reference before deleting.
  - All 28 matched; mesa's copy differs only in the clock. 28 files deleted, 0–11 importers each rewritten; every checked repo matches its 0.3 baseline. portal's web build fails its offline-shell budget (285 kB over 283 kB) with this change reverted too, so the growth is portal's own uncommitted schema work, not T1.
- [x] 1.2 **T1** — shrink the 4 variants (ela, calendly, vellum, quo) to their day and zone extras over mesa's `dt`. ela pins mesa 0.1.14, so confirm that tarball exports `dt` first.
  - 0.1.14 (and portal's 0.1.9) export `dt`/`at`/`ago`. Extras kept: ela `zoneOf`/`todayIn`/`dayOf`/`dayFilter`/`dayLabel`; calendly `localZone`/`zones`/`zoneLabel`; vellum `day`/`month`; quo `stamp`/`clock`/`dayName`/`dayBreak`/`sameDay`/`isToday`. Typecheck and tests at baseline.
- [x] 1.3 **T5** — delete `rank.js` in linear and notion; import `@frontierjs/toolbelt/rank`. Check both apps' seed ranks against toolbelt's even-width `spread`.
  - notion done, uncommitted: `rank.js` deleted, 5 importers repointed, 12 `?? ''` lower bounds became `?? null` (toolbelt rejects `''`); 24,763 stored ranks valid; checks match baseline. linear: its schema default `a0` and 3 stored rows fail toolbelt's validator (a key may not end in 0); owner ruled a new default plus re-rank.
  - linear done, uncommitted: default `V` (`between(null, null)`) in `schema.lite` and migration `20261126195042_rank_default_valid_key.sql`, applied to the dev db; OPS-1..3 re-ranked `F`/`U`/`j`; 7 importers repointed; 49/49 ranks valid; build, typecheck, 53 tests and web build green. The migration also carries an `oauth_flow` catch-up (`grant`, `initiator`) the schema had without a migration; that drift is why `verify-order.mjs` could not set up its db before. With it fixed, the drive fails at its first drag on a 500 (`where clause: field "userId" was given undefined`) on old ranks too, so it is linear's own defect, not T5's.
- [~] 1.4 **T7** — moved to 2.8: conduit-quo's receiver is shaped differently (other names, `now` in seconds, envelope results, events as `{ id, type, payload }`) and quo's inbox handlers read the old shape, so the delete is a rewrite (owner, 2026-11-26).
- [x] 1.5 **T3** — ela's Anthropic provider onto `conduit-anthropic` (`link:`, as ela's other conduits). ela keeps prompt, redaction and parsing. Drive against a copy of the dev db, which is prod data.
  - Uncommitted in ela: `providers/anthropic/index.ts` (−32/+16), `package.json`, `bun.lock`. A stand-in server showed the same URL, headers and body as before for ok, 401, 403, 400, 429, 529 and 500. `tasks-ask` and `intake-ask` 29/29 (`createTestEnv` is in-memory); typecheck 22 errors before and after. Two edges move from `unreadable` to `unavailable`: a 2xx that is not a message, and an empty model or prompt.
- [x] 1.6 **T6** — thin serpgrid's `providers/dataforseo/index.ts` (397 lines) to the per-agency credential resolver, pacing, cost estimate and listing mapping; dedupe its sink and recording helper against the conduit's.
  - Uncommitted in serpgrid: `index.ts` 397 → 362, `domain/scan.ts`, `package.json`, `bun.lock`; build, typecheck and 261 tests green. The sink (305 lines; recordings, balances, pacing, dev logins) and `recording.ts` stay: the conduit's 97-line sink has none of it. Small saving, because the conduit drops two things serpgrid needs, so serpgrid keeps its own `getTask` and a flag capture until 2.7. Behavior that moved: a 40100 or 40202 inside a 200 now maps to `auth_failed`/`rate_limited` (a 40100 mid-scan stops the scan); free reads are `replayable`, so `retry_limit: 2` may retry them.

**Done 2026-11-26.** Every app copy of mesa's `dt` and toolbelt's rank is gone, and ela and serpgrid run on their conduits; all of it is uncommitted in the prototype repos. Two findings went bigger than the audit said: serpgrid's saving waits on conduit-dataforseo (2.7), and quo's deletion is a receiver rewrite (2.8). Scripts: `scratchpad/twins/convert.mjs` skipped any `runs/` directory and missed one charter importer the web build caught, so do not reuse it as is.

### Phase 2 — Framework gap, then the app (one at a time on the main tree)

Goal: each conduit or package gains the one thing an app copy had, and the app copy goes.
Done when: thod, transit, calendly, grouppi and the 20 retention apps import the shared code, their 0.3 checks match, and the packages' own tests pass.

- [x] 2.1 **T2** — add `retrievePaymentIntent` to conduit-stripe; swap thod's 346-line `providers/stripe/index.ts` onto it the way grouppi's `core/stripe.ts` does. conduit-stripe is `replayable` without a key where thod sent none, so thod's drive stays green.
  - Done 2026-11-26, uncommitted: `retrievePaymentIntent` (GET, `pi_` id guard, sink route, 2 drive rows → 42); thod's `providers/stripe/index.ts` deleted, constants in `core/stripe.ts`. thod keeps its own `sink.ts` (its `/intents` and `/js/…` stand-ins are not the conduit's). Build, typecheck, `checkout.test.ts` 12/12 as before.
- [x] 2.2 **T4** — conduit-resend runs junction's `assertMessageAddresses` (it checks CRLF only today); delete transit's `core/mailer.ts`.
  - Done 2026-11-26, uncommitted (`FJS-D2411`): junction's `mail()` grades every send and batch (`test/mail-plugin-grades.test.ts`); conduit-resend's mailer returns and sends a `messageId` (14 drive rows); transit's `core/mailer.ts` deleted, mail runs on `resendTarget({ id: 'provider:mail', ref: 'MAIL_API_KEY' })` so env and sinks are unchanged. A failed send's message now starts `Resend:`, not `mail:`. transit 12/240, same names as baseline.
- [ ] 2.3 **P4** — `createCaptureMailer` and `createLogMailer` in `@frontierjs/junction/mail`; calendly and grouppi use them, and `catalog/UPGRADE-RECIPE.md`'s pointer to `createCaptureMailer` becomes true. calendly's drive reads `sent`.
- [ ] 2.4 **P2** — Q2's helper, taking the client as a thunk (grouppi's lazy import is why: a test must not open the real db). The scaffold writes the three-line file; the 20 copies shrink to it.
- [ ] 2.5 **S1** — a scaffold option writing the serpgrid/chatwoot `FileStorage` wiring in `db.ts`, its path anchored to the file. No migration of the 8 existing apps.
- [~] 2.6 **S2** — dropped: the audit's own action is to leave membership and token principals per-app, since a preset would guess member and tenant columns and a wrong guess scopes a stranger in.
- [ ] 2.7 **T6, rest** — conduit-dataforseo carries `indeterminate` on `DataforseoFailure` (the vendor may have billed the batch) and keeps the raw task on `TaskAnswer`; serpgrid then drops its own `getTask` and flag capture. serpgrid's ambient tenant resolver becomes `perCaller` + `getFor` (the conduit README's way, `FJS-D2409`), and `engine.test.ts`'s pins move with it.
- [ ] 2.8 **T7** (`FJS-D2408`) — quo onto conduit-quo: depend on it, move `doors.ts` (webhook path, `verifyQuoLegacySignature`, `verifyQuoSignature`) and `inbox.ts` (`quoOwner`, `applyQuoEvent`, `applyQuoCall`, reading `payload.message`/`payload.call`) onto its dialect, then delete `providers/quo/` and `quo.test.ts`. `QUO_WEBHOOK_PATH` moves into `doors.ts`; the conduit does not export it (`FJS-D2410`).

### Phase 3 — Telnyx voice into conduit-telnyx (P1)

Goal: quo and serpgrid run call control, WebRTC credentials and the media stream from conduit-telnyx; ela and sstime take their per-account SMS client from it.
Done when: conduit-telnyx's tests cover the new modules, quo and serpgrid build and pass, and one live call on each is the owner's check.

- [ ] 3.1 Add carrier code `10039` to the invalid-destination set, and ela's per-account target and key resolver.
- [ ] 3.2 Promote serpgrid's `index.ts`, `stream.ts`, `sink.ts` as call, credentials and stream modules (Q1). `calls.ts` stays in each app.
- [ ] 3.3 serpgrid onto it (8 import sites). The conduit's verify is async and takes headers, so every call site changes.
- [ ] 3.4 quo onto it (8 import sites).
- [ ] 3.5 ela and sstime onto the per-account SMS client.

### Phase 4 — Shell grows what apps add by hand (P3)

Goal: `@frontierjs/ui` `Shell.mesa` mounts the palette, a theme/tools slot and optional Toaster/Confirm, and the 6 hand-built shells use it.
Done when: each converted app's drive passes and a screenshot of each matches its pre-conversion screen.

- [ ] 4.1 Shell gains a palette hook, a tools snippet and optional Toaster/ConfirmProvider mounts; the scaffold stops hand-writing them.
- [ ] 4.2 Convert remnant, notion and fiddle.
- [ ] 4.3 Convert portal (after a ui release; it pins 0.1.9).
- [ ] 4.4 Convert serpgrid and linear (custom rails and switchers).
- [ ] 4.5 Mark `IDEAS/app-shell.md` shipped.

### Phase 5 — ela's Microsoft vendor half onto conduit-microsoft (P5)

Goal: ela's `index.ts`, `graph.ts`, `subscriptions.ts` and the receive half come from conduit-microsoft (`FJS-D1463`); sync, map and writeback stay in ela.
Done when: ela's mail and calendar sync run live against Microsoft on the conduit, which is the owner's check: the conduit has never run against Microsoft and ela's copy has run since July.

- [ ] 5.1 Diff ela's files against the conduit and port anything ela learned live into the conduit first.
- [ ] 5.2 Swap ela onto it (`link:`).
- [ ] 5.3 Owner's live run.

### Phase 6 — Make the audit repeatable

Goal: the next audit is one command, not a session rebuilding scripts.
Done when: a `fli` command reproduces the 2026-11-26 counts from `catalog/twins/`.

- [ ] 6.1 Turn `drift.mjs` and the jscpd run into a `fli` command over `../fjs-prototypes/`, reading the "Not twins" list below as its allow-list.

## Not twins

Same file name, different job. The next audit leaves these alone.

- `payments.service.ts` ×5 — read-only mirrors (ela, paylode), a fake processor (etsy), Connect on conduit-stripe already (grouppi), checkout and ledger (thod).
- `merge.ts` ×5 — photo metadata (vellum), contact merge (chatwoot), ticket merge with undo (ela), search fusion (portal), git merge (anvil).
- serpgrid `web/src/lib/rank.js` — tones and labels a search-rank grid point; not a fractional key.
- `Icon.mesa` ×6 — `FJS-D951` makes the icon set each app's own.
- `domain/calls.ts` in quo and serpgrid — a phone menu with hours vs ring-every-member with voicemail.
- ela `microsoft/mailer.ts` — sends from the user's own mailbox; shrinks after Phase 5, stays app glue.
- serpgrid `providers/google` — delegated OAuth for Business Profile and Search Console; belongs beside conduit-gmail once a second app needs it.
