/**
 * email-kit.test.js
 *
 * Run from the email-kit package root:
 *   npx vitest run
 *
 * Requires @frontierjs/mesa to be installed (peer dep).
 * In the monorepo, run from the workspace root where both packages are present.
 */

import { describe, it, expect } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname  = path.dirname(fileURLToPath(import.meta.url))
const COMPONENTS = path.join(__dirname, 'components')
const TEMPLATES  = path.join(__dirname, 'templates')

// Resolve mesa render-component relative to mesa package
// In real usage this comes from @frontierjs/mesa/render-component.js
async function getRender() {
  // Try peer dep first, fall back to sibling package in monorepo layout
  for (const candidate of [
    '@frontierjs/mesa/render-component.js',
    '../mesa/render-component.js',
  ]) {
    try {
      const mod = await import(candidate)
      return { renderComponent: mod.renderComponent, renderFile: mod.renderFile }
    } catch { continue }
  }
  throw new Error('Cannot resolve @frontierjs/mesa — install it as a peer dependency')
}

const render = await getRender()

// The kit's own renderer, not mesa's — it is what expands the MSO placeholders.
const { renderEmailFile: renderKit } = await import('./render.js')

const renderEmail     = (source, data = {}) =>
  render.renderComponent(source, { cwd: COMPONENTS, target: 'email', data })

const renderEmailFile = (file, data = {}) =>
  render.renderFile(path.join(COMPONENTS, file), { cwd: COMPONENTS, target: 'email', data })

// ── render.js API ─────────────────────────────────────────────────────────────

describe('@frontierjs/email-kit render API', () => {
  it('renderEmail renders from source string', async () => {
    const { renderEmail: re } = await import('./render.js')
    const result = await re(
      `<script>import Section from './Section.mesa'
import Row from './Row.mesa'
import Column from './Column.mesa'
export let name = ''</script>
<Section><Row><Column><p>Hello {name}</p></Column></Row></Section>`,
      { data: { name: 'World' }, cwd: COMPONENTS }
    )
    expect(result.html).toContain('<!DOCTYPE html>')
    expect(result.html).toContain('Hello World')
    expect(result.text).toContain('Hello World')
  })

  it('renderEmailFile renders from disk', async () => {
    const { renderEmailFile: ref } = await import('./render.js')
    const result = await ref(path.join(TEMPLATES, 'WelcomeEmail.mesa'), {
      cwd: COMPONENTS,
      data: { firstName: 'Alice', planName: 'Pro', amount: '$49', nextBilling: 'May 1', dashboardUrl: 'http://x', reviewerName: 'Sarah' }
    })
    expect(result.html).toContain('<!DOCTYPE html>')
    expect(result.html).toContain('Alice')
    expect(result.subject).toBe('Welcome to the platform!')
  })
})

// ── WelcomeEmail template ─────────────────────────────────────────────────────

describe('WelcomeEmail template', () => {
  let result

  it('renders without error', async () => {
    result = await render.renderFile(path.join(TEMPLATES, 'WelcomeEmail.mesa'), {
      cwd: COMPONENTS,
      target: 'email',
      data: { firstName: 'Alice', planName: 'Pro', amount: '$49.00',
              nextBilling: 'May 1, 2025', dashboardUrl: 'https://app.example.com',
              reviewerName: 'Sarah K.' }
    })
    expect(result).toBeDefined()
    expect(result.html.length).toBeGreaterThan(3000)
  })

  it('produces a full HTML document', () => {
    expect(result.html).toContain('<!DOCTYPE html>')
    expect(result.html).toContain('xmlns:v=')
    expect(result.html).toContain('[if mso]')
  })

  it('extracts subject from <script module>', () => {
    expect(result.subject).toBe('Welcome to the platform!')
  })

  it('@media in head only', () => {
    const head = result.html.match(/<head[\s\S]*?<\/head>/)?.[0] ?? ''
    const body = result.html.replace(/<head[\s\S]*?<\/head>/, '')
    expect(head).toContain('@media')
    expect(body).not.toContain('@media')
  })

  it('CSS inlined into style attributes, no bare style in body', () => {
    expect(result.html).toContain('style=')
    const body = result.html.replace(/<head[\s\S]*?<\/head>/, '')
    expect(body).not.toContain('<style>')
  })

  it('renders prop data', () => {
    expect(result.html).toContain('Alice')
    expect(result.html).toContain('Pro')
    expect(result.html).toContain('$49.00')
  })

  it('renders SVG stars and review', () => {
    expect(result.html).toContain('<svg')
    expect(result.html).toContain('Sarah K')
  })

  it('renders footer', () => {
    expect(result.html).toContain('Unsubscribe')
  })

  it('produces plain-text fallback', () => {
    expect(result.text?.length).toBeGreaterThan(50)
  })
})

