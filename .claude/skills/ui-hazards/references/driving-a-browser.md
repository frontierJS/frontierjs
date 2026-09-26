# Driving a browser

The full entries behind this section of the `ui-hazards` skill's index.

- **An overlay that is present is not an overlay that is visible.** Kit overlays fade in with `el.animate(…, { fill: 'forwards' })`, so an assertion that only asks `querySelector` passes against a fully invisible full-screen backdrop. Assert computed opacity and hit-testing.
- **Headless Chrome delivers almost no rendering lifecycle after load.** Set up anything behind `IntersectionObserver` before load; `requestAnimationFrame` hangs. Working pattern: `packages/sierra/test/fixtures/island-site/verify.mjs`. **`getComputedStyle` goes stale after a class change** — `el.matches()` and `document.styleSheets` report the new state while computed styles stay frozen, and forcing layout does not help. To check a post-click style change, read the rules that match the element.
