# @frontierjs/config

The tooling opinion a FrontierJS application extends in one line. No source, no
binary, no runtime — three files and the reasoning behind them.

```bash
bun add -d @frontierjs/config @biomejs/biome typescript
```

`fli new` adds it for you. This package exists so that the opinion is a
**dependency and not a copy**: a rule improved here reaches every app that
already exists, where a file the scaffold wrote is frozen at the moment it was
written.

## What an app extends

```jsonc
// tsconfig.json
{ "extends": "@frontierjs/config/tsconfig", "include": ["api/**/*", "web/**/*"] }
```

```json
// biome.json
{ "extends": ["@frontierjs/config/biome"] }
```

`.editorconfig` is the exception, because EditorConfig has no extends
mechanism — the scaffold writes the text, and this package holds the original it
was written from.

## There is no formatter, and that is a decision

`biome.json` ships `"formatter": { "enabled": false }`.

FrontierJS aligns columns where a run of lines is parallel — imports, object
literals, `const` blocks:

```ts
import { withDb }  from './core/hooks.ts'
import { env }     from './core/env.ts'
```

Prettier, Biome and dprint all collapse that to a single space, and none of the
three can express it — an opinionated formatter's whole proposition is that
whitespace carries no information, and this rule says it carries some. The
framework's canonical files are written that way and so is the code `fli new`
generates, so the first format run of any of the three would rewrite the app it
had just scaffolded.

The rejected third path is a `biome-ignore format:` comment above every aligned
run. That is a comment whose only reader is a tool, in a house whose rule is
that a comment must be load-bearing or deleted.

`"assist": { "enabled": false }` comes with it for the same reason: Biome's
import sorting reorders an aligned import block, which is a format change
wearing a lint rule's clothes.

## What the linter is for, then

Correctness, security and the suspicious-pattern set — plus accessibility,
which reaches `index.html`. The `style`, `complexity` and `performance` groups
are off. With the formatter refused, a linter that argues about style is a
formatter that cannot fix anything.

`noExplicitAny` is off because a framework boundary types values it did not
create; `noUnusedVariables` is a warning rather than an error because a
destructure that drops a key is a legitimate shape.

## What it cannot see

**Biome reads neither `.mesa` nor `.lite`**, and neither can ESLint or dprint
without a hand-written processor. Those two files are where an FJS application's
real mistakes live, which draws the boundary this package is one half of:

> A linter owns generic JavaScript correctness. **`fli check` owns everything
> derived from the seed** — a model name that is not PascalCase singular, a
> resource file that is not named for its noun, a Vite config without
> `strictPort`, the body tag mentioned inside a comment. Neither reimplements
> the other, and the VS Code extension surfaces both rather than implementing
> either.

The reason is not tooling immaturity: doctor-class questions are cross-file.
*Does this resource name resolve to a model?* cannot be answered from the file
it appears in, and that is where every entry in the hazard catalogue lives.

A scaffolded app's `bun run check` runs `fli check` **first**, because it is the
half a linter cannot reach.

## Versioning

Loosening a rule is a patch. Adding one is a minor, and it can fail an app's CI
on code that has not changed — which is the price of the config being a
dependency, and the reason it is worth paying only for rules that catch bugs.
