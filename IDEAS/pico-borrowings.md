---
id: pico-borrowings
status: assessment
dated: 2026-10-22
---

# Idea — Six things worth taking from pico

**Status: ASSESSMENT.** Nothing here is built and nothing here is a dependency.
[pico](https://github.com/picosh/pico) is a Go monorepo of hosted developer
services — pages, tunnels, pipes, a blog, pastes, RSS mail — with one design
move under all of them: **ssh is the whole surface.** Each app is an ssh
listener (`pkg/pssh`) with a middleware chain (`pipe → list → scp → rsync →
auth → tui → cli`); a public key IS the account; the client is whatever is
already in `$PATH` — `scp`, `rsync`, `sftp`, `ssh`. Postgres, Docker images,
Caddy. Its `SELFHOST.md` says the platform is not designed to be self-hosted,
which is the opposite of this framework's goal, so the platform itself is not
a model. The six below stand on their own. The FJS state against each was
found by search on the date above; re-probe before planning.

## 1. An ssh pty is a front door with no client to install

`ssh pico.sh` opens a full TUI (vaxis) that the server renders over the pty.
A stranger needs nothing installed and no account form: the key presented at
connect is looked up, and a miss lands on the signup page with the key already
in hand (`pkg/tui/signup.go`).

**FJS:** Haven's identity is the same idea — a member is a machine's Ed25519
key (`FJS-D981`) — but the door is heavier: `fli haven` must be installed, and
the key under `~/.fli/` signs `POST /haven/login`. Mesa already renders to a
terminal (`fli dev:tui`), so the server could render the same scene over an ssh
pty and Haven would be `ssh haven.maverickmade.tech`. **Caveat:** `FJS-D241`
ruled ssh OUT of the fleet, because an outbound client holds fleet private keys
and puts an ssh client in Basecamp's container. An inbound listener holds no
private key but its own host key, so it is a different beast and needs its own
ruling rather than a repeal. Open: whether Bun has an ssh server worth trusting,
or the listener is a Go sidecar beside the Junction process.

## 2. A destructive command is a dry run until `--write`

Every pgs mutation (`pkg/apps/pgs/cli.go`) prints what it would do, then
`NOTICE: changes not committed, use --write to save operation`. The plan and the
act are one code path with one flag between them.

**FJS:** `basecamp verify --reset` wipes the dev database on the first run. No
fli command has the dry-run-by-default shape. This is the one item that needs no
ruling — it is a flag on commands that already exist.

## 3. Redirects, headers and ignores are files in the site

`_redirects` and `_headers` are Netlify-compatible, each parser about a hundred
lines (`redirect.go`, `header.go`), with a deny list of headers a site may not
set. `_pgs_ignore` is gitignore syntax over the upload. `calc_route.go` expands
a pretty URL (`/foo` → `foo.html` → `foo/index.html`) in one place.

**FJS:** Outpost holds a redirect as a Basecamp record pushed into a Caddy route
(`src/ingress.js`, `redirects: [{host, to}]`). A file in the artifact makes the
redirect a per-release fact, versioned and rolled back with the site, which is
where a static site's own redirects belong; the Basecamp record stays for
host-level ones. Fits sierra's static target, site-kit and outpost `static.js`.

## 4. The plumbing a public service grows

Three tables pico added as strangers arrived, each a migration in `sql/migrations`:
a feature-flag row per user that carries limits (`FindAccess(user, 'pgs')` then
`SetLimits(maxSize, …)`), an `invites` table so signup is gated, and
`block_signups(ip inet, reason)` read only by the signup flow.

**FJS:** Haven is the first app with strangers on it. A ban is a row policy and
a banned member reads an empty room (`IDEAS/haven.md`). Quota, invite-gated
signup and an IP block do not exist. All three are schema rows, not hooks
(Invariant 6), so they are a Phase 10 cost rather than a design.

## 5. A `runbooks/` folder

Two files: `ban-ip.md` and `delete-account.md`. Each is the operator's steps,
with the SQL inline, under a page long.

**FJS:** no operator runbook exists for a hosted app. Haven's deploy (10.1) is
the first time one is owed; the ban runbook writes itself from item 4.

## 6. A tunnel for the inbound drives

`ssh -R dev:80:localhost:8000 tuns.sh` puts a local server on a public https
hostname. The engine is `sish`, which pico does support self-hosting.

**FJS:** nothing to build. `app.conduit.receive()` drives and the Intake
stressor's live n8n hop (1.8.1) both need a public URL for a laptop; this is the
tool, not a feature.

## Smaller, noted and not taken

- `ssh pipe.pico.sh sub topic` is a CLI client on a broadcast channel. Junction
  channels exist; `fli sub <channel>` against a hosted app is a day, and nobody
  has asked.
- `AGENTS.md` is two lines, the second being *run `make check` before marking a
  task complete* — `fli done`'s whole job.
- The design RFC (use what you build, ship good-enough, show rather than
  theorize) restates `PHILOSOPHY.md`; nothing to fold in.
- Three database backends under `pkg/apps/pgs/db` (memory, postgres, sqlite),
  a Prometheus port per listener and the docker bake are the shape of a hosted
  product with one operator. Not this framework's shape.

## Order

Item 2 first and alone. Item 1 as a question to the owner, citing `FJS-D241`
and `FJS-D981`. Items 3–5 as owed boxes under `IDEAS/haven.md` Phase 10 when
10.1 is taken up. Item 6 is a note in `docs/TESTING.md` if the drives ever
reach a laptop.
