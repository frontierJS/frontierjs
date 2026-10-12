/*
 * words-build.mjs — a divider word no stylesheet defines stops `site-kit
 * build`, and the same site builds once its stylesheet defines the word.
 *
 * test/dialect.mjs calls the check by hand; this proves Sierra calls it, after
 * the pages are written, with the stylesheets the build actually emitted.
 * The site is written under test/ rather than the OS temp directory, so it
 * resolves vite and @frontierjs/* the way a workspace site does.
 *
 * Run: node test/words-build.mjs   (spawns bun, which the command needs)
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SITE = join(ROOT, 'test', `.words-site-${process.pid}`)

const failed = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `\n    ${detail}`}`)
  if (!ok) failed.push(label)
}

const write = (path, text) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

const build = () => spawnSync('bun', [join(ROOT, 'bin/site-kit.js'), 'build', SITE], { encoding: 'utf8' })

try {
  write(join(SITE, 'content/routes/index.md'), [
    '---', 'render: static', '---', '', '# Home', '', '====|.duo.split', '', 'WELCOME', '', '## Hello', '', '===', '', 'Right side', '',
    '====|.nghit', '', 'Night', '',
  ].join('\n'))
  write(join(SITE, 'content/settings/site.css'), '.duo { gap: 2rem }\n')

  const refused = build()
  const said = `${refused.stdout}\n${refused.stderr}`
  check('a word no stylesheet defines fails the build', refused.status !== 0, said.slice(-600))
  check('the failure names the file, the divider and the word',
    /content\/routes\/index\.md {2}====\|\.nghit {2}"nghit"/.test(said), said.slice(-600))
  check('a defined word is not named', !/"duo"/.test(said))

  write(join(SITE, 'content/settings/site.css'), '.duo { gap: 2rem }\n.nghit { color: navy }\n')
  const built = build()
  check('the same site builds once its stylesheet defines the word', built.status === 0, `${built.stdout}\n${built.stderr}`.slice(-600))
  if (built.status === 0) {
    const html = readFileSync(join(SITE, 'dist/index.html'), 'utf8')
    check('the built page carries the band, its container and both articles',
      // Mesa appends its scope class to each.
      /class="band duo[ "]/.test(html) && /class="container split[ "]/.test(html) && (html.match(/<article/g) ?? []).length === 2)
    check('the built page carries the kicker', /<p class="kicker[^"]*"[^>]*>WELCOME<\/p>/.test(html))
  }
} finally {
  rmSync(SITE, { recursive: true, force: true })
}

if (failed.length) {
  console.log(`\n${failed.length} failed`)
  process.exit(1)
}
