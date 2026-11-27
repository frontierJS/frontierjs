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
- ~~**Q7 — How conduit-telnyx carries ela's and sstime's per-account key (P1, step 3.1).**~~ **Answered 2026-11-26 (`FJS-D2412`): A — `telnyxTarget({ perCaller: true })`, declared once; the app's resolver answers `getFor(ref, who)` off the account's Integration row. ela's lazily registered `telnyx:<account>` targets and `telnyx-key:` refs go.**
  - **A** — `telnyxTarget({ perCaller: true })`, declared once; the app's resolver answers `getFor(ref, who)` off the account's Integration row. ela's lazily registered `telnyx:<account>` targets and `telnyx-key:` refs go.
  - **B** — fold ela's scheme as-is: `accountTelnyxTarget`, `ensureTelnyxTarget` and a `telnyxKeys` ref router.
  - **Recommend A** — `per_caller` is conduit's one owner of whose credential a send spends (`FJS-D848`), every sibling conduit spells it `perCaller` (D2409 did the same for serpgrid), and a 401 is no breaker fault, so one account's bad key cannot stop another's texts.
- ~~**Q8 — Whether Shell mounts Toaster and ConfirmProvider unasked (P3, step 4.1).**~~ **Answered 2026-11-27 (`FJS-D2413`): A — opt-in props: `toasts` (true or a position) and `confirm`; the scaffold passes both.**
  - **A** — opt-in props: `toasts` (true or a position) and `confirm`; the scaffold passes both.
  - **B** — on by default, `toasts={false}` / `confirm={false}` to opt out.
  - **Recommend A** — chronicle, ela, sstime and example each mount their own, and a second Toaster draws every toast twice with nothing saying so; `collapsible` and `foldable` are the opt-in precedent. Revisit B once every Shell app is converted.
- ~~**Q9 — The theme switch in Shell (P3, step 4.1).**~~ **Answered 2026-11-27 (`FJS-D2414`): A — Shell draws the ☀/☾ button from `theme` (the current value) and `ontheme(next)`, and `next` is `THEMES[theme].pair`, else a flip by `scheme`.**
  - **A** — Shell draws the ☀/☾ button from `theme` (the current value) and `ontheme(next)`, and `next` is `THEMES[theme].pair`, else a flip by `scheme`.
  - **B** — the same button, calling the app's own `toggleTheme`, which cycles every configured theme.
  - **C** — no built-in switch; it stays in each app's `topbar` snippet.
  - **Recommend A** — the button is what nearly every app hand-writes, `topbar` already is the slot so a `tools` snippet would be a second name for it, and a cycle of eleven has no "other one"; an app that wants the cycle keeps its own button in `topbar`.
- ~~**Q10 — How a sidebar Shell drops an empty topbar (P3, step 4.4).**~~ **Answered 2026-11-27 (`FJS-D2415`): A — derived: Shell draws the bar with only the drawer toggle when it has no title, section, `topbar`, theme switch or railed Sign out, and one frame.css rule beside `.sidebar-toggle` hides such a bar at md and up.** serpgrid's rail frame has no bar at md and up, and with no drawer toggle it draws no nav at all below md.
  - **A** — derived: Shell draws the bar with only the drawer toggle when it has no title, section, `topbar`, theme switch or railed Sign out, and one frame.css rule beside `.sidebar-toggle` hides such a bar at md and up.
  - **B** — an explicit `bar={false}` prop.
  - **C** — the app hides `.topbar` at md and up in its own CSS.
  - **Recommend A** — Shell already holds every input, `bar={false}` restates it and could hide a passed title, and C copies the 768px literal into the app; below md the bar stays and serpgrid gains the drawer it lacks.
