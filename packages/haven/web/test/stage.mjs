/**
 * web/test/stage.mjs — a scene mounted headless, for `scenes.test.js` and the
 * drives: its stage (`src/stage.js`), and the frame the terminal draws of it.
 *
 * The `.mesa` files are compiled by Sierra's terminal loader, as `fli haven`
 * compiles them, so `@/` and the `#paint` twin resolve as they do there; the
 * loader is one per process. With no `WalkIn` above it a scene has no
 * `$context.room`, so it is a picture and nothing signs in.
 *
 * Traps:
 * - `HAVEN_WEATHER` is `clear` and `HAVEN_SEASON` `summer` here unless set
 *   (`src/sky.js`), and a Vite server a drive starts bakes both in when it
 *   starts.
 * - `stages` must be the SAME module the component imports, or the slug is
 *   never found: both reach `src/stage.js` by its absolute path.
 * - The headless renderer is 100×30, the size `--frame` renders at, so what
 *   it draws is the stage's VIEW, never a stage wider than it; a frame row
 *   is read up to the view's width and trailing blanks are trimmed.
 */
import { join } from 'node:path'
import { installTerminalLoader } from '../../../sierra/src/terminal/loader.js'
import * as tui from '@frontierjs/mesa/runtime/terminal.js'
import { stages } from '../src/stage.js'

export const WEB = join(import.meta.dir, '..')

// Rain falls on blank cells, and a test or a drive that reads a blank one
// would pass or fail by the clock. Every process that imports this, and every
// child it spawns, is under a clear sky unless it sets another.
process.env.HAVEN_WEATHER ??= 'clear'
// The season turns a tree's art, and the frames are pinned in summer: with the
// real calendar a frame would flip with the month.
process.env.HAVEN_SEASON ??= 'summer'

/** Every scene: the file's name, its slug, and the route it is drawn at — what a door's `to` names. */
export const SCENES = [
  { name: 'Square', slug: 'square', path: '/' },
  { name: 'Tavern', slug: 'tavern', path: '/tavern/' },
  { name: 'Upstairs', slug: 'upstairs', path: '/upstairs/' },
  { name: 'Road',   slug: 'road',   path: '/road/' },
  { name: 'Woods',  slug: 'woods',  path: '/woods/' },
  { name: 'Docks',  slug: 'docks',  path: '/docks/' },
  { name: 'Island', slug: 'island', path: '/island/' },
  { name: 'Workshop', slug: 'workshop', path: '/workshop/' },
  { name: 'TownHall', slug: 'townhall', path: '/townhall/' },
  { name: 'Cellar', slug: 'cellar', path: '/cellar/' },
  { name: 'Glade',  slug: 'glade',  path: '/glade/' },
  { name: 'Canal',  slug: 'canal',  path: '/canal/' },
  { name: 'Mine',   slug: 'mine',   path: '/mine/' },
  { name: 'Range',  slug: 'range',  path: '/range/' },
  { name: 'Lane',   slug: 'lane',   path: '/lane/' },
  { name: 'Ravine', slug: 'ravine', path: '/ravine/' },
  { name: 'Jordan', slug: 'jordan', path: '/jordan/' },
  { name: 'Vlad',   slug: 'vlad',   path: '/vlad/' },
  { name: 'Colin',  slug: 'colin',  path: '/colin/' },
  { name: 'Sheriff', slug: 'sheriff', path: '/sheriff/' },
  { name: 'Market', slug: 'market', path: '/market/' },
  { name: 'Lodge',  slug: 'lodge',  path: '/lodge/' },
]

let loader = null

/**
 * Mount a scene with no room: `{ stage, frame, capture, dispose }`, `frame`
 * the rows the terminal drew of the stage's view, and `capture()` those rows
 * drawn again — after `stage.follow()` panned it. `name` is a scene's file
 * name under `src/scenes/`, or a path to a scene file elsewhere, which a
 * drive gives for a saved copy.
 */
export async function mountScene(name) {
  loader ??= await installTerminalLoader({ root: WEB })
  const path = name.endsWith('.mesa') ? name : join(WEB, 'src/scenes', `${name}.mesa`)
  const Component = (await import(path)).default
  const { renderer, renderOnce, captureCharFrame } = await tui.createHeadlessRenderer({ width: 100, height: 30 })
  const mounted = tui.mount(Component, { renderer })
  await new Promise((r) => setTimeout(r, 20))
  await renderOnce()
  const base = path.split('/').pop().replace(/\.mesa$/, '')
  const slug = SCENES.find((s) => s.name === base)?.slug ?? base.toLowerCase()
  const stage = stages.get(slug)
  if (!stage) throw new Error(`${name}.mesa made no stage named ${slug}`)
  const rows = () => {
    const v = stage.view
    return captureCharFrame().split('\n').slice(0, v.h).map((r) => r.slice(0, v.w).trimEnd())
  }
  return {
    stage,
    frame: rows(),
    async capture() { await renderOnce(); return rows() },
    dispose() { mounted.dispose(); renderer.destroy() },
  }
}

/**
 * A scene's stage, for a drive that reads its spawn, doors and palette. The
 * mount is kept: a piece frees its cells when it is destroyed, so a disposed
 * scene is an empty stage. The drive exits the process when it is done.
 */
export async function stageOf(name) {
  const { stage } = await mountScene(name)
  return stage
}
