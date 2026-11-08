---
id: widgets-deploy
status: proposed
dated: 2026-11-07
---

# Idea — widgets/ deploys like web/: a static App per surface, in both doors

**Status: PROPOSED.** Dated 2026-11-07, raised by ELA's widget release (`fjs-prototypes/ela/docs/deploy-chartered.md` Phase 4). The owner ruled the direction: widgets are a surface like web, declared in `frontier.config`, and get the same treatment as api and web. Q1–Q4 are open.

## The problem

`web/` is a deploy surface in both doors and `widgets/` is in neither.

- **SSH door (`fli deploy`).** `deploy.web` is the only static side: `03-build-web`, `08-release-web`, `edgeNames` and `spa()` in `core/edge.js`, plus rollback, revert and setup. Nothing builds, ships or routes `widgets/`. Caddy reads no `_headers`, and a widget origin routed through `spa()` would get the SPA's CSP and no CORS.
- **Basecamp door (`basecamp:deploy`).** The static branch builds `web/` and nothing else (`basecamp/deploy.md`, `join(root, 'web')`). Preflight reports `widgets/` as an info line with no fix. The setup plan makes one static App, `app`.
- **The fronting rule would misfire.** `frontingStatics` (`basecamp/api/src/domain/release/fronting.ts`, `FJS-D1981`) counts every inline sibling with a Domain that is not routed to another App. A widgets App with its own Domain would be released beside the API by `fli deploy` and by the API's git release, and both build `web/` into it.
- **The scaffold ships widgets as a container** (`core/widget-surface.js` writes `widgets/deploy/Dockerfile` and `serve.js`), which is a third uid, volume and health probe for static files.
- **Neither origin reaches the other's bundle.** The web build needs the widget origin for its embed snippet (ELA reads `VITE_WIDGETS_URL`, which is no framework convention). The widget build needs the API origin, because it runs on strangers' pages.

Groundwork already built (uncommitted): `sierra widgets` writes `_headers` and an `index.html` from `postbuild/widget-headers.js`, the one owner of the widget origin's cache and CORS rule. `serveWidgets` imports the same rule. Outpost's static origin applies `_headers`, so a static App serves a widget origin correctly with no Outpost change.

## The shape

- **`deploy.widgets` in `frontier.config`**, beside `deploy.web`: `{ domain, keep_releases }`, or `false`. Both doors read it.
- **A static App knows which surface it builds** (Q1). The Basecamp setup plan makes `widgets` beside `app` when `widgets/` exists and has a hostname. Release builds each static App from its own surface: `vite build` for web, `sierra widgets` for widgets.
- **The widgets Domain routes nothing back.** The API prefixes go to web's Domain only (`FJS-D1547`). The widget origin is cross-origin by definition.
- **Origins are baked, never pasted** (Q3). The web bundle gets the widget origin and the widget bundle gets the API origin, in both doors.
- **The SSH door routes the widget origin from Sierra's rule** (Q4). The Caddy route's headers come from `widgetHeaders()` and `cacheFor()`, never from parsing `_headers`. It has no CSP and no SPA fallback.

## Open questions

- **Q1 — How does a static App know its surface?** **A**: a `surface` field on the App's inline source, stated when the plan creates it, absent read as `web` for the rows that exist. **B**: a slug convention (`widgets` builds widgets/, anything else builds web/). **Recommend A**: a slug is a label any App may take, and a convention read off one would build the wrong tree into a renamed App with nothing saying so. A also leaves `frontingStatics` as it is, because a widgets App is legitimately released beside the API, just from its own surface.
- **Q2 — Where does the widgets hostname come from?** **A**: `deploy.widgets.domain`, read by both doors, plus a `--widgets-domain` flag for `basecamp:deploy`. At a terminal it offers `widgets.<web domain>`, and with `--yes` it offers nothing (a guessed hostname writes DNS). **B**: always derived as `widgets.<web domain>`. **Recommend A**, which is the rule web's hostname already follows.
- **Q3 — Which variable names carry the origins?** **Recommend** `FRONTIER_PUBLIC_WIDGETS_URL` into web/ and `FRONTIER_PUBLIC_API_URL` into widgets/, set by both doors the way `FJS-D1969` sets web's API origin. `bundle-env.js` already bakes the `FRONTIER_PUBLIC_` prefix. ELA renames `VITE_WIDGETS_URL`.
- **Q4 — One plan for both doors?** **Recommend yes**, Basecamp door first because ELA waits on it, then the SSH door in the same plan (`FJS-D1967`: both doors build one release). Once both doors serve widgets as static files, the scaffold stops writing `widgets/deploy/`.

