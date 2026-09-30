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
OUTPOST_SECRET=<this server's secret> \
BASECAMP_URL=https://basecamp.internal \
OUTPOST_TLS_CERT=/etc/basecamp/outpost.crt \
OUTPOST_TLS_KEY=/etc/basecamp/outpost.key \
bunx --bun @frontierjs/outpost
```

Those five have no default and the process refuses to start without them. An
Outpost that cannot name its server reports as nobody. One with no secret
would either refuse every command or accept every one. The command port serves
TLS only. Its certificate is self-signed (`ensureCert` in
`@frontierjs/outpost/cert`), sent to Basecamp in the enrollment exchange and
pinned there, so a command reaches no port holding any other (`FJS-D557`).
Everything else has a
default — `OUTPOST_PORT` (8180 dev, 7180 test — the number comes from
`packages/cli/core/ports.js`, project id 8), `OUTPOST_PUBLIC_URL`,
`OUTPOST_HEARTBEAT_MS`, `OUTPOST_REPORT_MS`, `OUTPOST_WORK_DIR`, and the four
that belong to the static half — `OUTPOST_STATIC_DIR`, `OUTPOST_STATIC_PORT`
(8181 dev, 7181 test; `0` turns it off) and `OUTPOST_STATIC_URL` — and
`OUTPOST_CADDY_ADMIN`, the machine's Caddy admin API (`http://127.0.0.1:2019`),
which a `/deploy` naming `hosts` pushes its route to. A machine with no Caddy
deploys an app with no hostname as before.

`OUTPOST_PUBLIC_URL` is stated rather than derived, because this process cannot
see the address the world reaches it at. It must be `https`, and the process
refuses to start otherwise: Basecamp registers no target for a plain-http one. It is what the heartbeat registers as
the Conduit target, and until that lands Basecamp refuses every release for the
machine — with a message saying so, rather than a green deploy that ran nothing.

## The protocol

Basecamp reaches it at `outpost:<server-id>` over Conduit. Every route but
`GET /health` requires a signature; `/exec` runs a shell command as this
process's user, so the default is refuse and a route opts out rather than in.

| | |
| --- | --- |
| `POST /pull` | `{ image }` → `{ digest }` |
| `POST /deploy` | `{ deployment_id, app_id, image, digest, source, config }` → `{ containerId, digest, commit_sha }`; `config` is `port`, `containerPort`, `volumePath`, `cpuLimit` (`--cpus`), `memLimitMb` (`--memory`), `env` and `logs` |
| `POST /stop` | `{ app_id }` → `{ stopped }` |
| `POST /health-check` | `{ app_id, port, path }` → `{ healthy }`, plus `reason` when it is not; with a `path`, running is not enough — `127.0.0.1:<port><path>` must answer 2xx |
| `POST /exec` | `{ command, timeout_s }` or `{ step }` → `{ exit_code, stdout, stderr }` |
| `POST /logs` | `{ app_id, tail, since }` → `{ running, tail, since, stdout, stderr }`, plus `error` when there is no such container |
| `POST /static/publish` | `{ app_id, files }` → `{ digest, files, bytes }` — written, not yet live |
| `POST /static/activate` | `{ app_id, slug, digest }` → `{ digest, host, url }` |
| `POST /static/health` | `{ app_id, digest }` → `{ healthy, digest }`, plus `reason` when it is not |
| `POST /static/retire` | `{ app_id, slug }` → `{ retired }` — off the air, every release kept |
| `POST /static/releases` | `{ app_id }` → `{ current, digests }` |
| `POST /system/prune` | `{ targets, keep_images }` → `{ freed_bytes, removed, volumes, usage }` |
| `POST /volumes/prune` | `{ names }` → `{ removed }` |
| `DELETE /volumes/<name>` | → `{ removed }`, or 409 with the container holding it |
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
only reads it can perform are inside one release directory. An app is reached by
the first label of the Host (`shop.fleet.example.com`) or, where there is no DNS,
by the first path segment (`/shop/`).

## Testing

`bun run test` — no Docker and no network. `createDocker({ run })`
takes the runner and `createReporter({ fetch })` takes the client, so what is
asserted is what the machine was ASKED to do and what left the process. A
package that could only be tested against a real daemon would be tested rarely
and wrongly.
