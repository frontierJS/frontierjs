---
id: branded-icons
status: proposed
dated: 2026-10-30
---

# Idea — a FrontierJS icon set, drawn in-house

**Status: PROPOSED.** Wanted eventually, not scheduled.

`FJS-D1655` ruled that the kit keeps no icon registry and ships no icons: an app
writes one `Icon` component over whatever set it adopts. The owner also wants a
first-party set drawn for FrontierJS, offered as a branded option an app can
pick instead of Lucide or Heroicons.

## What it would be

- A line set of about 60 icons covering what the kit and the scaffolded apps
  draw: navigation, actions (add, edit, delete, close, search, filter), status
  (check, warning, info, error), files, people, time, money.
- One grid (24px), one stroke width, one corner radius and one cap/join, so the
  set reads as one hand. Stroke color is `currentColor`, so tones still decide
  color (Invariant 13).
- Delivered as path data an app's `Icon` reads, and as an Iconify JSON
  collection so `i-fjs:<name>` works through Uno `preset-icons`.
- Its look follows the brand sheets (`~/fjs-brand-sheets-backup/`).

## What it is not

- Not a kit registry. `FJS-D1655` stands: the set fills an app's `Icon`, and the
  kit's components keep taking an icon snippet.
- Not a dependency of `@frontierjs/ui`. It ships as its own package or asset so
  an app that uses Lucide pays nothing for it.

## Open questions

- Package home: `@frontierjs/icons`, or an asset under `@frontierjs/css`.
- Drawn by hand, or generated and then corrected by hand.
- Whether `fli new` scaffolds the app `Icon` over this set by default.
