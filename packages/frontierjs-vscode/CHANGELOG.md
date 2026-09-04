# Changelog

The user-facing history of the FrontierJS VS Code extension. Engineering detail
— why a defect existed and what it cost — is in `CHANGES.md` in the repository.

## 0.1.0 — unreleased

First release. Litestone gets a language server; Mesa gets editor support.

### Litestone (`.lite`, `.litestone`)

- **Diagnostics** as you type, from the real parser rather than a copy of it.
  A document mid-keystroke usually does not parse, and that is the normal state
  rather than invalid input — the server stays up and reports what it can.
- **Imports are followed.** A schema that imports a package's models
  (`import "@frontierjs/auth/schema.lite"`) is parsed with those models present,
  so a relation pointing at one is no longer an error nobody could remove. An
  import that resolves to nothing is not reported: the package may simply not be
  installed. The root is the open buffer, so unsaved edits are what you see.
- **Completions** for field types, `@attributes`, `@@model-attributes`,
  `@funcName(fieldArg)` calls, and model and enum names. What the language
  contains is asked of Litestone's own catalog, so the offered set cannot drift
  behind the language.
- **Hover** documentation for attributes, types, models, enums and functions,
  including where a word is legal and what its arguments accept.
- **Go-to-definition** from a model reference to its declaration, and from
  `@funcName` to its function block.
- **Formatting** — aligned field columns and normalized spacing, on demand or
  on save.

### Mesa (`.mesa`)

- **Syntax highlighting** with embedded JavaScript and CSS, plus coloring that
  separates `let` (reactive), `const` (derived) and `var` (non-reactive).
- **Hover**, **completions** (`$`, `{`, `:`, `|`, `<`) and the **outline** panel,
  which groups props and state.
- **Snippets** for both languages.
- **Diagnostics** need the Mesa compiler, and it is your workspace's own rather
  than a copy shipped here — resolved from `node_modules/@frontierjs/mesa`, from
  a `packages/mesa` above the file being edited, or from `mesa.compilerPath`.
  Without it the other features still work and the extension says so once.
