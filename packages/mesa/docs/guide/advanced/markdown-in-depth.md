# Markdown in depth

You need this page when a `.md` file does more than prose: it interpolates
values, branches or loops, drops in interactive components, or runs through your
own remark and rehype plugins. For the basics, see
[Markdown files](../introduction/markdown-files.md).

```md
---
title: Launch notes
tags: [mesa, release]
featured: true
---

<script>
  import Counter from './Counter.mesa'
  let likes = 0
</script>

# {title}

{#if featured}
**This post is featured.**
{/if}

<Counter client:visible start={3} />

<p><button onclick={() => likes++}>Like {likes}</button></p>
```

Frontmatter keys become `export const` declarations, so `{title}` reads the
frontmatter. The file extension decides the language: `.md` is compiled as
markdown, and a `---` block at the top of a `.mesa` file is only metadata.

## `{…}` in prose is a path

In a `.md` file, a brace in prose interpolates a bare path (an identifier or a
member chain) and nothing else. Anything else is literal text, with no error:

```md
{title}                 interpolates
{post.author?.name}     interpolates
{ title }               literal: a path has no spaces
{items[0]}              literal: an index is not a member chain
{1, 2, 3}               literal
\{title}                renders {title}
```

That keeps a stray brace in prose from being compiled as JavaScript and
eaten. The price is that `{a + b}` does not work in prose. Compute it in
`<script>` (`const sum = a + b`) and write `{sum}`.

An attribute value is unchanged and takes any expression, as does every `{…}` in
a `.mesa` file. An unclosed brace is still a compile error, in `.md` as in
`.mesa`.

## Block directives

`{#if}`, `{#each}` and the other blocks work in the markdown body:

```md
{#if featured}
**This post is featured.**
{/if}

{#each tags as tag (tag)}
- {tag}
{/each}
```

Markdown is processed once per branch or iteration, so each pass of the `{#each}`
above becomes its own `<ul>` with one item. For one list, write the HTML in the
loop:

```md
<ul>
  {#each tags as tag (tag)}
    <li>{tag}</li>
  {/each}
</ul>
```

Mesa closes no element for you, so an inline element on its own line is wrapped
in a block yourself, as the `<p><button>` above is. Otherwise markdown opens a
`<p>` that nothing closes.

## `client:*`

A `client:*` directive on a component in markdown is an island, with the same
meaning as in a `.mesa` file: `client:load`, `client:idle`, `client:visible`,
`client:media="(query)"` and `client:static`. See [Islands](islands.md). Compile
with `islands: true` to get the markers.

## Compiling

```js
import { compileSource, compileFile } from '@frontierjs/mesa'

const ctx = await compileSource(source, { filename: 'Post.md' })   // by extension
const same = await compileFile('./pages/about.md')                 // reads the file

ctx.result        // compiled JS module string
ctx.analysis      // .errors and .warnings
ctx.isStatic      // true if the page needs no JavaScript at runtime
ctx.frontmatter   // the parsed frontmatter, for .md and .mesa alike
ctx.layout        // frontmatter.layout, or null
```

`compileSource` routes on the filename: `.md` goes to the markdown compiler,
anything else to the Mesa compiler. `compile(source, config)` always compiles
Mesa, and `compileMd` from `@frontierjs/mesa/compiler-md` always compiles
markdown.

## Remark and rehype plugins

Pass your own plugins with two options. Remark plugins run after `remark-gfm`,
and rehype plugins run after `rehype-slug` and before `rehype-stringify`. An
entry is a plugin function or a `[plugin, options]` pair, as in unified's
`.use()`:

```js
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'

const ctx = await compileSource(source, {
  filename: 'Post.md',
  remarkPlugins: [remarkMath, [remarkSomething, { option: 'value' }]],
  rehypePlugins: [rehypeKatex],
})
```

The markdown packages (unified, remark, rehype) are optional peers, so the app
installs them. With no plugins you pay nothing for the option.

---

Spec: [VISION.md § 18.4 to 18.7](../../VISION.md#184--in-prose-is-a-path) · RULE 63 · RULE 26
