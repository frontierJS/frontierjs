# toolbelt — Project State

_Verified 2026-09-03 by running the code. Everything below marked **verified** was
reproduced; anything else is labelled as unconfirmed._

> Drop this file into a fresh session to pick up toolbelt cold.
> `CLAUDE.md` is the map — the kits, the traps, and which caller proves a change.
> Read `../../CLAUDE.md` first for repo-wide vocabulary.

---

## What it is

`@frontierjs/toolbelt` v0.1.1 — pure-function kits, one per subpath, zero
dependencies, no root entry. It is **substrate below the dependency graph**
rather than a member of it (`FJS-D26`), so litestone and mesa may import it where
Invariant 1 would otherwise forbid the edge.

The licence for that standing is one rule — every export is a pure function — and
the rule is enforced by `bun run ci`'s hygiene phase rather than by habit.

## Verified state

| | |
|---|---|
| Tests | **280 passing, 0 failing**, 12 spec files (`bun run test`) — verified |
| Under node | **280 passing, 0 failing** (`node test/run.js`, node v22.21.1) — verified. The two runtimes now answer identically, which is the point of the section below |
| Typecheck | **clean, no baseline** (`bun run typecheck`) — verified |
| Substrate purity | *17 source file(s), no dependency and no ambient capability* — verified, from `bun run ci`'s hygiene phase |
| Published | `0.1.1` on npm, the version the tree carries (`npm view @frontierjs/toolbelt version`) — verified. Every declared entry point is in the tarball (`exports.snapshot.md`) |

Reproduce: `cd packages/toolbelt && bun run test && bun run typecheck`.

## The kit that had to stop asking the host

**`/units` ships ISO 4217 rather than reading the host's ICU tables** (`FJS-745`).
Two measurements, on node v22.21.1 and the bun in this tree:

- `Intl.supportedValuesOf('currency')` is **162 codes under node and 306 under
  bun, differing on 145**. bun carries every withdrawn code back to the Austrian
  schilling; node carries `ZWG`, Zimbabwe Gold, which bun does not — so
  `@money(ZWG)` parsed on one runtime and was refused as a typo on the other.
- `resolvedOptions().maximumFractionDigits` **disagrees on fourteen codes both
  runtimes carry**. node says the Iraqi dinar has no decimal places and bun says
  three; ISO says three. That is a stored amount out by a thousand between the
  machine that wrote it and the one that read it.

The second one is the sharper finding, and it is not a bug in either runtime:
`maximumFractionDigits` answers how an amount is **displayed**, which is CLDR's
question, and `@money` derives its scale from how an amount is **stored**, which
is ISO's. They are different questions, and reading the storage answer off the
display one would have been wrong even if the two hosts had agreed.

So the table is the kit's: 183 codes, 26 exponents that are not 2, and 13 codes
with no minor unit at all (the metals, the reserved codes, `XXX`) which
`minorUnits` refuses in their own words rather than answering 2. `Intl` still
does the formatting — the glyph, its side, the grouping — and no longer decides
the decimals. `units.spec.js` carries the negative control: with
`supportedValuesOf` stubbed to answer nothing, every value is unchanged.

This was also the one place the purity rule was thinner than it read. A host ICU
table is a dependency the manifest cannot declare, and declaring nothing is this
package's whole license to be imported by litestone and mesa (`FJS-D26`).

## What is NOT built

- **`/datetime`.** `docs/datetime.md` is the intent and `mockup/datetime/` is the
  parked prototype, sitting below the `packages/*` glob and named in
  `scripts/ci-allowances.json` § nonMembers. `FJS-411` is waiting on it — the
  *2h ago* ladder is written three times in basecamp and cannot move here until
  the clock argument is settled, because relative time is not a pure function of
  its argument.
- **The gate ladder as a kit** — `FJS-520`, ruling `FJS-D184`. The scale is
  hand-copied at four places across a boundary that forbids the import, the copies
  no longer agree, and the shape of the fix is the shape five kits here already
  took. Open, and the hard half is scope rather than mechanism.
- **A busy-element owner** — `FJS-390`, which may land here or in
  `@frontierjs/ui` and is deliberately not designed yet.
- **`/match` is shipped and undocumented.** It is in `exports` with 31 spec cases,
  and it is absent from the README's kit table and from `CLAUDE.md`'s
  *one kit per subpath* sentence. Both were written before `FJS-493` moved it here.
- `FJS-274` is repo-scope and names this package's history: `@frontierjs/utils`
  and `@frontierjs/datetime-kit` are still on the registry with no source in the
  tree, frozen at whatever they were when they folded in here.

## Picking it up next

1. **Run the suite under both runtimes.** `bun run test` alone cannot see the
   currency divergence, and the package advertises node.
2. Settle the `XXX` question above, then add whichever runtime's answer is the
   kit's to `units.spec.js` as an assertion about the kit rather than the host.
3. Add `/match` to the README table and to `CLAUDE.md`.
4. `/datetime` is the largest open piece, and `FJS-411` is the caller waiting for
   it. Start from `docs/datetime.md`, not from `mockup/`.

A kit here is only correct in its callers — `CLAUDE.md` § Proving a change is the
table, and it is where a change to `inflect` or `directives` is really graded.

## Unconfirmed

- Whether any other kit reads a host table the way `/units` reads ICU.
  `Intl` is the obvious candidate and `formatMoney` the obvious caller, but only
  the `isKnownCurrency` case was measured.
