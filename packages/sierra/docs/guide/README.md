# Sierra Guide

What a screen can do and how to build one, one quick page per idea. The guide
shows what is possible; the README beside this folder explains it.

A page is a skim, not a lesson:

- one or two sentences on what the feature is for
- one example, the smallest that shows it working
- a short list of what else it can do, a line each, with no explanation
- a closing **In depth** link to the doc its `from` note names

Edge cases, refusals, rulings and `FJS-` ids belong in the full doc. If a page
needs a second example to make sense, that material belongs in the full doc and
the page links to it.

A runnable example is a `js` fence, run by `test/doc-examples.test.js` with
`leads` (a resource over a live Junction app) and `userLevel` in scope; markup is
an `html` or `mesa` fence and is not run. A sliver that names something the
page does not declare is a `js fragment`.

This list is the page order. The website builds `/docs/sierra/` from it, so a
page that is not listed here is not published. Styling, the component kit, site
building, other surfaces and printing are their own packages; the last section
points at them and does not restate them.

## Introduction

- [Overview](introduction/overview.md)
<!-- from: README.md § top, Quick start -->
- [Getting started](introduction/getting-started.md)
<!-- from: README.md § Installation, Quick start -->
- [Project layout](introduction/project-layout.md)
<!-- from: README.md § Configuration; /CLAUDE.md Invariant 3; docs/layout.md -->

## Routing

- [Pages and paths](routing/pages-and-paths.md)
<!-- from: README.md § Routing, File roles, Path syntax -->
- [Layouts](routing/layouts.md)
<!-- from: README.md § Layouts -->
- [Frontmatter](routing/frontmatter.md)
<!-- from: README.md § Frontmatter -->
- [The page object](routing/the-page-object.md)
<!-- from: README.md § The `page` object -->
- [Navigation](routing/navigation.md)
<!-- from: README.md § Navigation API, Prefetching -->
- [Guards and hooks](routing/guards-and-hooks.md)
<!-- from: README.md § Guards and hooks -->
- [Named slots](routing/named-slots.md)
<!-- from: README.md § Named slots -->
- [Loading data for a page](routing/data-loading.md)
<!-- from: README.md § Data loading -->

## Resources

- [A resource](resources/a-resource.md)
<!-- from: README.md § Junction binding, Resources, Naming: service ⇄ model -->
- [Seeded from the schema](resources/schema-seeding.md)
<!-- from: README.md § Schema seeding -->
- [Field rules](resources/field-rules.md)
<!-- from: README.md § Field rules -->
- [Coercion and blanks](resources/coercion.md)
<!-- from: README.md § Coercion, Blank → null -->
- [Relations](resources/relations.md)
<!-- from: README.md § Relations -->
- [The gate in the browser](resources/gate.md)
<!-- from: README.md § Gate -->
- [Connection and another app](resources/connection.md)
<!-- from: README.md § A header on every call, Connection state, Another app -->
- [Signed-in state](resources/auth.md)
<!-- from: README.md § Auth -->
- [Presence](resources/presence.md)
<!-- from: README.md § Presence -->
- [Search](resources/search.md)
<!-- from: README.md § Search -->

## Building

- [Configuration](build/configuration.md)
<!-- from: README.md § Configuration -->
- [Build targets](build/targets.md)
<!-- from: README.md § Build targets -->
- [Prerendering](build/prerendering.md)
<!-- from: README.md § Build targets, The document around a prerendered page -->
- [Islands](build/islands.md)
<!-- from: README.md § Islands — making a static page interactive -->
- [After the build](build/post-build.md)
<!-- from: README.md § Post-build pipeline -->
- [Developing](build/dev-experience.md)
<!-- from: README.md § Dev experience -->
- [The theme](build/theme.md)
<!-- from: README.md § Theme -->

## Around Sierra

- [Styling with @frontierjs/css](around/styling.md)
<!-- from: ../css/README.md § The idea, Three kinds of class, Tones, Themes, Using it with UnoCSS -->
- [Components with @frontierjs/ui](around/components.md)
<!-- from: ../ui/README.md § What's in the box, Forms know what they are editing -->
- [A markdown site with site-kit](around/site-kit.md)
<!-- from: ../site-kit/README.md -->
- [Other surfaces](around/surfaces.md)
<!-- from: ../jetty/README.md § Using it in an app; /example/README.md; README.md § Build targets -->
- [PDFs and images with print-kit](around/print-kit.md)
<!-- from: ../print-kit/README.md -->
