/**
 * test/mcp-build.test.js — what an MCP App view IS, and what the loop writes.
 *
 * The claims a host settles — the iframe loads the document, a call leaves as
 * `tools/call`, nothing reaches the app's origin — are plan step 4.3's drive
 * (`IDEAS/agent-client-ui.md`). What can be settled here decides what gets
 * built at all: which files are views, what the two generated modules say and
 * in which order, that a built view is ONE file with its runtime and its
 * stylesheet inside, and what a failed or stale build leaves in a directory
 * `mcpPlugin()` serves whole.
 *
 * `viteBuild` is injected, as it is for the widget build, so the loop's
 * refusals and cleanup are asserted against a recorder. The last section runs
 * a real Vite build over a fixture resource file, because *one document with
 * everything inside it* is a claim only a bundle can answer.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, symlinkSync, rmSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import {
  discoverResources, viewBootSource, viewEntrySource, viewDocument, viewDocumentPlugin,
  hasMarkupHalf, viewFormSource, buildViews, buildViewsFor, VIEW_RUNTIME,
} from '../src/build/mcp-build.js'
import { clientSchemas } from '../src/build/schema-plugin.js'
import { resourceIn, applyHostContext } from '../src/mcp/index.js'
import { initTheme, theme } from '../src/theme/index.js'
// Mesa's parser by relative path, as every in-repo test imports workspace
// source: the build finds it through findMesaFile, and this is the same file.
import { parseHTML } from '../../mesa/src/compiler.js'
import { tmpDir } from './tmp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── discovery ────────────────────────────────────────────────────────────

describe('discovery', () => {
  let dir
  beforeAll(() => {
    dir = tmpDir('fjs-views-')
    const file = (p, body = '') => {
      mkdirSync(join(dir, p, '..'), { recursive: true })
      writeFileSync(join(dir, p), body)
    }
    file('Order.mesa')
    file('Customer.mesa')
    file('_Draft.mesa')                // underscore-prefixed — skipped
    file('.Hidden.mesa')
    file('helpers.js')                 // not a resource file
    file('Parts/Line.mesa')            // a directory is not a Resource (Invariant 19)
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test('a .mesa file is a view, sorted by name', () => {
    expect(discoverResources(dir).map(r => r.name)).toEqual(['Customer', 'Order'])
  })

  test('a directory is left alone', () => {
    // One Resource per file is the invariant; a directory here is a resource's
    // parts or a mistake, and either way not a view.
    expect(discoverResources(dir).map(r => r.name)).not.toContain('Parts')
    expect(discoverResources(dir).map(r => r.name)).not.toContain('Line')
  })

  test('a missing directory is empty, not a throw', () => {
    expect(discoverResources(join(dir, 'nope'))).toEqual([])
  })
})

// ─── the generated modules ────────────────────────────────────────────────

describe('the boot', () => {
  const schemas = { defs: { Order: { type: 'object' } }, models: ['Order'], updatePatch: { Order: {} }, readPatch: null }
  const src = viewBootSource({ schemas })

  test('registers the four schema tables virtual:sierra registers', () => {
    expect(src).toContain(`import { registerSchemas } from '@frontierjs/sierra/resource'`)
    expect(src).toContain(`registerSchemas({"Order":{"type":"object"}}, ["Order"], {"Order":{}}, null)`)
  })

  test('installs the relay client and imports the stylesheet', () => {
    expect(src).toContain(`import { mcpApp } from "${VIEW_RUNTIME}"`)
    expect(src).toContain('mcpApp()')
    expect(src).toContain(`import "@frontierjs/css"`)
  })

  test('boots the app\'s theme as virtual:sierra does, with persist off', () => {
    // A sandbox without allow-same-origin THROWS on a localStorage read, and a
    // view has no preference of its own: the host states the scheme.
    const themed = viewBootSource({ schemas, theme: { themes: ['theme-default', 'theme-dark'], default: 'theme-default', persist: true, key: 'shop_theme' } })
    expect(themed).toContain(`import { initTheme } from '@frontierjs/sierra/theme'`)
    expect(themed).toContain(`initTheme({"themes":["theme-default","theme-dark"],"default":"theme-default","persist":false,"key":"shop_theme"})`)
    // No theme block: the switch's own defaults, which are the kit's pair.
    expect(src).toContain(`initTheme({"persist":false})`)
    // Before the relay, so the document is themed whatever the relay does.
    expect(themed.indexOf('initTheme(')).toBeLessThan(themed.indexOf('mcpApp()'))
  })

  test('no schema is said in the page, not swallowed', () => {
    // An empty generated form on an agent's screen looks finished (`FJS-1649`).
    const none = viewBootSource({ schemas: null, schemaFailure: 'parse error at 3:1' })
    expect(none).not.toContain('registerSchemas(')
    expect(none).toContain('console.error(')
    expect(none).toContain('parse error at 3:1')
  })
})

describe('the entry', () => {
  const src = viewEntrySource({ name: 'Order', entry: '/abs/Order.mesa' }, { boot: '/abs/.sierra/mcp-boot.js' })

  test('imports the boot FIRST, then the resource file, then mounts', () => {
    // createResource() runs at the resource file's import and reads the
    // registry and the client right then — so the boot has to be evaluated
    // before it, which in ESM means imported before it.
    const boot = src.indexOf('import "/abs/.sierra/mcp-boot.js"')
    const view = src.indexOf('import View from "/abs/Order.mesa"')
    expect(boot).toBeGreaterThan(-1)
    expect(view).toBeGreaterThan(boot)
    expect(src).toContain(`import { mountView } from "${VIEW_RUNTIME}"`)
    expect(src).toContain('mountView(View, { name: "Order" })')
  })

  test('a view module other than the resource file is mounted in its place', () => {
    const over = viewEntrySource({ name: 'Order', entry: '/abs/Order.mesa' },
      { boot: '/abs/.sierra/mcp-boot.js', view: '/abs/.sierra/mcp-Order.form.mesa' })
    expect(over).toContain('import View from "/abs/.sierra/mcp-Order.form.mesa"')
    expect(over).not.toContain('import View from "/abs/Order.mesa"')
  })
})

// ─── the markup half ──────────────────────────────────────────────────────

describe('the markup half', () => {
  const has = (src) => hasMarkupHalf(src, parseHTML)

  test('a file with an element after its scripts has one', () => {
    expect(has('<script module>export const x = 1</script>\n<script>let a</script>\n<Form />\n')).toBe(true)
    expect(has('<script module>export const x = 1</script>\n{#if a}x{/if}\n')).toBe(true)
    expect(has('<script module>export const x = 1</script>\nplain text\n')).toBe(true)
  })

  test('script, style, a comment and whitespace are not one', () => {
    expect(has('<script module>export const x = 1</script>\n')).toBe(false)
    expect(has('<script module>export const x = 1</script>\n<script>let a</script>\n<style>.a{}</style>\n')).toBe(false)
    expect(has('<script module>export const x = 1</script>\n<!-- a note -->\n')).toBe(false)
  })

  test('a </script> string literal inside the script is not the end of it', () => {
    // The reason this is Mesa's parser and not a regex: the literal would end
    // the block early and hand the rest of the script over as markup.
    expect(has(`<script module>\n  const closer = '</script>'\n  export const x = 1\n</script>\n`)).toBe(false)
  })
})

// ─── the generated form ───────────────────────────────────────────────────

describe('the generated form', () => {
  const src = viewFormSource({ name: 'CreditNote', entry: '/abs/CreditNote.mesa' })

  test('is the kit form over the file\'s own Resource, with one submit', () => {
    expect(src).toContain('import * as Resource from "/abs/CreditNote.mesa"')
    expect(src).toContain(`import { resourceIn } from "${VIEW_RUNTIME}"`)
    expect(src).toContain('import Form   from "@frontierjs/ui/components/forms/Form.mesa"')
    expect(src).toContain('resourceIn(Resource, "CreditNote")')
    expect(src).toContain('<Form {resource} bind:record={record}>')
    expect(src).toContain('type="submit"')
  })

  test('states no method — save() decides create against patch', () => {
    expect(src).not.toMatch(/method=/)
    expect(src).not.toMatch(/mode:/)
  })

  test('is a resource file in shape: a module script, an instance script, markup', () => {
    expect(hasMarkupHalf(src, parseHTML)).toBe(true)
    expect(src.indexOf('<script module>')).toBeLessThan(src.indexOf('<script>'))
  })
})

describe('resourceIn', () => {
  const resource = () => ({ save() {}, formFields() {}, service: {} })

  test('answers the one export that is a Resource, whatever it is named', () => {
    const r = resource()
    expect(resourceIn({ creditNotes: r, helper: () => {}, LIMIT: 5 }, 'CreditNote')).toBe(r)
  })

  test('two names for one object is one Resource', () => {
    const r = resource()
    expect(resourceIn({ orders: r, resource: r }, 'Order')).toBe(r)
  })

  test('none is refused by name', () => {
    expect(() => resourceIn({ x: 1 }, 'Note')).toThrow(/Note\.mesa exports no Resource/)
  })

  test('two is refused rather than picked between', () => {
    expect(() => resourceIn({ a: resource(), b: resource() }, 'Pair')).toThrow(/2 Resources \(a, b\)/)
  })
})

// ─── the host's context ───────────────────────────────────────────────────

describe('applyHostContext', () => {
  const pair = { themes: ['theme-default', 'theme-dark'], default: 'theme-default', persist: false }
  beforeEach(() => initTheme(pair))

  test('the host\'s theme becomes the scheme, on the app\'s own pair', () => {
    applyHostContext({ theme: 'dark', displayMode: 'inline', locale: 'en-GB' })
    expect(theme.value).toBe('theme-dark')
    applyHostContext({ theme: 'light' })
    expect(theme.value).toBe('theme-default')
  })

  test('a host-context-changed without a theme key leaves the theme as it was', () => {
    // The notification carries only what changed (spec: partial update).
    applyHostContext({ theme: 'dark' })
    applyHostContext({ displayMode: 'fullscreen' })
    expect(theme.value).toBe('theme-dark')
    applyHostContext(null)
    expect(theme.value).toBe('theme-dark')
  })

  test('a theme the spec does not name is refused by name, not applied as nothing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    applyHostContext({ theme: 'high-contrast' })
    expect(theme.value).toBe('theme-default')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("'high-contrast' is not a scheme"))
    warn.mockRestore()
  })
})

// ─── the document ─────────────────────────────────────────────────────────

describe('the document', () => {
  test('is one HTML5 file with the stylesheet and the script inside', () => {
    const html = viewDocument({ name: 'Order', htmlClass: 'theme-dark', css: '.a{color:red}', script: 'console.log(1)' })
    expect(html.startsWith('<!doctype html>\n<html lang="en" class="theme-dark">')).toBe(true)
    expect(html).toContain('<meta charset="utf-8">')
    expect(html).toContain('<title>Order</title>')
    expect(html).toContain('<style>.a{color:red}</style>')
    expect(html).toContain('<body class="app">')
    expect(html).toContain('<script>console.log(1)</script>')
    expect(html).not.toContain('src=')
    expect(html).not.toContain('<link')
  })

  test('no theme means no class attribute', () => {
    expect(viewDocument({ name: 'Order' })).toContain('<html lang="en">')
  })

  test('a </script in the bundle cannot end the element', () => {
    // The one way a file that built clean fails to PARSE: the rest of the
    // bundle becomes markup. `<\/script` is the same string to JavaScript.
    const html = viewDocument({ name: 'X', script: 'const s = "</script><b>"' })
    expect(html).not.toContain('"</script><b>"')
    expect(html).toContain('"<\\/script><b>"')
    expect(html.match(/<\/script>/g)).toHaveLength(1)
  })
})

describe('the document plugin', () => {
  const run = (bundle, name = 'Order') => {
    const emitted = []
    const plugin = viewDocumentPlugin({ name, htmlClass: 'theme-x' })
    plugin.generateBundle.call({ emitFile: (f) => emitted.push(f) }, {}, bundle)
    return { bundle, emitted }
  }
  const chunk = (code, fileName = 'Order.js') => ({ type: 'chunk', isEntry: true, fileName, code })
  const css   = (source) => ({ type: 'asset', fileName: 'style.css', source })

  test('the chunk and the stylesheet leave the bundle and one document replaces them', () => {
    const { bundle, emitted } = run({ 'Order.js': chunk('mount()'), 'style.css': css('.a{}') })
    expect(Object.keys(bundle)).toEqual([])
    expect(emitted).toHaveLength(1)
    expect(emitted[0].fileName).toBe('Order.html')
    expect(emitted[0].source).toContain('<style>.a{}</style>')
    expect(emitted[0].source).toContain('<script>mount()</script>')
    expect(emitted[0].source).toContain('class="theme-x"')
  })

  test('no stylesheet is an empty style element, not a failure', () => {
    const { emitted } = run({ 'Order.js': chunk('mount()') })
    expect(emitted[0].source).toContain('<style></style>')
  })

  test('a second file the host would have to load fails the build by name', () => {
    expect(() => run({
      'Order.js':   chunk('mount()'),
      'chunk-1.js': { type: 'chunk', isEntry: false, fileName: 'chunk-1.js', code: '' },
    })).toThrow(/chunk-1\.js/)
    expect(() => run({
      'Order.js':  chunk('mount()'),
      'logo.png':  { type: 'asset', fileName: 'logo.png', source: new Uint8Array() },
    })).toThrow(/logo\.png/)
  })

  test('no entry chunk is a failure', () => {
    expect(() => run({ 'style.css': css('.a{}') })).toThrow(/no entry chunk/)
  })
})

// ─── the loop, against a recorder ─────────────────────────────────────────

describe('the loop', () => {
  let root
  const resources = () => join(root, 'src/resources')
  const out       = () => join(root, 'dist/mcp')

  const recorder = () => {
    const calls = []
    // The entry and the generated form are gone once the loop returns, so what
    // they said is read while the build is "running".
    const fn = async (config) => {
      const entry = config.build.lib.entry
      const view  = readFileSync(entry, 'utf8').match(/import View from "([^"]+)"/)?.[1]
      calls.push(Object.assign(config, { _entrySource: readFileSync(entry, 'utf8'), _view: view,
        _viewSource: view && existsSync(view) ? readFileSync(view, 'utf8') : null }))
    }
    fn.calls = calls
    return fn
  }
  const BARE   = `<script module>\n  export const x = 1\n</script>\n`
  const MARKUP = `<script module>\n  export const x = 1\n</script>\n\n<p>a form</p>\n`
  const resource = (name, body = BARE) => {
    mkdirSync(resources(), { recursive: true })
    writeFileSync(join(resources(), `${name}.mesa`), body)
  }

  beforeEach(() => { root = tmpDir('view-loop-') })

  test('N resource files are N builds, each over its own entry and the shared boot', async () => {
    resource('Order', MARKUP); resource('Customer')
    const viteBuild = recorder()
    const built = await buildViews({ root, outDir: out(), viteBuild })
    expect(built).toEqual([
      { name: 'Customer', fileName: 'Customer.html', generated: true },
      { name: 'Order',    fileName: 'Order.html',    generated: false },
    ])
    expect(viteBuild.calls).toHaveLength(2)
    for (const call of viteBuild.calls) {
      expect(call.build.lib.formats).toEqual(['iife'])
      expect(call.build.emptyOutDir).toBe(false)
      expect(call.build.cssCodeSplit).toBe(false)
      expect(call.configFile).toBe(false)
      // Vite copies public/ into every outDir, and a favicon beside the views
      // is a file the plugin would read as one.
      expect(call.publicDir).toBe(false)
      expect(call.plugins.map(p => p.name)).toContain('sierra:mcp-view')
    }
    expect(viteBuild.calls[0].build.lib.entry).toMatch(/mcp-Customer\.js$/)
  })

  test('a file with a markup half is the view; one without gets the generated form', async () => {
    resource('Order', MARKUP); resource('Customer')
    const viteBuild = recorder()
    const log = []
    await buildViews({ root, outDir: out(), viteBuild, log: m => log.push(m) })
    const [customer, order] = viteBuild.calls
    // The bare file: the entry mounts the generated form, which imports the
    // resource file for its Resource — so the boot still comes first.
    expect(customer._view).toMatch(/mcp-Customer\.form\.mesa$/)
    expect(customer._viewSource).toContain(`import * as Resource from ${JSON.stringify(join(resources(), 'Customer.mesa'))}`)
    expect(customer._viewSource).toContain('resourceIn(Resource, "Customer")')
    expect(customer._entrySource.indexOf('mcp-boot.js')).toBeLessThan(customer._entrySource.indexOf('import View'))
    // The file with markup: its own default export, and no form written for it.
    expect(order._view).toBe(join(resources(), 'Order.mesa'))
    expect(existsSync(join(root, 'node_modules/.sierra/mcp-Order.form.mesa'))).toBe(false)
    // Said in the log, so a form nobody wrote can be found.
    expect(log.find(m => m.startsWith('Customer →'))).toContain('generated form')
    expect(log.find(m => m.startsWith('Order →'))).not.toContain('generated form')
  })

  test('the generated modules are gone afterwards, the form included', async () => {
    resource('Order'); resource('Line', MARKUP)
    await buildViews({ root, outDir: out(), viteBuild: recorder() })
    const tmp = join(root, 'node_modules/.sierra')
    expect(readdirSync(tmp).filter(f => f.startsWith('mcp-'))).toEqual([])
  })

  test('no outDir is refused — fli supplies it', async () => {
    resource('Order')
    await expect(buildViews({ root, viteBuild: recorder() })).rejects.toThrow(/outDir/)
  })

  test('no resource file builds nothing and says where it looked', async () => {
    const lines = []
    const built = await buildViews({ root, outDir: out(), viteBuild: recorder(), log: m => lines.push(m) })
    expect(built).toEqual([])
    expect(lines.join('\n')).toMatch(/src\/resources/)
  })

  test('a failed build withdraws that view and leaves the others', async () => {
    // mcpPlugin() serves whatever the directory holds: a document from the
    // LAST run under a model whose build just failed is a screen that lies.
    resource('Aaa'); resource('Zzz')
    mkdirSync(out(), { recursive: true })
    writeFileSync(join(out(), 'Zzz.html'), 'from the last run')
    const viteBuild = async (cfg) => {
      const name = cfg.build.lib.fileName().replace(/\.js$/, '')
      writeFileSync(join(out(), `${name}.html`), 'built')
      if (name === 'Zzz') throw new Error('boom')
    }
    await expect(buildViews({ root, outDir: out(), viteBuild })).rejects.toThrow('boom')
    expect(readFileSync(join(out(), 'Aaa.html'), 'utf8')).toBe('built')
    expect(existsSync(join(out(), 'Zzz.html'))).toBe(false)
  })

  test('a document no resource file built is removed, and said', async () => {
    // Unlike a widget's stray script, nothing outside this directory names a
    // view — the plugin lists what the directory holds, so a leftover would be
    // offered to every agent as that model's screen with nothing to say so.
    resource('Order')
    mkdirSync(out(), { recursive: true })
    writeFileSync(join(out(), 'Ghost.html'), 'a resource file that was deleted')
    writeFileSync(join(out(), 'notes.txt'), 'not a view')
    const lines = []
    await buildViews({ root, outDir: out(), viteBuild: recorder(), log: m => lines.push(m) })
    expect(existsSync(join(out(), 'Ghost.html'))).toBe(false)
    expect(existsSync(join(out(), 'notes.txt'))).toBe(true)
    expect(lines.join('\n')).toMatch(/Ghost\.html/)
  })
})

// ─── a real build ─────────────────────────────────────────────────────────
//
// One fixture resource file with a markup half, through the same Mesa compiler
// an app builds with. The claims: one `.html` per resource file and nothing
// beside it; the runtime, the schema, the stylesheet and the component all
// INSIDE it; a `</script>` the component carries cannot end the element.

const SCHEMA = `
database main { path env("DATABASE_URL", "./app.db") }

model Note {
  id    Int    @id
  title String @length(1, 200)
  body  String?
}

model Tag {
  id    Int    @id
  label String @length(1, 40)
}
`

// No markup half: the generated form is this file's view. The literal is the
// probe's own trap — read with a regex, this file would have a markup half.
const TAG = `<script module>
  import { createResource } from '@frontierjs/sierra/resource'
  const closer = '</script>'
  export const tags = createResource('tags')
</script>
`

const NOTE = `<script module>
  import { createResource } from '@frontierjs/sierra/resource'
  export const notes = createResource('notes')
</script>

<script>
  // The one string a document cannot carry unescaped.
  const closer = '</script>'
  export let record = { title: 'a fixture note' }
</script>

<article class="card">
  <h1 id="title">{record.title}</h1>
  <p id="closer">{closer}</p>
</article>
`

describe('a real build', () => {
  const TMP = join(__dirname, 'tmp-mcp-build')
  const OUT = join(TMP, 'api-dist-mcp')
  let html = ''
  let tag  = ''
  let files = []
  let built = []

  beforeAll(async () => {
    const { build } = await import('vite')

    mkdirSync(join(TMP, 'db'), { recursive: true })
    mkdirSync(join(TMP, 'src/resources'), { recursive: true })
    writeFileSync(join(TMP, 'db/schema.lite'), SCHEMA)
    writeFileSync(join(TMP, 'src/resources/Note.mesa'), NOTE)
    writeFileSync(join(TMP, 'src/resources/Tag.mesa'), TAG)

    // The stylesheet resolves from the APP's node_modules, as it does in
    // example/web; this package does not depend on it, so the fixture links it.
    mkdirSync(join(TMP, 'node_modules/@frontierjs'), { recursive: true })
    try { symlinkSync(resolve(__dirname, '../../css'), join(TMP, 'node_modules/@frontierjs/css'), 'dir') } catch {}
    try { symlinkSync(resolve(__dirname, '../../litestone'), join(TMP, 'node_modules/@frontierjs/litestone'), 'dir') } catch {}
    // The generated form imports the kit from the app, as the boot does the stylesheet.
    try { symlinkSync(resolve(__dirname, '../../ui'), join(TMP, 'node_modules/@frontierjs/ui'), 'dir') } catch {}

    // Through `sierra mcp`'s own wiring: the schema is FOUND at db/schema.lite
    // and the `<html>` class is read off `theme.default`, as the SPA's would be.
    built = await buildViewsFor({
      vite:  { root: TMP },
      theme: { themes: ['theme-default', 'theme-dark'], default: 'theme-dark', key: 'fixture_theme' },
    }, { outDir: OUT, viteBuild: build, minify: false })

    files = readdirSync(OUT).sort()
    html  = readFileSync(join(OUT, 'Note.html'), 'utf8')
    tag   = readFileSync(join(OUT, 'Tag.html'), 'utf8')
  }, 90_000)

  afterAll(async () => { await rm(TMP, { recursive: true, force: true }) })

  test('one document per resource file, and nothing beside it', () => {
    expect(files).toEqual(['Note.html', 'Tag.html'])
    expect(built.map(b => [b.name, b.generated])).toEqual([['Note', false], ['Tag', true]])
  })

  test('a file with no markup half is the generated form, in one document like any other', () => {
    expect(tag.startsWith('<!doctype html>')).toBe(true)
    expect(tag.match(/<script>[\s\S]*?<\/script>/g)).toHaveLength(1)
    // The kit's form and its submit are in the bundle; the Resource is read off
    // the file's exports at runtime, not named by the build.
    expect(tag).toContain('resourceIn(')
    expect(tag).toContain('Save')
    expect(tag).toContain('createResource')
    expect(tag).toContain('"Tag"')
    expect(tag).toMatch(/novalidate/)
    // The markup-half file did not get one.
    expect(html).not.toContain('resourceIn(')
  })

  test('the runtime, the schema, the stylesheet and the component are inside it', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('class="theme-dark"')
    // The stylesheet: a token @frontierjs/css defines, and the page surface.
    expect(html).toMatch(/<style>[\s\S]*--ink[\s\S]*<\/style>/)
    expect(html).toMatch(/<style>[\s\S]*\.app\s*\{[\s\S]*<\/style>/)
    // The schema the boot registers, and the resource over it.
    expect(html).toContain('registerSchemas(')
    expect(html).toContain('"Note"')
    expect(html).toContain('createResource')
    // The component's own markup and the runtime it needs.
    expect(html).toContain('a fixture note')
    expect(html).toContain('mountView(Note, { name: "Note" })')
  })

  test('the switch is booted with the app\'s pair, persist off whatever the app said', () => {
    // Rollup reprints the literal, so the shape is matched and not the spelling.
    expect(html).toMatch(/initTheme\(\{\s*"themes":\s*\["theme-default",\s*"theme-dark"\],\s*"default":\s*"theme-dark",\s*"key":\s*"fixture_theme",\s*"persist":\s*false\s*\}\)/)
    expect(html).not.toContain('localStorage.getItem("fixture_theme")')
    // `applyHostContext` is NOT in the document yet: nothing calls it until the
    // handshake (plan step 3.3) and the bundler drops it. Asserting it here
    // would pass only by a dead reference; the unit tests above are its proof.
    expect(html).not.toMatch(/function applyHostContext\(/)
  })

  test('the component\'s </script> did not end the element', () => {
    const scripts = html.match(/<script>[\s\S]*?<\/script>/g)
    expect(scripts).toHaveLength(1)
    expect(html).toContain('<\\/script>')
  })
})

describe('sierra mcp', () => {
  const CLI = resolve(__dirname, '../src/tools/cli.js')
  const run = (...args) => spawnSync(process.execPath, [CLI, 'mcp', ...args], { encoding: 'utf8' })

  // The output belongs to the API surface; a default or a relative path would
  // be resolved from wherever this ran, which is web/ (`FJS-D955`).
  test('refuses without --out, naming the command that supplies it', () => {
    const r = run()
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('--out <absolute dir>')
    expect(r.stderr).toContain('fli mcp:build')
  })

  test('refuses a relative --out by name', () => {
    const r = run('--out', 'api/dist/mcp')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("must be absolute, got 'api/dist/mcp'")
  })
})

describe('clientSchemas', () => {
  // The reason a schema produced nothing reaches the page as well as the log,
  // so the boot of a view can say why every generated form is empty.
  test('a null answer keeps what was said as the failure', async () => {
    const said = []
    const dir  = tmpDir('mcp-client-schemas')
    const { generated, failure } = await clientSchemas(join(dir, 'schema.lite'), m => said.push(m), dir)
    expect(generated).toBeNull()
    expect(said.length).toBeGreaterThan(0)
    expect(failure).toBe(said.join('\n'))
  })
})
