# `<mesa:mounted>`

Hold the whole template back until work you start at mount has finished.

```mesa
<script>
  import { usersService } from '@/resources/User.mesa'
  import { currentUser } from '@/core/app'
  import { goto } from '@/core/router'

  let user

  const mounting = $.mounted(async () => {
    user = await usersService.get(currentUser.id)
  })
</script>

<mesa:mounted onerror={(err) => goto('/error')} />

<section>
  <h1>{user.name}</h1>
  <p>{user.email}</p>
</section>

{#snippet pending()}
  <p>Loading profile...</p>
{/snippet}

{#snippet failed(error)}
  <p>Could not load profile: {error.message}</p>
{/snippet}
```

`$.mounted(fn)` runs `fn` after the component mounts and returns a Promise. The
template renders `pending` until it resolves, so `user` is set by the time
`<section>` is built.

## One call, assigned to a `const`

Write `const ready = $.mounted(fn)`. The template is gated on that name, so a
bare call is refused. A component may call it
once. For several operations, use `Promise.all` inside the one call. To run
something at mount without gating anything, use `$.onMount(fn)` instead.

## It gates everything

Unlike [`<mesa:boundary>`](boundary.md), `<mesa:mounted>` always holds the
entire template, wherever it appears. Self-closing, or wrapping its own `pending`
and `failed` snippets, it behaves the same.

## `onerror` and `failed`

`onerror` runs when the promise rejects, for a redirect or a log. It is
independent of the `failed` snippet: if both are present, both run. The snippets
are found as described on the [`<mesa:boundary>`](boundary.md) page.

---

Spec: [VISION.md § 12.6](../../VISION.md#mesamounted--imperative-mount-gate) · RULE 37 · RULE 38 · RULE 39
