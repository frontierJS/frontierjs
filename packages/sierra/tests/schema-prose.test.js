/**
 * tests/schema-prose.test.js — what of the schema a browser is entitled to.
 *
 * `schema-plugin.js` puts a generated `$defs` table into the client bundle, and
 * for as long as it did that it put the schema's PROSE there too: a `///`
 * comment is emitted by litestone as `description`, and this repo's own
 * comments quote policy expressions and name internal URLs. An anonymous
 * visitor received all of it on the login page (`FJS-785`, ruled `FJS-D204`).
 *
 * Three things are asserted here and only the first is the fix:
 *
 *   1. no `description` ANNOTATION crosses, at any depth, through a real build;
 *   2. a column NAMED `description` survives untouched — the negative control,
 *      and the whole trap: the annotation and the field are the same word at
 *      different depths, and a filter by key name alone deletes a real column
 *      from every generated form on a build that says nothing;
 *   3. the table is still WHOLE. `FJS-D204` refused to project it down to the
 *      models a scanner thinks the UI reaches, so a model no resource names is
 *      present on purpose. A projection landing quietly turns this red, which
 *      is the point — it has to amend the ruling first.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { resolve, dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { writeFileSync, mkdirSync, symlinkSync, readFileSync, readdirSync } from 'fs'
import { rm } from 'fs/promises'
import { build } from 'vite'

import { stripProse, generateSchemas } from '../src/build/schema-plugin.js'
import { createSierraViteConfig } from '../src/build/index.js'
import { tmpDir } from './tmp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LITESTONE = resolve(__dirname, '../../litestone')

// Every shape the strip has to tell apart, in one schema.
//
// `Article.description` is the control: a real column, with constraints, whose
// name collides with the annotation. `Article`'s own `///` lines are the model
// -level prose and `title`'s are the field-level prose — the two depths
// litestone emits — and `Ledger` is a model no route or resource names, kept to
// pin the refusal in `FJS-D204`.
const SCHEMA = `
database main { path env("DATABASE_URL", "./app.db") }

/// An article. Drafts are readable by their author alone:
/// @@allow('read', authorId == auth().id)
model Article {
  id          Int     @id
  /// The headline. Rotate the editorial key at /internal/rotate.
  title       String  @length(1, 200)
  description String? @length(0, 500)
  body        String?
}

/// The books. @@gate("9") on update and delete is deliberate.
model Ledger {
  id     Int    @id
  amount Float
  @@gate("8")
}
`

function fixture(contents = SCHEMA) {
  const dir = tmpDir('sierra-prose-')
  mkdirSync(resolve(dir, 'db'), { recursive: true })
  const path = resolve(dir, 'db', 'schema.lite')
  writeFileSync(path, contents)

  // Litestone is deliberately not linked into sierra/node_modules — the walk-up
  // lookup is what the plugin actually does and it must be exercised.
  mkdirSync(resolve(dir, 'node_modules', '@frontierjs'), { recursive: true })
  try { symlinkSync(LITESTONE, resolve(dir, 'node_modules', '@frontierjs', 'litestone'), 'dir') } catch {}

  return { dir, path }
}

/** Every `description` value reachable in a table, with the path that found it. */
function proseIn(defs) {
  const found = []
  const walkNamed = (map, path) => {
    for (const [name, node] of Object.entries(map ?? {})) walkNode(node, `${path}.${name}`)
  }
  const NAME_KEYED = new Set(['properties', '$defs', 'definitions'])
  const walkNode = (node, path) => {
    if (Array.isArray(node)) return node.forEach((n, i) => walkNode(n, `${path}[${i}]`))
    if (!node || typeof node !== 'object') return
    for (const [key, value] of Object.entries(node)) {
      if (key === 'description' && typeof value === 'string') { found.push([path, value]); continue }
      if (NAME_KEYED.has(key)) walkNamed(value, `${path}.${key}`)
      else walkNode(value, `${path}.${key}`)
    }
  }
  walkNamed(defs, '')
  return found
}

// ─── the walk, in isolation ───────────────────────────────────────────────────

describe('stripProse', () => {

  test('takes a model-level annotation out', () => {
    const out = stripProse({ Article: { type: 'object', description: 'notes', properties: {} } })
    expect(out.Article.description).toBeUndefined()
    expect(out.Article.type).toBe('object')
  })

  test('takes a field-level annotation out', () => {
    const out = stripProse({
      Article: { properties: { title: { type: 'string', description: 'notes' } } },
    })
    expect(out.Article.properties.title.description).toBeUndefined()
    expect(out.Article.properties.title.type).toBe('string')
  })

  // The negative control. A walk that filters by key name alone passes every
  // assertion above and deletes this column.
  test('leaves a column NAMED description alone, constraints and all', () => {
    const out = stripProse({
      Article: {
        properties: {
          description: { type: 'string', maxLength: 500, description: 'notes' },
        },
      },
    })
    const prop = out.Article.properties.description
    expect(prop).toBeDefined()
    expect(prop.type).toBe('string')
    expect(prop.maxLength).toBe(500)
    expect(prop.description).toBeUndefined()   // its own annotation still goes
  })

  test('does not mutate its input', () => {
    const input = { Article: { description: 'notes', properties: {} } }
    stripProse(input)
    expect(input.Article.description).toBe('notes')
  })

  test('carries a $ref and an enum through untouched', () => {
    const out = stripProse({
      Plan: { enum: ['starter', 'pro'], description: 'notes' },
      Article: { properties: { plan: { $ref: '#/$defs/Plan' } } },
    })
    expect(out.Plan.enum).toEqual(['starter', 'pro'])
    expect(out.Article.properties.plan.$ref).toBe('#/$defs/Plan')
  })
})

