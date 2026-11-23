# Islands

A prerendered page ships HTML and CSS and no script, so on its own it never responds to anything. An island is a component you mark with a `client:*` directive so the page loads just that piece's script.

```mesa
<script>
  import Counter from '../islands/Counter.mesa'
</script>

<main>
  <h1>prerendered, ships no JS</h1>
  <Counter client:load start={7} />
</main>
```

## What else it can do

- `client:load` mounts at once and `client:idle` waits for the browser to be idle
- `client:visible` waits until the island scrolls into view
- `client:media="(min-width: 600px)"` mounts when the query matches
- `client:static` never mounts, and its chunk is never fetched
- Each island is its own chunk, fetched when its directive fires
- A click on an island before it mounts fetches it at once and lands on the live element after
- A key reaches an island before it mounts only through an element that names it in `aria-keyshortcuts="Control+K /"`: the key presses that element once the island is live. A key that presses no element, like a game's arrows, is lost until the island mounts
- A page with no island gets no script tag
- Props are serialized into the page, so they must survive JSON
- An island's CSS ships once, in the prerendered page
- `islands: false` in the config turns the pass off
- `hydratable: true` in the config adopts the whole page instead of mounting islands: the server's HTML is kept, `client:*` says when a piece attaches its handlers, and pieces share `$context`, stores and the route's `load()` data ([STATIC_RENDERING.md § Status](../../../../mesa/docs/STATIC_RENDERING.md#status))

**In depth:** [README § Islands](../../../README.md#islands--making-a-static-page-interactive)
