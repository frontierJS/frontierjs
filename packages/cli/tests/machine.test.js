// ─── machine.test.js — running a command on the machine being deployed to ─────
//
// Two halves, and the second is the one that matters.
//
// The pure half asserts the argv: which transport a host resolves to, and what
// command carries a script there. The executed half runs real scripts through
// the real `sh -s` and asserts the property the whole module exists for — that
// a script reaches the target's shell UNTOUCHED. Every defect this replaced was
// a script mangled in transit, and none of them is visible in a string
// comparison: `ssh HOST "…"` looks correct until a shell parses it twice.
//
// The regression corpus at the bottom is the nine commands that shipped broken.
// They are asserted as SCRIPTS now — `sh -n` on the exact text the target
// receives — because that is the check that would have caught them.

import { describe, test, expect } from 'bun:test'
import { execSync, execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const HERE = dirname(fileURLToPath(import.meta.url))
import {
  LOCAL_SERVERS, serverOf, transportFor, shQuote,
  runCommand, reachCommand, sendCommand, withCwd, createMachine,
  shipCommand, sameMachine,
} from '../core/machine.js'

// A real `context.exec`: the same execSync call the runtime makes.
const realExec = ({ command, ...opts }) => execSync(command, { stdio: 'inherit', ...opts })

// ─── which transport ─────────────────────────────────────────────────────────

describe('which transport a host resolves to', () => {
  test('the server half decides, not the user half', () => {
    expect(serverOf('deploy@box.example.com')).toBe('box.example.com')
    expect(serverOf('box.example.com')).toBe('box.example.com')
    expect(serverOf('  deploy@localhost ')).toBe('localhost')
  })

  test('a real server is ssh', () => {
    expect(transportFor('deploy@box.example.com')).toBe('ssh')
  })

  // The user half is meaningless locally — there is nothing to log in to.
  test('localhost is local however it is spelled, and whoever it names', () => {
    for (const s of LOCAL_SERVERS) {
      expect(transportFor(s)).toBe('local')
      expect(transportFor(`deploy@${s}`)).toBe('local')
    }
  })

  // Somebody testing their own sshd is a real thing to want, and no name-based
  // rule can reach it.
  test('a declared transport beats the inference, both ways', () => {
    expect(transportFor('deploy@localhost', 'ssh')).toBe('ssh')
    expect(transportFor('deploy@box.example.com', 'local')).toBe('local')
  })

  test('a transport that is neither is refused by name', () => {
    expect(() => transportFor('deploy@box', 'rsync')).toThrow(/rsync/)
  })
})

// ─── the argv ────────────────────────────────────────────────────────────────

describe('the command that carries a script', () => {
  test('ssh appends sh -s and nothing else — the script is not on the command line', () => {
    expect(runCommand('deploy@box', 'ssh')).toBe('ssh deploy@box sh -s')
  })

  test('local is the same command with no prefix', () => {
    expect(runCommand('deploy@localhost', 'local')).toBe('sh -s')
  })

  test('a local target is reachable by construction, so there is no probe', () => {
    expect(reachCommand('localhost', 'local')).toBe(null)
    expect(reachCommand('deploy@box', 'ssh')).toMatch(/BatchMode=yes/)
  })

  test('a path with a space survives quoting', () => {
    expect(sendCommand('deploy@box', 'local', '/a b/x.mjs', '/c d/x.mjs'))
      .toBe(`cp -f '/a b/x.mjs' '/c d/x.mjs'`)
  })

  test('an apostrophe in a path does not end the quote', () => {
    expect(shQuote(`/srv/jordan's app`)).toBe(`'/srv/jordan'\\''s app'`)
    // and it survives a round trip through a real shell
    const out = execSync(`printf '%s' ${shQuote(`/srv/jordan's app`)}`, { encoding: 'utf8' })
    expect(out).toBe(`/srv/jordan's app`)
  })
})

describe('a working directory', () => {
  test('no cwd leaves the script alone', () => {
    expect(withCwd('echo hi', null)).toBe('echo hi')
  })

  // A `cd` that fails and lets the rest run is how a deploy builds the wrong
  // tree, and it is silent until something much later reports a stale image.
  test('a cwd that does not exist stops the script rather than running it elsewhere', () => {
    const script = withCwd('echo SHOULD-NOT-RUN', '/nope/definitely/not/here')
    let out = ''
    try {
      out = String(execSync('sh -s', { input: script, stdio: 'pipe' }))
    } catch (e) {
      out = String(e.stdout ?? '')
    }
    expect(out).not.toMatch(/SHOULD-NOT-RUN/)
  })
})

// ─── the property the module exists for ──────────────────────────────────────

describe('a script reaches the target untouched', () => {
  const machine = createMachine({ host: 'localhost', exec: realExec })

  test('the transport is named in the description — a local deploy must not read as a remote one', () => {
    expect(machine.describe()).toBe('localhost (local)')
    expect(createMachine({ host: 'deploy@box', exec: realExec }).describe()).toBe('deploy@box')
  })

  test('newlines survive, so `then` and `do` stay on their own lines', () => {
    const out = machine.capture(`if true; then
  echo yes
fi
for i in 1 2; do
  echo "loop $i"
done`)
    expect(out).toBe('yes\nloop 1\nloop 2')
  })

  // The measured defect: `$(…)` inside an interpolated ssh string ran on the
  // operator's machine and arrived as literal text.
  test('$(…) is evaluated once, on the target', () => {
    const out = machine.capture(`echo "count=$(printf 'a\\nb\\nc' | wc -l)"`)
    expect(out).toBe('count=2')
  })

  test('nested double quotes survive — %{http_code} was the one that broke', () => {
    const out = machine.capture(`printf '%s' "a \\"b\\" %{http_code}"`)
    expect(out).toBe('a "b" %{http_code}')
  })

  test('a variable set in the script is read by the script, not by the local shell', () => {
    const out = machine.capture(`STATUS=200
if [ "$STATUS" = "200" ]; then
  echo matched
fi`)
    expect(out).toBe('matched')
  })

  test('a failing script throws', () => {
    expect(() => machine.capture('exit 7')).toThrow()
  })

  // `execSync` says `Command failed: sh -s`, which names every script this
  // module runs and distinguishes none of them — and that string is what the
  // journal records, so a failed step could not be attributed afterwards.
  test('a failure names the script and the machine it ran on', () => {
    try {
      machine.run('docker rename nothing-here also-nothing\nexit 3', { stdio: 'pipe' })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err.message).toContain('docker rename nothing-here')
      expect(err.message).toContain('the local machine')
      expect(err.script).toContain('exit 3')
    }
  })

  test('the reason is in the message, and only once', () => {
    try {
      machine.capture('cat /no/such/path/anywhere')
      throw new Error('should have thrown')
    } catch (err) {
      expect(err.message).toContain('No such file or directory')
      expect(err.message.split('No such file or directory').length - 1).toBe(1)
    }
  })

  test('a remote failure names the host rather than the local machine', () => {
    const m = createMachine({
      host: 'deploy@box',
      exec: () => { const e = new Error('Command failed: ssh deploy@box sh -s'); throw e },
    })
    try {
      m.run('docker stop app')
      throw new Error('should have thrown')
    } catch (err) {
      expect(err.message).toContain('on deploy@box')
      expect(err.message).toContain('docker stop app')
    }
  })

  test('a local target reports itself reachable without running a probe', () => {
    let calls = 0
    const t = createMachine({ host: 'localhost', exec: () => { calls++ } })
    expect(t.reach()).toBe(true)
    expect(calls).toBe(0)
  })

  test('an unreachable ssh target answers false rather than throwing', () => {
    const t = createMachine({ host: 'deploy@box', exec: () => { throw new Error('no route') } })
    expect(t.reach()).toBe(false)
  })
})

// ─── moving an image ─────────────────────────────────────────────────────────

describe('moving an image between machines', () => {
  const M = (kind, host) => ({ kind, host })

  // No registry and no temp file: `IDEAS/deploy-plane.md` keeps three
  // distribution strategies open, and this is the one that needs nothing.
  test('save on one end, load on the other, in one pipeline', () => {
    expect(shipCommand(M('ssh', 'deploy@build'), M('ssh', 'deploy@prod'), 'sha256:abc'))
      .toBe('ssh deploy@build docker save sha256:abc | ssh deploy@prod docker load')
  })

  test('a local end is the pipe itself, with no ssh', () => {
    expect(shipCommand(M('local', 'localhost'), M('ssh', 'deploy@prod'), 'sha256:abc'))
      .toBe('docker save sha256:abc | ssh deploy@prod docker load')
    expect(shipCommand(M('ssh', 'deploy@build'), M('local', 'localhost'), 'sha256:abc'))
      .toBe('ssh deploy@build docker save sha256:abc | docker load')
  })

  // Two names for one daemon means the bytes are already there.
  test('one daemon is not two machines', () => {
    expect(sameMachine(M('local', 'localhost'), M('local', 'deploy@127.0.0.1'))).toBe(true)
    expect(sameMachine(M('ssh', 'deploy@a'), M('ssh', 'deploy@a'))).toBe(true)
    expect(sameMachine(M('ssh', 'deploy@a'), M('ssh', 'deploy@b'))).toBe(false)
    expect(sameMachine(M('ssh', 'deploy@a'), M('local', 'deploy@a'))).toBe(false)
  })

  test('shipping to the same daemon runs nothing and says so', () => {
    let calls = 0
    const a = createMachine({ host: 'localhost', exec: () => { calls++ } })
    const b = createMachine({ host: 'local',     exec: () => { calls++ } })
    expect(a.shipTo(b, 'sha256:abc')).toBe(false)
    expect(calls).toBe(0)
  })

  test('shipping to another machine runs the pipeline and says so', () => {
    let cmd = null
    const a = createMachine({ host: 'localhost',   exec: (o) => { cmd = o.command } })
    const b = createMachine({ host: 'deploy@prod', exec: () => {} })
    expect(a.shipTo(b, 'sha256:abc')).toBe(true)
    expect(cmd).toBe('docker save sha256:abc | ssh deploy@prod docker load')
  })

  // The property the whole thing rests on: what may not vary is which bytes ran.
  test('a save/load round trip preserves the image id', () => {
    const exists = (() => {
      try { execSync('docker image inspect alpine:3.19 > /dev/null 2>&1'); return true }
      catch { return false }
    })()
    if (!exists) return              // no image to hand; the argv tests still stand

    const before = execSync(`docker image inspect alpine:3.19 --format '{{.Id}}'`, { encoding: 'utf8' }).trim()
    execSync(shipCommand({ kind: 'local' }, { kind: 'local' }, before), { stdio: 'pipe' })
    const after = execSync(`docker image inspect ${before} --format '{{.Id}}'`, { encoding: 'utf8' }).trim()
    expect(after).toBe(before)
  })
})

describe('send puts a file there', () => {
  test('locally it is a copy, and the bytes arrive', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fli-target-'))
    const src = join(dir, 'runner.mjs')
    const dst = join(dir, 'copied.mjs')
    writeFileSync(src, 'export const x = 1\n')

    createMachine({ host: 'localhost', exec: realExec }).send(src, dst)

    expect(existsSync(dst)).toBe(true)
    expect(readFileSync(dst, 'utf8')).toBe('export const x = 1\n')
  })
})

