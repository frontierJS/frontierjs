# Basecamp docs

Four pages, and they are read in different situations rather than in order.

- [VISION.md](VISION.md) — what Basecamp is for: developer command central for
  the FJS world. Read it first if you have not worked in this package before
- [SCREENS.md](SCREENS.md) — the screen inventory, counted against the mock and
  the tree rather than remembered. It is the map of what is unbuilt and, for
  each one, of what actually blocks it — so it is where a *what next* starts
- [UI_HANDOFF.md](UI_HANDOFF.md) — the API contract a session working in `web/`
  needs: what each service answers, and in what shape
- [UI_PLAN.md](UI_PLAN.md) — the phased build plan for `web/`. Companion to the
  handoff, which is the contract where this is the order

`mock/` beside them is the design mock the inventory is counted against.

The package root keeps the standard four (`README`, `CLAUDE`, `PROJECT_STATE`,
`CHANGES`); everything here is the depth behind them, per Invariant 17.
