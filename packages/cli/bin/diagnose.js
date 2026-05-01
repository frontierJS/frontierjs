#!/usr/bin/env node

import { register } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { existsSync } from 'node:fs'

console.log('Node version:', process.version)
console.log('Platform:    ', process.platform)

global.fliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const { findProjectRoot } = await import('../core/utils.js')
global.projectRoot = findProjectRoot(process.cwd(), global.fliRoot)

console.log('fliRoot:     ', global.fliRoot)
console.log('projectRoot: ', global.projectRoot)

const loaderPath = resolve(global.fliRoot, 'core/compiler.js')
console.log('Loader path: ', loaderPath)
console.log('Loader exists:', existsSync(loaderPath))

register(pathToFileURL(loaderPath))
console.log('Loader registered ✓')

const { compileCli } = await import('../core/compiler.js')
const testMd = `---\ntitle: test:diag\ndescription: Diagnostic test\n---\n\n\`\`\`js\nlog.info('ok')\n\`\`\`\n`
const compiled = compileCli(testMd)
const metaMatch = compiled.match(/export const metadata = (.+)/)
console.log('\nCompiler:', metaMatch ? '✓ metadata exported' : '✗ MISSING')

const { buildRegistry } = await import('../core/registry.js')
const registry = buildRegistry()
console.log('\nRegistry:')
for (const [name, entry] of registry.entries()) {
  if (!name.includes(':')) continue // skip aliases
  console.log(`  [${entry.source}] ${name}`)
}

const greetPath = resolve(global.projectRoot, 'cli/src/routes/hello/greet.md')
console.log('\nTesting import of hello:greet...')
console.log('File exists:', existsSync(greetPath))

try {
  const { Command } = await import('../core/runtime.js')
  const cmd = await Command({ file: greetPath, arg: ['World'], flag: {} })
  console.log('Command() ✓')
} catch (err) {
  console.log('Command() FAILED:', err.message)
}
