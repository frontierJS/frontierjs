// ─── docker-context.test.js — a build context docker cannot read ─────────────
//
// The failure is a sentence about a missing file that is plainly there, and the
// filed reading of it (*a dot-prefixed directory anywhere in the path*) is not
// what the machine does. So the rows here are the measurement: the shapes that
// build and the shapes that do not, over one cause.
//
// Two halves. The pure grader is asked about recorded probe output, which is
// what runs everywhere. The last section runs a REAL `docker build --check`
// against real directories and is skipped where there is no daemon — it is the
// only thing that can see the grader agreeing with a docker that has changed
// its wording.

import { describe, test, expect, afterAll } from 'bun:test'
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join } from 'path'
import {
  contextProbe, parseProbe, contextRefusal, pathReason,
} from '../core/docker-context.js'

const HOME = '/home/j'
const OPTS = { host: 'srv', dockerfile: 'deploy/Dockerfile', contextPath: '/home/j/.fli/app' }

// The two sentences one cause produces, taken verbatim from docker 29.6.1.
const READ_FAILED = `#1 [internal] load build definition from Dockerfile
#1 transferring dockerfile: 2B done
#1 DONE 0.0s
ERROR: failed to build: failed to solve: failed to read dockerfile: open Dockerfile: no such file or directory`

const RESOLVE_FAILED =
  `ERROR: failed to build: resolve : lstat deploy: no such file or directory`

const CLEAN = `#3 [internal] load .dockerignore
#3 transferring context: 2B done
Check complete, no warnings found.`

const probe = (over = {}) => ({
  home: HOME, pwd: '/home/j/.fli/app', docker: '/usr/bin/snap',
  dockerbin: '/snap/bin/docker', shellread: 'yes', check: READ_FAILED, ...over,
})

describe('which fact about the path put it out of reach', () => {
  test('a hidden directory directly under home', () => {
    expect(pathReason('/home/j/.fli/tutor/server', HOME)).toBe('hidden-under-home')
    expect(pathReason('/home/j/.fli', HOME)).toBe('hidden-under-home')
  })

  // The control that separates this from *a dot anywhere in the path*, which is
  // the reading that was filed and which the machine does not have.
  test('a hidden directory FURTHER down is not the reason', () => {
    expect(pathReason('/home/j/apps/.deep/server', HOME)).toBe('unknown')
  })

  test('outside home at all', () => {
    expect(pathReason('/tmp/build/app', HOME)).toBe('outside-home')
    expect(pathReason('/srv/apps/x', HOME)).toBe('outside-home')
  })

  test('inside home and not hidden is a third answer, not a reason', () => {
    expect(pathReason('/home/j/apps/server', HOME)).toBe('unknown')
    expect(pathReason('', HOME)).toBe('unknown')
    expect(pathReason('/home/j/app', '')).toBe('unknown')
  })

  // `/home/jane` starts with `/home/j` as a string and is a different home.
  test('a home that is a string prefix of the path is not a parent', () => {
    expect(pathReason('/home/jane/apps', HOME)).toBe('outside-home')
  })
})

describe('the probe output is read back whole', () => {
  test('every field, and the check block keeps its newlines', () => {
    const out = [
      'fli:home=/home/j',
      'fli:pwd=/home/j/.fli/app',
      'fli:dockerbin=/snap/bin/docker',
      'fli:docker=/usr/bin/snap',
      'fli:shellread=yes',
      'fli:check=<<',
      READ_FAILED,
    ].join('\n')
    const p = parseProbe(out)
    expect(p.home).toBe('/home/j')
    expect(p.pwd).toBe('/home/j/.fli/app')
    expect(p.dockerbin).toBe('/snap/bin/docker')
    expect(p.shellread).toBe('yes')
    expect(p.check).toContain('no such file or directory')
    expect(p.check.split('\n').length).toBe(4)
  })

  // Docker's own output contains lines that look nothing like the markers; a
  // parser that scanned for `=` anywhere would eat them.
  test('a check line that resembles a marker stays in the check block', () => {
    const p = parseProbe('fli:home=/home/j\nfli:check=<<\nfli:pwd=lies\n')
    expect(p.pwd).toBe('')
    expect(p.check).toBe('fli:pwd=lies')
  })

  test('nothing at all is not a crash', () => {
    expect(parseProbe('').shellread).toBe('')
    expect(parseProbe(null).home).toBe('')
  })
})

