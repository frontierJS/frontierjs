/**
 * tests/scanner-refusals.test.js — what the scanner must not silently accept
 *
 * The slice these came from has one disease: **a transformation that cannot
 * express its input emits something that builds.** Two files at one URL, an
 * apostrophe in a filename, a `__proto__` key in frontmatter — each produced a
 * green build and a wrong app, and none of the 191 tests over this code could
 * see any of them.
 *
 * Every row here is written against a real directory on disk and the real
 * `scan()`, not a hand-built tree: the shapes are about what the WALKER and
 * `fileToRoute` do with a filename, which a fixture tree cannot restate.
 */

import { describe, test, expect } from 'vitest'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'

import { scan } from '../src/scanner/index.js'
import { buildTree } from '../src/scanner/build-tree.js'
import { renderRouteTable } from '../src/scanner/generate-route-table.js'
import { walk } from '../src/scanner/walk.js'
import { tmpDir } from './tmp.js'

const PAGE = '<h1>x</h1>\n'

/** Write `files` (relative path → contents) under a fresh temp project root. */
async function project(files) {
  const root = tmpDir('refusals-')
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel)
    await mkdir(join(abs, '..'), { recursive: true })
    await writeFile(abs, body, 'utf8')
  }
  return root
}

/**
 * The route table as a MODULE.
 *
 * A JSON-shaped object literal and a `JSON.parse` of the same bytes read
 * identically as text and differently as JavaScript, which is the whole of
 * `FJS-801` — so the assertions below are made against what the emitted source
 * evaluates to. The lazy `import()` factories in it are never called, so their
 * relative specifiers never have to resolve from a data: URL.
 */
async function evaluate(code) {
  return import('data:text/javascript,' + encodeURIComponent(code))
}

async function tree(root) {
  const files = await walk(join(root, 'src/routes'), root)
  return buildTree(files, 'src/routes', { cwd: root })
}

// ─── FJS-798 — two files, one URL ────────────────────────────────────────────

describe('two files that resolve to one URL', () => {
  // Route groups are the DOCUMENTED feature nothing in this repo uses, which
  // is why this was latent and also why nothing had ever run it.
  test('two route groups holding the same page name', async () => {
    const root = await project({
      'src/routes/(app)/login.mesa':  PAGE,
      'src/routes/(auth)/login.mesa': PAGE,
    })
    await expect(tree(root)).rejects.toThrow(/both resolve to '\/login\/'/)
  })

  // The sharpest of the three: `buildTreeFromEntries` takes the first
  // `id === 'root'` and continues past the rest, so the real home page was
  // deleted from the app with nothing said.
  test('a root index inside a group, beside the real one', async () => {
    const root = await project({
      'src/routes/index.mesa':       PAGE,
      'src/routes/(app)/index.mesa': PAGE,
    })
    await expect(tree(root)).rejects.toThrow(/both resolve to '\/'/)
  })

  // `checkConflicts` lowercases the file name and not the folder key, so this
  // one walked past the guard that exists for exactly this shape.
  test('a file and a folder that differ only in case', async () => {
    const root = await project({
      'src/routes/about.mesa':       PAGE,
      'src/routes/About/index.mesa': PAGE,
    })
    await expect(tree(root)).rejects.toThrow(/both resolve to '\/about\/'/)
  })

  // The negative control. A guard that refuses everything satisfies any
  // assertion that only checks the refusal (`FJS-351`): a group that does NOT
  // collide has to keep working, or the feature is gone rather than guarded.
  test('a route group over distinct pages is still accepted', async () => {
    const root = await project({
      'src/routes/(app)/login.mesa':    PAGE,
      'src/routes/(auth)/register.mesa': PAGE,
      'src/routes/index.mesa':          PAGE,
    })
    const t = await tree(root)
    const paths = renderRouteTable(t, root)
    expect(paths).toContain('"/login/"')
    expect(paths).toContain('"/register/"')
  })
})

