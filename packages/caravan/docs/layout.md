# caravan — layout

The file-by-file map of `@frontierjs/caravan`, moved out of `CLAUDE.md` so a turn in this package does not pay for it. `CLAUDE.md` keeps the owners and the traps; hazards are `hazards.md`.

```
src/
  index.ts     caravan() — the public surface, queue + admin routes
  db.ts        the jobs database: schema, claim/complete/fail, migration on open
  worker.ts    the worker loop
  cron.ts      recurring declarations
  types.ts     job/queue types
  autoload.ts  handler discovery
bin/
  caravan.ts   the operator verbs from a shell — `caravan queue …`, JSON out.
               What `fli deploy:pause` runs inside the serving container
```
