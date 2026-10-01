# site-kit — package map

**`@frontierjs/site-kit`** — the engine of a markdown-authored static site. A
site is `content/` over this package; everything a site would otherwise copy
lives here.

**Private on purpose.** It is in no list — not the website's package pages
(they walk `packages/*` and skip `private`), not npm. It is a workspace member
through the root `website/packages/*` glob, which is the only thing that
installs it; a package under `website/packages/` outside that glob is
uninstalled and says nothing.

**Two consumers, one engine.** `website/site/` first, then
`fjs-prototypes/ksite` extending it. A generic piece here and a ksite fork of
it is the outcome this package exists to prevent.

## Layout

No source yet. `src/` arrives with the first piece moved out of ksite's engine.

## Proving a change

`website/`'s own `bun run test` — the build and the verify drive over the site
that consumes it. A linked workspace never puts a file under `node_modules/`,
so a defect that only a published engine has (`FJS-1552`) is ksite's to find.
