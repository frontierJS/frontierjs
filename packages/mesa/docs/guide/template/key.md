# `{#key}`

Destroy and recreate a block whenever an expression changes.

```mesa
<script>
  import Profile from './Profile.mesa'

  let userId = 1
</script>

<button onclick={() => userId++}>Next user</button>

{#key userId}
  <Profile id={userId} />
{/key}
```

Each time `userId` changes, the old `<Profile>` is torn down and a new one is
built. Nothing inside survives: component state, DOM nodes, an input's text and
`$.onMount` all start over.

## When to reach for it

Use it to reset a component's internal state when its subject changes, to replay
a CSS enter animation, or to run `$.onMount` again. If you only want a component
to show new data, pass the value as a prop instead; no key needed.

---

Spec: [VISION.md § 9.4](../../VISION.md#94-key-block--key-expr) · RULE 27
