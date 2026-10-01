# @frontierjs/site-kit

The engine a markdown-authored marketing site takes as a dependency: its blocks,
layouts, themes and build. The site that depends on it is its `content/` folder
and nothing else, so upgrading a site is a version bump rather than a copy
(`FJS-D33`).

**Private and unlisted while it is built out.** It lives inside `website/`
because frontierjs.com is its first consumer and the place its kinks get found;
the Kobami client template (`fjs-prototypes/ksite`) extends it next, with a
cleaning-company theme and content over the same engine.

Nothing is exported yet. The pieces arrive from ksite's `@kobami/ksite` engine
as each one is made generic.
