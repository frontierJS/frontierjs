# Named slots

A page can push content up into its layout, such as a sidebar that only some pages have. Both sides are plain markup.

```mesa
<!-- route: src/routes/blog/[slug].mesa -->
<mesa:slot name="sidebar">
  <nav>Related posts</nav>
</mesa:slot>

<h1>{page.title}</h1>
```

```mesa
<!-- layout: src/routes/blog/_module.mesa -->
<aside><slot name="sidebar">No sidebar for this page.</slot></aside>
<main><slot /></main>
```

## What else it can do

- `<slot />` is the default slot, which is the route itself
- `<slot name="X">` takes fallback content for a page that provides nothing
- `{#if $slots.sidebar}` asks whether the current page provided a slot
- `provideSlot(name, snippetFn)` from `@frontierjs/sierra/router` registers a slot from script
- `page.slots` holds the slots the current page provided

**In depth:** [Sierra README § Named slots](../../../README.md#named-slots)
