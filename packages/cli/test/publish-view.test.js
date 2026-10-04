/*
 * test/publish-view.test.js — the engine behind the GUI's publish walk.
 *
 * The panel is `test/browser/specs/publish.spec.mjs`. What is here needs no
 * Chrome and no registry, and covers what this module decides rather than what
 * `ws:pub` decides:
 *
 *   THE OPTIONS GATE. `ws:pub` pastes `--tag` and `--otp` into a shell string,
 *   so a value of any other shape is refused here, never escaped. A package is
 *   named only by a member the workspace holds, and `--filter` matches by
 *   SUBSTRING — so a name that would also select a second package is refused,
 *   or ticking one box publishes two.
 *
 *   THE ORDER. The gates come before the dry run and the dry run before the
 *   publish; a step that spends a version or pushes asks first.
 *
 *   A REAL DRY RUN. Over a git-initialized fixture workspace, so the plan step
 *   is `ws:pub` itself and the versions it states are its own.
 */
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir }                                        from 'node:os'
import { join, resolve }                                 from 'node:path'
import { fileURLToPath }                                 from 'node:url'
import { execSync }                                      from 'node:child_process'

import {
  PUBLISH_STEPS, PUBLISH_STAGES, describePublish, pubArgv, runPublishStep,
  publishLocal, workspaceMembers, displayArgv,
} from '../core/publish-view.js'

const CLI = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')