// ─── through the generator, over a real .lite ─────────────────────────────────

describe('generateSchemas', () => {

  test('emits no annotation at any depth', async () => {
    const { dir, path } = fixture()
    const out = await generateSchemas(path, () => {}, dir)
    expect(out).not.toBeNull()
    expect(proseIn(out.defs)).toEqual([])
  })

  test('the update patch carries none either', async () => {
    const { dir, path } = fixture()
    const out = await generateSchemas(path, () => {}, dir)
    // The patch is a diff of two tables, so prose left in one arrives here as a
    // changed property rather than as a `description` key at the top.
    expect(JSON.stringify(out.updatePatch)).not.toContain('/internal/rotate')
  })

  test('the description COLUMN survives with its length rule', async () => {
    const { dir, path } = fixture()
    const out = await generateSchemas(path, () => {}, dir)
    // A nullable column is emitted as an `anyOf`, so the constraint is one
    // array hop down — which is also the shape that proves the walk recurses
    // through an array rather than stopping at it.
    const prop = out.defs.Article.properties.description
    expect(prop).toBeDefined()
    expect(prop.anyOf[0].maxLength).toBe(500)
  })

  // FJS-D204: the table is not projected. A model nothing names still crosses.
  test('a model no resource names is still in the table', async () => {
    const { dir, path } = fixture()
    const out = await generateSchemas(path, () => {}, dir)
    expect(out.defs.Ledger).toBeDefined()
    expect(out.defs.Ledger['x-gate']).toBeDefined()
    expect(out.models).toContain('Ledger')
  })
})

// ─── through a real Vite build ────────────────────────────────────────────────
//
// The string the plugin returns is not what a visitor downloads. The whole
// finding was confirmed against a minified production bundle and the fix is
// asserted the same way: virtual:sierra JSON.stringifies the table into the
// entry chunk, and nothing but reading that chunk can see it.

const TMP = join(__dirname, 'tmp-schema-prose-build')

describe('the built bundle', () => {
  let bundle = ''

  beforeAll(async () => {
    mkdirSync(join(TMP, 'db'), { recursive: true })
    mkdirSync(join(TMP, 'src/routes'), { recursive: true })
    writeFileSync(join(TMP, 'db/schema.lite'), SCHEMA)
    writeFileSync(join(TMP, 'src/routes/index.mesa'), '<h1>hi</h1>')
    writeFileSync(join(TMP, 'index.html'),
      '<!doctype html><html><body><div id="app"></div>' +
      '<script type="module" src="/src/main.js"></script></body></html>')
    writeFileSync(join(TMP, 'src/main.js'), "import 'virtual:sierra'\n")
    // virtual:sierra imports the app's own config by absolute path.
    mkdirSync(join(TMP, 'config'), { recursive: true })
    writeFileSync(join(TMP, 'config/sierra.config.js'), 'export default {}\n')

    mkdirSync(join(TMP, 'node_modules/@frontierjs'), { recursive: true })
    try { symlinkSync(LITESTONE, join(TMP, 'node_modules/@frontierjs/litestone'), 'dir') } catch {}

    await build({
      ...createSierraViteConfig({ routesDir: 'src/routes', postbuild: false }),
      root: TMP,
      logLevel: 'silent',
      build: { outDir: join(TMP, 'dist'), emptyOutDir: true },
    })

    const dir = join(TMP, 'dist/assets')
    bundle = readdirSync(dir).filter(f => f.endsWith('.js'))
      .map(f => readFileSync(join(dir, f), 'utf8')).join('\n')
  }, 60_000)

  afterAll(async () => { await rm(TMP, { recursive: true, force: true }) })

  test('the schema reached it at all', () => {
    expect(bundle).toContain('Article')
  })

  test('no doc comment reached it', () => {
    expect(bundle).not.toContain('/internal/rotate')
    expect(bundle).not.toContain('authorId == auth().id')
    expect(bundle).not.toContain('Drafts are readable')
  })

  test('the description COLUMN did', () => {
    // The name, not the annotation — the control, in the one place it matters.
    expect(bundle).toContain('description')
  })
})
