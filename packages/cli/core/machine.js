// machine.js — running a command on the machine being deployed to.
//
// One owner for one translation (Invariant 4): (host, script) → the argv that
// runs that script THERE. Before this, every call site across the twenty-eight
// files of the deploy namespace spelled `ssh ${host} "${cmd}"` by hand, and there
// was no local backend at all — so nothing in this repo could execute the deploy
// path, which is how everything in the next section stayed true for as long as
// it did.
//
// It is a MACHINE and not a target because `target` is already the environment
// in every deploy command — `resolveTarget` answers `production` — and one word
// for the environment and the box would make `deploy --production` to localhost
// unsayable.
//
// ─── the script travels on stdin, and that is the whole design ───────────────
//
// `context.exec` runs `execSync(command)`, which is `/bin/sh -c` — so a script
// interpolated into that string is parsed TWICE, once by the local shell and
// once by the remote one. Measured against the health check that shipped:
//
//   ssh HOST "for i in $(seq 1 10); do; STATUS=$(curl -s -w "%{http_code}" …
//
//   · `$(seq 1 10)` ran on the OPERATOR'S machine and arrived as literal text
//   · `$(curl …)` also ran locally, polling the operator's own localhost:3000
//   · the nested `"` around %{http_code} closed the outer quote
//   · `"$STATUS"` expanded locally to empty, so the target received `[  = 200 ]`
//
// Nine of the ten multi-line commands in the pipeline were shell syntax errors
// on the target, for a second reason that compounds the first:
// `.replace(/\n\s*/g, '; ')` turns `then` into `then;` and `do` into `do;`, and
// sh refuses both. The lock, the rename, the stop, the health poll, the restore,
// the cleanup and the rollback were all in that set.
//
// So a script is never interpolated and never joined. It goes to `sh -s` on
// stdin, where no shell but the target's own ever reads it: newlines survive,
// quotes survive, and `$(…)` is evaluated exactly once, there.
//
// ─── local is a transport, not a simulation ──────────────────────────────────
//
// The local backend is the same script through the same `sh -s`, minus the ssh
// prefix. It is not a mock and it is not a dry run: it runs the real docker
// commands against the real daemon. That is what makes it usable as the proof
// the `deploy` CI phase owes — a pipeline nothing executes is a pipeline whose
// nine syntax errors nobody finds.

import { isVerbose } from './verbosity.js'

// ─── which transport ─────────────────────────────────────────────────────────

/** Server names that mean *this machine*. Compared against the server, never the user@ half. */
export const LOCAL_SERVERS = new Set(['local', 'localhost', '127.0.0.1', '::1'])

/** The server half of a host. `deploy@box` → `box`; a bare `box` → `box`. */
export const serverOf = (host) => String(host ?? '').split('@').pop().trim()

/**
 * Inferred transport, overridable.
 *
 * Inference is on the SERVER name because `host` is `${user}@${server}` or the
 * bare server (`sshHost`), and the user half means nothing locally — there is no login.
 * `transport: 'ssh'` is the escape for somebody genuinely testing sshd on their
 * own box, which is a real thing to want and unreachable by any name-based rule.
 */
export function transportFor(host, declared = null) {
  if (declared === 'ssh' || declared === 'local') return declared
  if (declared) throw new Error(`Unknown deploy transport: ${declared} — expected 'ssh' or 'local'`)
  return LOCAL_SERVERS.has(serverOf(host)) ? 'local' : 'ssh'
}

// ─── the argv ────────────────────────────────────────────────────────────────

/** Single-quote for sh. Used for paths only — a script is never quoted, it is piped. */
export const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

/**
 * One TCP + auth handshake per deploy instead of one per command.
 *
 * A deploy makes eighty-odd calls to its target, and a fresh handshake was 1.35s
 * of each against a 100ms-RTT box (0.21s multiplexed), so most of a two-minute
 * deploy was logging in. Every ssh, scp and rsync below carries these options.
 *
 * The path is under `~/.ssh` and short: a unix socket path is capped at 108
 * bytes and ssh refuses to start past it, which a per-session temp directory
 * exceeds. `%C` is a hash of local host, remote host, port and user, so two
 * users or two boxes never share a socket. The master outlives `fli` by
 * `ControlPersist` and exits on its own.
 */
