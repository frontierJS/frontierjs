import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { bundleEnvKeys, bundleEnvLine } from '../core/bundle-env.js'

let web
beforeEach(() => { web = mkdtempSync(join(tmpdir(), 'bundle-env-')) })
afterEach(() => rmSync(web, { recursive: true, force: true }))

describe('bundleEnvKeys', () => {
  test('names the exposed keys and the file each came from, never a value', () => {
    writeFileSync(join(web, '.env'), 'VITE_A=1\nSECRET=x\nFRONTIER_PUBLIC_API_URL=http://a\n')
    writeFileSync(join(web, '.env.production'), 'VITE_A=2\n')
    const keys = bundleEnvKeys(web, { VITE_SHELL: 's', PATH: '/bin' })
    expect(keys).toEqual([
      { key: 'FRONTIER_PUBLIC_API_URL', from: '.env' },
      { key: 'VITE_A', from: '.env.production' },
      { key: 'VITE_SHELL', from: 'process' },
    ])
    expect(JSON.stringify(keys)).not.toContain('http://a')
  })

  test('the line says the Variables are not the source', () => {
    writeFileSync(join(web, '.env'), 'VITE_A=1\n')
    expect(bundleEnvLine(bundleEnvKeys(web, {}))).toContain("not the App's Variables: VITE_A (.env)")
    expect(bundleEnvLine([])).toContain('none baked')
  })
})
