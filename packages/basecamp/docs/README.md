# Basecamp docs

These pages are read in different situations rather than in order.

- [vision.md](vision.md) — what Basecamp is for: developer command central for
  the FJS world. Read it first if you have not worked in this package before
- [screens.md](screens.md) — the screen inventory, counted against the mock and
  the tree rather than remembered. It was the map of what is unbuilt and, for
  each one, of what actually blocks it; since 2026-08-30 it is 41 of 41 and the
  phases are the record of what each one decided
- [providers.md](providers.md) — what SCREENS left: ten providers, every boundary
  declared, nothing behind any of them. Four screens are each waiting on one, and
  this is what wiring one costs — the decisions already made, and which drive
  assertions go red the day you do. **Start here if you are picking up a
  third party**
- [backups.md](backups.md) — the operator's recipe for archives that leave the box:
  a B2 bucket and key, the destination form and what each refusal means,
  retention, `location`, the key escrow, and a restore by hand
- [provisioning.md](provisioning.md) — buying a machine at a cloud: the compute
  connector boundary, the spend guard, cloud-init and enrollment, phase by phase
- [footprint.md](footprint.md) — what a Basecamp box spends in memory, measured on
  yuma: the evidence a minimum box size will be set from, and how to re-measure
- [layout.md](layout.md) — the file-by-file map of the package, out of `CLAUDE.md`
- [hazards.md](hazards.md) — every hazard, the full `What bites here`

The package root keeps the standard four (`README`, `CLAUDE`, `PROJECT_STATE`,
`CHANGES`); everything here is the depth behind them, per Invariant 17.
