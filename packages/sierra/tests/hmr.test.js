/**
 * hmr.test.js — Tests for Sierra HMR infrastructure
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { hmrInvalidate } from '../src/router/internals.js'
import { generateOverlayScript } from '../src/build/dev-overlay.js'
import { _generateVirtualSierra } from '../src/virtual/virtual-sierra.js'
import { rewriteLayoutSlots } from '../src/build/slot-rewrite.js'

// ── hmrInvalidate ─────────────────────────────────────────────────────────────

describe('hmrInvalidate', () => {
  it('is exported from internals', () => {
    expect(typeof hmrInvalidate).toBe('function')
  })

  it('does not throw when called with an unknown file', () => {
    expect(() => hmrInvalidate('src/routes/unknown.mesa')).not.toThrow()
  })

  it('does not throw when called with null/undefined', () => {
    expect(() => hmrInvalidate(null)).not.toThrow()
    expect(() => hmrInvalidate(undefined)).not.toThrow()
  })
})

// ── virtual-sierra HMR wiring ─────────────────────────────────────────────────

describe('virtual-sierra HMR wiring', () => {
  it('generated module contains sierra:hmr event handler', () => {
    const src = _generateVirtualSierra({}, 'config/routes.js')
    expect(src).toContain('sierra:hmr')
  })

  it('generated module contains hmrReload import', () => {
    const src = _generateVirtualSierra({}, 'config/routes.js')
    expect(src).toContain('hmrReload')
  })

  it('generated module wraps HMR in DEV + hot check', () => {
    const src = _generateVirtualSierra({}, 'config/routes.js')
    expect(src).toContain('import.meta.env.DEV')
    expect(src).toContain('import.meta.hot')
  })
})

// ── generateOverlayScript ─────────────────────────────────────────────────────

describe('generateOverlayScript', () => {
  it('returns a non-empty string', () => {
    const script = generateOverlayScript()
    expect(typeof script).toBe('string')
    expect(script.length).toBeGreaterThan(0)
  })

  it('contains hot.on for error events', () => {
    const script = generateOverlayScript()
    // The overlay listens for sierra:error events from the server
    expect(script).toContain('sierra:error')
  })

  it('contains sierraShowError function', () => {
    const script = generateOverlayScript()
    expect(script).toContain('sierraShowError')
  })

  it('contains the overlay element id', () => {
    const script = generateOverlayScript()
    expect(script).toContain('__sierra_overlay__')
  })

  it('contains __sierraReportError global', () => {
    const script = generateOverlayScript()
    expect(script).toContain('__sierraReportError')
  })

  it('contains error forwarding via hot.send', () => {
    const script = generateOverlayScript()
    expect(script).toContain('sierra:error:client')
  })

  it('wraps everything in DEV check', () => {
    const script = generateOverlayScript()
    expect(script).toContain('import.meta.env.DEV')
  })

  it('contains dismiss button', () => {
    const script = generateOverlayScript()
    expect(script).toContain('Dismiss')
  })

  it('contains copy button', () => {
    const script = generateOverlayScript()
    expect(script).toContain('Copy')
    expect(script).toContain('navigator.clipboard')
  })

  it('contains full reload button', () => {
    const script = generateOverlayScript()
    expect(script).toContain('Full reload')
    expect(script).toContain('location.reload()')
  })
})
