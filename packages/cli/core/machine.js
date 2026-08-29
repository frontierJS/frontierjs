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

// ─── which transport ─────────────────────────────────────────────────────────

/** Server names that mean *this machine*. Compared against the server, never the user@ half. */
export const LOCAL_SERVERS = new Set(['local', 'localhost', '127.0.0.1', '::1'])

/** The server half of a host. `deploy@box` → `box`; a bare `box` → `box`. */
export const serverOf = (host) => String(host ?? '').split('@').pop().trim()

/**
 * Inferred transport, overridable.
 *
 * Inference is on the SERVER name because `host` is always `${user}@${server}`
 * (`resolveSide`), and the user half means nothing locally — there is no login.
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
 * The command that reads a script on stdin and runs it on the target.
 *
 * `sh -s` rather than `bash`: a deploy target is whatever the operator has, and
 * every script here is POSIX. ssh joins its trailing args with a space and hands
 * them to the remote login shell, so the remote runs `sh -s` and reads our pipe.
 */
export const runCommand = (host, transport) =>
  transport === 'local' ? 'sh -s' : `ssh ${host} sh -s`

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
  transport === 'local' ? command : `ssh ${host} ${command}`

/**
 * Run an INTERACTIVE program there — one that wants the operator's terminal.
 *
 * The second case `runCommand` cannot serve, and for the opposite reason to
 * `pipeCommand`: `docker exec -it` and `docker logs --follow` need stdin to be
 * the terminal, so the script cannot travel on it and the command has to be an
 * argument. Single-quoted rather than double, so the local shell expands nothing
 * — a command the operator typed reaches the target as they typed it.
 */
export const ttyCommand = (host, transport, command) =>
  transport === 'local' ? command : `ssh -t ${host} ${shQuote(command)}`

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

/** The reachability probe. Local is reachable by construction; saying otherwise would be theatre. */
export const reachCommand = (host, transport) =>
  transport === 'local' ? null : `ssh -o ConnectTimeout=5 -o BatchMode=yes ${host} true`

/** Put a local file on the target. */
export const sendCommand = (host, transport, localPath, remotePath) =>
  transport === 'local'
    ? `cp -f ${shQuote(localPath)} ${shQuote(remotePath)}`
    : `scp -q ${shQuote(localPath)} ${host}:${remotePath}`

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
    : `rsync -a --delete ${shQuote(localDir + '/')} ${host}:${remoteDir}/`

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

// ─── the machine ─────────────────────────────────────────────────────────────

/**
 * A machine, and everything a deploy does to one.
 *
 * `exec` is injected — `context.exec` in a step file, a spawn in a test. The
 * same seam `createDocker({ run })` uses in `@frontierjs/outpost`, and for the
 * same reason: the alternative is a pipeline that can only be exercised by
 * having a server.
 *
 *   run(script, opts)      run a script there, output inherited, throw on failure
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
export function createMachine({ host, exec, transport = null, path = null }) {
  const kind = transportFor(host, transport)
  const cmd  = runCommand(host, kind)

  // `path` is carried as data and is deliberately NOT a default cwd: several
  // scripts run before it exists (the mkdir that creates `.fli`), and a cwd that
  // silently fails is exactly what `withCwd`'s `|| exit 1` exists to refuse.
  // `describe` is what --dry prints. Without it every step of a deploy reads as
  // the same line — `ssh host sh -s` — since the script is on stdin.
  const call = (script, { cwd = null, stdio = 'inherit', ...opts } = {}) => {
    const body = withCwd(script, cwd)
    return exec({
      command:  cmd,
      input:    body,
      stdio,
      describe: `${kind === 'local' ? 'sh' : `ssh ${host}`} <<'EOF'\n${body}\nEOF`,
      ...opts,
    })
  }

  // A failed `execSync` says `Command failed: sh -s`, which names every script
  // this module runs and distinguishes none of them — and that string is what
  // the journal records, so a step that failed cannot be attributed afterwards.
  // The script goes into the message; stderr joins it where it was captured
  // (`capture`), and is on the operator's terminal where it was not (`run`).
  const attribute = (err, script) => {
    const first = String(script).split('\n').find(l => l.trim()) ?? ''
    const where = kind === 'local' ? 'the local machine' : host
    // execSync already folds stderr into its own message when it captured any,
    // so appending it again prints the reason twice.
    const errs = String(err?.stderr ?? '').trim()
    const base = String(err.message ?? '')
    err.script  = script
    err.message = `${base} — on ${where}: ${first.trim().slice(0, 120)}` +
      (errs && !base.includes(errs) ? `\n${errs}` : '')
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
      catch (err) { throw attribute(err, script) }
    },

    // `stdio: 'pipe'`, and never a `capture: true` — the latter is not an
    // execSync option, so it leaves the output on the terminal and returns null
    // (`FJS-537`). Set here once so no caller has to know that.
    capture: (script, opts) => {
      try { return String(call(script, { ...opts, stdio: 'pipe' }) ?? '').trim() }
      catch (err) { throw attribute(err, script) }
    },

    /** Run an interactive program there, with the operator's terminal attached. */
    tty: (command, opts) =>
      exec({ command: ttyCommand(host, kind, command), ...opts }),

    /** Run a named program there, with `input` on its stdin. Answers stdout. */
    pipe: (command, input) =>
      String(exec({ command: pipeCommand(host, kind, command), input, stdio: 'pipe' }) ?? ''),

    send: (localPath, remotePath) =>
      exec({ command: sendCommand(host, kind, localPath, remotePath) }),

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
