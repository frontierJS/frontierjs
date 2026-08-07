# Idea — A mutation you can declare beside the page, that works without a bundle

**Status: IDEA. Nothing here is built.** Dated 2026-08-06. Claims about current
behaviour were read off the source with line numbers named. See `VERIFYING.md`.

---

## Trigger

SvelteKit form actions:

```js
// +page.server.js
export const actions = {
  create: async ({ request }) => {
    const data = await request.formData()
    const problems = validate(data)
    if (problems) return fail(400, { problems, values: data })
    throw redirect(303, '/orders')
  }
}
```

A mutation endpoint **declared beside the page it belongs to**, that works with
JavaScript disabled, and that `use:enhance` upgrades to a fetch without changing
a line of it.

## Where FJS stands

`<Form>` shipped 2026-08-06 and is **JavaScript-only**. It intercepts submit,
calls the service over WebSocket or HTTP, maps the rejection to per-field
messages and renders them. With the bundle absent or broken, the form does
nothing at all — the `<form>` has no `action`, so a native submit posts to the
current URL and gets the SPA shell back.

**Every piece this needs already exists**, which is the reason to write this down:

- `transport/body.ts` parses `application/x-www-form-urlencoded` and
  `multipart/form-data` (`CT_URLENCODED`, `CT_MULTIPART`) — a native form POST
  already arrives at a service with `ctx.data` populated.
- `redirectResponse(url, status)` exists in `transport/bridge.ts:325`.
- The schema already produces per-field messages that the browser check and the
  server validator agree on, word for word — that is what `x-messages` is for,
  and `example` asserts the same sentence from both.
- Sierra prerenders `render: static` routes to HTML.
- `<Field>` already renders `errors[name]`, so the shape a re-render would need
  to hand back is the shape the components already take.

So the gap is not capability. **It is that there is no way to declare it**, and
nobody assembles five existing pieces by hand for a case they only notice when
it is too late.

## The idea

A route may declare actions, in the realm's own language:

```html
<!-- web/src/routes/orders/create.mesa -->
<script module>
  // Runs on the server. Same file as the page; not in the client bundle.
  export const actions = {
    create: async ({ data, app }) => app.service('orders').create(data),
  }
</script>

<Form action="create" resource={orders}>
  <Input name="reference" />
  <Button type="submit">Create order</Button>
</Form>
```

- `<Form action="create">` emits a real `action` and `method="post"`, so the
  page works with no JavaScript: post → run → redirect or re-render with
  `errors` populated from `toFieldErrors`, which is already the one owner of
  that translation.
- With the bundle present, `<Form>` does exactly what it does today and never
  navigates. The declaration is the same either way — that is the whole point,
  and it is what `use:enhance` gets right.
- The error contract does not change. `fail()` has no equivalent here because
  it does not need one: the errors map is already the component contract.

## What it turns on

**`<script module>` in a route would have to be able to run server-side.**
Today it runs at import in the browser (Mesa VISION §11, rule 30) and Invariant
18 makes it the home of a Resource's code. Splitting "module scope" into
"module scope that ships" and "module scope that does not" is the real work
here, and it is the same question `server-only-boundary.md` asks from the other
direction — which is why these two should be designed together even though
either could ship alone.

The honest alternative is a separate file (`create.server.mesa`, or
`+page.server.js`-style). Uglier, much smaller, and it makes the boundary
visible in a directory listing rather than inside a file — which
`server-only-boundary.md` argues is the better property anyway.

## Why this is worth doing

Three reasons, in order of how much they matter to this framework:

1. **It is the only version of the UI realm that does not require the API realm
   to be reachable from a browser bundle.** FJS's thesis is three realms and one
   model; today the third realm cannot talk to the second without JavaScript.
2. **It is the natural home for the `static` target.** Sierra prerenders, and a
   prerendered page currently cannot accept input at all — the island seam
   exists for reading, not writing. Form actions are what make a static page a
   real application rather than a brochure, and they compose with `4.4b`'s route
   classification: a route with actions is server-needed, and the compiler can
   say so.
3. **Progressive enhancement is a correctness property, not a nicety.** The
   failure mode today is silent: a bundle that 404s leaves a form that looks
   complete and does nothing on submit. That is the same shape as `FJS-C10`,
   where `example`'s production build loaded no JavaScript and the page looked
   right.

## Open questions

- **Does an action bypass the Service abstraction, or go through it?** Through
  it, presumably — the gates, hooks and validation are all there. But then
  `ctx` is a `ServiceContext` and the action wants request-shaped things
  (redirect, status), which is the `TransportContext`/`ServiceContext` asymmetry
  `CLAUDE.md` already calls the whole trap.
- **What re-renders?** Server-rendering the route through `renderComponent` is
  the SvelteKit answer and Sierra has the machinery (`prerender.js` composes
  route + layout chain). Whether that path is fast enough per request, and what
  it does about a layout that reads a store, is unexplored.
- **Does `<Form>` keep two code paths forever**, or does the enhanced path
  become a thin wrapper over the native one? SvelteKit chose the latter and it
  is why `use:enhance` is small.

## Relationship to the other files

- `server-only-boundary.md` — the same seam from the other side; these want one
  design.
- `static-safety.md` / `overview.md` 4.4b — a route with actions is a route the
  build can classify.
- `forms-from-the-seed.md` — that file is about generating the *fields*; this
  one is about where the *submit* goes. Independent.