## Plan

### Phase 0 — Groundwork

Goal: ELA's own build writes the widget origin's files.
Done when: `bun run build:widgets` in ELA leaves `_headers` and `index.html` in `widgets/dist/embeds`.

- [x] 0.1 `sierra widgets` writes `_headers` and `index.html` from `postbuild/widget-headers.js`; `serveWidgets` imports the same rule. Proved by `widget-serve.test.js` (the file read Cloudflare's way equals what the server sends), `test:widgets` 51/51 and `example` `verify:widget` 40/40.
- [ ] 0.2 Commit, and the owner publishes Sierra (the `gh release` step is the owner's).
- [ ] 0.3 ELA moves `@frontierjs/sierra` to that tarball.

### Phase 1 — Basecamp door

Goal: `fli deploy` through Basecamp makes and releases a widgets static App from `widgets/`.
Done when: `basecamp:deploy --dry` against a fixture app with `widgets/` plans the App and its Domain, and the cli suite covers the plan and the build.

- [ ] 1.1 The App's surface (Q1) in Basecamp's app source, with existing rows read as `web`.
- [ ] 1.2 Preflight: `surface-unreleased` for widgets carries a fix, `releasePlan` gains `widgets`, and the checks that assume one static App count per surface.
- [ ] 1.3 `applyPlan` makes `widgets` beside `app`, places it on the API's machines, and adds its Domain with no routes back.
- [ ] 1.4 The static branch builds the App's surface into a temp dir with the origins baked (Q3). `fli deploy` releases each static App from its own surface.
- [ ] 1.5 The API's git release (`FJS-D1979`) builds each front from its surface too.

### Phase 2 — ELA live

Goal: a page on another origin loads ELA's widget from `widgets.ela.maverickmade.tech` and posts a response.
Done when: `widgets/test/lawn-estimator.html`, served from a third origin against the live hosts, finishes a quote, and the form page's snippet names the live widget origin.

- [ ] 2.1 `deploy.widgets.domain` in ELA's `frontier.config`, and `fli deploy` on `ela-chartered` (asks before the live run).
- [ ] 2.2 ELA reads `FRONTIER_PUBLIC_WIDGETS_URL`. web is rebuilt, which also releases `4e97475` (held), so the owner releases it.
- [ ] 2.3 Delete ELA's `widgets/deploy/`, which makes plan 4.2 moot.

### Phase 3 — SSH door

Goal: `fli deploy` over ssh builds, ships, routes and rolls back widgets/ the way it does web/.
Done when: the cli suite covers the steps, and `verify:docker` (or the deploy drive) answers a widget script with CORS and the entry cache.

- [ ] 3.1 `deploy.widgets` read and graded beside `deploy.web` (`edgeNames`, `resolveSide`, `makeDeployBlock`, the docs).
- [ ] 3.2 Build and release steps beside `03-build-web` and `08-release-web`, under their own `releases/` and `current`.
- [ ] 3.3 A widget route in `core/edge.js` from Sierra's rule, plus setup (directories, DNS), rollback, revert and the journal.
- [ ] 3.4 The scaffold writes `deploy.widgets` and stops writing `widgets/deploy/`.
