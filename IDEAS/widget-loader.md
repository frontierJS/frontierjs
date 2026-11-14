---
id: widget-loader
status: proposed
dated: 2026-11-07
---

# Idea — One pasted script: a widget loader that configures itself by key

**Status: PROPOSED.** Dated 2026-11-07, raised while shipping ELA's widgets (`fjs-prototypes/ela/docs/deploy-chartered.md` Phase 4). Nothing here is built. Q1–Q4 are open.

## The problem

A widget snippet is pasted into a CMS on a site the app does not own, and nobody edits it again. Anything the snippet holds can only change through every site that pasted it.

The legacy ELA snippet carried the whole form in `data-*` attributes: fields, styles, button text and a base64 `custom` blob. So editing a form meant re-pasting it on every site. The converted ELA already moved most of that to the server. The snippet carries `data-form` (the form's `publicKey`, ruling 42), and the widget's first call, `formResponses.widget { key }`, returns what it draws. Three things are still in the paste:

- **Which widget it is.** The tag `<ela-lawn-estimator>` and the file `LawnEstimator.js` both name the view, so switching a form's view means re-pasting.
- **The API origin** (`data-api-url`). It changes exactly once, at cutover, which is the worst time to ask a site to re-paste.
- **The redirect** (`data-redirect-url`). It is a form setting stored on the page instead of on the form row.

## The shape

Plausible's snippet is the precedent: one `<script defer data-domain="…" src="https://plausible.io/js/script.js">`. The script reads its own tag through `document.currentScript`, and everything else is the server's. Intercom's `app_id` and Calendly's inline embed work the same way: a stable loader URL plus a key, with configuration fetched at load time.

```html
<script defer src="https://widgets.example.com/embed.js" data-form="KEY"></script>
```

1. **`embed.js` is the one URL anyone pastes.** It is small, has no framework and is short-cached (`max-age=300, must-revalidate`, the rule `sierra/src/widget/serve.js` `cacheFor` already gives an entry).
2. **The API origin is baked into `embed.js` at build time**, once per deployment, the way the web build takes `VITE_API_URL`. The page never states it.
3. **The loader asks the API what this key is**, using the same `widget { key }` call with the view added to its answer, then `import()`s that view's bundle from its own origin.
4. **It mounts beside its own script tag**, or into a `data-target` selector when one is given. It does this by creating the widget's custom element, so the runtime in `sierra/src/widget/index.js` is unchanged.
5. **Every bundle behind the loader is content-hashed and immutable.** Only the loader's URL is fixed, so only the loader revalidates.

The element form keeps working: a page that writes `<ela-basic-form data-form>` plus a bundle's `<script>` is still valid. The loader is the documented snippet, not the only one.

## Why it fits

- **It is still static files.** The loader and the bundles are a static App's release, and the configuration is an API read. It does not reopen `FJS-D763` (widgets/ is its own origin).
- **The cache split stops being a convention and becomes the design.** The rule `serveWidgets` encodes per file becomes the boundary between "the URL a stranger holds" and "bytes nobody names".
- **CORS is no longer optional.** A classic `<script src>` loads without it, but a cross-origin `import()` does not. That is the reason the static release must carry the widget origin's headers (ELA Phase 4.1: Sierra emits `_headers` from `serveWidgets`' rule).

## Open questions

- ~~**Q1 — Whose loader is it?**~~ **Answered 2026-11-14 (`FJS-D2141`): A — Sierra's widget target emits `embed.js` beside the bundles when `sierra.config.js` carries `widgets.loader`, served under the entry rule `cacheFor` already gives (`packages/sierra/src/postbuild/widget-headers.js`, used at `packages/sierra/src/widget/serve.js:119`); an app without the key builds as today.** **A**: Sierra's widget target emits `embed.js`, and an app opts in with `widgets.loader: { key, resolve }` in `sierra.config.js`. An app without the key builds exactly as it does today. **B**: each app writes its own. **Recommend A, ruled together with Q2**: `serve.js` already owns the entry-versus-hashed rule, so the loader sits beside it, and B would give every app a hand-written copy of the part that goes wrong. Demand is one of five: calendly, chatwoot, maidtech and posthog have widget surfaces with no loader, and only ELA pastes into strangers' CMSs. That is why it is opt-in. B is the reopen path if no second app opts in.
  - **A** — Sierra's widget target emits `embed.js` beside the bundles when `sierra.config.js` carries `widgets.loader`, served under the entry rule `cacheFor` already gives (`packages/sierra/src/postbuild/widget-headers.js`, used at `packages/sierra/src/widget/serve.js:119`); an app without the key builds as today
  - **B** — no framework loader: ELA hand-writes `embed.js` at the final URL and copies the entry-versus-hashed cache rule into its own release; any later app writes its own
  - **Recommend A** — the cache split is the part that goes wrong and it already has one owner in `widget-headers.js`, so the loader belongs beside it; opt-in keeps the four apps without strangers' CMSs unchanged, and B stays the reopen path if no second app opts in.