// ─── FJS-801 — `__proto__` in frontmatter ────────────────────────────────────

describe('a frontmatter key the build and the browser read differently', () => {
  test('the emitted meta is an ordinary object, prototype and all', async () => {
    const root = await project({
      'src/routes/index.mesa':
        '---\ntitle: home\n__proto__:\n  render: static\n  publishes: 9\n---\n' + PAGE,
    })
    const code = renderRouteTable(await tree(root), root)

    // The route table is JS SOURCE, so the assertion has to be made against
    // what that source evaluates to — a JSON-shaped literal and a JSON.parse
    // of the same bytes are indistinguishable until you run them.
    const mod = await evaluate(code)
    const meta = mod.tree.meta

    expect(Object.getPrototypeOf(meta)).toBe(Object.prototype)
    expect(meta.render).toBeUndefined()
    expect(meta.publishes).toBeUndefined()
    // …and the key is still THERE as data, so nothing was silently dropped.
    expect(Object.keys(meta)).toContain('__proto__')
    expect(meta.title).toBe('home')
  })
})

// ─── FJS-821(a) — the table interpolates filenames into source ───────────────

describe('a filename that is legal on disk and not legal in source', () => {
  test("an apostrophe in a route file still emits a table that parses", async () => {
    const root = await project({ "src/routes/en's-guide.mesa": PAGE })
    const code = renderRouteTable(await tree(root), root)

    // Parsed rather than pattern-matched: *does this file parse* is the whole
    // claim, and a regex over it would be a second, weaker parser.
    const mod = await evaluate(code)
    expect(mod.all).toContain("/en's-guide/")
  })

  test('a filename shaped like an escape does not become source', async () => {
    const name = "a'),z:(()=>{globalThis.SIERRA_PWNED=1})(),y:import('b"
    const root = await project({ [`src/routes/${name}.mesa`]: PAGE })
    const code = renderRouteTable(await tree(root), root)

    const mod = await evaluate(code)
    expect(globalThis.SIERRA_PWNED).toBeUndefined()
    expect(Object.keys(mod.components)).toHaveLength(1)
  })

  // The negative control for the escape, and for Invariant 12: an ordinary
  // name still emits single quotes, so a table regenerated by this build is
  // byte-identical to the one before it.
  test('an ordinary name is still single-quoted', async () => {
    const root = await project({ 'src/routes/about.mesa': PAGE })
    const code = renderRouteTable(await tree(root), root)
    expect(code).toContain("'about': () => import('")
  })
})

// ─── FJS-821(c) / FJS-806 — a companion's meta is read fresh ─────────────────

describe('a companion edited while the process is running', () => {
  test('the second scan reads what is on disk now', async () => {
    const root = await project({
      'src/routes/index.mesa':   PAGE,
      'src/routes/index.meta.js': 'export const meta = { title: "FIRST" }\n',
    })

    const one = await scan('src/routes', { cwd: root })
    await writeFile(
      join(root, 'src/routes/index.meta.js'),
      'export const meta = { title: "SECOND" }\n',
      'utf8'
    )
    const two = await scan('src/routes', { cwd: root })

    expect(one.meta.title).toBe('FIRST')
    // Under a plain `import()` this answered FIRST for the life of the process,
    // and under `?t=${mtime}` it answers FIRST under bun and SECOND under node
    // — so the assertion is the value, in whichever runtime is running.
    expect(two.meta.title).toBe('SECOND')
  })

  test('the sidecar the fresh import writes is not left behind', async () => {
    const root = await project({
      'src/routes/index.mesa':    PAGE,
      'src/routes/index.meta.js': 'export const meta = { title: "T" }\n',
    })
    await scan('src/routes', { cwd: root })
    const files = await walk(join(root, 'src/routes'), root)
    expect(files.filter(f => f.includes('sierra-fresh'))).toEqual([])
  })
})
