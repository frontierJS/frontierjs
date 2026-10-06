# Changes — @frontierjs/outpost

## 2026-10-06 — the Fable audit's repro tests, under `test/audit-*`

`audit-signature.test.js` and `audit-static.test.js` come from the Fable audit of 2026-10-05. The cases the listeners survived are plain tests. Six cases are still open and are `test.failing` naming their rows: `FJS-1833` nonce replay, `1834` one app served under another's hostname, `1856` URIError, `1857` `timeout_s: 0`, and `1858` unsigned `x-service-method`. The suite passes 129/129.

## 2026-10-05 — a release that fails puts the old container back (`FJS-1765`)

`/deploy` ran `docker rm -f` before `docker run`, so a run docker refused (a port already allocated, exit 125) left the app with no container, and a start that never answered left the broken one serving. Now the live container is renamed `fjs-<app>_replaced` and stopped, the new one is run, and `/deploy` answers only once it is healthy: running, and answering `config.healthCheck` on the published port where one is named, polled 10 × 3s (`createDocker({ health })`). A refused run or an unhealthy start removes the new container and renames and starts the old one; the error says whether it came back answering. The route then goes back to the port the restored container published. A `_replaced` with no live container beside it is kept as the last good one. `/stop` removes it. Stop-then-start is kept because a SQLite volume takes one writer. `bun run test` 109/109 (six new). `verify:docker` 40/40 adds four against the real daemon and Caddy: with the release's port held, and with whoami listening on the wrong port, the previous container's id is serving again, over HTTPS, with no `_replaced` left behind.

## 2026-10-03 — `/deploy` checks its run config before it moves the route (`FJS-1682`)

`checkRunConfig` (volume path, CPU, memory) is exported from `docker.js` and `/deploy` calls it before re-pointing Caddy. Refused after the route moved, a redeploy that changed its port left the old container running behind a route dialing the new one. Basecamp no longer sends `/stop` ahead of `/deploy`, so every refusal here now leaves the live app serving. `test/outpost.test.js` § *a redeploy refused for its config…* fails with the call removed.

## 2026-10-03 — a static prune keeps `keep` releases when their mtimes tie

Releases published within one millisecond tie on directory mtime, and the sort could put the new release or the live one past the `keep` cut, where both are spared — so one extra survived (`test/static.test.js` § *old releases are pruned*, red about one run in three). The release just written now ranks first, and the live one wins a tie.

## 2026-09-30 — `/route`: hostnames changed between releases (`FJS-1610`)

`POST /route { app_id, hosts }` replaces the app's Caddy route without touching the container, or removes it when `hosts` is empty. It dials the port the running container published, read with `docker inspect` (`docker.published`), so a port edited on the app since the release is not used. No container, or one that publishes no port, is refused when there are hosts to route. Hostname checks and the refusal of a hostname another app holds are `/deploy`'s. The bind is left alone. The reply's `rebind` says when it no longer matches: a first hostname on a port open on every interface, or the last one removed from a loopback port (`FJS-1616`). `outpost.test.js` has five cases. `verify:docker` 36/36 adds four against the real Caddy and daemon: a second name answers over HTTPS, the port and the loopback bind are read back, the container keeps its id, and an empty set takes the route.

## 2026-09-30 — Caddy fronts an app by its hostnames (`FJS-D564`, `FJS-D565`)

