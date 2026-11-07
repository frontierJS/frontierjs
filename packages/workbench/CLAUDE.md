# Workbench -- Project Context

An FJS app laid out like `basecamp` (`db/`, `api/`, `web/`), private
(`"private": true`, `FJS-D1788`). It owns **the developer's own machine**: the
Claude Code chats per pinned checkout, the registers read and ruled on (Atlas,
Decide), the loops as a town (Autopilot), the Claude Code tab, and the indexed
`~/.claude` history. The plan, and the first open box, is
`IDEAS/workbench-package.md`.

**It is a laptop tool, not a fleet.** Its API can start a shell and spawn
`claude` on the machine it runs on, so it binds loopback (`HOST`, default
`127.0.0.1`) and signs in with one pass-phrase (`WORKBENCH_KEY`).

**Basecamp imports nothing from Workbench and Workbench imports nothing from
Basecamp.** What crosses is a signed call (`FJS-D1188`), never an import. Fli's
readers (`packages/cli/core/*`) are imported by path, as `atlas.ts` does today.

## Ports

API **5501**, web **5508** -- the global tooling block's `workbench` and
`workbenchWeb` (`packages/cli/core/ports.js`, `docs/PORTS.md`), not a project
slot. `api/index.ts` states 5501; `web/config/vite.config.js` states 5508 with
`strictPort`.

## Where things are

`docs/layout.md` is the file-by-file map. The owners:

- `db/schema.lite` -- Member, Session (Haven's door: no `@frontierjs/auth`,
  no `Workspace`, no level ladder, `FJS-D1786`), and `ClaudeTranscript`,
  `ClaudeMessage`, `ClaudeWrite`, and `Notification` (`@frontierjs/notifications`, in-app plus
  the ntfy push in `api/src/push.ts`; the topic and a reply topic are minted into `~/.config/workbench/push.json`, the reply topic being where a Post ruling button's anonymous tap lands (`domain/atlas/autopilot-post.ts`)).
- `api/src/app.ts` builds the app and claims `app.own('workbench', ...)`;
  `auth.ts` + `login.ts` are the door; `principal.ts` reads the member per call.
- `api/src/core/env.ts` is the only reader of the environment.
- `api/src/peer.ts` is this machine's Ed25519 key pair (`~/.config/workbench/peer.json`,
  shown at `GET /door/peer` and in the wings' Peer block); `api/src/domain/peer/` dials
  Basecamp's `apps.preview` as a signed peer -- the entry `BASECAMP` names in
  `basecamps.json` (default `dev`), whose `peerKeyId` is the id Basecamp's "Add a peer" form answers. `peer-call.ts` is one conduit target signed with
  conduit's `ed25519`.
- `web/src/lib/session.js` is who is signed in (Sierra's `account.me` is not
  mounted); `lib/nav.js` is the nav table.
- `api/src/domain/laptop/` reads fli's own files on this machine through
  `@frontierjs/cli/core/home.js` (what files) and `core/services.js` (what
  accounts); `/laptop/` shows them. A value never leaves the API: the page gets
  presence, mode and a masked key, and a probe (`gh auth status`) runs only on
  Check. Workbench's own folder is `workbenchDir()` in `core/env.ts`.

## Traps

- **`asSystem()` reads `Session.tokenHash`**, as Haven's does: `@guarded` hides it from everyone else.
- **A page and a service share a URL** (`/workbench/` is both). The dev proxy tells them apart by `Accept`; `web/config/api-paths.js` derives the proxied paths from `app.snapshot.md`, so regenerate it (`junction app --app api/src/app.ts`) after adding a service.
- **A preview's freeze builds on Basecamp's disk**: `freeze` sends `branch.path` and is refused unless the entry's `url` is loopback (`IDEAS/workbench-package.md` § 3.1 Q). Open, thaw and retire work over the wire.
- **`/ws` carries one channel**, `notifications:user:<memberId>` (`core/channels.ts`); the inApp driver pushes there and the bell's tether merges the frame. `notifications` is the service's name for that reason -- the client routes a frame by the service named in its first word.

## Desktop

```
bun run build:desktop  # desktop/: web/ bundled into a Tauri shell, at
                       # desktop/shell/target/debug/workbench-desktop; needs `bun run api`
bun run verify:desktop # that shell, signed in at the door and scanning, on an OS-chosen API port
fli desktop:run        # build it, start the API if nothing answers on 5501, open the window
fli desktop:install    # add it to the app launcher; a click opens it through desktop:run
                       # (--release: the release shell, after fli desktop:run --release)
```

The drive holds no port: the global block has no slot for one, so it builds the
bundle against whatever port the OS hands its scratch API. The binary it leaves
behind points there; `bun run build:desktop` puts 5501 back.

## Proving a change

`bun run typecheck`, `bun run test` (`api/test/peer-dialer.test.ts` is the signed call
against a stub door; `services.test.ts` the bell's service). For anything under `web/`, start
`bun run api` and `bun run web`, sign in, and see `/workbench/`; stop both after. The drives,
by `DRIVES.md`: `verify:desktop` (the shell, the door and the local scan) and `verify:atlas`
(`/atlas/` over the real registers, signed in at this door; holds no port). The live peer call needs a running Basecamp with this key enrolled.