// ─── the regression corpus ───────────────────────────────────────────────────
//
// Nine of the ten multi-line commands in the deploy pipeline were shell syntax
// errors on the target, because `.replace(/\n\s*/g, '; ')` turns `then` into
// `then;` and `do` into `do;`. These are the shapes, kept as scripts. `sh -n`
// parses without executing, which is the check nothing was running.

const parses = (script) => {
  try { execFileSync('sh', ['-n'], { input: script, stdio: ['pipe', 'pipe', 'pipe'] }); return true }
  catch { return false }
}

describe('the shapes that shipped broken', () => {
  test('the join that produced them is refused by sh, so the corpus is honest', () => {
    const body = `if docker inspect app > /dev/null 2>&1; then
  docker rename app app_replaced
fi`
    expect(parses(body)).toBe(true)
    expect(parses(body.trim().replace(/\n\s*/g, '; '))).toBe(false)
  })

  const CORPUS = {
    'the deploy lock': `if [ -f /srv/app/.deploy.lock ]; then
  echo "LOCKED: $(cat /srv/app/.deploy.lock)"
  exit 1
fi
echo "$$:$(date -u +%Y-%m-%dT%H:%M:%SZ):production" > /srv/app/.deploy.lock
echo ok`,

    'the rename': `if docker inspect app > /dev/null 2>&1; then
  docker rename app app_replaced
fi`,

    'the stop': `if docker inspect app_replaced > /dev/null 2>&1; then
  docker stop --time 10 app_replaced
fi`,

    'the health poll': `for i in $(seq 1 10); do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/health 2>/dev/null)
  if [ "$STATUS" = "200" ]; then
    echo ok
    exit 0
  fi
  sleep 2
done
echo fail
exit 1`,

    'the restore': `docker stop app || true
docker rm   app || true
if docker inspect app_replaced > /dev/null 2>&1; then
  docker rename app_replaced app
  docker start  app
  echo restored
else
  echo "no previous container to restore"
fi`,

    'the cleanup': `if docker inspect app_replaced > /dev/null 2>&1; then
  docker stop app_replaced || true
  docker rm   app_replaced
fi`,

    'the rollback': `docker stop  app || true
docker rm    app || true
docker rename app_previous app
docker start  app`,
  }

  for (const [name, script] of Object.entries(CORPUS)) {
    test(`${name} parses as a script`, () => {
      expect(parses(script)).toBe(true)
    })
  }

  // The health poll is the one with a second defect on top of the join, and it
  // is the only one that can be proven end to end without a docker daemon.
  test('the health poll runs on the target and reports its own failure', () => {
    const machine = createMachine({ host: 'localhost', exec: realExec })
    // A port nothing serves: the loop must reach `fail` and exit non-zero, which
    // is the branch that used to be reached by a syntax error instead.
    const script = `for i in $(seq 1 2); do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:1/health 2>/dev/null)
  if [ "$STATUS" = "200" ]; then
    echo ok
    exit 0
  fi
done
echo fail
exit 1`
    let stdout = ''
    try { execSync('sh -s', { input: script, stdio: 'pipe' }) }
    catch (e) { stdout = String(e.stdout ?? '').trim() }
    expect(stdout).toBe('fail')
  })
})

