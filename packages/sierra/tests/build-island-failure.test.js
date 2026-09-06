/**
 * tests/build-island-failure.test.js — a static build with islands, end to end
 *
 * `closeBundle` used to catch an island-bundle failure, print
 * *Island bundling FAILED*, and carry on to exit 0 — while the sibling failure
 * ten lines below (a static route that threw while rendering) throws, with a
 * comment making exactly the opposite argument: *a deploy with a missing page
 * and a green log*. For a storefront whose buy button is an island, "the pages
 * are correct, they are just inert" is a shop that cannot take money, and CI
 * reads the exit code and not the log. It rethrows now, and removes the orphan
 * chunks the failed second Vite build left in the published directory
 * (`FJS-821`).
 *
 * **What is here is the control, and the reason it is alone is worth stating.**
 * The failure the audit measured is `@frontierjs/sierra/islands` unresolvable —
 * the shape an app that INSTALLED the framework has, and that no app in this
 * repo can have, since every one of them resolves the package to
 * `packages/sierra/`. Three ways to force it from inside a fixture were tried
 * and each broke the prerender instead (they share
 * `node_modules/.sierra/`) or was resolved past. The audit could not probe it
 * either, for the same reason. So the throw itself is measured by stubbing the
 * fix rather than by a fixture, and what stays in the suite is the half a
 * fixture CAN hold: that an ordinary static build with eleven islands still
 * completes and still emits a bundle — which is what a `closeBundle` that
 * threw on every island build would break, and which nothing else here runs.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { cp, mkdir, readdir, rm } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { build } from 'vite'

import { createSierraViteConfig } from '../src/build/index.js'
import sierraConfig from './fixtures/island-site/config/sierra.config.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SOURCE = join(__dirname, 'fixtures/island-site')
const TMP    = join(__dirname, 'tmp-island-failure')

const assets = (root) => readdir(join(root, 'dist/client/assets')).catch(() => [])

beforeAll(async () => {
  await rm(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  await mkdir(TMP, { recursive: true })
  // The fixture's committed dist/ is not copied — this build writes its own.
  for (const entry of ['src', 'config', 'index.html']) {
    await cp(join(SOURCE, entry), join(TMP, entry), { recursive: true })
  }
}, 120_000)

afterAll(async () => {
  await rm(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe('a static build over a site with islands', () => {
  test('completes, and emits an island bundle', async () => {
    await build({ ...createSierraViteConfig(sierraConfig), root: TMP, logLevel: 'silent' })

    const files = await assets(TMP)
    expect(files.some(f => f.startsWith('islands-'))).toBe(true)
    // Per-island chunks too: the entry is a table of import thunks, so a build
    // that emitted only the entry would mean nothing was reachable from it.
    expect(files.some(f => f.startsWith('island-'))).toBe(true)
  }, 180_000)
})
