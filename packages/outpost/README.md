# @frontierjs/outpost

**The process a fleet server runs.** Basecamp is the control plane; this is its
hands on a machine. One per `Server` row (`FJS-D29` — infrastructure takes place
nouns), and it does two things and nothing else:

- **answers commands** — pull, build, deploy, stop, health-check, exec, prune —
  every one of them signed;
- **reports** — a heartbeat that says where to reach it, and the machine's
  volumes and disk on a slower clock.

It is not an FJS application. Its job is to run Docker commands and report
health, and an FJS app would put a schema, a migration runner and an ORM on
every fleet server to do that.

## Running one

```sh
OUTPOST_SERVER_ID=<the Server row's id> \
OUTPOST_SIGNING_KEY=<this machine's private key> \
OUTPOST_HUB_KEY=<Basecamp's public key> \
BASECAMP_URL=https://basecamp.internal \
OUTPOST_TLS_CERT=/etc/outpost/outpost.crt \
OUTPOST_TLS_KEY=/etc/outpost/outpost.key \
bunx --bun @frontierjs/outpost
```

Those six have no default and the process refuses to start without them. An
Outpost that cannot name its server reports as nobody. One with no hub key
would either refuse every command or accept every one. Both keys come from
enrolling: the machine makes its own Ed25519 pair and Basecamp records the
public half, then answers its own, which every command is verified against
(`FJS-D1604`). The command port serves
TLS only. Its certificate is self-signed (`ensureCert` in
`@frontierjs/outpost/cert`), sent to Basecamp in the enrollment exchange and
pinned there, so a command reaches no port holding any other (`FJS-D557`).
Everything else has a
default — `OUTPOST_PORT` (8180 dev, 7180 test — the number comes from
`packages/cli/core/ports.js`, project id 8), `OUTPOST_PUBLIC_URL`,
`OUTPOST_HEARTBEAT_MS`, `OUTPOST_REPORT_MS`, `OUTPOST_WORK_DIR`,
`OUTPOST_RESTORE_DIR` (`/var/lib/outpost/restore`, the one directory
`/volume/restore` reads an archive from), `OUTPOST_BACKUP_DIR`
(`/var/lib/outpost/backups`, where `/backup` writes one),
`OUTPOST_DEPLOY_KEY_DIR` (`/var/lib/outpost/deploy-keys`, each app's deploy
key, made once and never sent; `FJS-D1555`), and the four
that belong to the static half — `OUTPOST_STATIC_DIR`, `OUTPOST_STATIC_PORT`
(8181 dev, 7181 test; `0` turns it off) and `OUTPOST_STATIC_URL` — and
`OUTPOST_CADDY_ADMIN`, the machine's Caddy admin API (`http://127.0.0.1:2019`),
which a `/deploy` naming `hosts` pushes its route to. A machine with no Caddy
deploys an app with no hostname as before.

On the box a Basecamp runs on, `fli deploy` also writes `OUTPOST_HOST_DB_PATH`
and `OUTPOST_HOST_ENV_PATH`: the database directory and the file holding
`ENCRYPTION_KEY`. `posture()` then stats both into `host_files`, which
`/hub/security/` grades. No other machine sets them.

`OUTPOST_PUBLIC_URL` is stated rather than derived, because this process cannot
see the address the world reaches it at. It must be `https`, and the process
refuses to start otherwise: Basecamp registers no target for a plain-http one. It is what the heartbeat registers as
the Conduit target, and until that lands Basecamp refuses every release for the
machine — with a message saying so, rather than a green deploy that ran nothing.

## Taking one off