export const SSH_MUX = `-o ControlMaster=auto -o ControlPath=${shQuote('~/.ssh/fli-%C')} -o ControlPersist=60`

/**
 * The command that reads a script on stdin and runs it on the target.
 *
 * `sh -s` rather than `bash`: a deploy target is whatever the operator has, and
 * every script here is POSIX. ssh joins its trailing args with a space and hands
 * them to the remote login shell, so the remote runs `sh -s` and reads our pipe.
 */
export const runCommand = (host, transport) =>
  transport === 'local' ? 'sh -s' : `ssh ${SSH_MUX} ${host} sh -s`

/**
 * Run a PROGRAM there with something else on stdin.
 *
 * The one case `runCommand` cannot serve: the journal runner reads a JSON object
 * on stdin, so that channel is already taken and the program has to be named on
 * the command line. Safe here because the program is `bun <path>` with no
 * caller-supplied argument — and it is a verb on the machine rather than an ssh
 * string in `_module.md`, so the local backend keeps working.
 */
export const pipeCommand = (host, transport, command) =>
  transport === 'local' ? command : `ssh ${SSH_MUX} ${host} ${command}`

/**
 * Run an INTERACTIVE program there — one that wants the operator's terminal.
 *
 * The second case `runCommand` cannot serve, and for the opposite reason to
 * `pipeCommand`: `docker exec -it` and `docker logs --follow` need stdin to be
 * the terminal, so the script cannot travel on it and the command has to be an
 * argument. Single-quoted rather than double, so the local shell expands nothing
 * — a command the operator typed reaches the target as they typed it.
 *
 * `pty: false` is the same command for a one-liner: a remote pty merges stderr
 * into stdout, where `-e` puts the answer alone.
 */
export const ttyCommand = (host, transport, command, { pty = true } = {}) =>
  transport === 'local' ? command : `ssh${pty ? ' -t' : ''} ${SSH_MUX} ${host} ${shQuote(command)}`

/**
 * Move an image from one machine to another, by content.
 *
 * `docker save` on one end piped into `docker load` on the other — no registry,
 * no temp file, and no trip through the operator's disk. `IDEAS/deploy-plane.md`
 * keeps three distribution strategies open and makes none of them the
 * definition; this is the one that needs no infrastructure, and it works today.
 * **What may not vary is which bytes ran**, and a save/load round trip preserves
 * the image ID, so the digest the Release names is the digest that starts.
 *
 * Each end is `pipeCommand` — bare where the machine is this one, ssh-prefixed
 * where it is not — so every combination of transports is the same one line.
 * Same machine is not this function's case: the caller skips it, because two
 * names for one daemon means the bytes are already there.
 */
export const shipCommand = (from, to, image) =>
  `${pipeCommand(from.host, from.kind, `docker save ${image}`)} | ` +
  `${pipeCommand(to.host, to.kind, 'docker load')}`

/** Are these two the same daemon? Host AND transport, because `local` is a daemon and a name is not. */
export const sameMachine = (a, b) =>
  a.kind === b.kind && (a.kind === 'local' || a.host === b.host)

/** The reachability probe. Local is reachable by construction; saying otherwise would be theater. */
export const reachCommand = (host, transport) =>
  transport === 'local' ? null : `ssh -o ConnectTimeout=5 -o BatchMode=yes ${SSH_MUX} ${host} true`

/** Put a local file on the target. */
export const sendCommand = (host, transport, localPath, remotePath) =>
  transport === 'local'
    ? `cp -f ${shQuote(localPath)} ${shQuote(remotePath)}`
    : `scp -q ${SSH_MUX} ${shQuote(localPath)} ${host}:${remotePath}`

/** Bring a file or directory on the target here — `sendCommand` the other way. */
export const fetchCommand = (host, transport, remotePath, localPath) =>
  transport === 'local'
    ? `cp -Rf ${shQuote(remotePath)} ${shQuote(localPath)}`
    : `scp -rq ${SSH_MUX} ${host}:${remotePath} ${shQuote(localPath)}`

