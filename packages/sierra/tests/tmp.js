// tests/tmp.js — where this suite's temp directories go.
//
// Nine test files here made directories straight in os.tmpdir() under twelve
// different prefixes, and nothing removed any of them: a vitest run cannot
// delete its own (a build is still writing when the test returns) and an exit
// handler is not reliable. So they accumulated — 2,304 of them on the machine
// that measured it (FJS-361).
//
// One ROOT fixes it in the one way that stays fixed: a single prefix to sweep,
// so a test added later cannot leak a name nobody listed. Reach for tmpDir(),
// never mkdtempSync(tmpdir()).
//
// Relative, not '@frontierjs/litestone/testing': bun resolves workspace:* to a
// COPY under node_modules/.bun, so the package spec would test a stale reaper.

import { mkdtempSync } from 'node:fs'
import { join }        from 'node:path'
import { tempDir }     from '../../litestone/src/tmp-dirs.js'

const ROOT = tempDir('sierra-tests-')

/** A uniquely-named directory inside this run's root. `prefix` is for reading
 *  a failure, not for finding the directory later — the sweep matches ROOT. */
export function tmpDir(prefix = 'x-') { return mkdtempSync(join(ROOT, prefix)) }
