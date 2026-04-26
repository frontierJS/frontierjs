#!/usr/bin/env bun
import { main }    from './runner.js'
import { preview } from './framework.js'

const args         = process.argv.slice(2)
const dryRun       = args.includes('--dry-run')
const previewMode  = args.includes('--preview')
const skipExisting = args.includes('--skip-existing')
const force        = args.includes('--force')
const outputPath   = args.find(a => a.startsWith('--out='))?.split('=')[1]
const onlyArg      = args.find(a => a.startsWith('--only='))?.split('=')[1]
const only         = onlyArg ? onlyArg.split(',').map(v => v.trim()) : null
const concurrency  = parseInt(args.find(a => a.startsWith('--concurrency='))?.split('=')[1] ?? '8')
const paramsArg    = args.find(a => a.startsWith('--params='))?.split('=').slice(1).join('=')
const configPath   = args.find(a => !a.startsWith('--')) ?? './index.js'

if (paramsArg) {
  try {
    JSON.parse(paramsArg) // validate before setting
    process.env.TRANSFORM_PARAMS = paramsArg
  } catch {
    console.error('Fatal: --params must be valid JSON')
    process.exit(1)
  }
}

if (previewMode) {
  preview(configPath).catch(err => {
    console.error('Fatal:', err.message)
    process.exit(1)
  })
} else {
  main(configPath, { dryRun, verbose: true, outputPath, only, concurrency, skipExisting, force }).catch(err => {
    console.error('Fatal:', err.message)
    process.exit(1)
  })
}
