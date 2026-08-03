# The style guide

The interactive reference: 45 pages, every component live, six themes.
No React, no build step, no bundler — the same bet the package itself makes.

Converted from `style-guide.jsx` on 2026-08-02, which is now retired; the last
version of it is in git history if you need to compare.

## Run it

```sh
open packages/css/guide/index.html      # file:// works, nothing is a module
```

or, for DevTools and a phone on the same network:

```sh
bun run demo        # serves the package root
# → http://localhost:5173/guide/
```

## What is here

| File         | What it is                                                     |
| ------------ | -------------------------------------------------------------- |
| `index.html` | The shell. `<link>`s the real `../index.css`, then `guide.js`.  |
| `guide.js`   | Data, page builders, and a hash router. One file, plain JS.     |
| `guide.css`  | The guide's own chrome (`.sg-*`) plus a few preview utilities.  |

The design system CSS is **linked, never copied**, so the guide cannot drift
from the source — the same rule the JSX version established in v0.6.

## How it is put together

Each nav entry is one function returning an HTML string, registered in the
`PAGES` map at the bottom of `guide.js`. A page that needs behavior hangs an
`init(root)` off its own function; the router calls it after mount.

Two rules worth knowing before editing:

- **Interactivity is wired by delegation from `data-*` attributes**, never by
  inline handlers, so the markup in a preview stays copy-pasteable — what you
  read is what you would write in an app.
- **The page host node is replaced on every render, not refilled.** Listeners
  added by `init` go with it, so no page has to clean up after itself. Refill
  it instead and every second visit doubles up the handlers.

Adding a page: write the function, add it to `PAGES`, add its id to `NAV`.
The "coming soon" fallback is derived from the same map, so a nav entry with
no page says so rather than rendering blank.
