/*
 * test/shortcuts.test.js
 *
 * `core/shortcuts.js` is the one owner of what a shortcut IS. The claim the
 * design turns on is that a shortcut is not a new kind of thing — it is an
 * ordinary project command file — so most of what is worth asserting here is
 * cross-module: the generated text goes back through the compiler that will
 * run it, and through the frontmatter parser the registry reads it with.
 *
 * Every refusal is paired with the legitimate shape one character away. A
 * generator that refused everything would satisfy any test that only asked
 * about the refusals.
 */

import { describe, test, expect, afterEach, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  SHORTCUT_NAMESPACE,
  shortcutTitle,
  shortcutPath,
  refuseName,
  refuseCommand,
  refuseTaken,
  targetExpression,
  renderShortcut,
} from '../core/shortcuts.js'
import { compileCli, extractFrontmatter } from '../core/compiler.js'
import { getConfig, Command, forwardedArgs } from '../core/runtime.js'

const transpiler = new Bun.Transpiler({ loader: 'js' })
const parseEsm   = (src) => transpiler.transformSync(src)

const render = (command, name = 'go-time') => renderShortcut({ name, command })

// A registry is Map<name|alias, { filePath, meta, source }> — the shape
// buildRegistry returns, restated here rather than built, because the thing
// under test is the refusal and not the discovery.
const registryOf = (...titles) => new Map(
  titles.map(t => [t.key ?? t, { filePath: `/x/${t.key ?? t}.md`, meta: { title: t.title ?? t }, source: 'core' }])
)

describe('the name', () => {
  test('a plain kebab name is accepted', () => {
    expect(refuseName('go-time')).toBeNull()
    expect(refuseName('up')).toBeNull()
  })

  // The colon is the namespace separator and a shortcut's namespace is chosen
  // for it, so a name carrying one would claim a namespace it does not own.
  test('a name carrying a colon is refused, and the refusal names the fix', () => {
    const why = refuseName('my:thing')
    expect(why).toContain(':')
    expect(why).toContain('thing')
  })

  test('shapes that are not command names are refused', () => {
    expect(refuseName('Go-Time')).not.toBeNull()
    expect(refuseName('go time')).not.toBeNull()
    expect(refuseName('9lives')).not.toBeNull()
    expect(refuseName('')).not.toBeNull()
    expect(refuseName(undefined)).not.toBeNull()
  })
})

describe('the command line', () => {
  test('an ordinary one line is accepted', () => {
    expect(refuseCommand('fli ws:atlas --open --live')).toBeNull()
    expect(refuseCommand('  docker compose up -d  ')).toBeNull()
  })

  // The target goes into the file's own frontmatter description, where a second
  // line either ends the block or is read as another key.
  test('two lines are refused, pointing at the file', () => {
    expect(refuseCommand('fli a\nfli b')).toContain('one line')
    expect(refuseCommand('')).not.toBeNull()
  })
})

describe('a name already in use', () => {
  // The registry lets a project command override a core one in SILENCE,
  // because that override is the authoring model. It is the wrong default for
  // a name typed from memory: `fli make:shortcut new "…"` would eat `fli new`.
  test('a taken name is refused, naming what holds it', () => {
    const why = refuseTaken('new', registryOf({ key: 'new', title: 'project:new' }))
    expect(why).toContain('project:new')
  })

  test('a name held only as an ALIAS is refused too', () => {
    const why = refuseTaken('ws:atlas', registryOf({ key: 'ws:atlas', title: 'workspace:atlas' }))
    expect(why).toContain('workspace:atlas')
  })

  test('a free name is not refused', () => {
    expect(refuseTaken('go-time', registryOf({ key: 'new', title: 'project:new' }))).toBeNull()
    expect(refuseTaken('go-time', new Map())).toBeNull()
  })
})

describe('what the shortcut runs', () => {
  // A global install and a workspace checkout are routinely both present. A
  // shortcut resolving `fli` off PATH would reach the other one, and nothing
  // would print.
  test('a leading fli becomes the fli that is running', () => {
    expect(targetExpression('fli ws:atlas --open')).toBe('${$.fli} ws:atlas --open')
    expect(targetExpression('fli')).toBe('${$.fli}')
  })

  test('anything else is left as written', () => {
    expect(targetExpression('docker compose up -d')).toBe('docker compose up -d')
    // The control for the rewrite above: `flip` is not `fli`.
    expect(targetExpression('flip a')).toBe('flip a')
  })

  test('a shell variable survives to the shell rather than being interpolated', () => {
    expect(targetExpression('echo ${HOME}')).toBe('echo \\${HOME}')
    expect(targetExpression('echo `date`')).toBe('echo \\`date\\`')
  })
})

