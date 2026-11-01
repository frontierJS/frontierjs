// test/storage-dts-exports.test.ts
//
// FJS-3718: `parseRef` is exported by @frontierjs/litestone/storage and shown in
// docs/file-storage.md, but index.d.ts did not declare it, so a TypeScript app
// reading a File ref with { resolve: false } cast instead of importing it.

import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as storage from '../src/storage/index.js'

const DTS = readFileSync(resolve(import.meta.dir, '../src/storage/index.d.ts'), 'utf8')

test('every runtime export of the storage entry is declared in index.d.ts', () => {
  const undeclared = Object.keys(storage).filter(name => !new RegExp(`\\b${name}\\b`).test(DTS))
  expect(undeclared).toEqual([])
})

test('parseRef is declared over a ref, its JSON text, or nothing', () => {
  expect(DTS).toMatch(/export declare function parseRef\(value: FileRef \| string \| null \| undefined\): FileRef \| null/)
})
