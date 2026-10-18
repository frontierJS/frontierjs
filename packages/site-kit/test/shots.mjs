/*
 * shots.mjs — `site-kit shots` sees a light fill change that a color threshold
 * does not (`FJS-2265`).
 *
 * A site is built, its shots accepted, and the same build is shot again: no
 * difference. Then a stripe goes from #F0F4F8 to #FFFFFF, which is inside
 * Playwright's 0.2 tolerance, and the run must name the page and width and
 * write both PNGs. Needs Chrome; without it the test says so and passes.
 *
 * Run: node test/shots.mjs   (spawns bun, which the command needs)
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findChrome } from '../../mesa/src/drive.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SITE = join(ROOT, 'test', `.shots-site-${process.pid}`)

if (!findChrome()) {
  console.log('· no Chrome on this machine — shots not run')
  process.exit(0)
}

const failed = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `\n    ${detail}`}`)
  if (!ok) failed.push(label)
}

const write = (path, text) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

const run = (...args) => spawnSync('bun', [join(ROOT, 'bin/site-kit.js'), ...args, SITE], { encoding: 'utf8' })
const said = (r) => `${r.stdout}\n${r.stderr}`

try {
  write(join(SITE, 'content/routes/index.md'), '---\nrender: static\n---\n\n# Home\n\n====|.stripe\n\nA light stripe\n')
  const stripe = (fill) => write(join(SITE, 'content/settings/site.css'), `.stripe { background: ${fill}; padding: 3rem 0 }\n`)

  stripe('#F0F4F8')
  const built = run('build')
  check('the site builds', built.status === 0, said(built).slice(-600))

  const accepted = run('shots', '--accept')
  check('--accept keeps a shot per page and width', accepted.status === 0 && /6 shot\(s\)/.test(said(accepted)), said(accepted).slice(-600))

  const same = run('shots')
  check('the same build is identical to its accepted shots', same.status === 0 && /identical/.test(said(same)), said(same).slice(-600))

  stripe('#FFFFFF')
  const rebuilt = run('build')
  check('the changed site builds', rebuilt.status === 0, said(rebuilt).slice(-600))

  const changed = run('shots')
  const out = said(changed)
  check('a stripe gone from #F0F4F8 to white fails the run', changed.status === 1, out.slice(-600))
  check('and names the page and the width', /✗ \/ at 390px differs/.test(out) && /✗ \/ at 1536px differs/.test(out), out.slice(-600))
  const diff = join(SITE, '.site-kit/shots/diff')
  check('and writes both PNGs of each', existsSync(join(diff, 'index@390.before.png')) && existsSync(join(diff, 'index@390.after.png')))

  check('--accept takes the new look', run('shots', '--accept').status === 0 && run('shots').status === 0)
} finally {
  rmSync(SITE, { recursive: true, force: true })
}

if (failed.length) {
  console.log(`\n${failed.length} failed`)
  process.exit(1)
}
