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
import { readFileSync, existsSync } from 'fs'
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

// ── every component is rendered by something ─────────────────────────────────
//
// `Header` and `Link` were in neither this file nor the `WelcomeEmail`
// template: nothing in the repo had ever rendered them, so they worked by luck
// rather than by evidence. Four more — `Heading`, `Text`, `Review`, `TwoCol` —
// were reached only through the whole-document template render, which asserts
// the document and not the component, so a break in one showed up as a byte
// count nobody checked.
//
// The list is derived from the directory rather than written out, because a
// hand-kept list is what let two components fall out of it.

import { readdirSync } from 'fs'
import { refuseChildren, resetSlotGuard } from './components/slot-guard.js'

const ALL = readdirSync(COMPONENTS).filter((f) => f.endsWith('.mesa')).map((f) => f.replace('.mesa', ''))

// The props each needs to render anything at all. A component absent from here
// takes none, which is itself an assertion — add the entry when you add a prop
// that is required.
const PROPS = {
  Button:  'href="https://x" text="Go"',
  Image:   'src="https://x/i.png" alt="a photo"',
  Link:    'href="https://x"',
  Address: 'line1="1 St" city="Town"',
  Avatar:  'name="Ada"',
  Stars:   'rating={4}',
  Heading: 'text="Hi"',
  KeyValue: 'label="Kay" value="Vee"',
  Contact: 'name="Ada" email="a@b.c"',
  Footer:  'unsubscribeUrl="https://x"',
}

const renderOne = (name) => renderEmail(
  `<script>import ${name} from './${name}.mesa'</script>` +
  `<${name} ${PROPS[name] ?? ''}>SLOTMARK</${name}>`)

describe('every component in the directory renders', () => {
  it('the list is the directory, and it is not empty', () => {
    expect(ALL.length).toBeGreaterThanOrEqual(20)
    expect(ALL).toContain('Header')
    expect(ALL).toContain('Link')
  })

  for (const name of readdirSync(COMPONENTS).filter((f) => f.endsWith('.mesa')).map((f) => f.replace('.mesa', ''))) {
    it(`${name} renders markup`, async () => {
      const r = await renderOne(name)
      expect(r.html).toContain('<!DOCTYPE html>')
      const body = r.html.slice(r.html.indexOf('<body'))
      expect(body).toMatch(/<(table|td|tr|a|img|p|div|h[1-6]|span)\b/i)
    })
  }
})

// ── a component that cannot take children says so ────────────────────────────
//
// Mesa drops children handed to a component with no matching <slot>, silently.
// Fourteen of these take children and eight cannot, so a caller has no way to
// tell which kind they are holding — and getting it wrong renders an empty
// button, not an error.
//
// Every refusal is PAIRED with a component that legitimately keeps its
// children, because a guard that warned on everything would satisfy any test
// that only asked about the refusal.

const CANNOT = ['Address', 'Avatar', 'Button', 'Contact', 'Divider', 'Image', 'Spacer', 'Stars', 'TwoCol']
const CAN    = ['Section', 'Row', 'Column', 'Card', 'Header', 'Footer', 'Text', 'Heading', 'Link']

