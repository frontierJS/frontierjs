# FrontierJS — VS Code Extension

Language support for FrontierJS projects.

## Litestone (`.lite`, `.litestone`)

Full language server for Litestone schema files:

- **Syntax highlighting** — models, enums, functions, attributes, types, `{field}` references
- **Diagnostics** — parse errors and validation warnings as you type
- **Completions** — field types, `@attributes`, `@@model-attributes`, `@funcName(fieldArg)` calls, model/enum names
- **Hover** — attribute docs, type docs, model/enum/function signatures on hover
- **Go-to-definition** — jump from a model reference to its declaration, from `@funcName` to the function block
- **Formatting** — aligned field columns, normalised spacing (`Format Document` or format on save)

### Quick start

```prisma
// schema.lite

enum Plan { starter  pro  enterprise }

function slug(text: String): String {
  @@expr("lower(replace({text}, ' ', '-'))")
}

model Account {
  id        Int  @id
  name      String
  slug      String     @slug(name)
  plan      Plan     @default(starter)
  createdAt DateTime @default(now())
}
```

Errors appear as red squiggles. Hover over any type or attribute for documentation.
`Ctrl+Space` for completions. `Shift+Alt+F` to format.

## MESA

Syntax highlighting, snippets, language configuration, hover documentation,
completions (`$`, `{`, `:`, `|`, `<`) and the outline panel are active for
`.mesa` files.

**Diagnostics need the Mesa compiler**, which is your workspace's own rather
than a copy shipped here — the extension resolves `@frontierjs/mesa` from
`node_modules`, from a `packages/mesa` above the file you are editing, or from
`mesa.compilerPath`. Without it the other four features still work and the
extension says so once.

## Extension settings

| Setting | Default | Description |
|---|---|---|
| `litestone.formatOnSave` | `true` | Auto-format `.lite` files on save |
| `litestone.trace.server` | `"off"` | LSP trace level (`"off"` / `"messages"` / `"verbose"`) |
| `litestone.parserPath` | `""` | Absolute path to your `litestone/src` directory. Leave empty for auto-resolve (sibling monorepo directory or installed npm package). |
| `mesa.compilerPath` | `""` | Path to `@frontierjs/mesa`'s `src/compiler.js`, or to the package directory. Leave empty for auto-resolve. |
| `mesa.validateOnType` | `true` | Validate Mesa files as you type (debounced). Disable for large files. |
| `mesa.validateDelay` | `300` | Debounce delay in ms for on-type validation. |

## Development

```bash
npm install
npm run watch   # watch mode

# Press F5 in VS Code to launch the Extension Development Host
```

To debug the language server: use the **Extension + Server** compound launch config.

```bash
npm test               # builds, then 88 assertions across three suites:
                       #   46  Litestone — the built server over real LSP/stdio
                       #   36  Mesa — the providers against a stubbed editor
                       #    6  Snippets — every `$` in every body
npm run package        # → vscode-frontierjs-<version>.vsix
npm run verify:package # packs, unpacks, and tests the .vsix itself
```
