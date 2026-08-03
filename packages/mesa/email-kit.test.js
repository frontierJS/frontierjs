/**
 * email-kit.test.js — integration tests for the Mesa email component kit
 *
 * ── SKIPPED: the components under test are not in this repo ────────────────
 *
 * These suites render 14 `.mesa` files (WelcomeEmail, Button, Stars, Avatar,
 * Card, DataTable, Contact, Address, …) that ship with `@frontierjs/mesa-email`.
 * That package is not part of this workspace — there is no `mesa-email/`
 * directory and nothing in node_modules — and EMAIL_DIR points at an absolute
 * `/tmp` path that no checkout can reproduce. Every assertion here failed with
 * ENOENT, which is a missing-fixture problem, not a rendering bug.
 *
 * What IS covered and green, in this repo:
 *   • the email render target  — render-component.js, `target: 'email'`
 *   • CSS inlining for email   — css-inliner.test.js, 36/36
 *
 * To re-enable: vendor the kit into this package (e.g. `email/`), point
 * EMAIL_DIR at it instead of /tmp, and drop the two `.skip`s below. Do not
 * hand-write stand-in components to make these pass — the assertions check
 * MSO/VML namespaces, bulletproof VML buttons and exact SVG star counts, so
 * invented fixtures would only be asserting themselves.
 *
 * Run: npx vitest run email-kit.test.js
 */

import { describe, it, expect } from 'vitest'
import { renderFile, renderComponent } from './render-component.js'
import path from 'path'

// Absolute /tmp path — part of why this cannot run here. Repoint when vendoring.
const EMAIL_DIR = path.join('/tmp/mesa/email')

// ── WelcomeEmail end-to-end ───────────────────────────────────────────────────

describe.skip('WelcomeEmail template', () => {
  let result

  it('renders without error', async () => {
    result = await renderFile(path.join(EMAIL_DIR, 'WelcomeEmail.mesa'), {
      target: 'email',
      data: {
        firstName:    'Alice',
        planName:     'Pro',
        amount:       '$49.00',
        nextBilling:  'May 1, 2025',
        dashboardUrl: 'https://app.example.com/dashboard',
        reviewerName: 'Sarah K.',
      }
    })
    expect(result).toBeDefined()
    expect(result.html).toBeTruthy()
  })

  it('produces a full HTML document', () => {
    expect(result.html).toContain('<!DOCTYPE html>')
    expect(result.html).toContain('<html')
    expect(result.html).toContain('<head>')
    expect(result.html).toContain('<body')
    expect(result.html).toContain('</html>')
  })

  it('includes MSO/VML namespace for Outlook', () => {
    expect(result.html).toContain('xmlns:v=')
    expect(result.html).toContain('[if mso]')
  })

  it('extracts subject from <script module>', () => {
    expect(result.subject).toBe('Welcome to the platform!')
  })

  it('has @media queries in <head> only', () => {
    const headMatch = result.html.match(/<head[\s\S]*?<\/head>/)
    const bodyMatch = result.html.match(/<body[\s\S]*?<\/body>/)
    expect(headMatch?.[0]).toContain('@media')
    expect(bodyMatch?.[0]).not.toContain('@media')
  })

  it('inlines CSS into style attributes', () => {
    expect(result.html).toContain('style=')
    // No bare <style> in <body>
    const body = result.html.replace(/<head[\s\S]*?<\/head>/, '')
    expect(body).not.toContain('<style>')
  })

  it('renders prop data into output', () => {
    expect(result.html).toContain('Alice')
    expect(result.html).toContain('Pro')
    expect(result.html).toContain('$49.00')
    expect(result.html).toContain('May 1, 2025')
  })

  it('renders SVG stars', () => {
    expect(result.html).toContain('<svg')
    expect(result.html).toContain('</svg>')
  })

  it('renders card with KeyValue rows', () => {
    expect(result.html).toContain('Next billing')
  })

  it('renders review with reviewer name', () => {
    expect(result.html).toContain('Sarah K')
  })

  it('renders footer with unsubscribe link', () => {
    expect(result.html).toContain('Unsubscribe')
  })

  it('produces a plain-text fallback', () => {
    expect(result.text).toBeTruthy()
    expect(result.text.length).toBeGreaterThan(20)
  })
})

// ── Individual component tests ────────────────────────────────────────────────

