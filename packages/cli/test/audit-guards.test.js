// ─── audit-guards — the guards fli check and fli proves claim and do not keep ──
//
// Audit run 1.4 (IDEAS/fable-audit-plan.md). Each `test.failing` asserts the
// FIXED behavior, so it fails today and starts passing when the fix lands; drop
// `.failing` then. Every case builds its own tree under a temp directory, so
// nothing here reads this workspace.

import { test, expect }                                   from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'node:fs'
import { tmpdir }                                         from 'node:os'
import { spawnSync }                                      from 'node:child_process'
import { join, dirname }                                  from 'node:path'

import { runChecks }                 from '../core/checks.js'
import { matchChanged, resolveRun }  from '../core/proofs.js'

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'fjs-audit-1.4-'))
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), body)
  }
  return root
}

test('a proof row naming a directory with a trailing slash matches a file under it', () => {
  const m = matchChanged('the deploy pipeline — `_steps-docker/`, `core/machine.js`', {
    files: ['packages/cli/commands/deploy/_steps-docker/01-preflight.md'], packages: [],
  })
  expect(m?.tier).toBe('path')
  // A directory token is a whole segment: `_steps-docker/` is not under `my_steps-docker/`.
  expect(matchChanged('`_steps-docker/`', { files: ['x/my_steps-docker/a.md'], packages: [] })).toBeNull()
})

