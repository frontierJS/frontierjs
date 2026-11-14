# Mesa Guide

How to write Mesa, one short page per primitive. The spec is
[`../VISION.md`](../VISION.md); a page links to the RULE it teaches rather than
restating it.

This list is the page order. The website builds `/docs/mesa/` from it, so a page
that is not listed here is not published.

## Introduction

- [Overview](introduction/overview.md)
- [Getting started](introduction/getting-started.md)
- [`.mesa` files](introduction/mesa-files.md)
- [Markdown files](introduction/markdown-files.md)

## Reactivity

- [`let`](reactivity/let.md)
- [`const`](reactivity/const.md)
- [`var`](reactivity/var.md)
- [Props](reactivity/props.md)
- [Shared state](reactivity/shared-state.md)
- [Objects and arrays](reactivity/objects-and-arrays.md)
- [`$:` watches and effects](reactivity/watches-and-effects.md)
- [Writable derived](reactivity/writable-derived.md)

## Template syntax

- [Basic markup](template/basic-markup.md)
- [`{#if}`](template/if.md)
- [`{#each}`](template/each.md)
- [`{#await}`](template/await.md)
- [`{#key}`](template/key.md)
- [`{#snippet}` and `{@render}`](template/snippet.md)
- [`<slot />`](template/slot.md)
- [`{@html}`](template/html.md)
- [`{@attach}`](template/attach.md)
- [`bind:`](template/bind.md)
- [`class:` and `style:`](template/class-and-style.md)

## Styling

- [Scoped styles](styling/scoped-styles.md)
- [Passing a class](styling/class-passthrough.md)

## Special elements

- [`<mesa:window>`](special-elements/window.md)
- [`<mesa:document>` and `<mesa:body>`](special-elements/document-and-body.md)
- [`<mesa:head>`](special-elements/head.md)
- [`<mesa:portal>`](special-elements/portal.md)
- [`<mesa:element>`](special-elements/element.md)
- [`<mesa:boundary>`](special-elements/boundary.md)
- [`<mesa:mounted>`](special-elements/mounted.md)

## Runtime

- [Lifecycle](runtime/lifecycle.md)
- [Context](runtime/context.md)
- [Component events](runtime/component-events.md)
- [Async](runtime/async.md)
- [Timers and measuring](runtime/timers-and-measuring.md)
- [Animations](runtime/animations.md)
- [Debugging](runtime/debugging.md)

## Advanced

- [Timing and the flush](advanced/timing-and-the-flush.md)
- [Ordered watch groups](advanced/watch-groups.md)
- [Lifetimes — `createRoot`](advanced/create-root.md)
- [External reactivity](advanced/external-reactivity.md)
- [Dynamic paths](advanced/dynamic-paths.md)
- [Server rendering](advanced/server-rendering.md)
- [Islands](advanced/islands.md)
- [Shadow DOM](advanced/shadow-dom.md)
- [Virtual lists](advanced/virtual-lists.md)
- [Input masking](advanced/input-masking.md)
- [Markdown in depth](advanced/markdown-in-depth.md)

## Misc

- [Testing](misc/testing.md)
- [Vite, HMR and DevTools](misc/vite-hmr-devtools.md)
- [Coming from Svelte](misc/coming-from-svelte.md)

## Reference

- [`@frontierjs/mesa` — compiler](reference/compiler.md)
- [`@frontierjs/mesa/runtime`](reference/runtime.md)
- [`@frontierjs/mesa/render`](reference/render.md)
- [`@frontierjs/mesa/drive`](reference/drive.md)
- [Errors and warnings](reference/errors-and-warnings.md)
- [Every rule](reference/rules.md)
