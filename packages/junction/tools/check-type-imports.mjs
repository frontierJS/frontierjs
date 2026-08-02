// tools/check-type-imports.mjs
//
// Finds types imported as values — `import { fn, SomeType } from './x.ts'`
// where SomeType is an interface or type alias.
//
// Bun transpiles TypeScript fully, so it erases these silently and nothing
// breaks. Any runtime that *strips* types instead of transpiling does not: the
// import survives into the emitted JS, the target module has no such runtime
// export, and the module fails to instantiate:
//
//   SyntaxError: The requested module './types.ts' does not provide an
//   export named 'TransportStats'
//
// That is Node's --experimental-strip-types, and it is the same rule
// TypeScript's own `verbatimModuleSyntax` / `isolatedModules` enforce. Anyone
// consuming this package outside Bun hits it immediately.
//
// Fix: split the import.
//
//   import { fn } from './x.ts'
//   import type { SomeType } from './x.ts'

import { readFileSync, readdirSync, statSync } from 'fs'
import { join, dirname, resolve, relative } from 'path'

const ROOT = process.argv[2] ?? 'src'

const files = []
;(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p)
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) files.push(resolve(p))
  }
})(ROOT)

// Keyed by ABSOLUTE path — resolveTarget() below produces absolute paths, and
// keying by the relative walk paths silently matched nothing.
const source = Object.fromEntries(files.map(f => [resolve(f), readFileSync(f, 'utf8')]))

/** Resolve a relative specifier to a file we have, tolerating .ts / index.ts. */
function resolveTarget(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec)
  for (const candidate of [base, base + '.ts', join(base, 'index.ts')]) {
    if (source[candidate]) return candidate
  }
  return null
}

const declaredAsType  = (body, name) =>
  new RegExp(`export\\s+(interface|type)\\s+${name}\\b`).test(body)

const declaredAsValue = (body, name) =>
  new RegExp(`export\\s+(async\\s+)?(function|const|let|var|class|enum)\\s+${name}\\b`).test(body) ||
  new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`).test(body)

const problems = []

for (const file of files) {
  // Value imports only — `import type { … }` is already correct.
  const re = /^import\s+\{([^}]*)\}\s*from\s*'([^']+)'/gm
  for (const m of source[file].matchAll(re)) {
    const spec = m[2]
    if (!spec.startsWith('.')) continue
    const target = resolveTarget(file, spec)
    if (!target) continue

    const names = m[1]
      .split(',')
      .map(n => n.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean)

    for (const name of names) {
      const body = source[target]
      if (declaredAsType(body, name) && !declaredAsValue(body, name)) {
        problems.push({ file, name, spec })
      }
    }
  }
}

if (problems.length === 0) {
  console.log(`  ✓ no types imported as values (${files.length} files)`)
  process.exit(0)
}

console.log(`  ✗ ${problems.length} type(s) imported as values:\n`)
for (const { file, name, spec } of problems) {
  console.log(`    ${relative(process.cwd(), file)}`)
  console.log(`      ${name}  from '${spec}'  → move to \`import type\``)
}
process.exit(1)
