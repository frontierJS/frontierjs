// ─── local-env.test.js — what `deploy:local` hands the container ─────────────
//
// FJS-2434. The project `.env` is written for a process running from the app
// root, so `DATABASE_URL=./db/app.db` is relative to a directory that is not the
// container's. Passed whole, it names an empty file inside the image rather than
// the mounted /db, and the local run is refused as a production deploy.

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { parseEnvText, containerEnvOverrides } from '../core/local-env.js'

const LOCAL = readFileSync(new URL('../commands/deploy/local.md', import.meta.url), 'utf8')

describe('containerEnvOverrides', () => {
  test('a relative path under ./db is re-rooted at the mount', () => {
    const o = containerEnvOverrides('DATABASE_URL=./db/app.db\nAUDIT_PATH=db/audit/\n', '/db')
    expect(o).toEqual({ DATABASE_URL: '/db/app.db', AUDIT_PATH: '/db/audit/' })
  })

  test('quotes are stripped before the path is read', () => {
    expect(containerEnvOverrides(`DATABASE_URL="./db/app.db"\n`, '/db')).toEqual({ DATABASE_URL: '/db/app.db' })
  })

  test('an absolute path, a URL and an unrelated value are left alone', () => {
    const text = 'A=/data/app.db\nB=postgres://h/db/x\nC=./other/x.db\nD=hello\n# E=./db/x\n'
    expect(containerEnvOverrides(text, '/db')).toEqual({})
  })

  test('parseEnvText skips comments and blank lines', () => {
    expect(parseEnvText('# c\n\nA=1\nB = "two"\n')).toEqual({ A: '1', B: 'two' })
  })
})

describe('the shipped command applies them', () => {
  test('overrides come after --env-file so they win', () => {
    const run = LOCAL.slice(LOCAL.indexOf('const runCmd = ['), LOCAL.indexOf('$.exec({ command: runCmd })'))
    expect(run).toContain('overrideArgs')
    expect(run.indexOf('overrideArgs')).toBeGreaterThan(run.indexOf('envArg'))
  })
})