describe('the refusal', () => {
  test('fires on the dockerfile-level sentence', () => {
    const r = contextRefusal(probe(), OPTS)
    expect(r).not.toBeNull()
    expect(r[0][0]).toBe('error')
    expect(r[0][1]).toContain('cannot read the build context')
  })

  // The same cause, one stage earlier, with entirely different words.
  test('fires on the context-level sentence too', () => {
    const r = contextRefusal(probe({ check: RESOLVE_FAILED }), OPTS)
    expect(r).not.toBeNull()
  })

  test('names the snap when docker is one, through either spelling', () => {
    const viaWrapper = contextRefusal(probe(), OPTS)
    const viaPath    = contextRefusal(probe({ dockerbin: '/usr/bin/docker', docker: '/snap/bin/docker' }), OPTS)
    for (const r of [viaWrapper, viaPath])
      expect(r.some(([, t]) => /SNAP/.test(t))).toBe(true)
  })

  // The negative control for the snap sentence: the same failure from a docker
  // that is not one must not be explained by a confinement it does not have.
  test('does not name the snap when docker is not one', () => {
    const r = contextRefusal(probe({ dockerbin: '/usr/bin/docker', docker: '/usr/bin/docker' }), OPTS)
    expect(r.some(([, t]) => /SNAP/.test(t))).toBe(false)
    expect(r.some(([, t]) => /confining its reads/.test(t))).toBe(true)
  })

  test('the fix names the directory to rename, or the move out of /tmp', () => {
    const hidden = contextRefusal(probe(), OPTS)
    expect(hidden.at(-1)[1]).toContain('".fli"')

    const outside = contextRefusal(probe({ pwd: '/tmp/build/app' }), { ...OPTS, contextPath: '/tmp/build/app' })
    expect(outside.at(-1)[1]).toContain('under /home/j')
  })

  // A path this cannot explain gets advice that is true rather than advice that
  // is specific: telling somebody to rename a directory that has no dot in it
  // is advice that fails when taken.
  test('an unexplained path is refused without inventing a cause', () => {
    const r = contextRefusal(probe({ pwd: '/home/j/apps/server' }), OPTS)
    expect(r).not.toBeNull()
    expect(r.at(-1)[1]).toMatch(/AppArmor|SELinux|confines/)
  })

  test('a context that reads is silent', () => {
    expect(contextRefusal(probe({ check: CLEAN }), OPTS)).toBeNull()
  })

  // The one shape that must NOT be adopted: the file is genuinely absent, which
  // is 02b-build-check's sentence and not this one.
  test('a dockerfile the shell cannot read either is not this', () => {
    expect(contextRefusal(probe({ shellread: 'no' }), OPTS)).toBeNull()
  })

  // A docker too old to carry `--check` refuses the flag. That is *cannot tell*,
  // and reporting it as a confined context would be a refusal nobody can act on.
  test('a docker that does not know --check is not graded', () => {
    const r = contextRefusal(probe({ check: `unknown flag: --check\nSee 'docker build --help'.` }), OPTS)
    expect(r).toBeNull()
  })

  test('no probe at all is silent', () => {
    expect(contextRefusal(null, OPTS)).toBeNull()
  })
})

describe('the probe script', () => {
  test('parses as a shell script', () => {
    const script = contextProbe('deploy/Dockerfile')
    execFileSync('sh', ['-n'], { input: script })
  })

  test('it asks the shell whether the file is there, and docker separately', () => {
    const script = contextProbe('deploy/Dockerfile')
    expect(script).toContain('[ -f deploy/Dockerfile ]')
    expect(script).toContain('docker build --check -f deploy/Dockerfile .')
  })
})

// ─── against a real daemon ───────────────────────────────────────────────────
// Skipped without one. This is the only row that can see docker changing the
// words the grader reads, and the only one that can see the confinement itself
// stop being true — which is what a fixed snap, or a machine without one, is.
const hasDocker = (() => {
  try { execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'pipe' }); return true }
  catch { return false }
})()

describe.skipIf(!hasDocker)('a real docker, over real directories', () => {
  const run = (dir) => {
    mkdirSync(join(dir, 'deploy'), { recursive: true })
    writeFileSync(join(dir, 'deploy', 'Dockerfile'), 'FROM alpine\nRUN echo built\n')
    const out = execFileSync('sh', ['-s'], {
      input: `cd '${dir}' || exit 1\n` + contextProbe('deploy/Dockerfile'),
      encoding: 'utf8',
    })
    return contextRefusal(parseProbe(out), { host: 'localhost', dockerfile: 'deploy/Dockerfile', contextPath: dir })
  }

  const visible = join(homedir(), `fli-ctx-${process.pid}`)
  const hidden  = join(homedir(), `.fli-ctx-${process.pid}`)
  const outside = join(tmpdir(), `fli-ctx-${process.pid}`)
  const deep    = join(visible, '.deep', 'app')

  // In afterAll, not at the end of a passing branch: a directory left in
  // somebody's home by a test that took the other path, or threw, is this
  // file's own version of the defect it is about.
  afterAll(() => {
    for (const d of [visible, hidden, outside])
      try { rmSync(d, { recursive: true, force: true }) } catch {}
  })

  test('a readable context is silent, at depth', () => {
    expect(run(join(visible, 'a', 'b'))).toBeNull()
  })

  // The row that falsifies *a dot anywhere in the path*. If this ever refuses,
  // the grader and the machine have stopped agreeing.
  test('a hidden directory further down still reads', () => {
    expect(run(deep)).toBeNull()
  })

  test('the two unreadable shapes are both caught, or neither is confined here', () => {
    const h = run(hidden)
    const o = run(outside)
    // A machine whose docker is not confined answers null to both, which is the
    // honest pass: the assertion is that the grader agrees with the machine.
    if (h === null && o === null) return
    expect(h).not.toBeNull()
    expect(o).not.toBeNull()
    expect(o.at(-1)[1]).toContain(homedir())
  })
})
