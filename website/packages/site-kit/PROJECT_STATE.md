# site-kit — Project State

> `CLAUDE.md` is the map. Read `../../../CLAUDE.md` first for repo-wide vocabulary.

## What it is

`@frontierjs/site-kit` 0.0.0, private — the engine a markdown-authored
marketing site depends on.

## State

| | |
|---|---|
| Source | none yet — the package is a workspace member with no exports |
| Tests | none; exempt in `scripts/ci-allowances.json` until the first piece lands |
| Consumers | `website/site/` (planned), `fjs-prototypes/ksite` (after it) |
| Published | no, and not listed anywhere |

## Next

Move the first generic piece out of ksite's `packages/ksite/` engine, with the
test that comes with it, and drop the CI exemption in the same change.