let root
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'fli-publish-view-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true, workspaces: ['packages/*'] }))
  for (const [folder, pkg] of [
    ['ui',      { name: '@t/ui',      version: '0.1.0' }],
    ['ui-kit',  { name: '@t/ui-kit',  version: '0.2.0' }],
    ['secret',  { name: '@t/secret',  version: '1.0.0', private: true }],
  ]) {
    mkdirSync(join(root, 'packages', folder), { recursive: true })
    writeFileSync(join(root, 'packages', folder, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
  }
  const git = (c) => execSync(`git ${c}`, { cwd: root, stdio: 'ignore' })
  git('init -q')
  git('-c user.email=t@t -c user.name=t add -A')
  git('-c user.email=t@t -c user.name=t commit -qm init')
})
afterAll(() => { try { rmSync(root, { recursive: true, force: true }) } catch {} })

// ─── the table ───────────────────────────────────────────────────────────────

test('every step is a gate, a note or a command, in a stage that exists', () => {
  const stages = new Set(PUBLISH_STAGES.map(s => s.id))
  const ids    = PUBLISH_STEPS.map(s => s.id)
  expect(new Set(ids).size).toBe(ids.length)
  for (const s of PUBLISH_STEPS) {
    expect(stages.has(s.stage)).toBe(true)
    expect([s.gate, s.argv, s.run].filter(Boolean).length).toBe(1)
  }
  expect(ids.indexOf('commit')).toBeLessThan(ids.indexOf('plan'))
  expect(ids.indexOf('plan')).toBeLessThan(ids.indexOf('publish'))
  expect(ids.indexOf('publish')).toBeLessThan(ids.indexOf('verify'))
})

test('a step that spends a version or pushes asks first', () => {
  for (const id of ['publish', 'push'])
    expect(PUBLISH_STEPS.find(s => s.id === id).confirm?.length ?? 0).toBeGreaterThan(0)
  expect(PUBLISH_STEPS.find(s => s.id === 'plan').confirm).toBeUndefined()
})

test('the page is shown commands as typed, never an argv to send back', () => {
  const { steps } = describePublish()
  expect(steps.every(s => !('argv' in s) && !('fix' in s))).toBe(true)
  expect(steps.find(s => s.id === 'plan').command).toBe('fli ws:pub --dry')
  expect(steps.find(s => s.id === 'whoami').command).toBe('npm whoami')
})

// ─── the options gate ────────────────────────────────────────────────────────

const members = () => workspaceMembers(root)

test('the members are packages/* with a manifest, private ones flagged', () => {
  expect(members().map(m => m.name)).toEqual(['@t/secret', '@t/ui', '@t/ui-kit'])
  expect(members().find(m => m.name === '@t/secret').private).toBe(true)
})

test('an untouched selection sends no --filter, so ws:pub picks', () => {
  expect(pubArgv({}, members()).argv).toEqual(['ws:pub', 'patch'])
  expect(pubArgv({ bump: 'minor', tag: 'beta', all: true, tolerate: true, push: false }, members()).argv)
    .toEqual(['ws:pub', 'minor', '--tag', 'beta', '--all', '--tolerate-republish', '--no-push'])
})

test('a value ws:pub would paste into a shell is refused, not escaped', () => {
  expect(pubArgv({ bump: 'patch; rm -rf ~' }, members()).error).toMatch(/not a bump/)
  expect(pubArgv({ tag: 'latest; curl x' }, members()).error).toMatch(/not a dist-tag/)
  expect(pubArgv({ tag: '$(id)' }, members()).error).toMatch(/not a dist-tag/)
  expect(pubArgv({ otp: '12345a' }, members()).error).toMatch(/6 to 8 digits/)
})

test('a package is a member by exact name, and one that would select two is refused', () => {
  expect(pubArgv({ packages: ['@t/nope'] }, members()).error).toMatch(/no package/)
  // `--filter @t/ui` matches `@t/ui-kit` too — ticking one box would publish both.
  expect(pubArgv({ packages: ['@t/ui'] }, members()).error).toMatch(/would also select @t\/ui-kit/)
  expect(pubArgv({ packages: ['@t/ui-kit'] }, members()).argv).toEqual(['ws:pub', 'patch', '--filter', '@t/ui-kit'])
})

test('a dry run never carries the password', () => {
  expect(pubArgv({ otp: '123456' }, members(), { dry: true }).argv).not.toContain('--otp')
  expect(pubArgv({ otp: '123456' }, members()).argv).toEqual(['ws:pub', 'patch', '--otp', '123456'])
})

test('a step runs only through the table', () => {
  const run = (o) => runPublishStep({ root, fliRoot: CLI, ...o })
  expect(run({ id: 'commit' }).error).toMatch(/unknown step/)
  expect(run({ id: 'partial' }).error).toMatch(/unknown step/)
  expect(run({ id: 'publish' }).error).toMatch(/approving/)
  expect(run({ id: 'push' }).error).toMatch(/approving/)
  expect(run({ id: 'whoami', fix: true }).error).toMatch(/no fix/)
  expect(run({ id: 'plan', opts: { tag: 'a b' } }).error).toMatch(/not a dist-tag/)
})

// ─── against a real workspace ────────────────────────────────────────────────

test('the local half reads the members and what changed since each tag', () => {
  const { available, packages } = publishLocal({ root, fliRoot: CLI })
  expect(available).toBe(true)
  const ui = packages.find(p => p.name === '@t/ui')
  // Never released, so no tag and affected — the case ws:pub always publishes.
  expect(ui.affected).toBe(true)
  expect(ui.lastTag).toBeNull()
})

test('the plan step is ws:pub --dry itself, streamed, and spends nothing', async () => {
  const lines = []
  const out = runPublishStep({ root, fliRoot: CLI, id: 'plan', opts: { bump: 'minor', otp: '123456' }, onLine: l => lines.push(l) })
  expect(out.error).toBeUndefined()
  expect(out.argv).toEqual(['ws:pub', 'minor', '--dry'])
  expect(out.display).toBe('fli ws:pub minor --dry')
  const code = await out.done
  const text = lines.join('\n')
  expect(text).toMatch(/@t\/ui\s+0\.1\.0 → 0\.2\.0/)
  expect(text).toMatch(/skipping @t\/secret \(private\)/)
  expect(code).toBe(0)
  expect(execSync('git status --porcelain', { cwd: root, encoding: 'utf8' })).toBe('')
}, 60_000)

test('the console never shows the one-time password', () => {
  const shown = displayArgv('fli', pubArgv({ otp: '654321' }, members()).argv)
  expect(shown).toBe('fli ws:pub patch --otp ••••••')
})
