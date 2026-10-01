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
| `src/static.js` | **the other kind of release** — an app whose source is the FILES. Writes them under their own digest, swaps one symlink, and computes the digest itself |
| `src/serve.js` | the origin those files answer on. A SECOND listener, its own port, nothing signed — see below |
| `src/vitals.js` | what the machine feels like — cpu, memory, disk, load, read from `/proc` and `statfs`. It REMEMBERS: cpu is a delta |
| `src/report.js` | the outbound half: heartbeat, volume report, disk report — one signed POST, three callers |
| `src/ingress.js` | **the machine's front door** — Caddy's admin API: a route per app (`@id` `fjs-<app>`) PATCHed on deploy and on `/route`, DELETEd on stop, the ingress server made on the first one |
| `src/cert.js` | the command port's self-signed certificate — made once, kept, and the argv the install script builds its own openssl line from |
| `src/index.js` | the process: serve, start the timers, stop them on a signal |

## What bites here

- **The command port is TLS or nothing, and the certificate must not change.**
  Basecamp pins the one handed over at enrollment (`FJS-D557`), so a new
  certificate on 8180 fails every command until the machine enrolls again, and
  a restart that minted one would do exactly that. `ensureCert` reads before it
  makes. A plain-http `OUTPOST_PUBLIC_URL` is refused at start, because Basecamp
  would register no target for it and the machine would look healthy.

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
- **The static origin is a SECOND listener and that is the whole of its safety**
  (`FJS-D345`). The pages it serves are written by whoever can edit an app —
  arbitrary script, out of a paste box — so anything they reach as same-origin
  is theirs. A port is an origin: one listener carrying both would put the
  signed fleet protocol inside every prototype, and Basecamp's session inside
  it one hop later. Same process, because it holds no state beyond the
  filesystem the command half writes. `OUTPOST_STATIC_PORT=0` turns it off.
- **A publish writes the bytes; `activate` makes them live.** Two calls, because
  a publish interrupted by a dropped connection or a full disk would otherwise
  be halfway to being the thing the world sees. Files land in a staging
  directory and arrive by one `rename`, so a digest directory is never holding
  some of its own files — which `activate` would then serve forever as a
  release that passes every check it has.
- **The digest is computed here and a caller states none.** Same rule `/deploy`
  already follows: a release records what RAN, and a claim about bytes somebody
  sent is not a reading of the bytes that landed. The path is hashed with a
  length prefix, or `{'a/b': x}` and `{'a': 'b'+x}` collide — and a collision is
  a rollback restoring the wrong bytes with nothing saying so.
- **A file path is an ALLOW-LIST, not a blocklist.** `..` has three spellings
  and the fourth writes outside the directory as whatever user this process is.
  `/exec` is the route everybody reads as dangerous; a publish is the same power
  with none of the warning signs.
- **Containment on the serve side is asserted TWICE, and the second one is the
  one that matters.** Prefix arithmetic over the path a caller named, then
  `realpath` over the file the kernel would open: a symlink planted inside a
  release passes the first and reads whatever it points at, through a 200, on a
  port with no authentication in front of it. Publish writes only regular files,
  so that is the case where something else put it there.
- **Outpost holds no copy of Caddy's routes, and must not grow one.** Caddy runs
  `--resume` (the package's `caddy-api` unit) and reloads what its admin API
  last saved, which is the whole answer to *Caddy restarted* (`FJS-D564`). A
  path Caddy has not made yet answers 400, not 404; an `@id` it has not seen
  answers 404 — `PATCH /id/…` falling back to `POST` rests on that.
- **Naming a hostname moves the port to loopback, for that app only**
  (`FJS-D565`). An app with no hostname keeps its port on every interface, or
  nothing reaches it; `verify:docker` connects on a non-loopback address to
  prove the other case refuses.
- **A path with no extension is served `index.html`.** An app using the History
  API 404s on every refresh otherwise. A request that names a file gets the
  truth — a fallback there hides a typo forever.

## Proving a change

`bun run test` — no Docker, no network. `bun run verify:docker` for anything
that runs a command or touches Caddy — it pulls `caddy:2`. Then `basecamp`'s own drive
(`bun run verify`), which stands up a sink speaking this protocol: if a shape
here changes, that is where it shows.