- ~~**Q11 — How a nav group hides its heading (P3, step 4.4).**~~ **Answered 2026-11-27 (`FJS-D2416`): A — a NavGroup `hideLabel: true`, drawn as `<ul aria-label>`; ignored with a warning under `foldable`, whose `<summary>` needs a visible label.** serpgrid's rail draws no group headings; the label is only the list's accessible name.
  - **A** — a NavGroup `hideLabel: true`, drawn as `<ul aria-label>`; ignored with a warning under `foldable`, whose `<summary>` needs a visible label.
  - **B** — the app hides `.navlist-label` in its own CSS.
  - **Recommend A** — Table's column `hideLabel` is the same word for the same thing, `label` stays the one field the palette and the list's name read, and B reaches into a kit class.
- ~~**Q12 — Where a sidebar's search trigger goes (P3, step 4.4).**~~ **Answered 2026-11-27 (`FJS-D2417`): A — a `head(where)` snippet mirroring `foot(where)`, drawn after the brand and fold line and before the groups, in the sidebar, rail and drawer; not in the topbar layout, where `topbar` is that slot.** serpgrid draws one under the brand line; fiddle wanted the same slot in 4.2.
  - **A** — a `head(where)` snippet mirroring `foot(where)`, drawn after the brand and fold line and before the groups, in the sidebar, rail and drawer; not in the topbar layout, where `topbar` is that slot.
  - **B** — Shell draws a Search button whenever `palette` is set.
  - **C** — the app puts it inside `brand`.
  - **Recommend A** — no new concept, the app keeps its own trigger; B adds a button to every existing Shell with `palette` and needs an open hook for serpgrid's preloaded rows, and C sets the fold control beside a two-row block.

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
- [x] 2.3 **P4** — `createCaptureMailer` and `createLogMailer` in `@frontierjs/junction/mail`; calendly and grouppi use them, and `catalog/UPGRADE-RECIPE.md`'s pointer to `createCaptureMailer` becomes true. calendly's drive reads `sent`.
  - Done 2026-11-26, uncommitted: `createCaptureMailer({ from?, log? })` (`sent`, `to(address)`, `clear()`) and `createLogMailer({ from?, write? })` in `@frontierjs/junction/mail`, both graded like SMTP (11 tests). calendly's `core/mailer.ts` is 3 lines; grouppi's is deleted; UPGRADE-RECIPE item 19 is true. calendly has no drive script; its tests read `mailer.to()`. calendly 1/116 and grouppi 0/140 as baseline. grouppi's `bun run verify` fails at its first step on a clean HEAD copy too — filed, not this plan's.
