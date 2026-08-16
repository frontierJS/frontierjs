# create-frontier — state

**v0.1.0 · green · 9 tests · unpublished.** The name is free on npm; nothing has
claimed `create-frontier`.

## What works

`npm create frontier@latest <name>`, `bun create frontier <name>`, and every
`fli new` flag through it.

**Checked by hand, because a tty is involved and the automated attempt hung on
EOF rather than failing** — a flake wearing a test's clothes. Under `script`, with
`node index.js` and no name:

| Typed | Answer |
| --- | --- |
| `BAD NAME` | `lowercase letters, digits and hyphens only`, then re-prompts |
| Ctrl+D | `nothing written.` — no `AbortError`, no directory created |
| a valid name | scaffolds, in the caller's directory |

Also verified from a nested directory under an enclosing project: the app landed
beside the caller, and the same command run through `fli new` **without** the
`--project` pin landed one level up, in the enclosing project's root. Both
directions measured, which is what makes the pin a fact rather than a precaution.

## Open

- **Unpublished**, so `npm create frontier@latest` does not resolve yet. It
  cannot be published before `@frontierjs/cli@0.1.2` and `@frontierjs/config` are,
  since it depends on both — `workspace:*` becomes a real version at publish.
- **The npm path is untested end to end.** Everything here has been run against
  the working tree and against local tarballs; nobody has run
  `npm create frontier@latest` from a clean machine. That is the same gap
  `FJS-252` names for the deploy pipeline.
- **No `--template` menu.** `fli new` takes `--template full-stack|api-only` and
  this forwards it, but a person who types the bare command is asked only for a
  name. Whether the front door should ask more than fli does is undecided.