describe('the file it writes', () => {
  test('it is a command the registry can read', () => {
    const meta = extractFrontmatter(render('fli ws:atlas --open --live'))
    expect(meta.title).toBe('shortcut:go-time')
    expect(meta.alias).toBe('go-time')
    expect(meta.description).toBe('fli ws:atlas --open --live')
    // The command's flags are the target's, so it must not warn about them.
    expect(meta.mode).toBe('passthrough')
  })

  test('a description given wins over the command line', () => {
    const meta = extractFrontmatter(renderShortcut({
      name: 'go-time', command: 'fli ws:atlas', description: 'The atlas, opened',
    }))
    expect(meta.description).toBe('The atlas, opened')
  })

  // The writer interpolated the words bare, and the frontmatter kit refuses a
  // `: ` in a plain value and cuts one at ` #` — the shortcut either vanished
  // from `fli list` or said half of what was typed.
  test('a description holding `: ` or ` #` reads back as written', () => {
    for (const description of ['Deploy: staging', 'tests # fast ones', '@scope/pkg release']) {
      expect(extractFrontmatter(renderShortcut({ name: 'go-time', command: 'fli ws:atlas', description })).description)
        .toBe(description)
    }
  })

  // Invariant 15: a clean compile is not proof of valid JS. The command string
  // is author input that lands inside a template literal, which is the one
  // place a stray backtick stops being a character and starts being syntax.
  test.each([
    'fli ws:atlas --open --live',
    'docker compose up -d',
    'echo `date`',
    'echo ${HOME}',
    'echo "a\\b"',
    "echo 'quoted'",
    'fli x --msg "back`tick and ${brace}"',
  ])('compiles to parseable JavaScript: %s', (command) => {
    const src = compileCli(render(command), '', '/tmp/shortcut.md')
    expect(() => parseEsm(src)).not.toThrow()
  })

  test('the target reaches the compiled body intact', () => {
    const src = compileCli(render('fli ws:atlas --open --live'), '', '/tmp/shortcut.md')
    expect(src).toContain('${$.fli} ws:atlas --open --live')
    expect(src).toContain('$.paths.root')
    expect(src).toContain('args:    $.forwarded')
  })

  test('the path is under the routes directory, in its own namespace', () => {
    const p = shortcutPath({ root: '/app', routesDir: 'cli/src/routes', name: 'go-time' })
    expect(p).toBe('/app/cli/src/routes/shortcut/go-time.md')
    expect(shortcutTitle('go-time')).toBe(`${SHORTCUT_NAMESPACE}:go-time`)
  })
})

// ─── mode: passthrough ───────────────────────────────────────────────────────
// The runtime half. A shortcut re-types the tail of the argv at another
// command, so "flag not defined" names a flag that IS defined by the thing
// being run — and it would print on every forwarded flag, every run.
describe('mode: passthrough', () => {
  const warnings = []
  const realWarn = console.warn
  afterEach(() => { console.warn = realWarn; warnings.length = 0 })

  const resolve = (mode) => {
    console.warn = (msg) => warnings.push(String(msg))
    getConfig({ title: 't', mode, args: [], flags: {} }, [], { offline: true })
    return warnings.join('\n')
  }

  test('an undeclared flag is announced by an ordinary command', () => {
    expect(resolve(undefined)).toContain('offline')
  })

  test('and is silent under passthrough', () => {
    expect(resolve('passthrough')).toBe('')
  })

  test('strict still refuses — passthrough is a third answer, not a loosening of it', () => {
    console.warn = () => {}
    expect(() => getConfig({ title: 't', mode: 'strict', args: [], flags: {} }, [], { offline: true }))
      .toThrow()
  })
})

// What a shortcut forwards is the raw tail — and not all of it: `--dry` was
// answered by not running, so a target that received it would be told twice.
describe('$.forwarded', () => {
  const argv = (...words) => ['/bun', '/fli.js', ...words]

  test('is what was typed after the command name', () => {
    expect(forwardedArgs(argv('basecamp', '--no-build', 'x y'))).toEqual(['--no-build', 'x y'])
  })

  test('starts after the name when a global flag comes first', () => {
    expect(forwardedArgs(argv('--verbose', 'basecamp', '--no-build'))).toEqual(['--no-build'])
  })

  test("drops fli's own --dry in every spelling, and nothing beside it", () => {
    expect(forwardedArgs(argv('ci', '--dry', '-d', '--dry=true', '--dryer'))).toEqual(['--dryer'])
  })

  test('drops a leading -- and keeps a later one', () => {
    expect(forwardedArgs(argv('ci', '--', '--help', '--', 'x'))).toEqual(['--help', '--', 'x'])
  })

  test('is empty with nothing after the name, or no name at all', () => {
    expect(forwardedArgs(argv('ci'))).toEqual([])
    expect(forwardedArgs(argv('--version'))).toEqual([])
  })
})

describe('$.exec args', () => {
  let dir
  beforeAll(() => {
    global.fliRoot     = join(import.meta.dir, '..')
    global.projectRoot = global.fliRoot
    dir = mkdtempSync(join(tmpdir(), 'fli-args-'))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const run = async (body, flag = {}) => {
    const file = join(dir, 'probe.md')
    writeFileSync(file, ['---', 'title: probe:args', '---', '', '```js', body, '```', ''].join('\n'))
    const events = []
    await (await Command({ file, arg: [], flag, emit: (e) => { events.push(e); return Promise.resolve() } }))()
    return events
  }

  test('each word reaches the child as one argument, quotes and all', async () => {
    const out = join(dir, 'out')
    await run(`fs.writeFileSync(${JSON.stringify(out)}, $.exec({
      command: "printf '%s|'",
      args:    ["it's", 'a b', '$HOME', '\`date\`'],
      stdio:   ['ignore', 'pipe', 'inherit'],
      encoding: 'utf8',
    }))`)
    expect(readFileSync(out, 'utf8')).toBe("it's|a b|$HOME|`date`|")
  })

  test('a dry run prints the command with its words quoted', async () => {
    const events = await run(`$.exec({ command: 'echo', args: ['a b'] })`, { dry: true })
    expect(events.find(e => e.level === 'dry')?.text).toBe("echo 'a b'")
  })

  test('args that is not an array is refused rather than stringified', async () => {
    await expect(run(`$.exec({ command: 'echo', args: 'a b' })`)).rejects.toThrow('array of words')
  })
})
