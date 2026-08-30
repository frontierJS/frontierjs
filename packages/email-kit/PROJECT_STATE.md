# @frontierjs/email-kit — project state

State as of **2026-08-06**. The kit was added on 2026-08-03; on 08-06 it was
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

- **34/34 tests pass** — `bun run test`. Re-verified 2026-08-06: between
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

Both were live defects in the rendered output, and both were silent — the HTML
stayed well-formed.

### The bulletproof button was not bulletproof

`<!--[if mso]>` was being serialised as `<!--[if mso]-->`. The comment closed,
and the VML after it became live markup: `<v:roundrect …>` parsed as
`<v :roundrect="" …>`, an unknown element with a stray attribute. **The
Outlook-only fallback shipped to every client, so every recipient saw the
button twice.**

Root cause is happy-dom, which the static renderer runs in: it ends a
conditional comment early when certain tags appear inside it. Two independent
triggers found — a namespaced attribute (`xmlns:v="…"`) and some `style`
values; a multi-line opening tag also does it. `{@html}` was the previous
mitigation and cannot work, because `{@html}` sets `innerHTML` — that *is* the
DOM.

Fix: the VML never enters the DOM. `Button.mesa` emits it percent-encoded in a
`data-mso` attribute, and `expandMsoPlaceholders()` in `render.js` splices it
back once the HTML is a string again. Percent-encoding rather than raw text
because happy-dom does not escape `"` in a serialised attribute value either.

**Consequence to know:** rendering a kit component through Mesa's
`renderComponent` *directly* leaves the placeholder in place and drops the
Outlook fallback. Use `renderEmail` / `renderEmailFile` from
`@frontierjs/email-kit/render`. Pinned by a test that asserts exactly that.

### The plain-text alternative was full of markup artefacts

Fixed in Mesa's `htmlToText` (`packages/mesa/src/render-component.js`):

- `<style>` / `<script>` / `<head>` contents were read as prose.
- Conditional comments were not handled, so the Outlook fallback text sat
  beside the real anchor and every CTA appeared twice. The two shapes need
  opposite treatment — downlevel-*hidden* blocks go, downlevel-*revealed*
  markers go but their content stays. Removing anything matching
  `<!--[if … <![endif]-->` deletes the real anchor and the text loses every
  link it has.
- Entity decoding was a fixed list of six, so `&#847;` — the zero-width
  spacer every preheader is padded with — printed literally.
- The hidden preheader was included, duplicating the opening line.

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

**`FJS-051`** package name does not match the directory (ruling: **`FJS-D15`**) ·
**`FJS-052`** `import.meta.url.pathname` is wrong on Windows, and the documented
`autoImport` option is unimplemented · **`FJS-053`** never opened in a real mail
client.

No integration with `@frontierjs/ui` or `@frontierjs/css`, and there should not
be: email needs inlined table markup and the css package ships a stylesheet. The
two kits are deliberately separate — that is a decision, not an open item.

Add a new item to `../../ISSUES.md`, not here.
