/**
 * test/build-start-failure.test.js — a build whose buildStart refused
 *
 * Rollup runs `closeBundle` after a failed build too, so the postbuild plugin
 * prerendered every route of a build that never started, and whatever that
 * prerender threw replaced the error that stopped it. A scanner refusal read as
 * an autoImport failure on every page, and the scanner's own message was
 * printed nowhere (`FJS-2701`).
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { cp, mkdir, rm, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { build } from 'vite'

import { createSierraViteConfig } from '../src/build/index.js'
import sierraConfig from './fixtures/island-site/config/sierra.config.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SOURCE = join(__dirname, 'fixtures/island-site')
const TMP    = join(__dirname, 'tmp-build-start-failure')

beforeAll(async () => {
  await rm(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  await mkdir(TMP, { recursive: true })
  for (const entry of ['src', 'config', 'index.html']) {
    await cp(join(SOURCE, entry), join(TMP, entry), { recursive: true })
  }
  // A dynamic static route with no `.meta.js` to say which pages it stands for.
  await writeFile(join(TMP, 'src/routes/[slug].mesa'),
    '---\ntitle: Slug\nrender: static\n---\n<main><h1>slug</h1></main>\n')
}, 120_000)

afterAll(async () => {
  await rm(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe('a static build whose buildStart throws', () => {
  test("rejects with the scanner's message, and prerenders nothing", async () => {
    const run = build({ ...createSierraViteConfig(sierraConfig), root: TMP, logLevel: 'silent' })
    await expect(run).rejects.toThrow(/companion \.meta\.js|getStaticPaths/)
    expect(existsSync(join(TMP, 'dist/client/plain/index.html'))).toBe(false)
  }, 180_000)
})