The install (Basecamp's `installScript()`) writes `/usr/local/sbin/outpost-uninstall`
beside the unit, so a box carries its own way back whatever happened to the
Basecamp that enrolled it. `sudo outpost-uninstall` removes the Outpost, its
credential, its firewall and its Litestream unit, and leaves the apps it placed
running, unreplicated. `--purge` also removes those apps and every Docker
volume, `/var/lib/outpost` with its backups, Docker, Caddy, their apt sources,
the Litestream binary and the Outpost's bun.
It asks you to type `purge`, or takes `--yes` when there's no terminal. Both
end by listing what they left on purpose: the sshd drop-in (removing it can
turn password login back on), chrony, security updates, and the Server row,
which stays in Basecamp until a person removes it there.

## The protocol

Basecamp reaches it at `outpost:<server-id>` over Conduit. Every route but
`GET /health` requires a signature; `/exec` runs a shell command as this
process's user, so the default is refuse and a route opts out rather than in.

| | |
| --- | --- |
| `POST /pull` | `{ image }` → `{ digest }` |
| `POST /deploy` | `{ deployment_id, app_id, image, digest, source, config }` → `{ containerId, digest, commit_sha }`; `config` is `port`, `containerPort`, `volumePath`, `cpuLimit` (`--cpus`), `memLimitMb` (`--memory`), `env` and `logs` |
| `POST /build` | `{ app_id, source, image }` → `{ digest, commit_sha, dockerfile, exposed_port }`; cloned with the app's deploy key, built with `source.dockerfile` (the App's stored copy) when given, else `deploy/Dockerfile`, else `Dockerfile`; `exposed_port` is that file's last `EXPOSE`, null when none says; a `deploy/Dockerfile` with no `deploy/generated/` is refused naming `fli deploy:vendor` (`FJS-D942`) |
| `POST /deploy-key` | `{ app_id }` → `{ app_id, public_key }`; the app's ed25519 key made on the first ask and kept. Every heartbeat carries all of them as `deploy_keys: [{ app_id, public_key }]` |
| `POST /source/file` | `{ app_id, path }` → `{ path, content }`; one file (64 KB at most) off the app's last clone, `content: null` when the clone has no such file; refused for an app never built here and for a path or symlink leading outside the clone |
| `POST /stop` | `{ app_id }` → `{ stopped, unrouted }` |
| `POST /site/preview` | `{ app_id, source, branch, alias, cloudflare: { token, account_id } }` → `{ commit_sha, url, version_url }`; the branch's head installed, built with `site-kit build --preview` and uploaded as a Worker version aliased `alias`, each step in a throwaway container, the checkout removed after; `commit_sha` is what was built, which may be newer than the caller saw |
| `POST /site/publish` | `{ app_id, source, branch, commit, cloudflare: { token, account_id }, app?: { volume_path, env } }` → `{ commit_sha, url, skipped? }`; the same steps with `site-kit build` and `site-kit deploy`, the live site; refused when `branch` is no longer at `commit`. With `app`, an API App's `site/`: `sierra site --deployed` first, the build against a `litestone backup` of `fjs-<app>`'s database with `env` as its variables, `sierra site --deploy`; no `site/` or no deployment answers `skipped` (`FJS-D1689`) |
| `POST /route` | `{ app_id, hosts, port? }` → `{ hosts, port, rebind }`; the app's Caddy route replaced, or removed for no hosts, dialing the port the running container published. `rebind` is a sentence when the bind no longer matches, which only the next `/deploy` changes. A stated `port` is for an app with NO container — a preview's dev server on this machine — and is refused beside one |
| `POST /health-check` | `{ app_id, port, path }` → `{ healthy }`, plus `reason` when it is not; with a `path`, running is not enough — `127.0.0.1:<port><path>` must answer 2xx |
| `POST /exec` | `{ command, timeout_s }` or `{ step }` → `{ exit_code, stdout, stderr }` |
| `POST /logs` | `{ app_id, tail, since }` → `{ running, tail, since, stdout, stderr }`, plus `error` when there is no such container |
| `POST /analytics` | `{ route_id, from, to }` (UTC instants ending `Z`, each optional) → `{ route_id, from, to, files, lines, skipped, truncated, oldest, kept_since, hosts: [{ host, requests, bytes, client_ips, status, paths, errors, durations }] }` — `client_ips` is distinct `request.client_ip`s, never people; paths drop the query; each panel answers its top 20, and a read parses at most 100,000 lines newest first (`truncated`, `oldest` say where it was cut); `kept_since` is the first line of the oldest file the roll keeps, whatever the window; counted off the route's Caddy access log and its rolled files; a route with no log is refused by name |
| `POST /static/publish` | `{ app_id, files }` → `{ digest, files, bytes }` — written, not yet live |
| `POST /static/activate` | `{ app_id, slug, digest }` → `{ digest, host, url }` |
| `POST /static/health` | `{ app_id, digest }` → `{ healthy, digest }`, plus `reason` when it is not |
| `POST /static/retire` | `{ app_id, slug }` → `{ retired }` — off the air, every release kept |
| `POST /static/releases` | `{ app_id }` → `{ current, digests }` |
| `POST /ingress` | `{}` → `{ caddy, listen, routes: [{ id, hosts, to }], servers }` — what Caddy's `ingress` server routes, whoever wrote it, each route reduced to its destinations; `servers` lists every other http server (a second one on :443 is a Caddyfile left running); `caddy: false` on a machine without one |
| `POST /system/prune` | `{ targets, keep_images }` → `{ freed_bytes, removed, volumes, usage }` |
| `POST /volumes/prune` | `{ names }` → `{ removed }` |
| `DELETE /volumes/<name>` | → `{ removed }`, or 409 with the container holding it |
| `POST /backup` | `{ app_id, upload_url? }` → `{ volume, path, bytes, files, sha256, uploaded?, upload_error? }`; `fjs-<app>-data` tarred (gzip) into `OUTPOST_BACKUP_DIR` by a throwaway container holding the volume read-only. The archive stays on the machine and the answer is its path and digest. With `upload_url`, a pre-signed PUT Basecamp minted, the archive is streamed to it from the Outpost process and `uploaded` says whether it landed, `upload_error` the bucket's words when not; the machine holds no bucket key. Refused for a volume the machine does not hold |
| `POST /volume/restore` | `{ app_id, path \| url + sha256, overwrite? }` → `{ volume, archive, files, bytes, overwrite, sha256? }`; a tar (gzip or not) under `OUTPOST_RESTORE_DIR`, extracted into `fjs-<app>-data`. With `url`, a pre-signed GET Basecamp minted, the archive is fetched there first and refused unless its sha256 matches; the copy is removed after. Refused while any container holds the volume, and into one with files unless `overwrite: true`, which empties it first |
| `POST /replica/restore` | `{ app_id, replica, databases, at?, overwrite? }` → `{ volume, files, bytes, overwrite, databases, replication }`; each named database restored out of the app's Litestream replica, at `at` or the latest, replacing only those `.db` files in the stopped volume; Litestream is restarted so it picks them up |
| `POST /replica/drill` | `{ app_id, replica, databases, at?, image, digest?, env }` → `{ databases, verified, verify }`; each named database restored out of the replica into a staging directory, never the volume, then `litestone restore --verify-only` run over it in the app's own image (`--network none`, `env` passed by name); `verified: false` is a 200 with the report, and an image that answers no report is a 500 (`FJS-D1524`) |
| `GET /health` | unsigned liveness — says nothing about the machine |