// ── Individual components ─────────────────────────────────────────────────────

describe('Email components', () => {
  it('Button: VML + anchor', async () => {
    // Through the KIT renderer, not mesa's renderComponent — the VML lives in
    // a placeholder attribute until expandMsoPlaceholders() splices it back,
    // which is what keeps it out of the DOM that would mangle it.
    const r = await renderKit('components/Button.mesa', {
      cwd: __dirname,
      data: { href: 'https://example.com', text: 'Click', bgcolor: '#9fc612' },
    })
    expect(r.html).toContain('https://example.com')
    expect(r.html).toContain('v:roundrect')
    expect(r.html).toContain('background-color:#9fc612')
  })

  it('Button: rendering through raw renderComponent leaves the placeholder', async () => {
    // Documenting the trade-off rather than hiding it. Bypassing the kit's
    // renderer drops the Outlook fallback — silently, which is why it is
    // pinned. Use renderEmail/renderEmailFile from '@frontierjs/email-kit/render'.
    const r = await renderEmailFile('Button.mesa', { href: 'https://example.com', text: 'Click' })
    expect(r.html).toContain('data-mso')
    expect(r.html).not.toContain('v:roundrect')
  })

  it('Stars: correct filled/empty count', async () => {
    const r = await renderEmailFile('Stars.mesa', { count: 4, total: 5, color: '#f59e0b', empty: '#ddd' })
    expect((r.html.match(/fill="#f59e0b"/g) ?? []).length).toBe(4)
    expect((r.html.match(/fill="#ddd"/g) ?? []).length).toBe(1)
  })

  it('Avatar: SVG with initial', async () => {
    const r = await renderEmailFile('Avatar.mesa', { name: 'Alice Johnson', bgcolor: '#9fc612' })
    expect(r.html).toContain('<svg')
    expect(r.html).toContain('>A<')
  })

  it('Card: heading and border', async () => {
    const r = await renderEmailFile('Card.mesa', { heading: 'Order Summary' })
    expect(r.html).toContain('Order Summary')
    expect(r.html).toContain('border:')
  })

  it('DataTable: columns and rows', async () => {
    const r = await renderEmailFile('DataTable.mesa', {
      columns: [{ key: 'name', label: 'Item' }, { key: 'price', label: 'Price', align: 'right' }],
      rows: [{ name: 'Lawn mowing', price: '$85.00' }]
    })
    expect(r.html).toContain('Lawn mowing')
    expect(r.html).toContain('$85.00')
    expect(r.html).toContain('Item')
  })

  it('Contact: hides empty fields', async () => {
    const r = await renderEmailFile('Contact.mesa', { name: 'Bob', email: '', phone: '', url: '' })
    expect(r.html).toContain('Bob')
    expect(r.html).not.toContain('mailto:')
  })

  it('Address: map link', async () => {
    const r = await renderEmailFile('Address.mesa', { line1: '123 Main St', city: 'Phoenix', state: 'AZ', zip: '85001' })
    expect(r.html).toContain('123 Main St')
    expect(r.html).toContain('maps.google.com')
  })

  it('Divider: no <hr>', async () => {
    const r = await renderEmailFile('Divider.mesa', { color: '#ccc' })
    expect(r.html).toContain('background-color:#ccc')
    expect(r.html).not.toContain('<hr')
  })

  it('Spacer: correct height, zero font-size', async () => {
    const r = await renderEmailFile('Spacer.mesa', { height: 32 })
    expect(r.html).toContain('32px')
    expect(r.html).toContain('font-size:0')
  })

  it('KeyValue: label, value, bold', async () => {
    const r = await renderEmailFile('KeyValue.mesa', { label: 'Status', value: 'Active', bold: true })
    expect(r.html).toContain('Status')
    expect(r.html).toContain('Active')
    expect(r.html).toContain('font-weight:700')
  })

  it('Footer: unsubscribe and privacy links', async () => {
    const r = await renderEmailFile('Footer.mesa', {
      company: 'ACME', unsubscribe: 'https://x.com/unsub', privacy: 'https://x.com/privacy'
    })
    expect(r.html).toContain('ACME')
    expect(r.html).toContain('Unsubscribe')
    expect(r.html).toContain('Privacy Policy')
  })

  it('Image: src, alt, width, fluid', async () => {
    const r = await renderEmailFile('Image.mesa', { src: 'https://x.com/img.jpg', alt: 'Hero', width: 600 })
    expect(r.html).toContain('https://x.com/img.jpg')
    expect(r.html).toContain('alt="Hero"')
    expect(r.html).toContain('width:600px')
  })

  it('Image: hides when display=false', async () => {
    const r = await renderEmailFile('Image.mesa', { src: 'https://x.com/img.jpg', display: false })
    expect(r.html).not.toContain('<img')
  })
})

