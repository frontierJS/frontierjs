// scope.test.js — a free identifier, or a name declared twice, in the unit the
// runtime loads: `core/scope.js` over snippets, and `resolveCommands` over this
// package's own commands, which is where FJS-730's class is kept at zero.

import { describe, test, expect } from 'bun:test'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { scopeProblems, typeScriptIn } from '../core/scope.js'
import { resolveCommands }             from '../core/command-parse.js'
import { compileCli, SHIM_GLOBALS }    from '../core/compiler.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const REPO  = resolve(__dir, '../../..')
const ts    = typeScriptIn(REPO)

const free = (code, globals = []) => scopeProblems(ts, code, { globals }).free.map(f => `${f.name}@${f.line}`)
const dups = (code) => scopeProblems(ts, code).duplicates.map(d => `${d.name}@${d.line}`)

describe('the parser', () => {
  test('is the workspace\'s own typescript', () => {
    expect(typeof ts?.createSourceFile).toBe('function')
    expect(typeScriptIn('/nonexistent')).toBeNull()
  })
})

describe('free identifiers', () => {
  test('a name bound nowhere is reported once per line, with its line', () => {
    expect(free('const a = 1\necho(a)\necho(b)\nwrite(b, b)')).toEqual(['echo@2', 'echo@3', 'b@3', 'write@4', 'b@4'])
  })

  test('declarations of every kind bind: import, var, let, const, function, class, param, catch, loop', () => {
    const code = [
      "import fs, { readFileSync as read } from 'node:fs'",
      "import * as os from 'node:os'",
      'var v = 1; let l = 2; const { c, d: [e], ...rest } = {}',
      'function f(p, { q } = {}, ...more) { return p + q + more + v + l + c + e + rest }',
      'class K { m() { return f } }',
      'const g = function named(n) { return n ? named(n - 1) : K }',
      'try { g() } catch (err) { read(err) }',
      'for (const x of []) os.x(x)',
      'for (let i = 0; i < 1; i++) fs.x(i)',
      'label: for (const k in {}) { if (k) break label }',
    ].join('\n')
    expect(free(code)).toEqual([])
  })

  test('a property, a key, a label, import.meta and typeof are not references', () => {
    const code = [
      'const o = { key: 1, [JSON.stringify(1)]: 2, method() {}, get acc() { return 1 } }',
      'o.missing.deeper',
      'import.meta.url',
      'typeof notDeclared',
      'const { renamed: local } = o',
      'local',
    ].join('\n')
    expect(free(code)).toEqual([])
  })

  test('shorthand, a computed key and a destructuring default are references', () => {
    expect(free('const o = { shorthand }')).toEqual(['shorthand@1'])
    expect(free('const o = { [computed]: 1 }')).toEqual(['computed@1'])
    expect(free('const { a = fallback } = {}')).toEqual(['fallback@1'])
  })

  test('a parameter of ANOTHER function binds nothing here', () => {
    const code = 'function one(deployConf) { return deployConf }\nfunction two() { return deployConf }'
    expect(free(code)).toEqual(['deployConf@2'])
  })

  test('host globals resolve; the shim\'s three resolve only when passed', () => {
    const code = 'process.exit(Bun.version + console.log(Buffer.from(fetch)))\n$.exec(path.join(fs.x))'
    expect(free(code)).toEqual(['$@2', 'path@2', 'fs@2'])
    expect(free(code, SHIM_GLOBALS)).toEqual([])
  })

  test('the compiled head binds what a body destructures, and module scope sees none of it', () => {
    const unit = compileCli('---\ntitle: t\n---\n\n<script>\nconst helper = () => log.info(echo)\n</script>\n\n```js\nlog.info(flag.x, arg.y, tty, chalk, echo, answers)\nhelper()\n```\n')
    expect(free(unit, SHIM_GLOBALS).map(s => s.replace(/@\d+$/, ''))).toEqual(['log', 'echo'])
  })
})

describe('duplicate declarations', () => {
  test('two lexical bindings of one name in one scope, or a lexical beside a var', () => {
    expect(dups('const a = 1\nconst a = 2')).toEqual(['a@2'])
    expect(dups("import { a } from 'x'\nfunction a() {}")).toEqual(['a@2'])
    expect(dups('var a = 1\nlet a = 2')).toEqual(['a@2'])
  })

  test('two vars, a shadow in an inner scope, and two parameters are not', () => {
    expect(dups('var a = 1\nvar a = 2')).toEqual([])
    expect(dups('const a = 1\n{ const a = 2 }\nfunction f(a) { const b = a; { const b = 1 } }')).toEqual([])
  })
})

describe('resolveCommands', () => {
  test('every command this package ships resolves, with its namespace module', () => {
    const { checked, problems } = resolveCommands(resolve(__dir, '../commands'), ts)
    expect(checked).toBeGreaterThan(300)
    expect(problems).toEqual([])
  })

  test('the cli\'s own route tree resolves too', () => {
    const { checked, problems } = resolveCommands(resolve(__dir, '../cli/src/routes'), ts)
    expect(checked).toBeGreaterThan(0)
    expect(problems).toEqual([])
  })
})