`/deploy` takes `hosts`. Naming any pushes a route to the machine's Caddy through its admin API (`src/ingress.js`, `OUTPOST_CADDY_ADMIN`, default `http://127.0.0.1:2019`): one route per app, `@id` `fjs-<app>`, reverse-proxying to `127.0.0.1:<port>`, PATCHed on a redeploy and DELETEd by `/stop` and by a deploy that names none. The ingress server is made on the first route and listens on Caddy's own `https_port`. The same deploy binds the container's port to `127.0.0.1`. A hostname Caddy cannot route (a wildcard, a bare label) is refused before anything runs; one another app's route holds is refused before the container starts; so is a Caddy that does not answer. A machine with no Caddy deploys an app with no hostname exactly as before. Outpost keeps no copy of the routes: Caddy's `--resume` reloads them after a restart, which is `FJS-D564`'s owed answer. `bun run test` 97/97 (ten new, against a Caddy stand-in modelled on the real admin API's answers). `verify:docker` 32/32 with seven new assertions against a real Caddy; forcing the old all-interfaces bind fails `ingress.portRefusesOffLoopback`, and dropping `--resume` fails `ingress.survivesACaddyRestart`.

## 2026-09-30 — limits and a health path are applied (`FJS-1605`)

`/deploy` takes `config.cpuLimit` (`--cpus`) and `config.memLimitMb` (`--memory <n>m`). Like `volumePath`, a bad value is refused before the old container is removed. `/health-check` takes `port` and `path`. With a path, a running container must also answer `127.0.0.1:<port><path>` with a 2xx, and a failure says why in `reason`. `createDocker({ fetch })` is the seam the suite uses. `bun run test` 87/87, `verify:docker` 25/25.

## 2026-09-30 — the command port speaks TLS only (`FJS-1603`, `FJS-D557`)

8180 carried every deploy's decrypted environment in the clear. It now serves
`OUTPOST_TLS_CERT`/`OUTPOST_TLS_KEY`, both required. `OUTPOST_PUBLIC_URL` defaults to
`https://localhost:<port>`, and the process refuses to start on one that is not `https`.
`@frontierjs/outpost/cert` exports `ensureCert(dir)`, which makes a self-signed P-256
certificate once and keeps it across restarts, because Basecamp pins the one it was
handed. It also exports `OPENSSL_CERT_ARGS`, which the install script builds its shell line
from. `verify:docker` drives the process over pinned TLS and asserts that plain HTTP on the
command port gets no answer. The static origin on 8181 is unchanged.

## 2026-09-30 — a deploy keeps its data: `config.volumePath` is a named volume

`/deploy` removes the old container before it starts the new one, so a database container kept nothing from one release to the next. `config.volumePath` now mounts `fjs-<app>-data` at that path. The next release is handed the same volume. A path that is not absolute, or that holds `:` or `,` (which docker would read as more than a mount point), is refused before the running container is removed. Basecamp sends the path for a blueprint that declares persistent storage. One new test covers the mount and the refusal, and checks that the refusal removed nothing. `bun run test` 83/83.

## 2026-09-27 — the process against a real daemon, and a volume report that says what the volumes hold (`FJS-1398`)

`verify:docker` starts the Outpost process on test-tier 7180 with a stand-in Basecamp on 7182 and drives it with signed commands against the real daemon: `/pull` answers the daemon's own image id, `/deploy` runs that digest on 7183 with its env and the 10m log cap and answers HTTP, a second deploy replaces the first, `/stop` removes it, and the heartbeat, volume report and disk report arrive signed and holding what the daemon holds. It never calls a prune or a volume route — on a workstation those remove somebody's things. It found **every volume reported as 0 bytes with no mountpoint**: `volume ls` answers `Size: "N/A"` and `volume inspect` answers an array on one line. Sizes now come from `docker system df -v`, and the line reader flattens an array.

## 2026-09-26 — a disk report reads Docker's sizes as decimal, and the volume sweep removes volumes (`FJS-257`)

The inspector had only ever met canned text, and the first real daemon it met disagreed with it
twice. **Docker's human sizes are decimal** — its API put the images at 13,808,647,133 bytes and its
CLI printed `13.81GB` — and `bytes()` scaled them by 1024, so every disk report basecamp received
read 2.4% fuller at kB and 7.4% at GB. `bytes()` is base 1000 now and knows `P`. **`docker volume
prune` takes no `--format`**: asked for one it exits 125 having removed nothing, so the
`unused_volumes` sweep answered an empty list on every machine. It runs `volume prune -f` and reads
the names under `Deleted Volumes:`, the block a real daemon prints.

The canned test asserted the 1024 reading, which is how both passed; it is corrected, and a second
canned test holds four lines captured from Docker 29.8. `test/docker-live.test.js` is the grade
nothing canned can give: the inspector's `disk()` against the daemon's own byte counts read off its
API socket, and a volume sweep scoped by label to a volume the test made, since the sweep itself
removes every unused anonymous volume on the machine. It skips, and says so, where no daemon
answers. Both go red on the old code.

## 2026-09-20 — an app whose source is the files themselves

`docker.js` had the whole vocabulary of a release — pull, build, deploy, stop, health-check — and
none of it describes an HTML page that loads React from a CDN. There is nothing to build, nothing to
push and no container to start. `src/static.js` is the other half ([`FJS-D345`](../../DECISIONS.md#fjs-d345)):
five routes under `/static/`, signed like every other command.

**The release is addressed by its own digest and the digest is computed HERE.** Basecamp states
none. That is `/deploy` answering its own digest taken one step further — a release records what ran,
and a caller's claim about bytes it sent is not a reading of the bytes that landed. Three things
follow and none of them is a mechanism anybody has to remember: the directory is named for the
digest, so a republish of identical bytes rewrites the same files in the same place and answers the
same digest; a rollback sends nothing, because `activate` needs only a digest this machine still
holds; and `publish` is separate from `activate`, so a release interrupted by a dropped connection
or a full disk is never halfway to being the thing the world sees.

**Writes go through `node:fs` and every path is an allow-list.** A segment is a plain file name:
no traversal, no absolute path, no backslash, no empty segment. The blocklist version of that check
is the one that gets written — `..` has three spellings and the fourth writes outside the directory
as whatever user this process is — and `/exec` is the route everybody reads as dangerous while a
publish that writes `../../etc/cron.d/x` is the same power with none of the warning signs. Files are
written into a staging directory and moved into place with one `rename`, so a publish that dies
halfway cannot leave a digest directory holding some of its own files, which `activate` would then
serve forever as a release passing every check it has.

**`serve.js` is a SECOND listener on a port of its own**, dev 8181, test 7181, off entirely with
`OUTPOST_STATIC_PORT=0`. The pages are written by whoever can edit an app, so anything they reach as
same-origin is theirs; a port is an origin, so one listener carrying both would put the signed fleet
protocol inside every prototype. It resolves an app by the first label of the Host, falls back to the
first path segment — both are ANSWERED in order, or a machine that gets a domain name of its own
reads every request as an app nobody published — and serves `index.html` for a path with no
extension, since an app using the History API otherwise 404s on every refresh. A request naming a
file gets the truth instead.

**Containment is asserted twice and the second one is the one that matters.** Prefix arithmetic on
the path a caller named, then `realpath` on the file the kernel would open: a symlink sitting inside
a release directory passes the first and reads whatever it points at, through a 200, on a port with
no authentication in front of it. Publish writes only regular files, so that is the case where
something else put it there — which is exactly when the check has to hold. It was written as a test
first and the test failed.

`test/static.test.js` runs against a real temp directory rather than an injected fs: symlink
swapping, atomic rename and path containment are properties of the kernel, and a fake one would pass
all three while the machine does none of them.

## 2026-09-20 — the bun floor is `1.4.0`

`engines: { bun: '>=1.0.0' }` was a number nobody had moved since it was written, and an engine range
is advisory anyway: bun runs an app whose floor it does not meet, so a machine one minor behind
reports the feature it cannot reach as MISSING rather than reporting itself as stale. `fli doctor`
grades the installed version against this floor now, which is the half a `package.json` field cannot
enforce on its own.

## 2026-09-07 — the readings basecamp keeps are the readings this sends

`health()` sent `{ load, memory }` and basecamp keeps `cpu`, `memory` and
`disk`, so two of the three series a real fleet draws had never had a point
written to them and no CPU threshold could fire
([`FJS-1027`](../../ISSUES_ARCHIVE.md#fjs-1027)). Both sides were silent about it and
both were right to be — a missing reading is a real state — and every test
either side agreed with itself.

`src/vitals.js` is the reader. It is a module rather than four lines in the
reporter because **CPU is a rate and `/proc/stat` is a counter**: the
percentage is the delta between two reads, so it has to remember, and it is
injectable for the same reason `{ run }` and `{ fetch }` are. The first read
makes its own window rather than reporting no CPU until the second heartbeat.

`load` still rides along and is still not kept as a series — it is not
comparable between machines without a core count, and `Server.health` renders
every key it is handed.

30 → 40 tests.

## 2026-09-05 — a release could not run what it built

`deploy()` addressed the image as `${image}@${digest}`, and for a build done on
this machine that digest is the image **Id** — `digestOf` reports `{{.Id}}` and
its own comment says why: an image built here has never been pushed, so it has
no repo digest. `name@sha256:<id>` is not a reference any daemon resolves, so
docker read it as a pull and every `source.kind: 'git'` deploy failed with *pull
access denied for <name>* seconds after building successfully
([`FJS-919`](../../ISSUES_ARCHIVE.md#fjs-919)).

A bare id is a reference the daemon takes, so the local case addresses the bytes
directly and the registry case keeps `name@digest`. Which one it is is asked of
the daemon rather than guessed at — both are `sha256:…` and nothing in the string
distinguishes them.

**The test asserted the defect.** *a git deploy builds here, then runs what it
built* expected `acme-web@<digest>`, and its injected runner answers every
command with exit 0, so the broken form looked correct. It asserts the id now,
with an image the machine does NOT hold beside it as the control.

Found by `fli tutor:fleet`'s release half, which is the first thing to run this
path against a real daemon — basecamp's own drive injects a fake docker, which
is exactly what that means.

## 2026-08-19 — the package exists (`FJS-257`)

19 tests, 0 fail. Unpublished.

Basecamp has spoken a complete Outpost protocol since before this package
existed — `deployment.engine.ts`, `fleet.engine.ts`, `volumes` and `cleanup` all
send to `outpost:<server-id>` over Conduit — and there was no process on the
other end. So the shapes here are read off those call sites rather than
invented, and the first test written found the first defect: the bodies are
snake_case on the wire (`app_id`) and a route that passed one straight through
addressed a container called `fjs-undefined`.

Signed with `@frontierjs/toolbelt/signature`, which is also what Conduit signs
with and what Basecamp now verifies with (`FJS-349`).
