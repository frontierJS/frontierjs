/*
 * test/new-scaffold.test.js
 *
 * Two ways `fli new` failed its own output, both found by the ELA stressor's
 * first command. `--widgets` handed `scaffoldWidgetSurface` a one-word name
 * under an empty prefix, which its tag guard refuses, so the scaffold stopped
 * half-written. And the first commit ran before the initial migration was
 * written, so a fresh repo opened with `db/migrations/` untracked.
 */

import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'fs'
import { join }   from 'path'
import { tmpdir } from 'os'

import { scaffoldWidgetSurface, widgetTag, isLegalWidgetTag } from '../core/widget-surface.js'

const NEW_MD = readFileSync(join(import.meta.dir, '../commands/project/new.md'), 'utf8')
const roots = []
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }) })

test('the widget `fli new --widgets` names is a tag a browser will register', () => {
  const call = NEW_MD.match(/scaffoldWidgetSurface\(\{[^}]*name:\s*'([^']+)'/)
  expect(call).not.toBeNull()
  expect(isLegalWidgetTag(widgetTag(call[1], ''))).toBe(true)
})

test('scaffoldWidgetSurface with no name scaffolds rather than refusing', () => {
  const root = mkdtempSync(join(tmpdir(), 'fjs-new-widget-'))
  roots.push(root)
  const { written } = scaffoldWidgetSurface({ root })
  expect(written.length).toBeGreaterThan(0)
  expect(existsSync(join(root, 'widgets/src/Embeds/HelloWidget.mesa'))).toBe(true)
})

test('the first commit comes after the initial migration is written', () => {
  const migration = NEW_MD.indexOf("migrate create initial")
  const commit    = NEW_MD.indexOf("git commit -m")
  expect(migration).toBeGreaterThan(-1)
  expect(commit).toBeGreaterThan(migration)
})
