#!/usr/bin/env bun
// src/repl-server.js — preload for `bun --preload=this repl`
// Sets up `db` in globalThis so Bun's native REPL can access it.
// Bun's REPL uses useGlobal:true, so Object.defineProperty on globalThis
// makes `db` available as a bare name without a var binding in the REPL.

import { createClient } from '../core/client.js'

const dbPath     = process.env.LITESTONE_DB_PATH
const schemaPath = process.env.LITESTONE_SCHEMA

if (!dbPath || !schemaPath) {
  console.error('litestone repl: missing LITESTONE_DB_PATH or LITESTONE_SCHEMA')
  process.exit(1)
}

const _db = await createClient({ path: schemaPath, db: dbPath })

// Define db as a non-configurable global property.
// Bun's REPL resolves bare names against the global object, so this
// makes `db` available directly without needing `globalThis.db`.
Object.defineProperty(globalThis, 'db', {
  value:        _db,
  writable:     true,
  enumerable:   true,
  configurable: true,
})

process.on('exit', () => { try { _db.$close() } catch {} })
