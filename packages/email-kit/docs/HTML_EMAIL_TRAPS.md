# HTML email traps

Two failure modes that a DOM-based renderer creates and that no test catches by
accident: both leave the output **well-formed**, so the only way to see them is
to look at what a mail client shows.

These were live defects in this kit on 2026-08-03 (see `CHANGES.md`); this file
is the durable account, because the shape recurs for any component that carries
Outlook fallbacks or a text alternative.

---

## 1. An Outlook conditional comment cannot survive a DOM round-trip

`packages/email-kit/components/Button.mesa`, `render.js`.

The bulletproof-button pattern wraps VML in a downlevel-hidden conditional
comment so that only Outlook's Word renderer sees it:

```html
<!--[if mso]>
  <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" ...>…</v:roundrect>
<![endif]-->
```

**happy-dom — which Mesa's static renderer runs in — ends the comment early.**
Any of these does it on its own:

- a namespaced attribute (`xmlns:v="…"`)
- a multi-line opening tag
- certain `style` values

The comment then serialises as `<!--[if mso]-->` — *closed* — and the VML behind
it becomes live markup: `<v:roundrect …>` parses as `<v :roundrect="" …>`.

**Every recipient, on every client, sees the button twice.** Nothing throws, the
HTML stays valid, and the only symptom is a duplicate CTA in the inbox.

### `{@html}` does not protect it

That was the previous mitigation here and it never worked. `{@html}` sets
`innerHTML`, which **is** the DOM — the exact place the comment cannot survive.

### The fix: keep the markup out of the DOM entirely

Percent-encode the block into a data attribute, and splice it back once the HTML
is a string again:

```html
<span data-mso={encodeURIComponent(msoHTML)}></span>
…
<span data-mso-close={encodeURIComponent(msoClose)}></span>
```

`expandMsoPlaceholders()` in `render.js` expands them after render.

**Percent-encoded, not raw** — happy-dom does not escape `"` inside a serialised
attribute value either, so a raw payload's own quotes would close the attribute
and reintroduce the same class of breakage one layer down.

### The trade-off, which is pinned by a test rather than left to be discovered

Rendering a kit component through Mesa's `renderComponent` **directly** leaves
the placeholder in place and drops the Outlook fallback. Use `renderEmail` /
`renderEmailFile`.

---

## 2. `htmlToText` must treat the two conditional-comment shapes OPPOSITELY

`packages/mesa/src/render-component.js` (`htmlToText`) — Mesa's function, but this
kit is what exercises it, and getting it wrong is visible in every email.

| shape | what it is | what the text alternative must do |
| --- | --- | --- |
| `<!--[if mso]> … <![endif]-->` | downlevel-**hidden** — the Outlook fallback | drop it **content and all** |
| `<!--[if !mso]><!--> … <!--<![endif]-->` | downlevel-**revealed** — the real anchor | drop **only the markers**, keep the content |

Treat them the same and you lose in one direction or the other:

- delete everything matching `<!--\[if … <!\[endif\]-->` → the real anchor goes
  with the fallback, and **the plain-text part of every email loses every link
  it had**
- keep both → **every CTA appears twice**

### The other three `htmlToText` faults fixed at the same time

- **`<style>`, `<script>` and `<head>` contents were read as prose**, so the
  responsive CSS rules appeared as text in the message body.
- **Entity decoding was a fixed list of six names**, so `&#847;` — the
  zero-width combining grapheme joiner every preheader is padded with — printed
  as the literal string `&#847;`. Numeric and hex references are decoded
  generally now, with zero-width and formatting characters dropped rather than
  emitted.
- **The hidden preheader was included**, duplicating the opening line and
  trailing its padding after it. `display:none` elements are dropped.

---

## Why both of these hid for so long

Neither produces malformed HTML, an exception, or a warning. The rendered string
parses, the test suite reads it back through the same DOM that broke it, and the
defect only exists in the eye of a mail client.

**Nothing here has been opened in a real mail client** — see `PROJECT_STATE.md`
§"What is NOT verified". Litmus/Email-on-Acid style verification is the
outstanding work, and until then these two are pinned by tests that assert the
*serialised string*, not the DOM.