**The signature is `@frontierjs/toolbelt/signature`** — the same module Conduit
signs with and Basecamp verifies with. Method, path, timestamp, nonce and a hash
of the body, so a captured signature cannot be replayed, moved to another
endpoint, or kept while the body is swapped underneath it.

## Where the bytes come from

V1 builds on the target: a `source.kind === 'git'` deploy clones, builds, and
answers the digest of what it built, which Basecamp records on
`Deployment.builtImage` and addresses every later step by. That is honest while
the Outpost is co-resident with Basecamp — one machine, the CapRover shape. The
end state is build-once-promote-a-digest, which needs a builder and somewhere to
put the artefact: `IDEAS/deploy-plane.md`.

**Only `sha256:<64 hex>` counts as a digest.** A tag is a name, and two builds
share it — an image inspect that answers anything else is reported as no digest
at all rather than as a plausible one.

### Or the bytes are the app

An App whose `source.kind` is `inline` has no repository and no image: the files
themselves are the release. A page that loads React from a CDN is a whole app,
and there is nothing here to build. `POST /static/publish` writes the files into
a directory named for their own sha256 and `POST /static/activate` swaps one
symlink — which is why a republish of identical bytes answers the same digest,
and why a rollback sends nothing at all.

The digest is computed here and the caller states none: a release records what
ran, and a claim about bytes somebody sent is not a reading of the bytes that
landed. Every path is an allow-list of plain file names, and the files are
written into a staging directory and moved into place with one `rename`, so a
publish that dies halfway cannot leave a release holding some of its own files.

**They are served on a second listener, on a port of its own** (`OUTPOST_STATIC_PORT`).
The pages are written by whoever can edit an app, so anything they reach as
same-origin is theirs — and a port is an origin, so sharing one with the signed
command protocol would put the fleet inside every prototype. Nothing on that
port is signed or authenticated: it is a web server for public files, and the
only reads it can perform are inside one release directory. It binds loopback
and Caddy fronts it by hostname (`FJS-D1459`), so an inline app with no hostname
is reached from the machine alone. An app is reached by the first label of the
Host (`shop.fleet.example.com`) or by the first path segment (`/shop/`).

## Testing

`bun run test` — no Docker and no network. `createDocker({ run })`
takes the runner and `createReporter({ fetch })` takes the client, so what is
asserted is what the machine was ASKED to do and what left the process. A
package that could only be tested against a real daemon would be tested rarely
and wrongly.