- ~~**Q2 — What does the resolve call return, and who owns it?**~~ **Answered 2026-11-14 (`FJS-D2142`): A — a declared method path, no new noun: `widgets.loader: { key: 'data-form', resolve: 'formResponses.widget' }`; the loader calls that method with `{ key }`, and the one framework fact is that the answer carries `view` (a missing `view` is refused by name).** For ELA it is `formResponses.widget`. A framework loader needs a named contract (`{ view, … }`) that every app's resolve method returns, or a declared method path in `sierra.config.js`. Run `decision-rules` before coining a noun for it.
  - **A** — a declared method path, no new noun: `widgets.loader: { key: 'data-form', resolve: 'formResponses.widget' }`; the loader calls that method with `{ key }`, and the one framework fact is that the answer carries `view` (a missing `view` is refused by name)
  - **B** — a named contract: Sierra coins a noun for the answer (`{ view, … }`) and documents its fields; every app's resolve method returns that shape
  - **Recommend A** — only `view` is load-bearing for the loader, so a named field in the config doc covers it without spending a noun; the app keeps naming its own method (ELA's `formResponses.widget` is unchanged), and the fixture test the paper names adds a no-`view` refusal case.
- ~~**Q3 — IIFE or ESM bundles behind the loader?**~~ **Answered 2026-11-14 (`FJS-D2143`): A — keep IIFE: the loader injects each bundle as a classic `<script>`, and the runtime in `packages/sierra/src/widget/index.js:8` stays one build mode; two widgets on a page each carry their own runtime.** The build emits IIFE today (`widget/index.js`: no module loader can be assumed). The loader is a module loader, so the bundles behind it could be ESM chunks that share a runtime, which shrinks a page with two widgets. The tradeoff is a second build mode.
  - **A** — keep IIFE: the loader injects each bundle as a classic `<script>`, and the runtime in `packages/sierra/src/widget/index.js:8` stays one build mode; two widgets on a page each carry their own runtime
  - **B** — ESM chunks behind the loader: a second build mode emits shared-runtime chunks the loader `import()`s cross-origin, which makes the CORS headers mandatory; the element form keeps the IIFE build
  - **Recommend A** — B's only gain is a smaller page carrying two widgets, which no app has asked for, against a second build mode to keep correct; B is the reopen path when a page carries two.
- ~~**Q4 — Where does the key live?**~~ **Answered 2026-11-14 (`FJS-D2144`): A — key on the loader's `<script>` tag, read through `document.currentScript`; the widget mounts beside that tag or into an optional `data-target`.** **A**: on the loader's `<script>` tag (Plausible). **B**: on a placeholder element the loader finds (`<div data-form>`), which also says where to mount. **A** is one line to paste. **B** places the widget without a `data-target`.
  - **A** — key on the loader's `<script>` tag, read through `document.currentScript`; the widget mounts beside that tag or into an optional `data-target`
  - **B** — key on a placeholder (`<div data-form="KEY">`) the loader scans for, which is also the mount point; the script tag carries nothing
  - **Recommend A** — one pasted line, the Plausible shape the paper cites; placement-by-element is already covered by the element form (`<ela-basic-form data-form>`), so B adds a second paste shape for what `data-target` already does.
- ~~**Q5 — Where does code that must run on every page live?**~~ **Answered 2026-11-14 (`FJS-D2145`): A — in the loader: `widgets.loader: { everyPage: 'src/lib/source.js' }` names a module, resolved from the widgets root, that Sierra bundles into `embed.js`; the site pastes one tag on every page, and the form bundle is fetched only where the tag carries `data-form`. A throw in the module is caught inside the loader, so a capture bug never blanks a form; an unresolvable path fails the build by name.** ELA's first-touch capture (`fjs-prototypes/ela/widgets/src/lib/source.js`: utm_*, click ids and the referrer, kept in the host page's localStorage) has to run on a landing page with no form, so today a site loads the whole form bundle on every page to record where a visitor came from. Raised by the owner while ruling Q3: the IIFE-or-ESM choice does not fix this; splitting what runs on every page from what runs where a form is does.
  - **A** — in the loader: `widgets.loader: { everyPage: 'src/lib/source.js' }` names a module, resolved from the widgets root, that Sierra bundles into `embed.js`; the site pastes one tag on every page, and the form bundle is fetched only where the tag carries `data-form`. A throw in the module is caught inside the loader, so a capture bug never blanks a form; an unresolvable path fails the build by name
  - **B** — a separate tracker script the site pastes site-wide beside `embed.js`, with its own cache rule; the form reads the stored source as it does today
  - **C** — it stays in the form bundle, as today: every page pays for the form to capture the source
  - **Recommend A** — `embed.js` is already the one short-cached URL every page holds (`packages/sierra/src/postbuild/widget-headers.js`), so a fix to the capture reaches every site in five minutes; B is a second paste and a second copy of the cache rule, and C is the cost the owner raised. The fixture test below also asserts the module is in `embed.js` and no form code is.

The test a ruling on Q1 and Q2 needs: a Sierra test that builds a fixture with a loader and asserts that `embed.js` is served revalidated and every chunk it imports has a hashed name. Nothing pins that today.

## Timing

**ELA has to decide the paste before its cutover**, meaning the `embed.js` URL and its `data-form` attribute. No client site has pasted a new-style snippet yet, so changing it now costs nothing, and after cutover it costs a re-paste on every site. Which package emits the file is not part of the paste. If Q2 is not settled by cutover, ELA can ship its own `embed.js` at the final URL, and Sierra can take it over later with no re-paste.
