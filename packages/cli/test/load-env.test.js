/*
 * test/load-env.test.js
 *
 * Precedence of the three places a variable can come from: the shell beats the
 * project .env, which beats ~/.config/fli/.env. `DATABASE_URL=./other.db fli
 * db:migrate` migrated the .env's database when the project file overrode the
 * shell (FJS-2631).
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadEnv, loadFliEnv, profileLine, PROFILE_NAMED } from '../core/utils.js'
import { dotenvLine } from '../core/vaultwarden.js'

const KEYS = ['FJS2631_SHELL', 'FJS2631_BOTH', 'FJS2631_GLOBAL']
let home, root

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'fli-env-home-'))
  root = mkdtempSync(join(tmpdir(), 'fli-env-root-'))
  mkdirSync(join(home, '.config', 'fli'), { recursive: true })
  writeFileSync(join(home, '.config', 'fli', '.env'), 'FJS2631_SHELL=global\nFJS2631_BOTH=global\nFJS2631_GLOBAL=global\n')
  writeFileSync(join(root, '.env'), 'FJS2631_SHELL=project\nFJS2631_BOTH=project\n')
  for (const k of KEYS) delete process.env[k]
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
  for (const k of KEYS) delete process.env[k]
})

describe('loadFliEnv', () => {
  test('a variable already in the shell beats the project .env and the global one', () => {
    process.env.FJS2631_SHELL = 'shell'
    loadFliEnv(root, home)
    expect(process.env.FJS2631_SHELL).toBe('shell')
  })

  test('the project .env beats the global one', () => {
    loadFliEnv(root, home)
    expect(process.env.FJS2631_BOTH).toBe('project')
  })

  test('the global .env fills what the project leaves unset', () => {
    loadFliEnv(root, home)
    expect(process.env.FJS2631_GLOBAL).toBe('global')
  })
})

// ─── a profile loads between the project and the global file (FJS-D1943) ────
// A wrong-client deploy is the failure: the profile is picked by the shell or
// the project, never remembered, and one that cannot load stops the global
// file's account keys being read in its place.

describe('loadFliEnv with FLI_PROFILE', () => {
  const PKEYS = ['FLI_PROFILE', 'D1943_PROJECT', 'D1943_PROFILE', 'D1943_GLOBAL', 'D1943_TOKEN']
  const writeProfile = (name, text) => {
    mkdirSync(join(home, '.config', 'fli', 'profiles'), { recursive: true })
    writeFileSync(join(home, '.config', 'fli', 'profiles', `${name}.env`), text)
  }
  beforeEach(() => {
    for (const k of PKEYS) delete process.env[k]
    writeFileSync(join(home, '.config', 'fli', '.env'), 'D1943_PROJECT=global\nD1943_PROFILE=global\nD1943_GLOBAL=global\nD1943_TOKEN=global\n')
    writeProfile('acme', 'D1943_PROJECT=profile\nD1943_PROFILE=profile\nD1943_TOKEN=acme\n')
  })
  afterEach(() => { for (const k of PKEYS) delete process.env[k] })

  test('shell beats project beats profile beats global', () => {
    writeFileSync(join(root, '.env'), 'FLI_PROFILE=acme\nD1943_PROJECT=project\n')
    process.env.D1943_TOKEN = 'shell'
    const profile = loadFliEnv(root, home)
    expect(profile).toMatchObject({ name: 'acme', source: 'project', refusal: null })
    expect(process.env.D1943_TOKEN).toBe('shell')
    expect(process.env.D1943_PROJECT).toBe('project')
    expect(process.env.D1943_PROFILE).toBe('profile')
    expect(process.env.D1943_GLOBAL).toBe('global')
  })

  test('the shell names the profile over the project, and an empty one names none', () => {
    writeProfile('other', 'D1943_TOKEN=other\n')
    writeFileSync(join(root, '.env'), 'FLI_PROFILE=acme\n')
    process.env.FLI_PROFILE = 'other'
    expect(loadFliEnv(root, home)).toMatchObject({ name: 'other', source: 'shell' })
    expect(process.env.D1943_TOKEN).toBe('other')

    // Bun pre-loads the cwd's .env, so the project's own name arrives looking like the shell's.
    process.env.FLI_PROFILE = 'acme'
    expect(loadFliEnv(root, home).source).toBe('project')

    delete process.env.D1943_TOKEN
    process.env.FLI_PROFILE = ''
    expect(loadFliEnv(root, home).name).toBe(null)
    expect(process.env.D1943_TOKEN).toBe('global')
  })

  test('a profile with no file is refused by name and the global keys stay unread', () => {
    writeFileSync(join(root, '.env'), 'FLI_PROFILE=nobody\n')
    const profile = loadFliEnv(root, home)
    expect(profile.refusal).toContain("FLI_PROFILE names 'nobody'")
    expect(profile.refusal).toContain('fli profile:create nobody')
    expect(process.env.D1943_TOKEN).toBeUndefined()
  })

  test('a name that is not a path segment is refused before it reaches the filesystem', () => {
    process.env.FLI_PROFILE = '../acme'
    const profile = loadFliEnv(root, home)
    expect(profile.refusal).toContain("'../acme' is not a profile name")
    expect(profile.path).toBe(null)
    expect(process.env.D1943_TOKEN).toBeUndefined()
  })

  test('FLI_PROFILE in the global file or a profile selects nothing', () => {
    writeFileSync(join(home, '.config', 'fli', '.env'), 'FLI_PROFILE=acme\nD1943_TOKEN=global\n')
    expect(loadFliEnv(root, home).name).toBe(null)
    expect(process.env.FLI_PROFILE).toBeUndefined()
    expect(process.env.D1943_TOKEN).toBe('global')
  })
})

// ─── loadEnv reads a value the way Bun's own loader does (FJS-3415) ──────────
// `bun run` reads .env when fli is not in front, so the oracle is Bun itself,
// run over the same file.

const SPELLINGS = {
  PLAIN: 'plain',
  EXP_BARE: 'p$FJS3415_BASE',
  EXP_DQ: '"p$FJS3415_BASE"',
  EXP_SQ: "'p$FJS3415_BASE'",
  EXP_BRACE: '${FJS3415_BASE}x',
  EXP_DEFAULT: '${FJS3415_NOPE:-dflt}',
  EXP_EMPTY_SET: '${FJS3415_EMPTY:-dflt}',
  EXP_MISSING: 'p$FJS3415_NOPE',
  EXP_FORWARD: '$FJS3415_LATER',
  ESC_BARE: 'p\\$FJS3415_BASE',
  ESC_DQ: '"p\\$FJS3415_BASE"',
  ESC_SQ: "'p\\$FJS3415_BASE'",
  ESC_BS_DOLLAR: 'a\\\\$FJS3415_BASE',
  LONE_DOLLAR: 'a$',
  DQ_QUOTE: '"a\\"b"',
  SQ_QUOTE: "'a\\'b'",
  DQ_BS: '"a\\\\b"',
  DQ_BS_N: '"a\\\\nb"',
  DQ_N: '"a\\nb"',
  DQ_T: '"a\\tb"',
  DQ_R: '"a\\rb"',
  SQ_N: "'a\\nb'",
  BARE_BS: 'a\\b',
  FJS3415_BASE: 'basev',
  FJS3415_EMPTY: '',
  FJS3415_LATER: 'late',
}

describe('loadEnv matches Bun’s own .env loader', () => {
  test('every spelling of $, \\ and \\" reads the same under both', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fli-env-bun-'))
    try {
      const file = join(dir, '.env')
      writeFileSync(file, Object.entries(SPELLINGS).map(([k, v]) => `${k}=${v}`).join('\n') + '\n')
      const names = Object.keys(SPELLINGS)
      const proc = Bun.spawnSync([process.execPath, '-e', `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(names)}.map(k => [k, process.env[k] ?? null]))))`], { cwd: dir, env: { PATH: process.env.PATH } })
      const bun = JSON.parse(proc.stdout.toString())

      const saved = {}
      for (const k of names) { saved[k] = process.env[k]; delete process.env[k] }
      try {
        loadEnv(file)
        const fli = Object.fromEntries(names.map((k) => [k, process.env[k] ?? null]))
        expect(fli).toEqual(bun)
      } finally {
        for (const k of names) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a variable in the shell is what $NAME expands to, over the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fli-env-bun-'))
    try {
      const file = join(dir, '.env')
      writeFileSync(file, 'FJS3415_S=file\nFJS3415_T=$FJS3415_S\n')
      process.env.FJS3415_S = 'shell'
      delete process.env.FJS3415_T
      loadEnv(file)
      expect(process.env.FJS3415_T).toBe('shell')
    } finally {
      delete process.env.FJS3415_S
      delete process.env.FJS3415_T
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('dotenvLine writes a line both readers give back (FJS-3415)', () => {
  const VALUES = ['plain', 'p$X', 'p$FJS3415_BASE', '${FJS3415_BASE}', 'a$', '$$', 'a"b', "a'b", 'a\\b', 'a\nb', 'a\nb$c', "it's $x", 'tab\there', 'a b #c', '']
  const REFUSED = ['a\rb', "a'b\\c", 'a"b\nc', 'a\\', 'p\\$X']

  test('each value is read back unchanged by fli and by Bun', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fli-env-line-'))
    try {
      const names = VALUES.map((_, i) => `FJS3415_L${i}`)
      const lines = VALUES.map((v, i) => dotenvLine(names[i], v))
      expect(lines.every((l) => l !== null)).toBe(true)
      const file = join(dir, '.env')
      writeFileSync(file, 'FJS3415_BASE=basev\n' + lines.join('\n') + '\n')
      const proc = Bun.spawnSync([process.execPath, '-e', `console.log(JSON.stringify(${JSON.stringify(names)}.map(k => process.env[k])))`], { cwd: dir, env: { PATH: process.env.PATH } })
      const bun = JSON.parse(proc.stdout.toString())
      for (const k of names) delete process.env[k]
      delete process.env.FJS3415_BASE
      loadEnv(file)
      const fli = names.map((k) => process.env[k])
      for (const k of [...names, 'FJS3415_BASE']) delete process.env[k]
      expect(bun).toEqual(VALUES)
      expect(fli).toEqual(VALUES)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a value with no agreed spelling is refused', () => {
    for (const v of REFUSED) expect(dotenvLine('K', v)).toBeNull()
  })
})

describe('an unquoted value ends at the first # as Bun ends it (FJS-3447)', () => {
  const LINES = ['a#b', 'a #b', 'a # b', 'http://x/y#frag', '  a#b  ', '#x', '"a#b"', "'a#b'", 'a\\#b', 'pw#1 # c']

  test('fli and Bun read each line to the same value', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fli-env-hash-'))
    try {
      const names = LINES.map((_, i) => `FJS3447_H${i}`)
      const file = join(dir, '.env')
      writeFileSync(file, LINES.map((l, i) => `${names[i]}=${l}`).join('\n') + '\n')
      const proc = Bun.spawnSync([process.execPath, '-e', `console.log(JSON.stringify(${JSON.stringify(names)}.map(k => process.env[k])))`], { cwd: dir, env: { PATH: process.env.PATH } })
      const bun = JSON.parse(proc.stdout.toString())
      loadEnv(file)
      const fli = names.map((k) => process.env[k])
      for (const k of names) delete process.env[k]
      expect(bun[0]).toBe('a')
      expect(fli).toEqual(bun)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('an outward command names its profile in its first line (fli-profiles 2.1)', () => {
  const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '')

  test('a profile is named with who named it', () => {
    expect(plain(profileLine({ name: 'acme', source: 'project' }, {}))).toBe('profile acme — named by the project .env')
    expect(plain(profileLine({ name: 'acme', source: 'shell' }, {}))).toBe('profile acme — named by the shell')
  })

  test('no profile says the global file is what it spends', () => {
    expect(plain(profileLine({ name: null }, {}))).toBe('profile none — account keys from ~/.config/fli/.env')
  })

  test('a child its parent already named the profile to prints nothing', () => {
    expect(profileLine({ name: 'acme', source: 'project' }, { [PROFILE_NAMED]: '1' })).toBeNull()
  })
})
