# `{@html}`

Insert a string as HTML instead of as text.

```mesa
<script>
  let note = '<strong>Saved</strong> just now'
</script>

<p>{@html note}</p>
```

`{expr}` always shows its value as text, so `<` stays `<`. `{@html expr}` parses the
string and puts the resulting nodes in the page. When the expression changes, the
old nodes are removed and the new ones inserted.

## It does not sanitize

Whatever the string holds goes in as markup, scripts and event handlers
included. Use `{@html}` only for content you wrote or already trust, such as the
output of your own markdown renderer. Anything a stranger typed goes in with plain
`{expr}`.

---

Spec: [VISION.md § 10.7](../../VISION.md#107-raw-html--html) · RULE 33
