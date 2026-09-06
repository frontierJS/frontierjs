---
title: tutor:site
description: A public site built ahead of time, and the check that says what it published
steps: _steps-site
examples:
  - fli tutor:site --workspace ~/frontier-tutorial
  - fli tutor:site --tmp --yes
flags:
  workspace:
    char: w
    type: string
    description: Directory to build the app in — kept when the lesson ends
    defaultValue: ''
  tmp:
    type: boolean
    description: Build in a throwaway directory instead (the default with no --workspace)
    defaultValue: false
  restart:
    type: boolean
    description: Begin this lesson again, forgetting what an earlier run finished
    defaultValue: false
  yes:
    char: y
    type: boolean
    description: Run the whole lesson without stopping — no confirmation between steps
    defaultValue: false
  keep:
    type: boolean
    description: Keep a throwaway workspace when the lesson ends
    defaultValue: false
  source:
    type: string
    description: Where @frontierjs packages come from — local (this tree) or npm
    defaultValue: ''
  api-port:
    type: number
    description: Port for the API — refused rather than moved if something holds it
    defaultValue: 8100
---


```js
openTutor(context, 'tutor:site', { ephemeral: ['02-run', '08-finish'] })

context.config.source  = flag.source || defaultSource()
context.config.apiPort = flag['api-port']
context.vars.apiPort   = context.config.apiPort
```

## Lesson 8 — the public half

An app has two audiences and they want opposite things. The console you have
been building is behind a sign-in, is allowed to be slow, and must be current.
The other half — the marketing pages, the catalogue, the thing a search engine
reads — is public, has to be fast, and can be a little out of date.

`site/` is that half, and it is a **surface**: a peer of `api/` and `web/` with
its own Vite root, its own tests and its own release. What it produces is one
HTML file per page with the data already in it, and no application server
behind any of it.

That trade has a sharp edge, and it is the point of this lesson.

**A prerendered page is public and cannot be recalled.** Whatever `load()` put
in it is served to anybody, cached by a CDN, indexed, and still on somebody's
disk after you delete it. So the build refuses to emit a page unless it can say
what went into it: every model read while `load()` ran is compared against that
model's `@@gate`, and a route that read something gated is **stopped** rather
than published. `publishes: N` in that route's own frontmatter is the override —
so publishing gated data is a line somebody wrote and a reviewer can see.

You will watch that refusal happen.
