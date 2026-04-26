# FrontierJS — VS Code Extension

Language support for FrontierJS projects.

## Litestone (`.lite`, `.litestone`)

Full language server for Litestone schema files:

- **Syntax highlighting** — models, enums, functions, attributes, types, `{field}` references
- **Diagnostics** — parse errors and validation warnings as you type
- **Completions** — field types, `@attributes`, `@@model-attributes`, `@funcName(fieldArg)` calls, model/enum names
- **Hover** — attribute docs, type docs, model/enum/function signatures on hover
- **Go-to-definition** — jump from a model reference to its declaration, from `@funcName` to the function block
- **Formatting** — aligned field columns, normalized spacing (`Format Document` or format on save)

### Quick start

```prisma
// schema.lite

enum Plan { starter  pro  enterprise }

function slug(text: Text): Text {
  @@expr("lower(replace({text}, ' ', '-'))")
}

model accounts {
  id        Integer  @id
  name      Text
  slug      Text     @slug(name)
  plan      Plan     @default(starter)
  createdAt DateTime @default(now())
}
```

Errors appear as red squiggles. Hover over any type or attribute for documentation.
`Ctrl+Space` for completions. `Shift+Alt+F` to format.

## MESA

Syntax highlighting, snippets, and language configuration for `.mesa` files are active. Semantic features (diagnostics, completions, hover) are coming in the next release.

## Extension settings

| Setting | Default | Description |
|---|---|---|
| `litestone.formatOnSave` | `true` | Auto-format `.lite` files on save |
| `litestone.trace.server` | `"off"` | LSP trace level (`"off"` / `"messages"` / `"verbose"`) |
| `litestone.parserPath` | `""` | Absolute path to your `litestone/src` directory. Leave empty for auto-resolve (sibling monorepo directory or installed npm package). |
| `mesa.compilerPath` | `""` | Path to `compiler.js`. Defaults to `node_modules/@mesa/compiler/compiler.js` in workspace root. |
| `mesa.validateOnType` | `true` | Validate Mesa files as you type (debounced). Disable for large files. |
| `mesa.validateDelay` | `300` | Debounce delay in ms for on-type validation. |

## Development

```bash
npm install
npm run watch   # watch mode

# Press F5 in VS Code to launch the Extension Development Host
```

To debug the language server: use the **Extension + Server** compound launch config.
