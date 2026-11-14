# Virtual lists

You need this page when a list has thousands of rows and rendering them all is
slow. `{#virtual each}` mounts only the rows in view and pads the rest with
spacers so the scrollbar stays honest.

```mesa
<script>
  let rows = Array.from({ length: 10000 }, (_, i) => ({
    id: i,
    name: 'Row ' + i,
    value: i * 3,
  }))
</script>

{#virtual each rows as row (row.id) height=48 viewport="500px"}
  <div class="row">
    <span>{row.name}</span>
    <span>{row.value}</span>
  </div>
{/virtual}

<style>
  .row { display: flex; justify-content: space-between; height: 48px; }
</style>
```

## Options

Options go last, after the optional `(key)`:

- `height=N` is the height of one row in pixels. Every row must be that tall.
  Leave it off and Mesa measures the first rendered row. Declare it when the row
  height comes from a stylesheet, because the first measurement happens before
  the stylesheet lands.
- `viewport="500px"` sets the height of the element the block sits in, which
  becomes the scroller. Leave it off and that element must already have a height
  and `overflow-y`.

An option Mesa does not know is a compile error that lists the two it does.

## How it works

The rows and two spacer `div`s are appended inside the element the block sits
in. On scroll, a `requestAnimationFrame` handler works out which rows should be
visible, disposes the ones that scrolled out and mounts the new ones. Each row is
a full reactive block, so signals, `bind:value` and child components work inside
it. A row that scrolls out loses its local state when it is disposed.

## What bites

- **Fixed height only.** Rows of varying height are not supported. A row taller
  or shorter than `height` makes the scroll position drift.
- **The block's parent is the scroller.** Put the block in its own element so
  the spacers do not mix with other children.
- **On the server it renders a window, not nothing.** With no viewport to
  measure, the first window comes from the declared (or fallback) height, and the
  bottom spacer carries the rest, so a prerendered page has its first screen of
  rows.

---

Spec: [VISION.md § 9.7](../../VISION.md#97-virtual-list--virtual-each) · RULE 34
