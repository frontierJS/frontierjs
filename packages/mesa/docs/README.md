# Mesa Docs

Everything that is not the package README, or `../PROJECT_STATE.md`.

## Specification

- [VISION.md](VISION.md) — **the language specification.** Numbered RULEs; §4 is the
  claims list the spec-check verifies. Amendments are recorded in place (RULE 26, RULE 54)
- [STATIC_RENDERING.md](STATIC_RENDERING.md) — the static-rendering model, server
  semantics, the two component-children protocols, island markers, `tmpDir`, and
  what a browser global answers on the server

## Design investigations

- [EXTERNAL_REACTIVITY.md](EXTERNAL_REACTIVITY.md) — how external state reaches a
  component, and the full failure matrix

---

Read `ui-hazards` and `git log -- packages/mesa/src/runtime.js` (the 2026-08-01
reactivity and block-teardown passes) before changing `runtime.js`; `STATIC_RENDERING.md` before changing either renderer.