- [x] 2.4 **P2** — Q2's helper, taking the client as a thunk (grouppi's lazy import is why: a test must not open the real db). The scaffold writes the three-line file; the 20 copies shrink to it.
  - Done 2026-11-26, uncommitted: `retentionJob({ cron, client })` in caravan (`cron` required, `client` a thunk, structural `RetentionClient`; 6 tests, README); `fli new` writes the three-line file; 18 apps converted, each build, typecheck and test identical before and after (statuspage's typecheck red at baseline: `IncidentUpdate` collision). UPGRADE-RECIPE item 6 points at it. **ela and portal wait**: they pin caravan tarballs (0.1.11, 0.1.8), so they convert after a caravan release.
- [x] 2.5 **S1** — a scaffold option writing the serpgrid/chatwoot `FileStorage` wiring in `db.ts`, its path anchored to the file. No migration of the 8 existing apps.
  - Done 2026-11-26, uncommitted: `fli new --with storage`, a wiring beside the package values (not in `--full`): db.ts imports `FileStorage`, exports the file-anchored `storage`, adds the plugin; env.ts `STORAGE_PATH`, `.env.example`, `storage/` ignored. 2 scaffold tests. A probe app booted and a `File` create run from cwd `/` landed under the app's `storage/`. A `File` column without it warns at client creation and refuses the first upload.
- [~] 2.6 **S2** — dropped: the audit's own action is to leave membership and token principals per-app, since a preset would guess member and tenant columns and a wrong guess scopes a stranger in.
- [x] 2.7 **T6, rest** — conduit-dataforseo carries `indeterminate` on `DataforseoFailure` (the vendor may have billed the batch) and keeps the raw task on `TaskAnswer`; serpgrid then drops its own `getTask` and flag capture. serpgrid's ambient tenant resolver becomes `perCaller` + `getFor` (the conduit README's way, `FJS-D2409`), and `engine.test.ts`'s pins move with it.
  - Done 2026-11-26, uncommitted: `DataforseoFailure.indeterminate` (from conduit's own lost-POST flag) and `TaskAnswer.raw` (14 drive rows). serpgrid's `getTask` is a thin adapter over the conduit's; its target is `perCaller` and `getFor(ref, who)` reads `who.tenant` (`FJS-D2409`); the composite resolver in `app.ts` forwards `getFor`/`invalidateFor`. `engine.test.ts`: cache and 4-agency concurrency tests replace the ambient pin; 263/0. `pace()` still keys on `tenantInScope()`: it is a pace slot, not a credential.
- [x] 2.8 **T7** (`FJS-D2408`) — quo onto conduit-quo: depend on it, move `doors.ts` (webhook path, `verifyQuoLegacySignature`, `verifyQuoSignature`) and `inbox.ts` (`quoOwner`, `applyQuoEvent`, `applyQuoCall`, reading `payload.message`/`payload.call`) onto its dialect, then delete `providers/quo/` and `quo.test.ts`. `QUO_WEBHOOK_PATH` moves into `doors.ts`; the conduit does not export it (`FJS-D2410`).
  - Done 2026-11-26, uncommitted: quo links conduit-quo; `doors.ts` picks `quoDialect`/`quoLegacyDialect` by the subscription's scheme and owns `QUO_WEBHOOK_PATH` (`FJS-D2410`); `inbox.ts` reads the conduit's event rows. `providers/quo/` and `quo.test.ts` deleted; `quo-door.test.ts` (20, over the conduit's sink) and a `verify.legacy` drive row (116) carry what it proved. quo 146/0. A test-sample delivery is now ignored, not recorded. Sender-side key rotation mid-flight is proven at the verifier only.

**Done 2026-11-26.** Each conduit or package gained the one thing an app copy had, and the copies went: thod, transit, calendly, grouppi, quo and 18 retention apps import the shared code (2.1–2.3's framework half landed in 5268f4258; the rest is uncommitted). Rulings `FJS-D2409`–`FJS-D2411`. **Owed**: ela and portal's `retention.job.ts` after a caravan release (tarball pins). grouppi's drive is red at HEAD too (`FJS-4656`), and quo's partial-row call read is filed.

### Phase 3 — Telnyx voice into conduit-telnyx (P1)

Goal: quo and serpgrid run call control, WebRTC credentials and the media stream from conduit-telnyx; ela and sstime take their per-account SMS client from it.
Done when: conduit-telnyx's tests cover the new modules, quo and serpgrid build and pass, and one live call on each is the owner's check.

- [x] 3.1 Add carrier code `10039` to the invalid-destination set; `telnyxTarget` takes `perCaller` and a `resilience` the app passes (no default: call control shares the target and its `command_id` replays need retries; a text is already never replayed once it may have left) (Q7). A test sends for two tenants and asserts each carries its own key.
- [x] 3.2 Promote serpgrid's `index.ts`, `stream.ts`, `sink.ts` as call, credentials and stream modules (Q1). `calls.ts` stays in each app.
- [x] 3.3 serpgrid onto it (8 import sites). The conduit's verify is async and takes headers, so every call site changes.
- [x] 3.4 quo onto it (8 import sites).
- [x] 3.5 ela and sstime onto the per-account SMS client.

**Built 2026-11-26; the owner's live call on quo and serpgrid is open.** conduit-telnyx drive 28 rows; serpgrid 263/0, quo 146/0, grouppi 140/0, sstime 19/8 (the same 8 files fail to load, `hours.xlsx.ts`), ela build + typecheck at its 22. Each app's `providers/telnyx/` is one `index.ts` of 79–85 lines (was 1,100+). `credentialToken` still bypasses conduit (an untyped JWT); a drive row flips when conduit can take it. `sendMessage` gained `messagingProfileId` for serpgrid. quo now sends a typed number normalized (`(555) 123-4567` → `+15551234567`) where it sent it raw, so two `consent.test.ts` pins moved. `sendText` in ela and sstime opens the account's tenant scope itself; junction's conduit plugin refuses an explicit `who`. sstime gained a copy of ela's `account-key.ts` (30 lines), a twin that goes when sstime merges into ela. ela's own tests are unrun (live data): `text-gate`, `outbound`, `surveys-*`, `document-send`, `survey-token`, `messages-page`, `automation-listeners`.

### Phase 4 — Shell grows what apps add by hand (P3)

Goal: `@frontierjs/ui` `Shell.mesa` mounts the palette, a theme/tools slot and optional Toaster/Confirm, and the 6 hand-built shells use it.
Done when: each converted app's drive passes and a screenshot of each matches its pre-conversion screen.

- [x] 4.1 Shell gains a palette hook, a tools snippet and optional Toaster/ConfirmProvider mounts; the scaffold stops hand-writing them.
  - Built 2026-11-26, uncommitted. Shell takes `palette(close)` (it owns ⌘K/Ctrl+K, bound only with the snippet and only while framed), `theme` + `ontheme` (the pair switch, `FJS-D2414`; no `tools` snippet, as `topbar` is that slot) and opt-in `toasts` / `confirm` (`FJS-D2413`). Toaster warns on a second live mount. The scaffold's route module passes `theme={theme.value} ontheme={setTheme} toasts confirm`. Proof: `shell-extras.spec.mjs` 43 rows, ui `bun run test` 2695 passing, cli `generated-mesa.test.js` now compiles and parses the three route-module templates (64 pass).
- [x] 4.2 Convert remnant, notion and fiddle.
  - Built 2026-11-27, uncommitted, in `../fjs-prototypes`. Before and after screenshots match except where Shell's frame differs: Sign out moves to the sidebar foot, the ☾ switch sits ahead of the topbar snippet, and notion's workspace picker moves to the bar's right.
    - **remnant**: `_module.mesa` 145→117 lines, topbar layout, the reader's focus mode hides `.topbar` from the app's own CSS. Build, typecheck and test 136/3 skip/0 are the same as before.
    - **notion**: 135→121 lines, sidebar layout, the page tree in `foot`. `nav.js` entries are members-only, since without `show` the sign-in page drew the sidebar. Its suite reads 8 pass/5 fail/1 error before and after; the API does not boot in that repo (a shadowed `links` service).
    - **fiddle**: 113→101 lines, plus `Palette.mesa` 87→71. Its gate contract finds nav links by `data-gate="nav"`, and the gate files are locked by `measure/gates.lock`, so a nav entry now takes `attrs` and Shell puts them on the link, minus `href`, `class`, `prefetch` and `aria-current`. The owner picked this over editing the gate (2026-11-27). There is a `shell.spec.mjs` row for it. The frame draws the nav twice (sidebar and drawer), so `verify-screens.js` dedupes hrefs. Proof: verify:screens 60/0, palette 93/0, pages 245/0 (was 199/1), player 15/0, review 26/0, gate 5 `--small` 47/0. `verify` fails on "the API badge to settle" before and after.
  - Gaps the conversions found, none built: Shell cannot hide its own topbar; a nav `show` sees only `{user, level}` (notion's Trash follows the workspace, so the layout rebuilds `groups`); there is no slot for a palette trigger and no second palette key (fiddle's "/" stays in its layout).
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