// ── The Outlook fallback survives the DOM ─────────────────────────────────────
//
// A bulletproof button is two branches of one conditional comment: VML that
// only Outlook sees, and an <a> that only everything else sees. Both have to
// come out the other side of a render intact, and until 2026-08-03 neither
// did — happy-dom, which the static renderer runs in, ends a conditional
// comment early for several shapes of tag inside it, so `<!--[if mso]>`
// serialized as `<!--[if mso]-->`. The comment closed, and the VML after it
// became live markup on every client.
//
// The failure is silent: the HTML stays well-formed, so nothing complains —
// every recipient just sees the button twice.

describe('MSO conditional comments', () => {
  const button = () => renderKit('components/Button.mesa', {
    cwd: __dirname,
    data: { href: 'https://x.test/go', text: 'CLICK ME' },
  })

  it('the MSO conditional comment survives the DOM', async () => {
    const { html } = await button()
    expect(html).toContain('<!--[if mso]>')
    // `<!--[if mso]-->` is the mangled form: a closed comment, VML exposed.
    expect(html).not.toContain('<!--[if mso]-->')
  })

  it('keeps the VML element namespaced rather than split into an attribute', async () => {
    const { html } = await button()
    expect(html).toContain('<v:roundrect')
    expect(html).not.toContain('<v :roundrect')
    expect(html).not.toContain('<w :anchorlock')
  })

  it('keeps the downlevel-revealed branch, which is the real anchor', async () => {
    const { html } = await button()
    expect(html).toContain('<!--[if !mso]><!-->')
    expect(html).toContain('<!--<![endif]-->')
    expect(html).toContain('href="https://x.test/go"')
  })

  it('leaves no placeholder behind', async () => {
    const { html } = await button()
    expect(html).not.toContain('data-mso')
  })

  it('counts the CTA once in the plain-text part, not twice', async () => {
    // The VML branch carries the same label as the anchor. It is Outlook-only
    // markup and must not reach the text alternative at all.
    const { text } = await button()
    expect((text.match(/CLICK ME/g) ?? []).length).toBe(1)
    expect(text).not.toMatch(/roundrect|anchorlock/)
  })
})

// ── The plain-text alternative ────────────────────────────────────────────────

describe('plain-text alternative', () => {
  const welcome = () => renderKit('templates/WelcomeEmail.mesa', {
    cwd: __dirname,
    data: { firstName: 'Alice', planName: 'Pro', dashboardUrl: 'https://x.test/dash' },
  })

  it('decodes numeric character references instead of printing them', async () => {
    // Preheaders are padded with `&#847;`. A fixed six-entity decode list left
    // it in the text as the literal string "&#847;".
    const { text } = await welcome()
    expect(text).not.toMatch(/&#\d+;/)
    expect(text).not.toMatch(/&#x[0-9a-f]+;/i)
  })

  it('drops the hidden preheader', async () => {
    // Its whole job is to be invisible, and its sentence repeats the opening
    // line — so in plain text it is duplication plus zero-width padding.
    const { text, html } = await welcome()
    expect(html).toContain('display:none')   // still present for the inbox preview
    expect(text.split('\n')[0]).not.toMatch(/account is ready — here/)
  })

  it('keeps link URLs', async () => {
    const { text } = await welcome()
    expect(text).toContain('https://x.test/dash')
  })

  it('does not leak stylesheet text', async () => {
    const { text } = await welcome()
    expect(text).not.toContain('@media')
    expect(text).not.toContain('!important')
  })
})
