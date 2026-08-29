/*
 * tests/ports.test.js
 *
 * The port scheme is a FORMULA, and the thing worth testing about it is that
 * two apps never derive one number. Everything below is in service of that:
 * `appPorts` is what `fli dev` refuses on, so a wrong answer there is either a
 * refusal nobody can act on or — worse — a check that passes while a stale
 * server still owns the port and still holds the old database open.
 */

import { describe, expect, test } from 'bun:test'
import { appPorts, devPorts, scriptsRunBy, projectIdFor, PROJECTS, DYNAMIC_PROJECT_FLOOR, port,
         GLOBAL, GLOBAL_RANGE, isGlobalPort, isReservedToolingPort } from '../core/ports.js'

// A surface is a directory at the app root (Invariant 3), so a fake tree is
// exactly a set of directory names — no filesystem needed.
const treeOf = (...dirs) => (p) => dirs.some(d => p.endsWith(`/${d}`))

describe('projectIdFor — which app is this', () => {
  test('the scoped name, the bare name and the directory all resolve', () => {
    expect(projectIdFor('@frontierjs/example', 'example')).toBe(PROJECTS.example)
    expect(projectIdFor('example', 'anything')).toBe(PROJECTS.example)
    expect(projectIdFor('@acme/whatever', 'basecamp')).toBe(PROJECTS.basecamp)
  })

  test('an app nobody has assigned is the scaffold, which is what the templates use', () => {
    // Not a throw and not a random id: 0 is the number in every scaffolded
    // vite.config, so an app that has not been assigned one is honestly
    // described by it.
    expect(projectIdFor('@acme/brand-new', 'brand-new')).toBe(PROJECTS.scaffold)
    expect(projectIdFor(undefined, undefined)).toBe(PROJECTS.scaffold)
  })
})

describe('the site surface — its own two categories', () => {
  test('siteDev and siteServe are distinct rows, and neither is the SPA\'s', () => {
    const projectId = PROJECTS.example
    const web       = port('fe',        { env: 'dev', projectId })
    const dev       = port('siteDev',   { env: 'dev', projectId })
    const served    = port('siteServe', { env: 'dev', projectId })

    expect(web).toBe(8010)
    expect(dev).toBe(8610)
    expect(served).toBe(8710)

    // The point of two CATEGORIES rather than two service slots on `fe`: a
    // site being written and a site being served are two origins, and neither
    // is a second server belonging to the SPA.
    expect(new Set([web, dev, served]).size).toBe(3)
  })

  test('the test env is a different block, so a drive cannot take a dev server\'s port', () => {
    const projectId = PROJECTS.example
    expect(port('siteDev',   { env: 'test', projectId })).toBe(7610)
    expect(port('siteServe', { env: 'test', projectId })).toBe(7710)
  })

  test('a scaffolded app is project 0 — the number in the templates', () => {
    expect(port('siteDev',   { env: 'dev', projectId: PROJECTS.scaffold })).toBe(8600)
    expect(port('siteServe', { env: 'dev', projectId: PROJECTS.scaffold })).toBe(8700)
  })

  test('site/ is a surface appPorts derives, not a list an app keeps', () => {
    const rows = appPorts('/x/example', {
      name: 'example', exists: treeOf('web', 'api', 'site'),
    })
    const site = rows.find(r => r.surface === 'site')
    expect(site).toBeTruthy()
    expect(site.port).toBe(8610)

    // And absent when the directory is: which surfaces an app has is the app's
    // business, and a refusal naming a port nothing is about to bind is worse
    // than no refusal.
    const noSite = appPorts('/x/example', { name: 'example', exists: treeOf('web', 'api') })
    expect(noSite.find(r => r.surface === 'site')).toBeUndefined()
  })
})

