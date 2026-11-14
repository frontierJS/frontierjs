# Basic markup

A `.mesa` file's template is HTML. Put JavaScript in braces to show a value, set
an attribute or attach an event handler.

```mesa
<script>
  let name = 'world'
  let count = 0
  const url = 'https://example.com'
</script>

<h1>Hello {name}!</h1>
<input value={name} oninput={(e) => name = e.target.value}>
<a href={url} aria-label="Visit {url}">{url}</a>
<button onclick={() => count++}>{count} clicks</button>
```

`{expr}` works in text and in an attribute value. Mix text and braces inside a
quoted attribute (`aria-label="Visit {url}"`) and the result is one string.
When the whole value is one expression, leave the quotes off.

## Every tag closes

Close every element explicitly. HTML lets you leave off `</li>` or `</p>`; Mesa
refuses, and the error names the tag that is still open. `<br>` and the other
void elements need no end tag, and `<span />` self-closes.

## Shorthand and spread

When the attribute and the variable share a name, write it once. Spread an
object to set several attributes at a time.

```mesa
<script>
  let name = 'email'
  let disabled = false
  let rest = { placeholder: 'you@example.com', required: true }
</script>

<input {name} {disabled} {...rest}>
```

## DOM events

An event handler is the DOM's own attribute name, `onclick`, `oninput`,
`onsubmit`, with a function in braces. `on:click` and `@click` are compile
errors; the message tells you to write `onclick`.

Pipe modifiers onto the name:

```mesa
<script>
  function save() {}
  function search() {}
</script>

<form onsubmit|preventDefault={save}>
  <input oninput|debounce(300)={search}>
  <button onclick|once|stopPropagation={save}>Save</button>
</form>
```

| Modifier | Effect |
| --- | --- |
| `once` | Remove the listener after the first call |
| `passive`, `capture` | The matching `addEventListener` option |
| `preventDefault`, `stopPropagation` | Call it for you |
| `self` | Only when `target === currentTarget` |
| `trusted` | Only real user events |
| `debounce(ms)`, `throttle(ms)` | Rate-limit the handler |

Component events are a separate thing; see [Component events](../runtime/component-events.md).

---

Spec: [VISION.md § 8.1](../../VISION.md#81-dom-events) · RULE 29b