test('runChecks refuses an --only id that names no rule in this scope', () => {
  const root = tree({ 'db/schema.lite': 'model A {\n  id Int @id\n}\n' })
  try {
    expect(() => runChecks({ root, only: ['vite-strict-prot'] })).toThrow(/vite-strict-prot/)
    expect(() => runChecks({ root, only: ['proof-target'] })).toThrow(/proof-target/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('vite-strict-port fires on strictPort: false and on strictPort only in a comment', () => {
  const root = tree({
    'db/schema.lite':                 'model A {\n  id Int @id\n}\n',
    'web/config/vite.config.js':      'export default { server: { strictPort: false } }\n',
    'widgets/config/vite.config.js':  '// strictPort: true\nexport default { server: {} }\n',
  })
  try {
    const { findings } = runChecks({ root, only: ['vite-strict-port'] })
    expect(findings.map(f => f.file.slice(root.length + 1)).sort()).toEqual([
      'web/config/vite.config.js', 'widgets/config/vite.config.js',
    ])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('proof-target reports a Run cell that resolves to no target at all', () => {
  const root = tree({
    'package.json': '{ "name": "ws", "scripts": {} }',
    'DRIVES.md': [
      '## Which drive proves a change', '',
      '| Changed | Run |', '| --- | --- |',
      "| `core/release.js` | `bun run ci`'s `deployJournalCycle`, whose assertion is the only one that can see it |",
      '',
    ].join('\n'),
  })
  try {
    expect(resolveRun("`bun run ci`'s `deployJournalCycle`", { root })).toHaveLength(0)
    const { findings } = runChecks({ root, scope: 'repo', only: ['proof-target'] })
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toMatch(/no target|nothing to run/i)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('proof-target grades a sibling checkout only where it is present', () => {
  const table = (script) => ({
    'ws/package.json': '{ "name": "ws", "scripts": {} }',
    'ws/DRIVES.md': [
      '## Which drive proves a change', '',
      '| Changed | Run |', '| --- | --- |',
      `| \`src/mirror-exit.js\` | \`../app\`: \`${script}\` |`,
      '',
    ].join('\n'),
  })
  const absent = tree(table('verify:exit'))
  const present = tree({ ...table('verify:gone'), 'app/package.json': '{ "name": "app", "scripts": { "verify:exit": "true" } }' })
  try {
    expect(runChecks({ root: join(absent, 'ws'), scope: 'repo', only: ['proof-target'] }).findings).toEqual([])
    const { findings } = runChecks({ root: join(present, 'ws'), scope: 'repo', only: ['proof-target'] })
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toMatch(/declares no such script/)
  } finally { for (const r of [absent, present]) rmSync(r, { recursive: true, force: true }) }
})

test('command-resolves finds a typescript hoisted to a parent node_modules', () => {
  const real = join(import.meta.dir, '..', '..', '..', 'node_modules', 'typescript')
  if (!existsSync(real)) return
  const ws = tree({
    'app/package.json':            '{ "name": "app" }',
    'app/.fli.json':               '{ "routesDir": "cli/src/routes" }',
    'app/cli/src/routes/x/zz.md':  '---\ntitle: x:zz\ndescription: zz\n---\n```js\nzzUndeclared()\n```\n',
  })
  mkdirSync(join(ws, 'node_modules'))
  symlinkSync(real, join(ws, 'node_modules', 'typescript'))
  try {
    const out = runChecks({ root: join(ws, 'app'), only: ['command-resolves'] })
    expect(out.skipped).toHaveLength(0)
    expect(out.findings).toHaveLength(1)
  } finally { rmSync(ws, { recursive: true, force: true }) }
})

test('migration-history reads an ENTRYPOINT script that runs db:migrate', () => {
  const root = tree({
    'db/schema.lite': 'model A {\n  id Int @id\n}\n',
    'Dockerfile':     'FROM oven/bun\nENTRYPOINT ["./entrypoint.sh"]\n',
    'entrypoint.sh':  '#!/bin/sh\nbun run db:migrate\nexec bun run start\n',
  })
  try {
    const out = runChecks({ root, only: ['migration-history'] })
    expect(out.skipped).toHaveLength(0)
    expect(out.findings).toHaveLength(1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('migration-history names an entrypoint script it cannot read', () => {
  const root = tree({
    'db/schema.lite': 'model A {\n  id Int @id\n}\n',
    'Dockerfile':     'FROM oven/bun\nENTRYPOINT ["./entrypoint.sh"]\n',
  })
  try {
    const out = runChecks({ root, only: ['migration-history'] })
    expect(JSON.stringify(out.skipped)).toContain('entrypoint.sh')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// FJS-2374
test('migration-history reads an exec-form CMD that runs db:migrate', () => {
  const root = tree({
    'db/schema.lite': 'model A {\n  id Int @id\n}\n',
    'Dockerfile':     'FROM oven/bun\nCMD ["bun", "run", "db:migrate"]\n',
  })
  try {
    const out = runChecks({ root, only: ['migration-history'] })
    expect(out.skipped).toHaveLength(0)
    expect(out.findings).toHaveLength(1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// What holds today, pinned so a fix to the above cannot loosen it.
test('vite-strict-port fires on a config with no strictPort at all', () => {
  const root = tree({
    'db/schema.lite':            'model A {\n  id Int @id\n}\n',
    'web/config/vite.config.js': 'export default { server: { port: 8010 } }\n',
  })
  try {
    expect(runChecks({ root, only: ['vite-strict-port'] }).findings).toHaveLength(1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a proof row naming a file path matches that file', () => {
  const m = matchChanged('the deploy pipeline — `_steps-docker/`, `core/machine.js`', {
    files: ['packages/cli/core/machine.js'], packages: [],
  })
  expect(m?.tier).toBe('path')
})

// FJS-2369 — the Changed column is graded as well as the Run column.

const table = rows => [
  '## Which drive proves a change', '',
  '| Changed | Run |', '| --- | --- |', ...rows, '',
].join('\n')

test('proof-target reports a Changed cell that no diff can hit, and passes one that names a package, a path or a symbol', () => {
  const root = tree({
    'package.json':                  '{ "name": "ws", "scripts": { "verify": "true" } }',
    'packages/alpha/package.json':   '{ "name": "@x/alpha", "scripts": { "verify": "true" } }',
    'DRIVES.md': table([
      '| a batch — a job per person, an idempotency key | `.`: `verify` |',
      '| alpha prerender — the shell | `.`: `verify` |',
      '| a batch — `core/worker.ts` | `.`: `verify` |',
      '| a batch — `resume()` | `.`: `verify` |',
      '| a batch — `id` | `.`: `verify` |',
    ]),
  })
  try {
    const { findings } = runChecks({ root, scope: 'repo', only: ['proof-target'] })
    expect(findings.map(f => f.line)).toEqual([5, 9])
    expect(findings[0].message).toMatch(/can be hit by no change/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('proof-target reports a Changed path that is no longer in the tree', () => {
  const root = tree({
    'package.json':                    '{ "name": "ws", "scripts": { "verify": "true" } }',
    'example/web/src/stores/cart.js':  'export const cart = 1\n',
    'DRIVES.md': table([
      '| the basket store (`web/src/cart.js`) | `.`: `verify` |',
      '| the basket store (`web/src/stores/cart.js`) | `.`: `verify` |',
      '| a glob `src/scenes/*.mesa`, a route `/auth/login`, a subpath `@x/y/geo`, a symbol `Room.pairId` | `.`: `verify` |',
    ]),
  })
  try {
    spawnSync('git', ['init', '-q'], { cwd: root })
    const { findings } = runChecks({ root, scope: 'repo', only: ['proof-target'] })
    expect(findings.map(f => [f.line, /web\/src\/cart\.js/.test(f.message)])).toEqual([[5, true]])
  } finally { rmSync(root, { recursive: true, force: true }) }
})
