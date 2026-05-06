/**
 * render-component.test.js
 *
 * Run: npx vitest run render-component.test.js
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { writeFile, unlink, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { renderComponent, renderFile } from './render-component.js'
import { initRenderer } from './render.js'

// ── Test fixtures directory ───────────────────────────────────────────────────
const FIXTURES = path.join('/tmp', 'mesa-render-test-' + Date.now())

beforeAll(async () => {
  await mkdir(FIXTURES, { recursive: true })
  // copy package.json so @frontierjs/mesa resolves from the fixture dir
  // by symlinking node_modules — simplest: write fixtures into /tmp/mesa directly
})

afterAll(async () => {
  // Cleanup fixture files
  const files = ['Badge.mesa', 'Card.mesa', 'Email.mesa', 'Static.mesa', 'WithStore.mesa']
  for (const f of files) {
    try { await unlink(path.join('/tmp/mesa', f)) } catch {}
  }
})

// Write a fixture file into /tmp/mesa so @frontierjs/mesa resolves
async function fixture(name, content) {
  const p = path.join('/tmp/mesa', name)
  await writeFile(p, content)
  return p
}

// ── Basic rendering ───────────────────────────────────────────────────────────

describe('renderComponent — target: html', () => {
  it('renders a simple component with props', async () => {
    const result = await renderComponent(
      `<script>export let name = 'World'</script><h1>Hello {name}</h1>`,
      { data: { name: 'Mesa' }, cwd: '/tmp/mesa', target: 'html' }
    )
    expect(result.html).toContain('Hello Mesa')
    expect(result.html).toContain('<h1>')
  })

  it('renders conditional block', async () => {
    const result = await renderComponent(
      `<script>export let show = false</script>{#if show}<p>visible</p>{/if}`,
      { data: { show: true }, cwd: '/tmp/mesa', target: 'html' }
    )
    expect(result.html).toContain('visible')
  })

  it('renders each block', async () => {
    const result = await renderComponent(
      `<script>export let items = []</script><ul>{#each items as item}<li>{item}</li>{/each}</ul>`,
      { data: { items: ['a', 'b', 'c'] }, cwd: '/tmp/mesa', target: 'html' }
    )
    expect(result.html).toContain('<li>a</li>')
    expect(result.html).toContain('<li>b</li>')
    expect(result.html).toContain('<li>c</li>')
  })

  it('returns css from <style> block', async () => {
    const result = await renderComponent(
      `<p class="x">text</p><style>.x { color: red; }</style>`,
      { cwd: '/tmp/mesa', target: 'html' }
    )
    expect(result.css).toContain('color')
    expect(result.html).toContain('<style>')
  })

  it('result.exports contains named exports', async () => {
    const result = await renderComponent(
      `<script module>export const title = 'My Page'</script><p>hi</p>`,
      { cwd: '/tmp/mesa', target: 'html' }
    )
    expect(result.exports.title).toBe('My Page')
  })

  it('result.subject is extracted from export const subject', async () => {
    const result = await renderComponent(
      `<script module>export const subject = 'Welcome, Alice!'</script><script>export let name = ''</script><p>hi</p>`,
      { data: { name: 'Alice' }, cwd: '/tmp/mesa', target: 'html' }
    )
    expect(result.subject).toBe('Welcome, Alice!')
  })
})

// ── Import resolution ─────────────────────────────────────────────────────────

describe('renderComponent — import resolution', () => {
  it('resolves and renders a child component', async () => {
    await fixture('Badge.mesa', `<script>export let label = 'OK'</script><span class="badge">{label}</span>`)

    const result = await renderComponent(
      `<script>import Badge from './Badge.mesa'</script><Badge label="works" />`,
      { cwd: '/tmp/mesa', target: 'html' }
    )
    expect(result.html).toContain('works')
    expect(result.html).toContain('badge')
  })

  it('resolves a two-level deep import chain', async () => {
    await fixture('Badge.mesa', `<script>export let label = 'OK'</script><span class="badge">{label}</span>`)
    await fixture('Card.mesa',  `<script>import Badge from './Badge.mesa'\nexport let heading = ''</script><div class="card"><h2>{heading}</h2><Badge label="inner" /></div>`)

    const result = await renderComponent(
      `<script>import Card from './Card.mesa'</script><Card heading="Test" />`,
      { cwd: '/tmp/mesa', target: 'html' }
    )
    expect(result.html).toContain('Test')
    expect(result.html).toContain('inner')
    expect(result.html).toContain('card')
  })

  it('collects CSS from all files in the tree', async () => {
    await fixture('Badge.mesa', `<span class="badge">ok</span><style>.badge { background: teal; }</style>`)

    const result = await renderComponent(
      `<script>import Badge from './Badge.mesa'</script><div class="wrap"><Badge /></div><style>.wrap { padding: 16px; }</style>`,
      { cwd: '/tmp/mesa', target: 'html' }
    )
    expect(result.css).toContain('background')
    expect(result.css).toContain('padding')
  })
})

// ── Email target ──────────────────────────────────────────────────────────────

describe('renderComponent — target: email', () => {
  it('inlines CSS into style attributes', async () => {
    const result = await renderComponent(
      `<p class="greeting">Hello</p><style>.greeting { color: #ee380d; font-size: 16px; }</style>`,
      { cwd: '/tmp/mesa', target: 'email' }
    )
    expect(result.html).toContain('color:#ee380d')
    expect(result.html).toContain('font-size:16px')
    expect(result.html).not.toContain('<style>')
  })

  it('resolves CSS variables before inlining', async () => {
    const result = await renderComponent(
      `<p class="btn">Click</p><style>:root{--brand:#ee380d} .btn{background:var(--brand)}</style>`,
      { cwd: '/tmp/mesa', target: 'email' }
    )
    expect(result.html).toContain('background:#ee380d')
  })

  it('produces a plain text fallback in result.text', async () => {
    const result = await renderComponent(
      `<h1>Welcome Alice</h1><p>Your order is confirmed.</p>`,
      { data: {}, cwd: '/tmp/mesa', target: 'email' }
    )
    expect(result.text).toBeDefined()
    expect(result.text).toContain('Welcome Alice')
    expect(result.text).toContain('Your order is confirmed')
  })

  it('extracts subject line from export const subject', async () => {
    const result = await renderComponent(
      `<script module>export const subject = 'Hi Alice!'</script><script>export let firstName = ''</script><p>body</p>`,
      { data: { firstName: 'Alice' }, cwd: '/tmp/mesa', target: 'email' }
    )
    expect(result.subject).toBe('Hi Alice!')
  })

  it('preserves @media in a <style> block by default', async () => {
    const result = await renderComponent(
      `<p class="x">text</p><style>@media(max-width:600px){.x{display:none}} .x{color:red}</style>`,
      { cwd: '/tmp/mesa', target: 'email' }
    )
    expect(result.html).toContain('@media')
    expect(result.html).toContain('color:red')
  })

  it('drops @media when preserveMediaQueries:false', async () => {
    const result = await renderComponent(
      `<p class="x">text</p><style>@media(max-width:600px){.x{display:none}} .x{color:red}</style>`,
      { cwd: '/tmp/mesa', target: 'email', preserveMediaQueries: false }
    )
    expect(result.html).not.toContain('@media')
    expect(result.html).toContain('color:red')
  })

  it('inlines CSS from child components too', async () => {
    await fixture('Badge.mesa', `<span class="badge">ok</span><style>.badge { padding: 4px 8px; }</style>`)

    const result = await renderComponent(
      `<script>import Badge from './Badge.mesa'</script><div><Badge /></div>`,
      { cwd: '/tmp/mesa', target: 'email' }
    )
    expect(result.html).toContain('padding:4px 8px')
  })
})

// ── Fragment target ───────────────────────────────────────────────────────────

describe('renderComponent — target: fragment', () => {
  it('returns inlined HTML without a wrapping document', async () => {
    const result = await renderComponent(
      `<p class="note">Hello</p><style>.note { font-size: 14px; }</style>`,
      { cwd: '/tmp/mesa', target: 'fragment' }
    )
    expect(result.html).toContain('font-size:14px')
    expect(result.html).not.toContain('<!DOCTYPE')
    expect(result.html).not.toContain('<html')
  })

  it('does not include result.text', async () => {
    const result = await renderComponent(
      `<p>text</p>`,
      { cwd: '/tmp/mesa', target: 'fragment' }
    )
    expect(result.text).toBeUndefined()
  })
})

// ── JS target ─────────────────────────────────────────────────────────────────

describe('renderComponent — target: js', () => {
  it('returns a module map with compiled JS', async () => {
    const result = await renderComponent(
      `<script>let count = 0</script><p>{count}</p>`,
      { filename: 'Counter.mesa', cwd: '/tmp/mesa', target: 'js' }
    )
    expect(result.modules).toBeInstanceOf(Map)
    expect(result.entry).toBe('Counter.mesa')
    const js = result.modules.get('Counter.mesa')
    expect(js).toBeDefined()
    expect(js).toContain('push_component')
  })

  it('includes child modules in the map', async () => {
    await fixture('Badge.mesa', `<span>badge</span>`)

    const result = await renderComponent(
      `<script>import Badge from './Badge.mesa'</script><div><Badge /></div>`,
      { filename: 'Parent.mesa', cwd: '/tmp/mesa', target: 'js' }
    )
    expect(result.modules.size).toBe(2)
    expect([...result.modules.keys()].some(k => k.includes('Badge'))).toBe(true)
  })

  it('collects CSS from the JS target too', async () => {
    const result = await renderComponent(
      `<p>text</p><style>p { margin: 0; }</style>`,
      { filename: 'Styled.mesa', cwd: '/tmp/mesa', target: 'js' }
    )
    expect(result.css).toContain('margin')
  })
})

// ── renderFile ────────────────────────────────────────────────────────────────

describe('renderFile', () => {
  it('renders a .mesa file from disk', async () => {
    const p = await fixture('Static.mesa', `<script>export let msg = 'hi'</script><p>{msg}</p>`)

    const result = await renderFile(p, { data: { msg: 'from file' }, target: 'html' })
    expect(result.html).toContain('from file')
  })
})

// ── htmlToText (via email target) ─────────────────────────────────────────────

describe('htmlToText — via email target', () => {
  it('converts headings and paragraphs', async () => {
    const result = await renderComponent(
      `<h1>Title</h1><p>Body text here.</p>`,
      { cwd: '/tmp/mesa', target: 'email' }
    )
    expect(result.text).toContain('Title')
    expect(result.text).toContain('Body text here')
  })

  it('preserves link URLs', async () => {
    const result = await renderComponent(
      `<a href="https://example.com">Click here</a>`,
      { cwd: '/tmp/mesa', target: 'email' }
    )
    expect(result.text).toContain('https://example.com')
    expect(result.text).toContain('Click here')
  })

  it('decodes HTML entities', async () => {
    const result = await renderComponent(
      `<p>AT&amp;T loves Mesa</p>`,
      { cwd: '/tmp/mesa', target: 'email' }
    )
    expect(result.text).toContain('AT&T loves Mesa')
  })
})
