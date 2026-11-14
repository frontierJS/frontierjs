# Markdown files

A `.md` file is a Mesa component whose template is markdown. Frontmatter, a
`<script>` block, components, `{#if}` and `{#each}` all work, so a post can hold a
live widget.

```md
---
title: My Post
date: 2025-01-15
---

<script>
  import Counter from './Counter.mesa'

  const year = new Date(date).getFullYear()
  let likes = 0
</script>

# {title}

Published in {year}.

{#if likes > 0}
  Thanks for {likes} likes!
{/if}

<p><button onclick={() => likes++}>Like</button></p>

<Counter start={5} />
```

## Frontmatter becomes values

Each frontmatter key is declared for you as a read-only prop, so `{title}` works
in the page and `date` works in the script with no declaration. A caller can pass a
different value for the same name, and the frontmatter is the fallback.

## `{…}` in prose is a path

In prose, a brace holds an identifier or a member chain such as `{post.author.name}`
and nothing else. Anything else is literal text, so `{1, 2, 3}` prints as written.
Write `\{title}` to print a brace that would otherwise open a path. For arithmetic,
compute a `const` in the script and print that, as `year` does above.

Inside an element's attributes, `{…}` takes any expression, as it does in a
`.mesa` file.

## Going further

Interactive islands with `client:*` directives and remark and rehype plugins are
covered in [Markdown in depth](../advanced/markdown-in-depth.md).

---

Spec: [VISION.md § 18](../../VISION.md#181-frontmatter) · RULE 63
