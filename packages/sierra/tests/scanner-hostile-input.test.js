/**
 * tests/scanner-hostile-input.test.js — what the scanner is handed, rather than
 * what it is supposed to be handed.
 *
 * The route tree is built from a directory somebody else laid out and from
 * frontmatter somebody else wrote — on a documentation site the content author
 * is not the person who runs the build. Three inputs the reader had half a rule
 * for (`FJS-821` (f) and (g)):
 *
 *   • a YAML alias bomb, which parses in six milliseconds and serializes to
 *     205 MB inside the generated config/routes.js;
 *   • a symlinked route DIRECTORY, invisible where a symlinked route FILE was
 *     included;
 *   • `[__proto__].mesa`, a legal filename whose param could never be read.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { walk } from '../src/scanner/walk.js'
import { parseFrontmatter, readFrontmatter } from '../src/scanner/parse-frontmatter.js'
import { matchRoute } from '../src/router/match.js'

// ─── the alias bomb ──────────────────────────────────────────────────────────

// Eight anchors, each repeating the one above it nine times: 9^8 leaves once
// expanded, and every one of them is written out by JSON.stringify.
const BOMB = [
  '---',
  'a: &a ["x","x","x","x","x","x","x","x","x"]',
  'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]',
  'c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]',
  'd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]',
  'e: &e [*d,*d,*d,*d,*d,*d,*d,*d,*d]',
  'f: &f [*e,*e,*e,*e,*e,*e,*e,*e,*e]',
  'g: &g [*f,*f,*f,*f,*f,*f,*f,*f,*f]',
  'h: &h [*g,*g,*g,*g,*g,*g,*g,*g,*g]',
  '---',
  'body',
].join('\n')

describe('frontmatter expansion is bounded', () => {
  test('an alias bomb is refused, and refused CHEAPLY', () => {
    const t0 = Date.now()
    const { frontmatter, error } = parseFrontmatter(BOMB)
    const ms = Date.now() - t0

    expect(error).toMatch(/expands to more than/)
    expect(frontmatter).toEqual({})
    // Serializing it to find out how big it is takes 1.6s and 205 MB — the
    // count has to abort at the budget instead.
    expect(JSON.stringify(frontmatter).length).toBeLessThan(64)
    expect(ms).toBeLessThan(1000)
  })

  test('the refusal names the FILE, because an allocation failure names nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sierra-fm-'))
    const file = join(dir, 'bomb.md')
    await writeFile(file, BOMB)
    await expect(readFrontmatter(file)).rejects.toThrow(file)
    await rm(dir, { recursive: true, force: true })
  })

  // The negative control. A bound that refused everything would satisfy the two
  // assertions above and stop every route declaring anything.
  test('ordinary frontmatter is untouched, aliases included', () => {
    const src = [
      '---',
      'title: About',
      'render: static',
      'tags: &t [a, b]',
      'also: *t',
      '---',
      'body',
    ].join('\n')
    const { frontmatter, error } = parseFrontmatter(src)
    expect(error).toBeNull()
    expect(frontmatter.title).toBe('About')
    expect(frontmatter.also).toEqual(['a', 'b'])
  })
})

// ─── the walker ──────────────────────────────────────────────────────────────

describe('walk follows symlinks', () => {
  let root

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sierra-walk-'))
    await mkdir(join(root, 'routes'), { recursive: true })
    await writeFile(join(root, 'routes', 'index.mesa'), '<p>home</p>')
    // The shared tree, outside the routes dir, linked in.
    await mkdir(join(root, 'shared', 'docs'), { recursive: true })
    await writeFile(join(root, 'shared', 'docs', 'index.mesa'), '<p>docs</p>')
    await writeFile(join(root, 'shared', 'guide.mesa'), '<p>guide</p>')
  })

  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  test('a symlinked route DIRECTORY is walked', async () => {
    await symlink(join(root, 'shared', 'docs'), join(root, 'routes', 'docs'))
    const files = await walk(join(root, 'routes'), root)
    expect(files).toContain('routes/docs/index.mesa')
  })

  test('a symlinked route FILE is still included — the half that already worked', async () => {
    await symlink(join(root, 'shared', 'guide.mesa'), join(root, 'routes', 'guide.mesa'))
    const files = await walk(join(root, 'routes'), root)
    expect(files).toContain('routes/guide.mesa')
  })

  test('a self-referential symlink does not hang, and says what it skipped', async () => {
    await symlink(join(root, 'routes'), join(root, 'routes', 'loop'))
    const warnings = []
    const files = await walk(join(root, 'routes'), root, { warn: m => warnings.push(m) })
    expect(files).toEqual(['routes/index.mesa'])
    expect(warnings.join('\n')).toMatch(/loop/)
  })

  test('a dangling symlink is not a route and not a crash', async () => {
    await symlink(join(root, 'shared', 'nothing-here'), join(root, 'routes', 'ghost'))
    const files = await walk(join(root, 'routes'), root)
    expect(files).toEqual(['routes/index.mesa'])
  })
})

// ─── the param nobody could read ─────────────────────────────────────────────

describe('a route param named __proto__', () => {
  const tree = {
    id: 'root', path: '/', file: null, layout: null, meta: {}, params: [], children: [
      {
        id: '[__proto__]', path: '/:__proto__/', file: 'src/routes/[__proto__].mesa',
        layout: null, meta: {}, params: ['__proto__'], children: [],
      },
    ],
  }

  test('is readable — it was a setter call, so the route matched and the value vanished', () => {
    const m = matchRoute('/hello/', tree, { trailingSlash: 'always' })
    expect(m).toBeTruthy()
    expect(m.params.__proto__).toBe('hello')
    expect(Object.prototype.hasOwnProperty.call(m.params, '__proto__')).toBe(true)
  })

  test('and the params object is not corrupted by it', () => {
    const m = matchRoute('/hello/', tree, { trailingSlash: 'always' })
    // The old assignment walked the prototype instead: `{}.__proto__ = 'hello'`
    // is a no-op for a string, and for an object it would replace the prototype.
    expect(Object.getPrototypeOf(m.params)).toBe(Object.prototype)
    // Written this way because `{ __proto__: 'hello' }` in a literal is the
    // setter syntax and produces `{}` — the same trap one layer up.
    const round = JSON.parse(JSON.stringify(m.params))
    expect(Object.keys(round)).toEqual(['__proto__'])
    expect(round.__proto__).toBe('hello')
  })

  test('an ordinary param is unaffected — the control', () => {
    const plain = {
      id: 'root', path: '/', file: null, layout: null, meta: {}, params: [], children: [
        {
          id: '[slug]', path: '/:slug/', file: 'src/routes/[slug].mesa',
          layout: null, meta: {}, params: ['slug'], children: [],
        },
      ],
    }
    const m = matchRoute('/hello/', plain, { trailingSlash: 'always' })
    expect(m.params).toEqual({ slug: 'hello' })
  })
})
