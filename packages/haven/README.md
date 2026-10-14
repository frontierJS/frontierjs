# @frontierjs/haven

A place in the terminal anyone with `fli` installed can walk into. Every person
online has a figure; arrow keys walk, a door enters the tavern, a typed line
is a bubble over your figure. An FJS application, not a library — the
framework's own chat place and its first app with strangers on it.

**Built so far: the schema and the API.** `db/schema.lite` — Member, Room,
Message, their gates and the ban; `api/` — a channel per room, moves as
presence, lines as `messages`. The signed login, the square and `fli haven` are
the plan in `IDEAS/haven.md`.

```bash
bun run test     # the schema's promises, and two members in a room over real sockets
```