// ─── the script has to REACH the shell ────────────────────────────────────────
//
// `execSync(cmd, { input, stdio: 'inherit' })` ignores `input` on node — stdin
// is the parent's, so `sh -s` reads EOF and exits 0 having run nothing — and
// honours it on bun. Every script this module sends travels on stdin, so under
// node every `machine.run` in the deploy pipeline was a silent no-op that
// reported success (`FJS-738`). `fli`'s shebang is `#!/usr/bin/env node`.
//
// The suite runs under bun, where the bug does not reproduce, which is why the
// SHAPE is asserted first: whatever else changes, stdin must be piped.

describe('a script sent to a machine', () => {

  test('is delivered on a PIPED stdin, never an inherited one', () => {
    let seen = null
    const m = createMachine({ host: 'localhost', exec: (opts) => { seen = opts } })
    m.run('echo hello')

    expect(seen.input).toContain('echo hello')
    expect(seen.stdio).not.toBe('inherit')
    expect(Array.isArray(seen.stdio)).toBe(true)
    expect(seen.stdio[0]).toBe('pipe')
  })

  test('and stdout and stderr are still the operator\'s', () => {
    let seen = null
    const m = createMachine({ host: 'localhost', exec: (opts) => { seen = opts } })
    m.run('echo hello')

    expect(seen.stdio[1]).toBe('inherit')
    expect(seen.stdio[2]).toBe('inherit')
  })

  test('a caller that states its own stdio still gets it', () => {
    let seen = null
    const m = createMachine({ host: 'localhost', exec: (opts) => { seen = opts } })
    m.capture('echo hello')
    expect(seen.stdio).toBe('pipe')
  })

  // The failure itself, under the runtime that has it. Skipped rather than
  // faked where there is no node — a shape assertion is above and this is the
  // execution.
  test('really runs, under node', () => {
    const node = execSync('command -v node || true', { encoding: 'utf8' }).trim()
    if (!node) return

    const mark = join(tmpdir(), `fjs-machine-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const probe = `
      const { createMachine } = await import(${JSON.stringify(pathToFileURL(join(HERE, '..', 'core', 'machine.js')).href)})
      const { execSync } = await import('node:child_process')
      const m = createMachine({ host: 'localhost', exec: ({ command, ...opts }) => execSync(command, { stdio: 'inherit', ...opts }) })
      m.run(${JSON.stringify(`touch ${mark}`)})
    `
    execFileSync(node, ['--input-type=module', '-e', probe], { stdio: 'pipe' })

    const made = existsSync(mark)
    if (made) rmSync(mark, { force: true })
    expect(made).toBe(true)
  })
})
