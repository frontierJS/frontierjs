/**
 * scanner-mount.test.js — a package's routes, mounted by one file (`FJS-D282`)
 *
 * `automations.mount.js` in the app's routes names a directory outside them, the
 * way `@frontierjs/orion/routes` names orion's screens. What is asked: the files
 * there get URLs under `/automations/`, the layout chain runs through the app's
 * own layouts into the package's, what a node STORES is the real file (so the
 * route table imports something that exists), a URL taken twice is still
 * refused, and a mount that names nothing is refused by name rather than
 * producing a section with no routes.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

import { scan, renderRouteTable } from '../src/scanner/index.js'

let root, web

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sierra-mount-'))
  web  = join(root, 'web')
  await mkdir(join(web, 'src', 'routes'), { recursive: true })
  await writeFile(join(web, 'src', 'routes', 'index.mesa'), '<p>home</p>')
  await writeFile(join(web, 'src', 'routes', '_module.mesa'), '---\nshell: app\n---\n<slot />')

  // The package, outside the app entirely.
  const pkg = join(root, 'pkg', 'routes')
  await mkdir(join(pkg, 'flows'), { recursive: true })
  await writeFile(join(pkg, 'index.mesa'), '---\ntitle: Automations\n---\n<p>list</p>')
  await writeFile(join(pkg, 'flows', '[flowId].mesa'), '<p>flow</p>')
  await writeFile(join(pkg, 'flows', '[flowId].meta.js'), 'export const meta = { section: "flow" }\nexport async function load() { return {} }\n')
  await writeFile(join(pkg, 'flows', '_module.mesa'), '<slot />')
  await writeFile(join(root, 'pkg', 'routes.js'), "export default new URL('./routes/', import.meta.url)\n")
})

afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const mount = (body) => writeFile(join(web, 'src', 'routes', 'automations.mount.js'), body)
const all   = (node) => [node, ...node.children.flatMap(all)]
const byPath = (tree, path) => all(tree).find(n => n.path === path)

describe('a mount', () => {
  test('puts the package routes under its name, storing the real files', async () => {
    await mount("export { default } from '../../../pkg/routes.js'\n")
    const tree = await scan('src/routes', { cwd: web })

    const list = byPath(tree, '/automations/')
    const flow = byPath(tree, '/automations/flows/:flowId/')
    expect(list).toMatchObject({ file: '../pkg/routes/index.mesa', meta: { title: 'Automations', shell: 'app' } })
    expect(flow).toMatchObject({
      file:      '../pkg/routes/flows/[flowId].mesa',
      companion: '../pkg/routes/flows/[flowId].meta.js',
      layout:    '../pkg/routes/flows/_module.mesa',
      params:    ['flowId'],
      meta:      { section: 'flow', shell: 'app' },
    })
    // A mounted page with no layout of its own runs inside the app's.
    expect(list.layout).toBe('src/routes/_module.mesa')
    for (const node of [list, flow]) expect(existsSync(resolve(web, node.file))).toBe(true)
  })

  test('the route table imports the real files', async () => {
    await mount("export default new URL('../../../pkg/routes/', import.meta.url)\n")
    const tree  = await scan('src/routes', { cwd: web })
    const table = renderRouteTable(tree, web, 'config/routes.js')

    const imports = [...table.matchAll(/import\((['"])(.+?)\1\)/g)].map(m => m[2])
    expect(imports).toContain('../../pkg/routes/flows/[flowId].mesa')
    for (const spec of imports) expect(existsSync(resolve(web, 'config', spec))).toBe(true)
  })

  test('a URL the app already has is still a conflict', async () => {
    await mount("export { default } from '../../../pkg/routes.js'\n")
    await mkdir(join(web, 'src', 'routes', 'automations'), { recursive: true })
    await writeFile(join(web, 'src', 'routes', 'automations', 'index.mesa'), '<p>mine</p>')
    await expect(scan('src/routes', { cwd: web })).rejects.toThrow(/both resolve to '\/automations\/'/)
  })

  test('a mount that names no directory is refused by name', async () => {
    await mount("export default 'relative/routes'\n")
    await expect(scan('src/routes', { cwd: web })).rejects.toThrow(/automations\.mount\.js must default-export the directory/)

    await mount("export default new URL('../../../pkg/routes.js', import.meta.url)\n")
    await expect(scan('src/routes', { cwd: web })).rejects.toThrow(/automations\.mount\.js mounts .*routes\.js, which is not a directory/)

    await mount("export { default } from './nowhere.js'\n")
    await expect(scan('src/routes', { cwd: web })).rejects.toThrow(/automations\.mount\.js could not be imported/)
  })
})
