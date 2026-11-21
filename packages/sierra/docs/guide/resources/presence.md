# Presence

`presence(channel)` is who else is on a channel, as a signal: a roster that updates as people join and leave, for an avatar strip, a cursor or a "typing" flag.

```html
<script>
  import { presence } from '@frontierjs/sierra/presence'
  const members = presence('workspace:42', { meta: { name: user.name } })
</script>

<p>{members.count} here</p>
{#each members.others as m}<span>{m.meta.name}</span>{/each}
```

This page has no running example: presence is a fact about a live socket connection, with no HTTP fallback.

## What else it can do

- The value is `{ members, others, self, count }`
- `members.updateMeta(meta, { debounce })` publishes a new meta for this connection
- `members.leave()` stops, and a component that called `presence()` at init scope leaves on destroy
- Two views of one channel on a page share the channel until the last one unmounts
- The server joins a connection to a channel from its own `channels(setup)`, and a browser cannot join itself
- A signed-out connection is never tracked
- A reconnect announces every channel again

**In depth:** [Sierra README § Presence](../../../README.md#presence)
