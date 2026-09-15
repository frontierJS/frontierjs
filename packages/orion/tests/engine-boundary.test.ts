// ─── the engine imports nothing but itself ────────────────────────────────────
//
// `src/engine/` is the part of orion written for throughput (README § The engine
// is written for speed), and what keeps it that way is that it cannot reach the
// framework: a service call in the executor's loop costs twice a direct write,
// and nothing on the page says so. The host hands the engine what it needs
// through `src/engine/ports.ts` and the store and queue interfaces.
//
// So every import under `src/engine/` is either relative and stays inside it, a
// Node builtin, or `@frontierjs/toolbelt` — the one package `FJS-D26` licenses
// everybody to import, because it is pure functions below the dependency graph
// and cannot drag a framework package in behind it. The engine parses a flow
// expression with the kit that parses `.lite` policies (`FJS-D271`); any other
// package fails, a framework one first.
//
// The walk is graded two ways, because a check that reads nothing passes: it has
// to have seen files, and it has to flag a source that breaks the rule.

import { describe, test, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { builtinModules }  from 'node:module'
import { join, relative, resolve, dirname, sep } from 'node:path'

const ENGINE = resolve(import.meta.dir, '../src/engine')

const BUILTINS = new Set(builtinModules)
const TOOLBELT = '@frontierjs/toolbelt'

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? sourceFiles(full) : full.endsWith('.ts') ? [full] : []
  })
}

// Static `from`, side-effect `import 'x'`, dynamic `import('x')` and `require('x')`.
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"])([^'"\n]+)\1/g

function violations(file: string, source: string): string[] {
  const out: string[] = []
  for (const [, , spec] of source.matchAll(SPECIFIER)) {
    if (!spec) continue
    if (spec.startsWith('.')) {
      const target = resolve(dirname(file), spec)
      if (target !== ENGINE && !target.startsWith(ENGINE + sep)) out.push(`${spec} leaves src/engine/`)
      continue
    }
    if (spec === TOOLBELT || spec.startsWith(TOOLBELT + '/')) continue
    const bare = spec.startsWith('node:') ? spec.slice(5) : spec
    if (!BUILTINS.has(bare)) out.push(`${spec} is a package`)
  }
  return out
}

describe('src/engine/ imports nothing outside itself', () => {
  const files = sourceFiles(ENGINE)

  test('the walk sees the engine', () => {
    expect(files.length).toBeGreaterThan(10)
  })

  test('every import is relative inside the engine, or a Node builtin', () => {
    const found = files.flatMap((f) =>
      violations(f, readFileSync(f, 'utf8')).map((v) => `${relative(ENGINE, f)}: ${v}`))
    expect(found).toEqual([])
  })

  test('the check refuses a framework package, a third-party package and an escape', () => {
    const file = join(ENGINE, 'executor/index.ts')
    const bad = [
      `import { createApp } from '@frontierjs/junction'`,
      `const db = await import("@frontierjs/litestone")`,
      `import 'lodash'`,
      `import { createClient } from '@frontierjs/litestone'`,
      `import type { Flow } from '../../services/flows'`,
    ].join('\n')
    expect(violations(file, bad)).toHaveLength(5)
    expect(violations(file, `import { Worker } from 'worker_threads'\nimport x from 'node:crypto'\nimport { a } from '../types'`)).toEqual([])
    // The one package the engine may import, and only it.
    expect(violations(file, `import { evaluate } from '@frontierjs/toolbelt/predicate'`)).toEqual([])
  })
})
