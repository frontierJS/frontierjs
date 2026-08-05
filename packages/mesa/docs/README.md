# Mesa Docs

Everything that is not the package README, `../PROJECT_STATE.md`, or `../CHANGES.md`.

## Specification

- [VISION.md](VISION.md) — **the language specification.** Numbered RULEs; §4 is the
  claims list the spec-check verifies. Amendments are recorded in place (RULE 26, RULE 54)
- [SSR_SPEC.md](SSR_SPEC.md) — server rendering: the W-items, island markers (W3, done),
  `tmpDir` (W1, open)
- [STATIC_RENDERING.md](STATIC_RENDERING.md) — the static-rendering model, server
  semantics, the two component-children protocols, and the Sierra gap

## Design investigations

- [EXTERNAL_REACTIVITY.md](EXTERNAL_REACTIVITY.md) — how external state reaches a
  component, and the full failure matrix
- [PLAIN_OBJECT_STATE.md](PLAIN_OBJECT_STATE.md) — the case for plain objects with `$:`
  path watching instead of Sierra's `externalSignals`

## Workstream passes

Point-in-time records. Read before touching the area each covers.

- [REACTIVITY_PASS.md](REACTIVITY_PASS.md) — 2026-08-01 reactivity audit: changes, open
  items, false leads
- [BLOCK_TEARDOWN_PASS.md](BLOCK_TEARDOWN_PASS.md) — 2026-08-01 block teardown: the two
  failure shapes behind every `{#key}`/`{#await}`/`{#each}`/`<mesa:boundary>` removal bug

---

Read `REACTIVITY_PASS.md` and `BLOCK_TEARDOWN_PASS.md` before changing `runtime.js`;
`STATIC_RENDERING.md` before changing either renderer.
