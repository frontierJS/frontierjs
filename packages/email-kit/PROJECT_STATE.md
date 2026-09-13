# @frontierjs/email-kit — project state

State as of **2026-09-05**. The kit was added on 2026-08-03; on 08-06 it was
renamed to `@frontierjs/email-kit` everywhere (`FJS-D15`) and its suite was
found to have been failing entirely — see `CHANGES.md`.

## What this is

22 table-based email components + a `WelcomeEmail` template, rendered through
Mesa's `target: 'email'` pipeline (CSS inlining, subject extraction,
plain-text alternative). It replaces MJML for transactional mail.

Until now this package existed only on another machine: `packages/mesa/
email-kit.test.js` referenced it at an absolute `/tmp/mesa/email` path and was
entirely `.skip`ped. **That file is now deleted** — the kit has its own suite,
and removing it took Mesa from 27 skipped tests to zero.

## What works

- **102/102 tests pass** — `bun run test`, re-verified 2026-09-05. Was 34, and the
  34 covered 16 of the 22 components: `Header` and `Link` were rendered by
  nothing at all, and four more only through the whole-document template. Every
  component is now rendered on its own, off a list READ from the directory.
- **A component that cannot take children warns instead of dropping them**
  (`components/slot-guard.js`). Eight take no content and `TwoCol` takes only
  named slots; Mesa drops the children in silence, so the kit says so. The
  language-level rule is `FJS-926`.
- Re-verified 2026-08-06: between
  2026-08-03 and then **all 34 were failing**, because mesa moved its sources
  into `src/` and both this package's probe paths and mesa's own temp-dir
  resolution still assumed the old layout. This line said "34/34 pass"
  throughout. A state file is a claim; run it.
- Renders a full `<!DOCTYPE html>` document with MSO namespaces, an
  Outlook-safe head block, inlined CSS, preserved `@media` queries, a
  `subject` from `<script module>`, and a derived `text` alternative.
- The `WelcomeEmail` template renders end-to-end at ~21 KB — under Gmail's
  102 KB clipping threshold with room to spare.

## Fixed on arrival

Two silent defects in the rendered output — the Outlook button fallback shipping
to every client, and markup in the plain-text alternative — are in `CHANGES.md`;
the traps behind them, and the one consequence to know (render through
`renderEmail`, never `renderComponent` directly), are `docs/HTML_EMAIL_TRAPS.md`.

## What is NOT verified

- **Nothing has been sent to, or opened in, a real mail client.** Everything
  above is asserted against the rendered HTML string. Outlook, Gmail, Apple
  Mail and the rest are untested — and Outlook's Word renderer is precisely
  the thing static assertions cannot stand in for.
- **No litmus/CanIEmail-style matrix.** The VML button is *structurally*
  correct now; whether it renders as intended in Outlook 2016/2019/365 is
  unconfirmed.
- **`email-base.css` is not exercised by tests.** It ships in
  `components/`, and nothing asserts that its rules survive inlining.
- **Dark-mode / `prefers-color-scheme`** is not handled anywhere in the kit.

## Open — see `ISSUES.md`

**`FJS-053`** never opened in a real mail client. `FJS-051` (package name vs
directory, ruled `FJS-D15`) and `FJS-052` (`import.meta.url.pathname` on
Windows, `autoImport`) are both closed now.

No integration with `@frontierjs/ui` or `@frontierjs/css`, and there should not
be: email needs inlined table markup and the css package ships a stylesheet. The
two kits are deliberately separate — that is a decision, not an open item.

Add a new item to `../../ISSUES.md`, not here.