/**
 * Mirror a local directory onto the target, deleting what is no longer in it.
 *
 * `--delete` because a tarball left from a previous version is a spec nothing
 * points at and megabytes in every layer that follows. The trailing slashes are
 * rsync's contents-of rather than the-directory-itself and are load-bearing.
 */
export const syncCommand = (host, transport, localDir, remoteDir) =>
  transport === 'local'
    ? `rsync -a --delete ${shQuote(localDir + '/')} ${shQuote(remoteDir + '/')}`
    : `rsync -a --delete -e ${shQuote(`ssh ${SSH_MUX}`)} ${shQuote(localDir + '/')} ${host}:${remoteDir}/`

/**
 * A script with its working directory established.
 *
 * `|| exit 1` because `cd` failing and the rest running anyway is how a deploy
 * builds the wrong tree — the step that pulls into `${path}` and the step that
 * builds in it are separate, so a missing path is silent until something later
 * reports a stale image.
 */
export function withCwd(body, cwd) {
  if (!cwd) return String(body)
  return `cd ${shQuote(cwd)} || exit 1\n${body}`
}

/** Past this many bytes of held output, execSync kills the child rather than truncating. */
export const HELD_MAX_BYTES = 256 * 1024 * 1024

/** How many of a held run's last lines a failure carries. --verbose shows them all as they come. */
export const HELD_TAIL_LINES = 40

const tail = (out) => {
  const lines = String(out ?? '').trimEnd().split('\n')
  if (lines.length === 1 && !lines[0]) return ''
  const shown = lines.slice(-HELD_TAIL_LINES).join('\n')
  return lines.length > HELD_TAIL_LINES
    ? `…${lines.length - HELD_TAIL_LINES} earlier line(s) held — --verbose prints every one\n${shown}`
    : shown
}

// ─── the machine ─────────────────────────────────────────────────────────────

/**
 * A machine, and everything a deploy does to one.
 *
 * `exec` is injected — `context.exec` in a step file, a spawn in a test. The
 * same seam `createDocker({ run })` uses in `@frontierjs/outpost`, and for the
 * same reason: the alternative is a pipeline that can only be exercised by
 * having a server.
 *
 *   run(script, opts)      run a script there, throw on failure; output held unless verbose
 *   capture(script, opts)  the same, answering stdout as a string
 *   tty(command)           an interactive program, the operator's terminal attached
 *   pipe(command, input)   a named program, with `input` on its stdin
 *   send(local, remote)    put a file there
 *   sync(localDir, remote) mirror a directory there
 *   reach()                is it reachable — true/false, never a throw
 *
 * `run` and `capture` are the ones to reach for. `tty` and `pipe` exist because
 * stdin can only carry one thing, and those two need it for something else.
 */
