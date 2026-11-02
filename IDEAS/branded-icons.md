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

- **Package home: `@frontierjs/icons`, or an asset under `@frontierjs/css`.**
  - **A** — `@frontierjs/icons`, a new package exporting path data and an Iconify
    JSON collection. Cost: one more published package, with its own release.
  - **B** — an asset under `@frontierjs/css` (`css/icons/fjs.json`). Cost: css's
    README § Icons and the `icon.css` header both say it ships no icons, and every
    css install carries the set, so an app on Lucide pays for it.
  - **Recommend A** — `FJS-D951` and `FJS-D1655` keep icons out of the kit, and
    css says it ships none, so B reverses its own stated line. A passes
    `map-packages.md`'s test: something an app can decline. Every set checked ships
    apart from the design system beside it: Heroicons is its own package, not
    Tailwind's ([repo](https://github.com/tailwindlabs/heroicons)), Octicons is
    `@primer/octicons` ([repo](https://github.com/primer/octicons)), and Lucide
    and Tabler publish per-framework packages
    ([Tabler](https://github.com/tabler/tabler-icons)), all read 2026-11-02.
    Confidence 2.
- **Drawn by hand, or generated and then corrected by hand.**
  - **A** — drawn by hand on written grid rules (canvas, stroke, joins, caps,
    corner radius), with a small check that grades each file against them. Cost:
    about 60 icons of a designer's time.
  - **B** — a model drafts the SVGs and a person corrects each one. Cost: every
    icon is still hand-fixed, consistency across the set is the known failure,
    and who holds the copyright on generated art is unsettled.
  - **Recommend A** — the sets this one would sit beside are drawn on published
    rules: Lucide's guide fixes a 24px canvas, a 2px stroke, round joins and caps
    ([guide](https://lucide.dev/contribute/icon-design-guide), read 2026-11-02),
    and Heroicons calls itself hand-crafted. No open set documents a
    generate-then-correct pipeline. The check on the written rules gives most of
    what B wants. Reopen B when a model's pilot batch of five passes that check.
    The stroke width is unchosen: `packages/ui/AGENTS.md` § Icons draws at 1.5,
    and Lucide and Tabler use 2. Confidence 2.
- **Whether `fli new` scaffolds the app `Icon` over this set by default.**
  - **A** — yes: `fli new` writes `web/src/components/Icon.mesa` and its path data
    from this set. Cost: every new app takes the dependency, and a scaffolded
    `Icon` is a convention that does not exist today.
  - **B** — no: the set is opt-in, shown as the example in `packages/ui/AGENTS.md`
    § Icons, and an app writes its own `Icon` over it. Cost: the set is found only
    by someone who looks.
  - **Recommend B** — the scaffold writes no `Icon` today (a favicon and one emoji,
    `packages/cli/core/scaffold/web.js`), so A coins a convention rather than
    switching a default, and `FJS-D951` refused the kit picking a set for the
    same reason: a set the kit picks is one every app restyles around. Frameworks
    with their own UI kits default to a third-party set, not their own art: Nuxt UI
    uses Iconify's `lucide` collection
    ([docs](https://ui.nuxt.com/docs/getting-started/integrations/icons/nuxt), read
    2026-11-02). Reopen A once the set has a real app using it. Confidence 2.
