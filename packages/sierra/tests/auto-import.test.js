/**
 * tests/auto-import.test.js — auto-import plugin and load() fixes
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

import { injectAutoImports, autoImportPlugin } from '../src/build/auto-import-plugin.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(__dirname, 'tmp-autoimport')

afterAll(async () => {
  await rm(TMP, { recursive: true, force: true })
})

// ─── injectAutoImports ────────────────────────────────────────────────────────

describe('injectAutoImports', () => {
  const map = new Map([
    ['Button', '/src/components/UI/Button.mesa'],
    ['Card',   '/src/components/UI/Card.mesa'],
    ['Modal',  '/src/components/UI/Modal.mesa'],
  ])

  test('injects import for component used in template', () => {
    const source = `<script>\n  let x = 1\n</script>\n<Button />`
    const result = injectAutoImports(source, map)
    expect(result).toContain("import Button from '/src/components/UI/Button.mesa'")
  })

  test('injects multiple imports when multiple components used', () => {
    const source = `<script></script>\n<Card>\n  <Button />\n</Card>`
    const result = injectAutoImports(source, map)
    expect(result).toContain("import Button from")
    expect(result).toContain("import Card from")
  })

  test('does not inject import for component already imported', () => {
    const source = `<script>\n  import Button from '../Button.mesa'\n</script>\n<Button />`
    const result = injectAutoImports(source, map)
    // Should not add a second Button import
    const matches = [...result.matchAll(/import Button/g)]
    expect(matches.length).toBe(1)
  })

  test('does not inject for components not in map', () => {
    const source = `<script></script>\n<UnknownComponent />`
    const result = injectAutoImports(source, map)
    expect(result).not.toContain('import UnknownComponent')
  })

  test('does not inject for lowercase tags', () => {
    const source = `<script></script>\n<div>\n  <span></span>\n</div>`
    const result = injectAutoImports(source, map)
    expect(result).toBe(source)
  })

  test('does not scan script blocks for component names', () => {
    // Button referenced only in script — not in template
    const source = `<script>\n  const x = Button\n</script>\n<div></div>`
    const result = injectAutoImports(source, map)
    expect(result).not.toContain('import Button')
  })

  test('injects inside existing script tag', () => {
    const source = `<script>\n  let count = 0\n</script>\n<Button />`
    const result = injectAutoImports(source, map)
    // Import should be inside the script block
    const scriptStart = result.indexOf('<script>')
    const scriptEnd = result.indexOf('</script>')
    const scriptContent = result.slice(scriptStart, scriptEnd)
    expect(scriptContent).toContain('import Button from')
  })

  test('prepends to source when no script tag', () => {
    const source = `<Button />`
    const result = injectAutoImports(source, map)
    expect(result.startsWith('import Button from')).toBe(true)
  })

  test('returns source unchanged when map is empty', () => {
    const source = `<Button />`
    expect(injectAutoImports(source, new Map())).toBe(source)
  })

  test('injects into instance script, not script module', () => {
    const source = [
      '<script module>',
      '  export { sidebar }',
      '</script>',
      '<script>',
      '  let count = 0',
      '</script>',
      '<Button />',
    ].join('\n')

    const result = injectAutoImports(source, map)

    // Import should be in the instance <script>, not <script module>
    const moduleEnd = result.indexOf('</script>')
    const moduleBlock = result.slice(0, moduleEnd)
    expect(moduleBlock).not.toContain('import Button from')

    // Should appear after the instance <script> opening tag
    const instanceStart = result.indexOf('<script>', result.indexOf('</script>'))
    const instanceBlock = result.slice(instanceStart)
    expect(instanceBlock).toContain('import Button from')
  })

  test('imports are sorted alphabetically', () => {
    const source = `<script></script>\n<Modal />\n<Button />\n<Card />`
    const result = injectAutoImports(source, map)
    const buttonIdx = result.indexOf('import Button')
    const cardIdx   = result.indexOf('import Card')
    const modalIdx  = result.indexOf('import Modal')
    expect(buttonIdx).toBeLessThan(cardIdx)
    expect(cardIdx).toBeLessThan(modalIdx)
  })
})

// ─── autoImportPlugin scan ────────────────────────────────────────────────────

describe('autoImportPlugin.scan', () => {
  let uiDir

  beforeAll(async () => {
    uiDir = join(TMP, 'components/UI')
    await mkdir(uiDir, { recursive: true })
    await writeFile(join(uiDir, 'Button.mesa'), '<button><slot /></button>', 'utf8')
    await writeFile(join(uiDir, 'Card.mesa'), '<div class="card"><slot /></div>', 'utf8')
    await writeFile(join(uiDir, 'helpers.js'), 'export const noop = () => {}', 'utf8')
    await writeFile(join(uiDir, 'utils.mesa'), '<!-- lowercase — not a component -->', 'utf8')
  })

  test('plugin is null when no autoImport config', () => {
    const plugin = autoImportPlugin({ target: 'spa' }, {})
    expect(plugin).toBeNull()
  })

  test('plugin is null when components array is empty', () => {
    const plugin = autoImportPlugin({ autoImport: { components: [] } }, {})
    expect(plugin).toBeNull()
  })

  test('plugin has correct name', () => {
    const plugin = autoImportPlugin(
      { autoImport: { components: ['components/UI'] } },
      {}
    )
    expect(plugin?.name).toBe('sierra:auto-import')
  })

  test('buildStart populates sierraContext.autoImportMap', async () => {
    const ctx = { autoImportMap: new Map() }
    const plugin = autoImportPlugin(
      { autoImport: { components: ['components/UI'] } },
      ctx
    )

    // Simulate configResolved
    plugin.configResolved({ root: TMP, command: 'build' })

    // Simulate buildStart (needs this binding with warn)
    await plugin.buildStart.call({ warn: () => {} })

    expect(ctx.autoImportMap.has('Button')).toBe(true)
    expect(ctx.autoImportMap.has('Card')).toBe(true)
  })

  test('excludes lowercase files and non-mesa files', async () => {
    const ctx = { autoImportMap: new Map() }
    const plugin = autoImportPlugin(
      { autoImport: { components: ['components/UI'] } },
      ctx
    )
    plugin.configResolved({ root: TMP, command: 'build' })
    await plugin.buildStart.call({ warn: () => {} })

    expect(ctx.autoImportMap.has('helpers')).toBe(false)
    expect(ctx.autoImportMap.has('utils')).toBe(false)
  })

  test('throws on naming conflict between two dirs', async () => {
    const dir2 = join(TMP, 'components/Other')
    await mkdir(dir2, { recursive: true })
    await writeFile(join(dir2, 'Button.mesa'), '<button />', 'utf8')

    const ctx = { autoImportMap: new Map() }
    const plugin = autoImportPlugin(
      { autoImport: { components: ['components/UI', 'components/Other'] } },
      ctx
    )
    plugin.configResolved({ root: TMP, command: 'build' })

    await expect(
      plugin.buildStart.call({ warn: () => {} })
    ).rejects.toThrow(/naming conflict.*Button/)
  })
})

// ─── load() gets meta ────────────────────────────────────────────────────────

describe('load() receives meta', () => {
  test('fixture meta.js signature accepts meta argument', async () => {
    // Verify our fixture accepts it without error
    const { load } = await import('./fixtures/basic-spa/src/routes/leads/[leadId].meta.js')
    // load() should accept { params, url, meta, fetch } without throwing
    const result = await load({
      params: { leadId: '1' },
      url: '/leads/1/',
      meta: { title: 'Lead Detail', dynamic: true },
      fetch: globalThis.fetch ?? (() => {}),
    })
    expect(result.lead.id).toBe('1')
  })
})

// ─── createSierraViteConfig includes auto-import plugin ───────────────────────

describe('createSierraViteConfig with autoImport', () => {
  test('includes sierra:auto-import when autoImport configured', async () => {
    const { createSierraViteConfig } = await import('../src/build/index.js')
    const cfg = createSierraViteConfig({
      target: 'spa',
      autoImport: { components: ['src/components/UI'] },
    })
    const names = cfg.plugins.map(p => p?.name).filter(Boolean)
    expect(names).toContain('sierra:auto-import')
  })

  test('does not include sierra:auto-import when not configured', async () => {
    const { createSierraViteConfig } = await import('../src/build/index.js')
    const cfg = createSierraViteConfig({ target: 'spa' })
    const names = cfg.plugins.map(p => p?.name).filter(Boolean)
    expect(names).not.toContain('sierra:auto-import')
  })
})
