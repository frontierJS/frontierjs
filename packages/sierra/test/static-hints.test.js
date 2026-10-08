/**
 * test/static-hints.test.js — a static build reports a reactivity hint only for
 * code a published script contains (`FJS-D629`)
 *
 * A hint says a read will not update when its import mutates, which is true
 * only of a component that re-renders in a browser. ksite's static build
 * prerendered four pages, published no script, and printed 21 hints, none of
 * which could be true. The build now holds every hint until the prune step and
 * prints the ones whose module a kept chunk carries.
 *
 * Both halves are asserted, because each one alone passes a broken build: a
 * build that dropped every hint would pass the page-only half, and one that held
 * nothing back would pass the island half. The island is the case that must
 * keep warning — it is the one place a static page runs a component.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest'
import { cp, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { build, createLogger } from 'vite'

import { createSierraViteConfig } from '../src/build/index.js'
import sierraConfig from './fixtures/island-site/config/sierra.config.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SOURCE = join(__dirname, 'fixtures/island-site')
const TMP    = join(__dirname, 'tmp-static-hints')

const said = []

beforeAll(async () => {
  await rm(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  await mkdir(TMP, { recursive: true })
  for (const entry of ['src', 'config', 'index.html']) {
    await cp(join(SOURCE, entry), join(TMP, entry), { recursive: true })
  }

  // A real site's entry imports its route table, which is what puts every route
  // through the main build. The fixture's entry is a bare comment.
  await writeFile(join(TMP, 'src/main.js'), "import '../config/routes.js'\n")

  // One content module, read without a watch by an island and by a page with none.
  await writeFile(join(TMP, 'src/content.js'), "export const site = { name: 'n', tag: 't' }\n")
  const counter = join(TMP, 'src/islands/Counter.mesa')
  await writeFile(counter, (await readFile(counter, 'utf8'))
    .replace('<script>', "<script>\n  import { site } from '../content.js'")
    .replace('count: {n}', 'count: {n} {site.name}'))
  await writeFile(join(TMP, 'src/routes/plain.mesa'), [
    '---', 'title: Plain', 'render: static', '---',
    "<script>\n  import { site } from '../content.js'\n</script>",
    '<main><h1>{site.tag}</h1></main>', '',
  ].join('\n'))

  const logger = createLogger('silent')
  logger.warn = (m) => said.push(String(m))
  logger.warnOnce = logger.warn
  const keep = (m) => said.push(String(m))
  const spies = [
    vi.spyOn(console, 'warn').mockImplementation(keep),
    vi.spyOn(console, 'log').mockImplementation(keep),
  ]
  try {
    await build({ ...createSierraViteConfig(sierraConfig), root: TMP, customLogger: logger })
  } finally {
    for (const s of spies) s.mockRestore()
  }
}, 180_000)

afterAll(async () => {
  await rm(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe('a static build and its reactivity hints', () => {
  test("an island's hint is printed, against its file", () => {
    const all = said.join('\n')
    expect(all).toMatch(/1 reactivity hint\(s\) in code a published script runs/)
    expect(all).toMatch(/src\/islands\/Counter\.mesa\n\s+\[Mesa\] 'site\.name' is read in the template/)
  })

  test("a page-only component's hint is held back and counted", () => {
    expect(said.join('\n')).not.toContain('site.tag')
    expect(said.join('\n')).toMatch(/1 reactivity hint\(s\) not printed/)
  })
})