export function createMachine({ host, exec, transport = null, path = null, verbose = isVerbose() }) {
  const kind = transportFor(host, transport)
  const cmd  = runCommand(host, kind)

  // `path` is carried as data and is deliberately NOT a default cwd: several
  // scripts run before it exists (the mkdir that creates `.fli`), and a cwd that
  // silently fails is exactly what `withCwd`'s `|| exit 1` exists to refuse.
  // `describe` is what --dry prints. Without it every step of a deploy reads as
  // the same line — `ssh host sh -s` — since the script is on stdin.
  // STDIN IS PIPED AND THE REST IS INHERITED, and the three cannot be collapsed
  // to `'inherit'`. `execSync` with `stdio: 'inherit'` IGNORES `input` on node —
  // stdin is the parent's, `sh -s` reads EOF and exits 0 having run nothing — and
  // HONORS it on bun. The script travels on stdin, so under node every
  // `machine.run` in the pipeline was a silent no-op that reported success: the
  // mkdir that creates `.fli`, the swap, the lock release, all of it. `fli`'s
  // shebang was node then, so that is what a global install did; CI never saw
  // it because the deploy phase invokes `bun <fli>` explicitly (`FJS-738`).
  // Piping stdin alone delivers the script on both runtimes and keeps the
  // operator's view of stdout and stderr.
  //
  // HELD unless --verbose: a deploy's targets print a bun install, a vite build
  // and a docker build, several hundred lines between the dozen the operator
  // acts on. `exec 2>&1` merges the target's two streams in order there, so a
  // failure's message ends with the last lines it wrote (`attribute`) and the
  // journal records them. ssh's own stderr stays the operator's, which is where
  // a refused connection says so. maxBuffer because past it execSync kills the
  // child, and a held docker build is what would reach it.
  const holds = (opts) => !verbose && opts?.stdio === undefined
  const call = (script, { cwd = null, stdio, ...opts } = {}) => {
    const body = withCwd(script, cwd)
    const held = holds({ stdio })
    return exec({
      command:  cmd,
      input:    held ? `exec 2>&1\n${body}` : body,
      stdio:    stdio ?? ['pipe', held ? 'pipe' : 'inherit', 'inherit'],
      describe: `${kind === 'local' ? 'sh' : `ssh ${host}`} <<'EOF'\n${body}\nEOF`,
      ...(held && { maxBuffer: HELD_MAX_BYTES }),
      ...opts,
    })
  }

  // A failed `execSync` says `Command failed: sh -s`, which names every script
  // this module runs and distinguishes none of them — and that string is what
  // the journal records, so a step that failed cannot be attributed afterwards.
  // The script goes into the message; stderr joins it where it was captured
  // (`capture`), and is on the operator's terminal where it was not (`run`).
  const attribute = (err, script, held = false) => {
    const first = String(script).split('\n').find(l => l.trim()) ?? ''
    const where = kind === 'local' ? 'the local machine' : host
    // execSync already folds stderr into its own message when it captured any,
    // so appending it again prints the reason twice.
    const errs = String(err?.stderr ?? '').trim()
    const base = String(err.message ?? '')
    const said = held ? tail(err?.stdout) : ''
    err.script  = script
    err.message = `${base} — on ${where}: ${first.trim().slice(0, 120)}` +
      (errs && !base.includes(errs) ? `\n${errs}` : '') +
      (said ? `\n${said}` : '')
    return err
  }

  return {
    kind,
    host,
    path,
    local: kind === 'local',

    /** What to print in a log line. The transport is named because a local deploy must not read as a remote one. */
    describe: () => (kind === 'local' ? `${serverOf(host)} (local)` : host),

    run: (script, opts) => {
      try { return call(script, opts) }
      catch (err) { throw attribute(err, script, holds(opts)) }
    },

    // `stdio: 'pipe'`, and never a `capture: true` — the latter is not an
    // execSync option, so it leaves the output on the terminal and returns null
    // (`FJS-537`). Set here once so no caller has to know that.
    capture: (script, opts) => {
      try { return String(call(script, { ...opts, stdio: 'pipe' }) ?? '').trim() }
      catch (err) { throw attribute(err, script) }
    },

    /** Run an interactive program there, with the operator's terminal attached. */
    tty: (command, { pty, ...opts } = {}) =>
      exec({ command: ttyCommand(host, kind, command, { pty }), ...opts }),

    /** Run a named program there, with `input` on its stdin. Answers stdout. */
    pipe: (command, input) =>
      String(exec({ command: pipeCommand(host, kind, command), input, stdio: 'pipe' }) ?? ''),

    send: (localPath, remotePath) =>
      exec({ command: sendCommand(host, kind, localPath, remotePath) }),

    fetch: (remotePath, localPath) =>
      exec({ command: fetchCommand(host, kind, remotePath, localPath) }),

    /** Mirror a local directory there. */
    sync: (localDir, remoteDir) =>
      exec({ command: syncCommand(host, kind, localDir, remoteDir) }),

    /**
     * Send an image from THIS machine to another one, by content.
     *
     * Answers `false` where the two are one daemon — the bytes are already
     * there, and saving and loading them into themselves is a slow no-op.
     */
    shipTo: (other, image, opts) => {
      if (sameMachine({ kind, host }, { kind: other.kind, host: other.host })) return false
      exec({
        command:  shipCommand({ kind, host }, { kind: other.kind, host: other.host }, image),
        describe: `docker save ${image} on ${host} | docker load on ${other.host}`,
        ...opts,
      })
      return true
    },

    reach: () => {
      const probe = reachCommand(host, kind)
      if (!probe) return true
      try { exec({ command: probe, stdio: 'ignore' }); return true }
      catch { return false }
    },
  }
}
