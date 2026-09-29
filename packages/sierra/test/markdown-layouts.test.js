/**
 * test/markdown-layouts.test.js — which file a `.md` file's `layout:` means
 *
 * An ordered list of directories, a later one winning a name: how a site cut
 * from a template replaces one of the template's layouts without copying the
 * rest (`FJS-1493`). Mesa does the wrap; this is only the lookup.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'

import { scanMarkdownLayouts } from '../src/build/markdown-layouts.js'
import { tmpDir } from './tmp.js'

let root
beforeAll(() => {
  root = tmpDir('markdown-layouts-')
  for (const d of ['engine', 'client', 'twice']) mkdirSync(join(root, d))
  writeFileSync(join(root, 'engine/Block.mesa'), '<slot />')
  writeFileSync(join(root, 'engine/Trust.mesa'), '<slot />')
  writeFileSync(join(root, 'engine/page.md'), '<slot />')
  writeFileSync(join(root, 'engine/notes.txt'), 'not a layout')
  writeFileSync(join(root, 'client/Block.mesa'), '<slot />')
  writeFileSync(join(root, 'twice/Block.mesa'), '<slot />')
  writeFileSync(join(root, 'twice/Block.md'), '<slot />')
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('scanMarkdownLayouts', () => {
  test('names every .mesa and .md by its basename, whatever its case', async () => {
    const layouts = await scanMarkdownLayouts(root, ['engine'])
    expect(Object.keys(layouts).sort()).toEqual(['Block', 'Trust', 'page'])
    expect(layouts.Block).toBe(join(root, 'engine/Block.mesa'))
  })

  test('a later directory wins a name, and leaves the rest alone', async () => {
    const layouts = await scanMarkdownLayouts(root, ['engine', 'client'])
    expect(layouts.Block).toBe(join(root, 'client/Block.mesa'))
    expect(layouts.Trust).toBe(join(root, 'engine/Trust.mesa'))
  })

  // The negative control: the order is the author's, so an earlier directory
  // listed last is the one that wins.
  test('the order is the list\'s, not the filesystem\'s', async () => {
    const layouts = await scanMarkdownLayouts(root, ['client', 'engine'])
    expect(layouts.Block).toBe(join(root, 'engine/Block.mesa'))
  })

  test('one directory holding a name twice has no order to appeal to, and is refused', async () => {
    await expect(scanMarkdownLayouts(root, ['twice'])).rejects.toThrow(/'Block' is both twice\/Block\.md and twice\/Block\.mesa/)
  })

  test('a missing directory warns and is skipped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await scanMarkdownLayouts(root, ['nowhere', 'engine'])).toHaveProperty('Block')
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/markdownLayouts dir not found: nowhere/))
    warn.mockRestore()
  })
})
