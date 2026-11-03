# @frontierjs/workbench

The developer's own machine as an app: a Claude Code chat per pinned checkout,
the registers read and ruled on, the loops as a town. An FJS application, not a
library, and **private** -- it is never published, because a laptop tool with a
database and a shell is not a thing `bun publish` should see.

**Built so far: the skeleton.** A schema (`Member`, `Session`, and the three
Claude usage models), an API with the door (`POST /door/login`), and a web shell
whose `/workbench/` screen is an empty state behind the sign-in. The wing moves
in from Basecamp in Phase 2 of `IDEAS/workbench-package.md`.

```bash
fli dev            # preflights the ports and the database, then runs both servers
bun run api        # the API on 5501
bun run web        # the browser on 5508, proxying to the API
bun run db:types   # regenerate db/schema.d.ts
bun run db:reset   # stops the servers, deletes the database
bun run typecheck
```

Sign in with `WORKBENCH_KEY` (a dev value is the default; `bun run start` runs as
production and refuses it).
