# Project layout

A FrontierJS app has one directory per realm at its root: `db/` for the schema, `api/` for Junction, and `web/` for Sierra. Sierra owns `web/` and only `web/`, and the schema is found at `../db/schema.lite` because it is a sibling.

```
my-app/
├── db/
│   └── schema.lite
├── api/
└── web/                  ← the Vite root
    ├── index.html
    ├── config/
    │   ├── vite.config.js
    │   ├── sierra.config.js
    │   └── routes.js     ← generated, do not edit
    ├── public/
    ├── src/
    │   ├── main.js
    │   ├── App.mesa
    │   ├── routes/
    │   ├── resources/
    │   └── components/
    ├── test/
    └── dist/
```

## What else it can do

- Every sub-project, `web/` or another surface, has the same six folders: `config/`, `src/`, `public/`, `test/`, `dist/` and `deploy/`
- `routesDir`, `outDir` and `routeTable.output` are relative to the Vite root (`web/`), never to `config/`
- `site/`, `widgets/`, `extension/`, `desktop/`, `mobile/` and `cli/` are surfaces beside `web/`, and each is its own Vite root
- A surface never imports another surface, and code two of them share lives in `shared/` (imported as `#shared/*`) or `db/`
- `src/resources/` holds the `createResource` bindings, one `.mesa` file per model
- `schema: 'path/to/schema.lite'` or `schema: false` overrides the schema auto-detection
- `config/routes.js` is committed, since the route table is a naming convention over the file tree

**In depth:** [Sierra README § Quick start](../../../README.md#quick-start), [§ Configuration](../../../README.md#configuration)
