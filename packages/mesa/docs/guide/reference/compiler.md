# `@frontierjs/mesa` — compiler

The compiler turns `.mesa` and `.md` source into an ES module. It is exported
from `@frontierjs/mesa` and from `@frontierjs/mesa/compiler` (the same file).
Markdown has its own entry, `@frontierjs/mesa/compiler-md`.

```js
import { compile, compileSource, compileFile } from '@frontierjs/mesa'
```

Every function is async and answers one object, `ctx`. A build reads
`ctx.result` and decides what to do about `ctx.analysis.errors`. See
[Errors and warnings](errors-and-warnings.md).

## `compile`

```js
compile(source: string, options?: object): Promise<ctx>
```

Compiles a `.mesa` source string. It never routes to Markdown, whatever the
filename says.

## `compileSource`

```js
compileSource(source: string, options?: object): Promise<ctx>
```

Compiles by file extension: a `filename` ending in `.md` goes to
[`compileMd`](#compilemd), anything else to `compile`. The extension decides the
language. A `---` block at the top of a `.mesa` file is metadata (a route's title,
its render mode): it is stripped, returned as `ctx.frontmatter`, and does not
turn the file into Markdown. `options.path` works as an alias for `filename`.

## `compileFile`

```js
compileFile(filepath: string, options?: object): Promise<ctx>
```

Reads the file, then calls `compileSource` with `filename` set to the path.

## `compileMd`

```js
import { compileMd } from '@frontierjs/mesa/compiler-md'

compileMd(source: string, options?: object): Promise<ctx>
```

Compiles Markdown with frontmatter. Frontmatter keys become `export const`
declarations, and `{expressions}`, blocks and components work in the prose. It
needs the unified packages installed in your app; without them the import fails
with an error that names the install line. See
[Markdown files](../introduction/markdown-files.md).

## Options

| Option | Default | Effect |
|---|---|---|
| `filename` | `''` | Names the file in error messages, dev labels and source positions, and picks the language in `compileSource` |
| `dev` | `false` | Emit the registration calls DevTools and HMR read, and turn `loc` on |
| `debug` | `true` | `false` strips every `$.inspect` call from the output |
| `css` | `true` | `true` emits the scoped styles into `ctx.result` as an `addStyles` call. `false` emits nothing and hands them back on `ctx.css.result` |
| `loc` | the value of `dev` | Stamp each template element with `data-fjs-loc="File.mesa:line:column"`, which click-to-source reads |
| `preserveComments` | `false` | Keep HTML comments in the template |
| `compact` | `true` | Collapse whitespace in the template. `'full'` collapses it inside text nodes too. It is never collapsed in `<pre>` or `<textarea>` |
| `warning` | `console.warn` | Called with `{ message }` for every error and warning the compile collects |
| `externalReactivityHints` | `'default'` | `'strict'` also warns about every read off an imported object that no `$:` watch covers |
| `externalSignals` | none | Maps a module path to the names it exports that are signals, so reads of them are reactive |
| `remarkPlugins` | `[]` | `.md` only. Plugins for the Markdown stage, each a function or a `[plugin, options]` pair |
| `rehypePlugins` | `[]` | `.md` only. The same, for the HTML stage |

With `css: false` every element still carries the scope class, so a page whose
caller forgets to inject `ctx.css.result` looks right in the markup and matches
no rule.

## The result

| Field | Holds |
|---|---|
| `ctx.result` | The compiled JavaScript module, as a string |
| `ctx.analysis.errors` | Strings. Anything in here means the output must not ship |
| `ctx.analysis.warnings` | Strings. The build succeeds and the code is probably wrong |
| `ctx.css.result` | The scoped CSS. Filled only when `css: false` |
| `ctx.css.id` | The content-addressed scope class on every element. Two components with identical CSS share an id |
| `ctx.frontmatter` | The parsed frontmatter object, for `.md` and `.mesa`. `undefined` when the file has none |
| `ctx.layout` | `.md` only: the frontmatter `layout` value, or `null` |
| `ctx.isStatic` | `true` when the component needs no JavaScript at runtime |
| `ctx.islands` | Each `client:*` call site, for a loader that maps a component name to a module |

## Errors and parse failures

The compiler reports and the build decides. A broken construct is pushed onto
`ctx.analysis.errors` and `compile` still answers, so a caller that ignores the
list will ship broken output. A source that cannot be parsed at all (an unclosed
element, a `$:` where it does not belong, a banned spelling such as `on:click`)
throws instead, with the position in the message.

```js
const ctx = await compileSource(source, { filename: 'Counter.mesa' })
if (ctx.analysis.errors.length) throw new Error(ctx.analysis.errors.join('\n'))
```

The Vite plugin does this for you. See [Vite, HMR and DevTools](../misc/vite-hmr-devtools.md).

---

Spec: [VISION.md § 18.7](../../VISION.md#187-compilation-api) · RULE 53
