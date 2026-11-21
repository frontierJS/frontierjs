# Sierra

Sierra turns a directory of Mesa components into a routed application. It scans `src/routes/` for the route table, writes the whole Vite config, and binds the running app to a Junction API, so a screen is a file.

```
src/routes/
├── index.mesa          /
├── about.mesa          /about/
└── leads/
    └── [leadId].mesa   /leads/:leadId/
```

```mesa
<script>
  import { page } from '@frontierjs/sierra/router'
  $: (page.params)
</script>

<h1>Lead {page.params.leadId}</h1>
```

## What else it can do

- `createResource('leads')` talks to a Junction service and reads its rules from `db/schema.lite`
- `<Form {resource} />` draws the form the schema describes
- Layouts, frontmatter, guards, named slots and per-route `load()` come with the router
- `target: 'spa'`, `'static'` or `'widget'` builds the same routes as an app, a prerendered site or embeddable scripts
- Prerendered pages become interactive through islands
- A sitemap, redirects, `llms.txt`, a 404 page and an offline shell are written after the build
- Themes and analytics are config, not code

**In depth:** [Sierra README](../../../README.md)