describe('children handed to a component that cannot render them', () => {
  const warnings = async (name) => {
    resetSlotGuard()
    const seen = []
    const real = console.warn
    console.warn = (...a) => seen.push(a.join(' '))
    try { await renderOne(name) } finally { console.warn = real }
    return seen.filter((w) => w.includes('[email-kit]'))
  }

  for (const name of CANNOT) {
    it(`${name} names itself and what to write instead`, async () => {
      const w = await warnings(name)
      expect(w.length).toBe(1)
      expect(w[0]).toContain(`<${name}>`)
      expect(w[0]).toMatch(/`|slot=/)          // it names a prop or a named slot
    })
  }

  for (const name of CAN) {
    it(`${name} keeps its children and says nothing`, async () => {
      resetSlotGuard()
      const seen = []
      const real = console.warn
      console.warn = (...a) => seen.push(a.join(' '))
      let r
      try { r = await renderOne(name) } finally { console.warn = real }
      expect(seen.filter((x) => x.includes('[email-kit]'))).toEqual([])
      expect(r.html).toContain('SLOTMARK')
    })
  }

  it('warns once per component, not once per render', async () => {
    resetSlotGuard()
    const seen = []
    const real = console.warn
    console.warn = (...a) => seen.push(a.join(' '))
    try {
      await renderOne('Divider')
      await renderOne('Divider')
    } finally { console.warn = real }
    expect(seen.filter((w) => w.includes('[email-kit]')).length).toBe(1)
  })

  // The guard reads $.slots, which is what a slotless child is given. If Mesa
  // ever stops handing it over, every refusal above goes quiet and passes.
  it('a slotless child can see that it was given children at all', async () => {
    const slots = { default: () => {} }
    const seen = []
    const real = console.warn
    console.warn = (...a) => seen.push(a.join(' '))
    resetSlotGuard()
    try { refuseChildren('Probe', slots, 'Pass `x`.') } finally { console.warn = real }
    expect(seen[0]).toContain('<Probe>')
  })
})

// ─── the advice names a prop that exists ─────────────────────────────────
//
// A guard's whole value is the sentence it prints. Three of the nine named a
// prop the component does not declare — `region`/`postcode` on Address, which
// takes `state`/`zip`; `rating` on Stars, which takes `count`; `src` on Avatar,
// which draws a letter and has no image at all. Advice that fails when taken is
// worse than none, and nothing could see it: the warning is a string, so every
// test above passed on all three.

describe('every guard names props the component declares', () => {
  const sources = Object.fromEntries(
    readdirSync(COMPONENTS)
      .filter((f) => f.endsWith('.mesa'))
      .map((f) => [f.replace('.mesa', ''), readFileSync(path.join(COMPONENTS, f), 'utf8')]),
  )

  const guarded = Object.entries(sources).filter(([, src]) => src.includes('refuseChildren('))

  it('finds the guards', () => {
    expect(guarded.length).toBe(CANNOT.length)
  })

  for (const [name, src] of guarded) {
    it(`${name}`, () => {
      const line   = src.split('\n').find((l) => l.includes('refuseChildren('))
      const advice = line.slice(line.indexOf('$.slots,') + 8)
      const props  = new Set([...src.matchAll(/export let (\w+)/g)].map((m) => m[1]))
      // Only bare identifiers. TwoCol's backticks hold `<div slot="left">`,
      // which is markup and not a prop.
      const named = [...advice.matchAll(/`([A-Za-z][A-Za-z0-9]*)`/g)].map((m) => m[1])
      for (const n of named) expect(props, `${name} advice names \`${n}\``).toContain(n)
    })
  }
})

// ─── values a caller supplies reach the document intact ──────────────────

describe('the Outlook fallback escapes what it carries (FJS-928)', () => {
  // The VML is built as a STRING and spliced in after render, so nothing
  // downstream escapes it. The anchor beside it always escaped correctly,
  // which is what hid this: one half of one component was safe.
  const hostile = {
    href: 'https://x.test/?a="onmouseover="alert(1)',
    text: 'Pay <![endif]--><img src=x onerror=alert(1)> now',
  }
  // The props are DECLARED in the wrapper: a bare `{href}` in a template that
  // never exported it is a ReferenceError at render, not a value from `data`.
  const src = `<script>
import Button from './Button.mesa'
export let href = ''
export let text = ''
</script>
<Button href={href} text={text} />`

  const render = async () => {
    const { renderEmail } = await import('./render.js')
    return renderEmail(src, { data: hostile, cwd: COMPONENTS })
  }

  it('a text that closes the conditional comment does not become live markup', async () => {
    const { html } = await render()
    // The `img` must not exist as an element anywhere in the document.
    expect(html).not.toMatch(/<img\s/)
    expect(html).toContain('&lt;![endif]--&gt;')
  })

  it('a hostile label adds no comment markers of its own', async () => {
    // Counted against the SAME button carrying a benign label rather than
    // against a literal: the email wrapper emits an `<!--[if mso]>` block of
    // its own in <head>, so any fixed number here would be a claim about the
    // wrapper and not about the payload.
    const { renderEmail } = await import('./render.js')
    const benign = await renderEmail(src, {
      data: { href: 'https://x.test/go', text: 'View your order' },
      cwd: COMPONENTS,
    })
    const { html } = await render()
    const count = (h, re) => h.match(re)?.length ?? 0
    expect(count(html, /<!--\[if mso\]>/g)).toBe(count(benign.html, /<!--\[if mso\]>/g))
    expect(count(html, /<!\[endif\]-->/g)).toBe(count(benign.html, /<!\[endif\]-->/g))
  })

  it('a quote in href does not break out of the VML attribute', async () => {
    const { html } = await render()
    const vml = html.slice(html.indexOf('<v:roundrect'), html.indexOf('</v:roundrect>'))
    expect(vml).toContain('&quot;onmouseover=&quot;')
    expect(vml).not.toContain('onmouseover="alert')
  })

  it('an ordinary label still renders as itself', async () => {
    const { renderEmail } = await import('./render.js')
    const { html } = await renderEmail(src, {
      data: { href: 'https://x.test/go', text: 'View your order' },
      cwd: COMPONENTS,
    })
    // The negative controls above pass against a component that escaped
    // everything into nonsense, so the legitimate case is asserted beside them.
    expect(html).toContain('>View your order</center>')
    expect(html).toContain('href="https://x.test/go"')
  })
})

