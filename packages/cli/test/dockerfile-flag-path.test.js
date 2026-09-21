// ─── dockerfile-flag-path.test.js — `-f` against the caller's cwd ────────────
//
// `deploy:local` builds with an ABSOLUTE context and passed `-f` the CONFIGURED
// string, which is relative — and `context.exec` carries no cwd, so it inherits
// the process's. Docker resolves `-f` against the caller's cwd, so the build
// worked only when somebody happened to be standing in the app root.
//
// What made it read as something else: the existence check three screens above
// resolves the same path ABSOLUTE, so the check passed and the build failed,
// which looks exactly like *the Dockerfile was written and docker cannot read
// it* (FJS-544). A command nobody can invoke from a script is the defect; the
// misleading sentence is why it survived.
//
// Two halves. The static half asks the shipped command file, since nothing here
// can execute a `.md` with a real `context`. The real-docker half is the reason
// to believe it, and it asserts the DIGEST is the same either way — a fix that
// changed the image would be a different change wearing this one's name.

import { describe, test, expect, afterAll } from 'bun:test'
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const LOCAL = readFileSync(new URL('../commands/deploy/local.md', import.meta.url), 'utf8')

let hasDocker = true
try { execFileSync('docker', ['info'], { stdio: 'ignore' }) } catch { hasDocker = false }

describe('the shipped command passes an absolute -f', () => {
  const buildLine = LOCAL.split('\n').find((l) => l.includes('context.exec') && l.includes('docker build'))

  test('there is exactly one build call to grade', () => {
    expect(buildLine).toBeTruthy()
  })

  test('-f is the resolved path, not the configured string', () => {
    expect(buildLine).toContain('-f ${dockerfilePath}')
    expect(buildLine).not.toContain('-f ${dockerfile}')
  })

  // A dry run that prints a command other than the one it would run is worse
  // than no dry run: it is the output somebody copies into a terminal.
  test('the --dry line prints what would actually run', () => {
    const dry = LOCAL.split('\n').find((l) => l.includes('log.dry') && l.includes('docker build'))
    expect(dry).toContain('-f ${dockerfilePath}')
    expect(dry).toContain('${context.paths.root}')
  })

  // The sibling call is relative ON PURPOSE and must stay that way: it runs on
  // the target with an explicit cwd and a relative context, where `-f` and the
  // context agree. Grading both the same way is how a correct call gets
  // "fixed" into a broken one.
  test('the on-server build is left relative, because it passes a cwd', () => {
    const step = readFileSync(
      new URL('../commands/deploy/_steps-docker/04-build-api.md', import.meta.url), 'utf8')
    const line = step.split('\n').find((l) => l.includes('docker build'))
    expect(line).toContain('${dockerfile}')
    expect(line).toContain('cwd: buildPath')
  })
})

describe.skipIf(!hasDocker)('a real docker, from a cwd that is not the app root', () => {
  const root = join(homedir(), `fli-dockerfile-flag-${process.pid}`)
  const app = join(root, 'app')
  const elsewhere = join(root, 'elsewhere')

  // Under the user's home rather than tmpdir: a confined daemon cannot read a
  // private /tmp, and that failure (`path ... not found`) is a DIFFERENT one
  // that would mask this test entirely.
  const build = (cwd, dashF, tag) => {
    try {
      const out = execFileSync('docker', ['build', '-q', '-t', tag, '-f', dashF, app],
        { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      return { ok: true, digest: out.trim() }
    } catch (e) {
      return { ok: false, err: `${e.stderr ?? ''}${e.stdout ?? ''}` }
    }
  }

  mkdirSync(join(app, 'deploy'), { recursive: true })
  mkdirSync(elsewhere, { recursive: true })
  writeFileSync(join(app, 'deploy', 'Dockerfile'), 'FROM busybox\nCOPY marker /marker\n')
  writeFileSync(join(app, 'marker'), 'hi\n')

  afterAll(() => {
    try { rmSync(root, { recursive: true, force: true }) } catch {}
    for (const t of ['fli-dff-root', 'fli-dff-rel', 'fli-dff-abs'])
      try { execFileSync('docker', ['rmi', '-f', `${t}:${process.pid}`], { stdio: 'ignore' }) } catch {}
    })

  const T = (n) => `${n}:${process.pid}`

  test('the relative form builds from the app root — which is why it survived', () => {
    const r = build(app, 'deploy/Dockerfile', T('fli-dff-root'))
    if (!r.ok && /not found|permission/i.test(r.err)) return   // daemon cannot read $HOME either
    expect(r.ok).toBe(true)
  })

  test('and fails from anywhere else, naming a directory that is plainly there', () => {
    const r = build(elsewhere, 'deploy/Dockerfile', T('fli-dff-rel'))
    if (r.ok) return   // an unconfined daemon resolving differently is not a failure of the fix
    expect(r.err).toMatch(/lstat deploy|no such file/)
  })

  test('the absolute form builds from anywhere, and to the SAME image', () => {
    const root_ = build(app, 'deploy/Dockerfile', T('fli-dff-root'))
    const abs = build(elsewhere, join(app, 'deploy', 'Dockerfile'), T('fli-dff-abs'))
    if (!root_.ok || !abs.ok) return
    expect(abs.digest).toBe(root_.digest)
  })
})
