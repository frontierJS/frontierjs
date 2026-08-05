# Changes

Newest first.

## 2026-08-03 — added to the monorepo; two silent rendering defects fixed

The kit arrived as `packages/email-kit`. Before this it existed only on
another machine — `packages/mesa/email-kit.test.js` pointed at an absolute
`/tmp/mesa/email` path and was entirely `.skip`ped. **That file is deleted**;
the kit brings its own suite, and removing it took Mesa from 27 skipped tests
to **zero**.

### The bulletproof button was shipping its Outlook fallback to everyone

`<!--[if mso]>` was serialised as `<!--[if mso]-->` — a *closed* comment — so
the VML behind it became live markup and `<v:roundrect …>` parsed as
`<v :roundrect="" …>`. Every recipient on every client saw the button twice.

happy-dom, which the static renderer runs in, ends a conditional comment early
when certain tags appear inside it: a namespaced attribute (`xmlns:v`) does it,
so does a multi-line opening tag, so do some `style` values. `{@html}` had been
used to protect the block and cannot — `{@html}` sets `innerHTML`, which *is*
the DOM.

`Button.mesa` now keeps the VML out of the DOM entirely: percent-encoded into a
`data-mso` attribute, spliced back by `expandMsoPlaceholders()` in `render.js`
once the HTML is a string again. (Percent-encoded, not raw — happy-dom does not
escape `"` in a serialised attribute value either, so the payload's own quotes
would close the attribute.)

**Trade-off:** rendering a kit component through Mesa's `renderComponent`
directly now leaves the placeholder and drops the Outlook fallback. Use
`renderEmail` / `renderEmailFile`. A test pins that behaviour rather than
letting it be discovered.

### The plain-text alternative was full of markup artefacts

Fixed upstream in Mesa's `htmlToText`: `<style>`/`<script>`/`<head>` contents
were read as prose; conditional comments were not handled, so every CTA
appeared twice; `&#847;` (the preheader's zero-width padding) printed
literally, because entity decoding was a fixed list of six; and the hidden
preheader was included, duplicating the opening line.

The two conditional-comment shapes need **opposite** treatment — the
downlevel-hidden block goes, the downlevel-revealed markers go but their
content stays. Deleting everything that matches `<!--[if … <![endif]-->`
removes the real anchor and the text loses every link it had.

### Also

- `getMesaRender()` had no bare-specifier candidate, so a consumer installing
  from npm always hit "install the peer dependency" no matter how correctly
  they had installed it. It also swallowed every failure with
  `catch { continue }`, which reported a missing dependency for a syntax error
  inside `render-component.js`. Real errors now propagate; the message lists
  what was tried.
- `test` now uses the package's own `vitest.config.js`, which already sets
  `pool: 'forks'` and a 30s timeout, instead of pointing at mesa's config and
  re-supplying only `pool` on the command line.