describe('appPorts — what this app is about to bind', () => {
  test('the two apps in this repo get the numbers their configs already hold', () => {
    const example  = appPorts('/x/example',  { name: '@frontierjs/example',  exists: treeOf('web', 'api') })
    const basecamp = appPorts('/x/basecamp', { name: '@frontierjs/basecamp', exists: treeOf('web', 'api') })

    // These are the literals in each app's vite config and test harness. A
    // change here renames a port two apps have hard-coded.
    expect(example.map(p => p.port).sort()).toEqual([8010, 8110])
    expect(basecamp.map(p => p.port).sort()).toEqual([8020, 8120])
  })

  test('only the surfaces that EXIST are probed', () => {
    // A list kept per app is the thing that goes stale the day somebody adds a
    // surface; reading the tree is what stops that. The other direction matters
    // as much: refusing on a port for a surface this app does not have is a
    // refusal nobody can act on.
    const apiOnly = appPorts('/x/example', { name: 'example', exists: treeOf('api') })
    expect(apiOnly.map(p => p.surface)).toEqual(['api'])

    const withWidgets = appPorts('/x/example', { name: 'example', exists: treeOf('web', 'api', 'widgets') })
    expect(withWidgets.map(p => p.surface).sort()).toEqual(['api', 'web', 'widgets'])
    // Category 2 is widgetDev — a widgets surface is a THIRD server while one
    // is being written, and it is not the SPA's.
    expect(withWidgets.find(p => p.surface === 'widgets').port).toBe(8210)
  })

  test('an app with no surfaces asks for nothing', () => {
    expect(appPorts('/x/empty', { name: 'example', exists: () => false })).toEqual([])
  })

  test('the script it names is one the app actually declares', () => {
    // Two conventions are live: the apps here call the script `api`, and
    // `fli new` writes `dev:api` because there they are composed into one
    // `dev`. Telling somebody to run a script their app does not have wastes
    // the next minute of their day.
    const here = appPorts('/x/example', {
      name: 'example', exists: treeOf('web', 'api'),
      scripts: { api: 'bun run api/app.ts', web: 'vite' },
    })
    expect(here.find(r => r.surface === 'api').script).toBe('api')

    const scaffolded = appPorts('/x/new-app', {
      name: 'new-app', exists: treeOf('web', 'api'),
      scripts: { 'dev:api': 'bun --watch run api/index.ts', 'dev:web': 'cd web && vite' },
    })
    expect(scaffolded.find(r => r.surface === 'api').script).toBe('dev:api')
    expect(scaffolded.find(r => r.surface === 'web').script).toBe('dev:web')
  })

  test('a surface with no script says so rather than inventing one', () => {
    const rows = appPorts('/x/odd', { name: 'odd', exists: treeOf('api'), scripts: {} })
    expect(rows[0].script).toBe(null)
  })
})

describe('devPorts — what `fli dev` is about to bind', () => {
  // FJS-568. `appPorts` answers what the app's surfaces WOULD bind; the
  // preflight has to answer what THIS command is about to. Refusing on the
  // difference is a refusal nobody can act on: the port named is one the
  // command would never have taken.
  const five = treeOf('web', 'api', 'site', 'widgets', 'extension')

  test("an app whose dev starts two of five surfaces is checked on two", () => {
    const scripts = {
      dev:          'bun run api & bun run web & wait',
      api:          'bun run api/index.ts',
      web:          'vite -c web/config/vite.config.js',
      'dev:site':   'cd site && vite -c config/vite.config.js',
      'dev:widgets': 'cd widgets && vite -c config/vite.config.js',
    }
    const rows = devPorts('/x/example', { name: 'example', exists: five, scripts })
    expect(rows.map(r => r.surface).sort()).toEqual(['api', 'web'])
    // The whole point: the site's port is NOT among them.
    expect(rows.some(r => r.port === 8610)).toBe(false)
    // And `appPorts` still answers the catalogue, which `fli ports` wants.
    expect(appPorts('/x/example', { name: 'example', exists: five, scripts }).length).toBe(5)
  })

  test('a scaffolded app composes every surface, so every one is checked', () => {
    const scripts = {
      dev:        'bun run --parallel dev:api dev:web dev:site',
      'dev:api':  'bun --watch run api/index.ts',
      'dev:web':  'cd web && vite -c config/vite.config.js',
      'dev:site': 'cd site && bun --bun vite -c config/vite.config.js',
    }
    const rows = devPorts('/x/new-app', { name: 'new-app', exists: treeOf('web', 'api', 'site'), scripts })
    expect(rows.map(r => r.surface).sort()).toEqual(['api', 'site', 'web'])
  })

  test('a dev that IS the surface command cannot be narrowed, so it is not', () => {
    // `fli new` writes `dev` as the command itself when there is one surface.
    // Narrowing to nothing here would skip the only check worth making.
    const rows = devPorts('/x/one', {
      name: 'one', exists: treeOf('web'),
      scripts: { dev: 'cd web && vite -c config/vite.config.js' },
    })
    expect(rows.map(r => r.surface)).toEqual(['web'])
  })

  test('a directory name that matches a script is not a script reference', () => {
    // The trap in anchoring on bare tokens: `cd web && vite` holds a `web` that
    // is a directory, and this app declares a `web` script.
    const scripts = {
      dev: 'bun run api & bun run dev:web & wait',
      api: 'bun run api/index.ts',
      web: 'vite',
      'dev:web': 'cd web && vite -c web/config/vite.config.js',
    }
    expect([...scriptsRunBy(scripts)].sort()).toEqual(['api', 'dev:web'])
  })

  test('a surface matches on either spelling, not just the one appPorts prints', () => {
    // An app may declare both `web` and `dev:web` and run the other one.
    const scripts = {
      dev:       'bun run dev:web',
      web:       'vite',
      'dev:web': 'cd web && vite',
    }
    const rows = devPorts('/x/both', { name: 'both', exists: treeOf('web'), scripts })
    expect(rows.map(r => r.surface)).toEqual(['web'])
  })

  test('an indirection is followed', () => {
    const scripts = {
      dev:     'bun run dev:all',
      'dev:all': 'bun run --parallel dev:api dev:web',
      'dev:api': 'bun --watch run api/index.ts',
      'dev:web': 'cd web && vite',
    }
    const rows = devPorts('/x/deep', { name: 'deep', exists: treeOf('web', 'api', 'site'), scripts })
    expect(rows.map(r => r.surface).sort()).toEqual(['api', 'web'])
  })

  test('a cycle terminates', () => {
    const scripts = { dev: 'bun run a', a: 'bun run b', b: 'bun run a' }
    expect(scriptsRunBy(scripts)).toEqual(new Set(['a', 'b']))
  })

  test('no manifest at all falls back to the catalogue', () => {
    const rows = devPorts('/x/bare', { name: 'bare', exists: treeOf('web', 'api') })
    expect(rows.map(r => r.surface).sort()).toEqual(['api', 'web'])
  })
})

