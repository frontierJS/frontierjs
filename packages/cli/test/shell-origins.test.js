import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crossOrigins, SHELL_ORIGINS } from '../core/shell-origins.js'

// FJS-2655 / FJS-D912 — the cross-origin list a deploy derives for the API.

const names = (web, api) => ({ web: { domain: web }, api: { domain: api } })

let root
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'fli-shell-origins-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('crossOrigins', () => {
  test('one origin and no shell: nothing is cross-origin', () => {
    expect(crossOrigins(names('app.example.com', null), root)).toEqual([])
  })

  test('the API on a domain of its own admits the web page', () => {
    expect(crossOrigins(names('app.example.com', 'api.example.com'), root))
      .toEqual(['https://app.example.com'])
  })

  test('a desktop surface adds every spelling of the shell origin, since the OS is unknown', () => {
    mkdirSync(join(root, 'desktop'))
    expect(crossOrigins(names('app.example.com', null), root)).toEqual(SHELL_ORIGINS.desktop)
    expect(SHELL_ORIGINS.desktop).toEqual(['tauri://localhost', 'http://tauri.localhost'])
  })

  test('web and shell together', () => {
    mkdirSync(join(root, 'desktop'))
    expect(crossOrigins(names('app.example.com', 'api.example.com'), root))
      .toEqual(['https://app.example.com', 'tauri://localhost', 'http://tauri.localhost'])
  })
})