describe.skip('Email component kit — individual components', () => {
  const render = (src, data = {}) =>
    renderComponent(src, { cwd: EMAIL_DIR, target: 'email', data })

  it('Button renders bulletproof VML + anchor', async () => {
    const r = await renderFile(path.join(EMAIL_DIR, 'Button.mesa'), {
      target: 'email',
      data: { href: 'https://example.com', text: 'Click Me', bgcolor: '#9fc612' }
    })
    expect(r.html).toContain('https://example.com')
    expect(r.html).toContain('Click Me')
    expect(r.html).toContain('v:roundrect')     // Outlook VML
    expect(r.html).toContain('background-color:#9fc612')
  })

  it('Stars renders correct count of filled SVG paths', async () => {
    const r = await renderFile(path.join(EMAIL_DIR, 'Stars.mesa'), {
      target: 'email',
      data: { count: 4, total: 5, color: '#f59e0b', empty: '#dddddd' }
    })
    // 4 filled + 1 empty
    const filled = (r.html.match(/fill="#f59e0b"/g) ?? []).length
    const empty  = (r.html.match(/fill="#dddddd"/g) ?? []).length
    expect(filled).toBe(4)
    expect(empty).toBe(1)
  })

  it('Avatar renders SVG with initial letter', async () => {
    const r = await renderFile(path.join(EMAIL_DIR, 'Avatar.mesa'), {
      target: 'email',
      data: { name: 'Alice Johnson', bgcolor: '#9fc612' }
    })
    expect(r.html).toContain('<svg')
    expect(r.html).toContain('>A<')   // initial
    expect(r.html).toContain('#9fc612')
  })

  it('Card renders border and heading', async () => {
    const r = await renderFile(path.join(EMAIL_DIR, 'Card.mesa'), {
      target: 'email',
      data: { heading: 'Order Summary', border: '#eeeeee' }
    })
    expect(r.html).toContain('Order Summary')
    expect(r.html).toContain('border:')
  })

  it('DataTable renders header and rows', async () => {
    const r = await renderFile(path.join(EMAIL_DIR, 'DataTable.mesa'), {
      target: 'email',
      data: {
        heading: 'Items',
        columns: [{ key: 'name', label: 'Item' }, { key: 'price', label: 'Price', align: 'right' }],
        rows: [{ name: 'Lawn mowing', price: '$85.00' }, { name: 'Edging', price: '$25.00' }]
      }
    })
    expect(r.html).toContain('Items')
    expect(r.html).toContain('Lawn mowing')
    expect(r.html).toContain('$85.00')
    expect(r.html).toContain('Edging')
    expect(r.html).toContain('Item')    // column header
    expect(r.html).toContain('Price')
  })

  it('Contact renders name, email, phone, url', async () => {
    const r = await renderFile(path.join(EMAIL_DIR, 'Contact.mesa'), {
      target: 'email',
      data: {
        name: 'Bob Smith',
        email: 'bob@example.com',
        phone: '(555) 123-4567',
        url: 'https://app.example.com/clients/1',
        urlText: 'View profile'
      }
    })
    expect(r.html).toContain('Bob Smith')
    expect(r.html).toContain('bob@example.com')
    expect(r.html).toContain('(555) 123-4567')
    expect(r.html).toContain('View profile')
  })

  it('Contact hides empty fields', async () => {
    const r = await renderFile(path.join(EMAIL_DIR, 'Contact.mesa'), {
      target: 'email',
      data: { name: 'Alice', email: '', phone: '', url: '' }
    })
    expect(r.html).toContain('Alice')
    expect(r.html).not.toContain('mailto:')
    expect(r.html).not.toContain('tel:')
  })

  it('Address renders formatted address with map link', async () => {
    const r = await renderFile(path.join(EMAIL_DIR, 'Address.mesa'), {
      target: 'email',
      data: { line1: '123 Main St', city: 'Phoenix', state: 'AZ', zip: '85001' }
    })
    expect(r.html).toContain('123 Main St')
    expect(r.html).toContain('Phoenix')
    expect(r.html).toContain('AZ')
    expect(r.html).toContain('maps.google.com')
  })

  it('Divider renders a table-cell hr', async () => {
    const r = await renderFile(path.join(EMAIL_DIR, 'Divider.mesa'), {
      target: 'email',
      data: { color: '#cccccc' }
    })
    expect(r.html).toContain('background-color:#cccccc')
    expect(r.html).not.toContain('<hr')
  })

  it('Footer renders company, unsubscribe, privacy', async () => {
    const r = await renderFile(path.join(EMAIL_DIR, 'Footer.mesa'), {
      target: 'email',
      data: {
        company: 'ACME Corp',
        address: '1 Main St',
        unsubscribe: 'https://example.com/unsub',
        privacy: 'https://example.com/privacy'
      }
    })
    expect(r.html).toContain('ACME Corp')
    expect(r.html).toContain('1 Main St')
    expect(r.html).toContain('Unsubscribe')
    expect(r.html).toContain('Privacy Policy')
  })

  it('Spacer renders a zero-font-size row with correct height', async () => {
    const r = await renderFile(path.join(EMAIL_DIR, 'Spacer.mesa'), {
      target: 'email',
      data: { height: 32 }
    })
    expect(r.html).toContain('32px')
    expect(r.html).toContain('font-size:0')
  })

  it('KeyValue renders label and value side by side', async () => {
    const r = await renderFile(path.join(EMAIL_DIR, 'KeyValue.mesa'), {
      target: 'email',
      data: { label: 'Status', value: 'Active', bold: true }
    })
    expect(r.html).toContain('Status')
    expect(r.html).toContain('Active')
    expect(r.html).toContain('font-weight:700')
  })

  it('Image renders with explicit width and fluid class', async () => {
    const r = await renderFile(path.join(EMAIL_DIR, 'Image.mesa'), {
      target: 'email',
      data: { src: 'https://example.com/img.jpg', alt: 'Hero', width: 600 }
    })
    expect(r.html).toContain('https://example.com/img.jpg')
    expect(r.html).toContain('alt="Hero"')
    expect(r.html).toContain('width:600px')
  })

  it('Image hides when display=false', async () => {
    const r = await renderFile(path.join(EMAIL_DIR, 'Image.mesa'), {
      target: 'email',
      data: { src: 'https://example.com/img.jpg', alt: 'x', display: false }
    })
    expect(r.html).not.toContain('<img')
  })

  it('Link renders mailto and target', async () => {
    const r = await renderFile(path.join(EMAIL_DIR, 'Link.mesa'), {
      target: 'email',
      data: { href: 'https://example.com', text: 'Go here', color: '#ee380d' }
    })
    expect(r.html).toContain('href="https://example.com"')
    expect(r.html).toContain('Go here')
    expect(r.html).toContain('color:#ee380d')
  })
})