describe('the scheme itself', () => {
  test('no two assigned apps share a frontend or a backend port', () => {
    // The failure that made this scheme exist: example and basecamp both asked
    // for 5274, vite hopped in silence, and the second app's drive tested the
    // first app's app.
    const fe = Object.values(PROJECTS).map(id => port('fe', { env: 'dev', projectId: id }))
    const be = Object.values(PROJECTS).map(id => port('be', { env: 'dev', projectId: id }))
    expect(new Set(fe).size).toBe(fe.length)
    expect(new Set(be).size).toBe(be.length)
  })

  test('the dynamic allocator starts above every assigned id', () => {
    const highest = Math.max(...Object.values(PROJECTS))
    expect(DYNAMIC_PROJECT_FLOOR).toBeGreaterThan(highest)
  })
})

describe('the global tooling block', () => {
  test('every assigned tool is inside 8500-8509', () => {
    for (const [name, p] of Object.entries(GLOBAL)) {
      expect(p, name).toBeGreaterThanOrEqual(GLOBAL_RANGE.first)
      expect(p, name).toBeLessThanOrEqual(GLOBAL_RANGE.last)
    }
  })

  test('no two tools share a slot', () => {
    const ps = Object.values(GLOBAL)
    expect(new Set(ps).size).toBe(ps.length)
  })

  test('the formula refuses the whole block, not just the taken slots', () => {
    // Reserving only what is currently assigned hands the next free slot to an
    // app, and the collision surfaces as a tool that has quietly moved.
    for (let serviceId = 0; serviceId <= 9; serviceId++) {
      expect(() => port('tooling', { env: 'dev', projectId: 0, serviceId }))
        .toThrow(/reserved for global tooling/)
    }
  })

  test('an app that is not project 0 may still take a tooling port', () => {
    expect(port('tooling', { env: 'dev', projectId: 1 })).toBe(8510)
  })

  test('test and prod tooling are not reserved — nobody types those', () => {
    expect(port('tooling', { env: 'test', projectId: 0 })).toBe(7500)
    expect(port('tooling', { env: 'prod', projectId: 0 })).toBe(9500)
  })

  test('a free slot in the block is reserved but not assigned', () => {
    expect(isReservedToolingPort(8509)).toBe(true)
    expect(isGlobalPort(8509)).toBe(false)
    expect(isGlobalPort(GLOBAL.devtools)).toBe(true)
  })
})
