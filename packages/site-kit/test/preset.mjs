/*
 * preset.mjs — a site that names a preset builds with it, or does not build.
 *
 * A preset carries a site's blocks and layouts, so a site whose preset fails
 * to load and builds anyway ships every page wrong. Each way of failing to
 * load one must stop siteKit() by name.
 *
 * Run: node test/preset.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { siteKit } from '../config/vite.js'

const failed = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `\n    ${detail}`}`)
  if (!ok) failed.push(label)
}

const TMP = mkdtempSync(join(tmpdir(), 'site-kit-preset-'))
const write = (path, text) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

/** A site naming `preset`, with `pkg` installed under its node_modules as {file: text}. */
function site(name, preset, pkg) {
  const root = join(TMP, name)
  write(join(root, 'content/routes/index.md'), '# Home\n')
  write(join(root, 'content/settings/site.js'), `export default { preset: ${JSON.stringify(preset)} }\n`)
  write(join(root, 'content/settings/site.md'), '---\ncompany: Acme\n---\n')
  for (const [file, text] of Object.entries(pkg ?? {})) write(join(root, 'node_modules/demo-preset', file), text)
  return root
}

const refuses = async (label, root, pattern) => {
  try {
    await siteKit({ root })
    check(label, false, 'siteKit() resolved')
  } catch (err) {
    check(label, pattern.test(err.message), err.message)
  }
}

const PKG = (exports) => JSON.stringify({ name: 'demo-preset', type: 'module', exports })

try {
  {
    const root = site('ok', 'demo-preset', {
      'package.json': PKG({ './preset': './preset.js' }),
      'shell.html':   '<body><script type="module" src="/@site-kit/main.js"></script></body>',
      'main.js':      '',
      'preset.js':    `export default ({ settings }) => ({
        plugins: [{ name: 'demo:' + settings.company }],
        shell: { html: new URL('shell.html', import.meta.url).pathname, entry: new URL('main.js', import.meta.url).pathname },
      })`,
    })
    const config = await siteKit({ root })
    const names = config.plugins.flat().map((p) => p?.name)
    check("a preset is handed the site's settings, site.md's front-matter", names.includes('demo:Acme'), names.join(', '))
    const shell = config.plugins.flat().find((p) => p?.name === 'site-kit:shell')
    check('the preset entry answers /@site-kit/main.js', shell?.resolveId('/@site-kit/main.js')?.endsWith('demo-preset/main.js'))
  }

  {
    const root = site('public', 'demo-preset', {
      'package.json': PKG({ './preset': './preset.js' }),
      'preset.js': 'export default () => ({})',
      'public/theme/mark.svg': '<svg>preset</svg>',
      'public/shared.txt': 'preset',
    })
    write(join(root, 'content/public/shared.txt'), 'site')
    const config = await siteKit({ root })
    const plugin = config.plugins.flat().find((p) => p?.name === 'site-kit:preset-public')
    // Dev: the middleware answers a preset file and steps aside for the site's.
    const serve = (url) => new Promise((done) => {
      let handler
      plugin?.configureServer({ middlewares: { use: (fn) => { handler = fn } } })
      if (!handler) return done('no middleware')
      const chunks = []
      const res = { setHeader() {}, write: (c) => chunks.push(Buffer.from(c)), on() { return res }, once() { return res }, emit() {}, end: (c) => { if (c) chunks.push(Buffer.from(c)); done(Buffer.concat(chunks).toString()) } }
      handler({ url, method: 'GET' }, res, () => done('next'))
    })
    check("dev serves a preset's public/ file", await serve('/theme/mark.svg') === '<svg>preset</svg>', await serve('/theme/mark.svg'))
    check("dev leaves a path the site's public/ has to the site", await serve('/shared.txt') === 'next')
    check('dev never serves outside the preset public/', await serve('/../preset.js') === 'next')
  }

  await refuses('a preset that is not installed stops the build', site('missing', 'demo-preset'), /names the preset 'demo-preset', which does not resolve/)
  await refuses('a package with no ./preset export stops the build',
    site('no-export', 'demo-preset', { 'package.json': PKG({ '.': './index.js' }), 'index.js': '' }),
    /which has no "\.\/preset" export/)
  await refuses('a preset whose default is not a function stops the build',
    site('not-fn', 'demo-preset', { 'package.json': PKG({ './preset': './preset.js' }), 'preset.js': 'export default {}' }),
    /is not a function of the site/)
  await refuses('a preset returning a key site-kit does not read stops the build',
    site('unknown-key', 'demo-preset', { 'package.json': PKG({ './preset': './preset.js' }), 'preset.js': 'export default () => ({ routesDir: "pages" })' }),
    /returned 'routesDir'/)
  await refuses('a preset that is not a string stops the build', site('not-string', 42), /is a number; it is a package name/)
  // Sierra writes both host files after the build emits, so a copy in either
  // public/ ships or vanishes depending on what the routes declare.
  await refuses("a preset's public/_redirects stops the build",
    site('preset-redirects', 'demo-preset', {
      'package.json': PKG({ './preset': './preset.js' }), 'preset.js': 'export default () => ({})', 'public/_redirects': '/a/ /b/\n',
    }),
    /the preset's public\/_redirects — Sierra writes _redirects/)
  {
    const root = site('public-redirects', 'demo-preset', { 'package.json': PKG({ './preset': './preset.js' }), 'preset.js': 'export default () => ({})' })
    write(join(root, 'content/public/_redirects'), '/a/ /b/\n')
    await refuses("a site's content/public/_redirects stops the build, naming content/settings/", root,
      /content\/public\/_redirects — a site's redirects are content\/settings\/_redirects/)
  }
} finally {
  rmSync(TMP, { recursive: true, force: true })
}

if (failed.length) {
  console.error(`\n${failed.length} failed`)
  process.exit(1)
}
