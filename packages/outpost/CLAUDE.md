# @frontierjs/outpost — the inside view

The process a fleet server runs. Basecamp sends it commands; it reports back.
Plain ESM JavaScript on Bun, one dependency (`@frontierjs/toolbelt`), no schema,
no ORM, no framework — see `README.md` for why it is not an FJS application.

## Layout

| File | What it owns |
| --- | --- |
| `src/config.js` | every environment variable, and the three that have no safe default |
| `src/docker.js` | **the one place a command runs on the machine** — `createDocker` for containers, `createInspector` for volumes and disk |
| `src/server.js` | the inbound half: the route table, and the signature every route but `/health` requires |
| `src/report.js` | the outbound half: heartbeat, volume report, disk report — one signed POST, three callers |
| `src/index.js` | the process: serve, start the timers, stop them on a signal |

## What bites here

- **The route bodies are basecamp's wire contract and they are snake_case.**
  `app_id`, `timeout_s`, `keep_images`, `server_id`. Inside is camelCase. A route
  that passes a body straight through addresses a container called
  `fjs-undefined`, which exists on no machine and reports healthy nowhere — the
  first test written here caught exactly that.
- **Nothing interpolates caller text into a shell string.** Every command is an
  argv array handed to the runner, so a volume name with a space in it is one
  argument. `/exec` is the deliberate exception and it is what it says it is.
- **A failing command answers the machine's own words.** A generic 500 is how a
  deploy fails with nothing on screen but a red pill, which is the shape
  `FJS-257` was filed about.
- **The runner is injectable and that is not a testing convenience** — it is the
  only way this package is testable at all without a daemon, and a package that
  is only testable against a real machine is tested rarely and wrongly.
- **`docker system df` has no byte mode**, so its human sizes (`4.13GB`) are
  parsed. A screen reading 4.13 bytes is what a missed unit looks like.
- **A prune answers what it REMOVED, never what it was asked about.** Basecamp
  forgets exactly the rows named in the answer; a volume that failed to delete
  and was reported anyway is a full disk nothing can see.
- **The first heartbeat is the registration.** It carries `outpost_url`, and
  until it lands basecamp has no address for this machine and refuses every
  release for it.
- **A control plane that is down must not take the Outpost with it.** Every
  timer tick catches and logs; the machine still has containers to run.

## Proving a change

`bun run test` — 19 tests, no Docker, no network. Then `basecamp`'s own drive
(`bun run verify`), which stands up a sink speaking this protocol: if a shape
here changes, that is where it shows.
