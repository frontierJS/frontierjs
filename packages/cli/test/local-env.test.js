// ─── local-env.test.js — what `deploy:local` hands the container ─────────────
//
// FJS-2434. The project `.env` is written for a process running from the app
// root, so `DATABASE_URL=./db/app.db` is relative to a directory that is not the
// container's. Passed whole, it names an empty file inside the image rather than
// the mounted /db, and the local run is refused as a production deploy.

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { parseEnvText, containerEnvOverrides, strayDatabasePaths } from '../core/local-env.js'

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

// FJS-3438. The server's env file is the operator's and the container reads it
// whole, so a database path outside the mount is the container's own layer.
describe('strayDatabasePaths', () => {
  test('DATABASE_URL and AUDIT_PATH naming an absolute path outside the mount are stray', () => {
    const text = 'DATABASE_URL=/data/app.db\nAUDIT_PATH="/data/audit.db"\n'
    expect(strayDatabasePaths(text, '/db')).toEqual([
      { key: 'DATABASE_URL', value: '/data/app.db' },
      { key: 'AUDIT_PATH', value: '/data/audit.db' },
    ])
  })

  test('a path under the mount, a relative one and a non-path are not', () => {
    const text = 'DATABASE_URL=/db/app.db\nAUDIT_PATH=/db/audit/\nX_PATH=db/x.db\nDATABASE_URL_2=postgres://h/x\nNAME=/data/app.db\n'
    expect(strayDatabasePaths(text, '/db')).toEqual([])
  })

  test('another *_PATH is stray only when it names a SQLite file', () => {
    const text = 'JOBS_PATH=/data/jobs.sqlite3\nUPLOAD_PATH=/data/uploads\nPATH=/usr/bin\n'
    expect(strayDatabasePaths(text, '/db')).toEqual([{ key: 'JOBS_PATH', value: '/data/jobs.sqlite3' }])
  })
})

describe('the shipped steps grade the server env file', () => {
  test('01b-env-check asks strayDatabasePaths before it can pass', () => {
    const step = readFileSync(new URL('../commands/deploy/_steps-docker/01b-env-check.md', import.meta.url), 'utf8')
    expect(step).toContain('strayDatabasePaths(serverEnv, CONTAINER_DB_DIR)')
    expect(step.indexOf('strayDatabasePaths')).toBeLessThan(step.indexOf('log.success(`Env check: all'))
  })

  test('03-directories names the local file before it seeds from it', () => {
    const step = readFileSync(new URL('../commands/deploy/_steps-setup/03-directories.md', import.meta.url), 'utf8')
    expect(step).toContain('strayDatabasePaths(')
  })
})
