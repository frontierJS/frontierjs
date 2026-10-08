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
  write(join(root, 'content/settings/site.js'), `export const company = 'Acme'\nexport default { preset: ${JSON.stringify(preset)} }\n`)
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
    check('a preset is handed the settings module, named exports included', names.includes('demo:Acme'), names.join(', '))
    const shell = config.plugins.flat().find((p) => p?.name === 'site-kit:shell')
    check('the preset entry answers /@site-kit/main.js', shell?.resolveId('/@site-kit/main.js')?.endsWith('demo-preset/main.js'))
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
} finally {
  rmSync(TMP, { recursive: true, force: true })
}

if (failed.length) {
  console.error(`\n${failed.length} failed`)
  process.exit(1)
}