describe('a name that is only whitespace (FJS-929)', () => {
  const avatar = (name) =>
    renderEmail(`<script>
import Avatar from './Avatar.mesa'
export let name = ''
</script>
<Avatar name={name} />`, { name })

  it('renders the placeholder instead of throwing', async () => {
    const { html } = await avatar('   ')
    expect(html).toContain('>?</text>')
  })

  it('an empty name is the same answer', async () => {
    expect((await avatar('')).html).toContain('>?</text>')
  })

  it('a real name still gives its initial', async () => {
    expect((await avatar('  alice  ')).html).toContain('>A</text>')
  })
})

describe('an unset optional attribute is omitted, not stringified (FJS-931)', () => {
  it('Image writes no width or height when none was given', async () => {
    const { html } = await renderEmail(
      `<script>import Image from './Image.mesa'</script>\n<Image src="/a.png" alt="a" />`)
    expect(html).not.toContain('undefined')
    expect(html).toMatch(/<img[^>]*src="\/a\.png"/)
  })

  it('Image keeps a width it was given', async () => {
    const { html } = await renderEmail(
      `<script>import Image from './Image.mesa'</script>\n<Image src="/a.png" alt="a" width={600} />`)
    expect(html).toContain('width="600"')
  })

  it('Column writes no colspan when none was given', async () => {
    const { html } = await renderEmail(
      `<script>import Column from './Column.mesa'</script>\n<Column>x</Column>`)
    expect(html).not.toContain('undefined')
  })
})

describe('Section padding survives a DOM (FJS-930)', () => {
  // Asserted through a real parse rather than against the string. The stray
  // rows were IN the rendered output for the life of the package — a `<tr>`
  // with no table ancestor is discarded by the parser, not by the renderer,
  // so a substring check agrees with the broken version.
  const section = (attr) => renderEmail(
    `<script>\nimport Section from './Section.mesa'\n</script>\n` +
    `<Section ${attr}><tr><td>BODY</td></tr></Section>`)

  const parsed = (html) => {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    return doc
  }

  it('the spacer rows are still there after a parse', async () => {
    const { html } = await section('padding={24}')
    const doc = parsed(html)
    const rows = [...doc.querySelectorAll('tr')]
    expect(rows.length).toBe(3)                       // spacer, body, spacer
    expect(rows[0].textContent.trim()).not.toBe('BODY')
    expect(rows[1].textContent.trim()).toBe('BODY')
    expect(doc.querySelectorAll('td[style*="height:24px"]').length).toBe(2)
  })

  it('no padding means no spacer rows', async () => {
    const doc = parsed((await section('')).html)
    expect(doc.querySelectorAll('tr').length).toBe(1)
  })

  it('a section bgcolor runs through the padding', async () => {
    const { html } = await section('padding={24} bgcolor="#f9f9f9"')
    const table = parsed(html).querySelector('table[role="presentation"]')
    expect(table.getAttribute('style')).toContain('background-color:#f9f9f9')
    expect(table.querySelectorAll('tr').length).toBe(3)
  })
})

describe('the exported component map matches the directory (FJS-933)', () => {
  // Kept as a literal in index.js rather than derived, so a bundler never has
  // to see a readdirSync — but a list of the components, written by hand beside
  // the components, is the shape that let `Header` and `Link` be rendered by
  // nothing in this repo for the life of the package.
  it('names every .mesa file and nothing else', async () => {
    const { components } = await import('./index.js')
    const onDisk = readdirSync(COMPONENTS)
      .filter((f) => f.endsWith('.mesa'))
      .map((f) => f.replace('.mesa', ''))
      .sort()
    expect(Object.keys(components).sort()).toEqual(onDisk)
  })

  it('every path it exports exists', async () => {
    const { components } = await import('./index.js')
    for (const [name, p] of Object.entries(components)) {
      expect(existsSync(p), `${name} → ${p}`).toBe(true)
    }
  })
})
