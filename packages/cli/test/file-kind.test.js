// file-kind.test.js — what a path IS, for codegraph and for the proof table.

import { test, expect } from 'bun:test'
import { kindOf }       from '../core/file-kind.js'

test('reads the path', () => {
  expect(kindOf('src/app.ts')).toBe('source')
  expect(kindOf('test/app.test.js')).toBe('test')
  expect(kindOf('src/app.spec.ts')).toBe('test')
  expect(kindOf('README.md')).toBe('doc')
  expect(kindOf('tsconfig.json')).toBe('config')
  expect(kindOf('web/vite.config.js')).toBe('config')
  expect(kindOf('db/ddl.snapshot.sql')).toBe('generated')
  expect(kindOf('bun.lock')).toBe('generated')
  expect(kindOf('public/logo.png')).toBe('asset')
  expect(kindOf('example/api/src/app.ts')).toBe('example')
  expect(kindOf('packages/sierra/examples/basic/main.js')).toBe('example')
  expect(kindOf('website/src/index.mesa')).toBe('example')
  // what an example holds that is a test, a doc or config stays that
  expect(kindOf('example/web/test/verify.mjs')).toBe('test')
  expect(kindOf('example/README.md')).toBe('doc')
  // a word inside a name is not the directory
  expect(kindOf('src/examples.js')).toBe('source')
  expect(kindOf('site/src/index.mesa')).toBe('source')
  // a build directory under src/ is a module, and one beside it is output
  expect(kindOf('packages/sierra/src/build/prerender.js')).toBe('source')
  expect(kindOf('packages/jetty/src/build/manifest.js')).toBe('source')
  expect(kindOf('packages/sierra/dist/index.js')).toBe('generated')
  expect(kindOf('build/app.js')).toBe('generated')
})
