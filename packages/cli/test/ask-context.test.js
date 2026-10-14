// ask-context.test.js — what the ask panel's server reads off a pick's source.
//
// Over a real app tree in a temp directory: a layout whose slot wrapper is
// the pick, a route under it with a loop, and a resource whose model the
// schema declares. That is the shape the context exists for — the pick's own
// loc names the layout, and only the locs under it reach the route.

import { describe, test, expect, afterAll } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GUIDES, askContext, enclosingLoops, findAppRoot, findGuides, resourceImports } from '../core/ask-context.js'

const dir = mkdtempSync(join(tmpdir(), 'fli-ask-context-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const web = join(dir, 'web')
const put = (path, text) => { mkdirSync(join(dir, path, '..'), { recursive: true }); writeFileSync(join(dir, path), text) }

put('db/schema.lite', 'model Pin {\n  id    Int    @id\n  name  String\n  repo  String?\n  @@gate("4")\n}\n')
put('web/src/resources/Pin.mesa', '<script module>\n  export const pins = createResource(\'pins\')\n</script>\n')
put('web/src/resources/Note.mesa', '<script module>\n  export const notes = createResource(\'notes\')\n</script>\n')
put('web/src/routes/_module.mesa', '<script>\n  import { notes } from \'../resources/Note.mesa\'\n</script>\n<main>\n  <div class="screen-body">\n    <slot />\n  </div>\n</main>\n')
put('web/src/routes/pins.mesa', [
  '<script>',
  '  import { pins, other as mine } from \'../resources/Pin.mesa\'',
  '</script>',
  '<!-- {#each never as x} is a comment -->',
  '<ul>',
  '  {#each ordered(pins) as p (p.id)}',
  '    <li>{p.name}',
  '      {#each p.files as f}<code>{f}</code>{/each}',
  '      <b>{p.repo}</b>',
  '    </li>',
  '  {/each}',
  '</ul>',
  '',
].join('\n'))

describe('enclosingLoops', () => {

  const src = '<ul>\n  {#each a as x}\n    <li>{#each x.b as y}<i>{y}</i>{/each} <b/></li>\n  {/each}\n</ul>\n'

  test('outermost first, each with the line it opens on', () => {
    expect(enclosingLoops(src, 3, 34)).toEqual([{ head: 'a as x', line: 2 }, { head: 'x.b as y', line: 3 }])
  })

  test('a closed loop is not open after it, and nothing is open before the first', () => {
    expect(enclosingLoops(src, 3, 47)).toEqual([{ head: 'a as x', line: 2 }])
    expect(enclosingLoops(src, 1, 1)).toEqual([])
    expect(enclosingLoops(src, 99, 1)).toEqual([])
  })

  test('a block quoted in a comment is not one', () => {
    expect(enclosingLoops('<!-- {#each a as x} -->\n<p></p>\n', 2, 1)).toEqual([])
  })

})

describe('resourceImports', () => {

  test('each name imported, the file resolved from the importer, the model its filename names', () => {
    const src = 'import { pins, other as mine } from \'../resources/Pin.mesa\'\nimport { x } from \'./x.js\''
    expect(resourceImports(src, 'src/routes/pins.mesa', web)).toEqual([{ names: ['pins', 'mine'], file: 'src/resources/Pin.mesa', model: 'Pin' }])
  })

})

describe('findAppRoot', () => {

  test('the Vite root or a parent holding db/schema.lite, and null where none does', () => {
    expect(findAppRoot(web)).toBe(dir)
    expect(findAppRoot(dir)).toBe(dir)
    expect(findAppRoot(tmpdir())).toBe(null)
  })

})

describe('findGuides', () => {

  test('each guide installed above the Vite root, through the workspace link, and none for a package not installed', () => {
    put('pkgs/css/AGENTS.md', '# css\n')
    put('pkgs/mesa/AGENTS.md', '# mesa\n')
    put('pkgs/sierra/README.md', '# no guide\n')
    mkdirSync(join(dir, 'node_modules', '@frontierjs'), { recursive: true })
    for (const p of ['css', 'mesa', 'sierra']) symlinkSync(join(dir, 'pkgs', p), join(dir, 'node_modules', '@frontierjs', p))
    const real = realpathSync(dir)
    expect(findGuides(web)).toEqual([
      { pkg: 'css',  file: join(real, 'pkgs/css/AGENTS.md'),  dir: join(real, 'pkgs/css'),  about: GUIDES.css },
      { pkg: 'mesa', file: join(real, 'pkgs/mesa/AGENTS.md'), dir: join(real, 'pkgs/mesa'), about: GUIDES.mesa },
    ])
  })

})

describe('askContext', () => {

  const slot = { loc: 'src/routes/_module.mesa:5:3', inner: ['src/routes/pins.mesa:5:1', 'src/routes/pins.mesa:7:5', 'src/routes/pins.mesa:8:28', 'src/routes/pins.mesa:9:7'] }

  test('a slot wrapper: the route is found under it, with its loops, and the resource its loop file reads', () => {
    const { picks: [p], data } = askContext(web, [slot])
    expect(p.loc).toBe('src/routes/_module.mesa:5:3')
    expect(p.loops).toEqual([])
    expect(p.files).toEqual(['src/routes/pins.mesa:5'])
    expect(p.inner).toEqual([
      { head: 'ordered(pins) as p (p.id)', at: 'src/routes/pins.mesa:6' },
      { head: 'p.files as f', at: 'src/routes/pins.mesa:8' },
    ])
    // The layout imports a resource too, and draws no loop: it is not listed.
    expect(data).toEqual(['`pins`, `mine` from src/resources/Pin.mesa — model Pin at ../db/schema.lite:1: id, name, repo'])
  })

  test('a pick inside a loop: the loop is around it, and is not listed again under it', () => {
    const { picks: [p] } = askContext(web, [{ loc: 'src/routes/pins.mesa:7:5', inner: ['src/routes/pins.mesa:8:28'] }])
    expect(p.loops).toEqual([{ head: 'ordered(pins) as p (p.id)', at: 'src/routes/pins.mesa:6' }])
    expect(p.inner).toEqual([{ head: 'p.files as f', at: 'src/routes/pins.mesa:8' }])
    expect(p.files).toEqual([])
  })

  test('absolute writes every path from the root, for a prompt pasted elsewhere', () => {
    const { picks: [p], data } = askContext(web, [slot], { absolute: true })
    expect(p.loc).toBe(join(web, 'src/routes/_module.mesa:5:3'))
    expect(p.files).toEqual([join(web, 'src/routes/pins.mesa:5')])
    expect(data[0]).toContain(`from ${join(web, 'src/resources/Pin.mesa')} — model Pin at ${join(dir, 'db/schema.lite')}:1`)
  })

  test('a resource with no model of its name says so, and a file that cannot be read adds nothing', () => {
    const models = () => []
    const { data } = askContext(web, [slot], { models })
    expect(data).toEqual(['`pins`, `mine` from src/resources/Pin.mesa — no model named Pin in the schema'])
    const { picks: [p], data: none } = askContext(web, [{ loc: 'src/gone.mesa:1:1', inner: [] }])
    expect(p).toMatchObject({ loops: [], inner: [], files: [] })
    expect(none).toEqual([])
  })

})
