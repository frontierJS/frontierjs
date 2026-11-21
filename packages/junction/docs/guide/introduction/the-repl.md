# The REPL

`bun run repl` opens a shell on a running API, for trying a request without writing curl. It reads the live route list, keeps the last answer in `$_` and can replay a session.

```text
$ bun run repl                              # connects to localhost:3000
○ › health
○ › post /users {"name":"Alice","email":"a@b.com"}
● › auth my-token
● › set id = $_.id
● › get /users/$id
● › watch /health 2000
```

## What else it can do

- Tab completes commands, live paths from `/metrics` and `$variable` names
- `$_` holds every response body, and `set name = $_.field` keeps one part of it
- `last .data[0].email` pulls a field from the last answer, and `inspect $_` prints it whole
- `watch /health 2000` polls an endpoint, and ctrl+c stops the watch without leaving the shell
- `!3` replays history entry 3
- `health`, `metrics` and `services` hit the built-in endpoints
- `--port`, `--host` and `--https` aim it at another app: `bun run tools/repl.ts --host staging.myapp.com --https`
- `tutorial` walks four chapters in 18 steps against the real app, and `tutorial list` names them

**In depth:** [README § The REPL](../../../README.md#the-repl)
