# Basecamp docs

These pages are read in different situations rather than in order.

- [VISION.md](VISION.md) — what Basecamp is for: developer command central for
  the FJS world. Read it first if you have not worked in this package before
- [SCREENS.md](SCREENS.md) — the screen inventory, counted against the mock and
  the tree rather than remembered. It was the map of what is unbuilt and, for
  each one, of what actually blocks it; since 2026-08-30 it is 41 of 41 and the
  phases are the record of what each one decided
- [ADAPTERS.md](ADAPTERS.md) — what SCREENS left: ten providers, every boundary
  declared, nothing behind any of them. Four screens are each waiting on one, and
  this is what wiring one costs — the decisions already made, and which drive
  assertions go red the day you do. **Start here if you are picking up a
  third party**
- [PROVISIONING.md](PROVISIONING.md) — buying a machine at a cloud: the compute
  connector boundary, the spend guard, cloud-init and enrollment, phase by phase

`mock/` beside them is the design mock the inventory is counted against.

The package root keeps the standard four (`README`, `CLAUDE`, `PROJECT_STATE`,
`CHANGES`); everything here is the depth behind them, per Invariant 17.
