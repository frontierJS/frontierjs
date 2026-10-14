/*
 * check.mjs — `site-kit check` over a site it writes and builds: each kit rule
 * group fires on the defect planted for it, a preset's rules run beside the
 * kit's, one with a kit rule's id replaces it (FJS-D962), and the command
 * exits 1 on an error.
 *
 * Bun, not node: the context parses front-matter with Bun.YAML, as the command does.
 * The site is written under test/ so it resolves @frontierjs/* the way a
 * workspace site does.
 *
 * Run: bun test/check.mjs
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { siteKit } from '../config/vite.js'
import { runCheck } from '../check/run.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SITE = join(ROOT, 'test', `.check-site-${process.pid}`)

const failed = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `\n    ${detail}`}`)
  if (!ok) failed.push(label)
}
const write = (path, text) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}
const PKG = (exports) => JSON.stringify({ name: 'demo-preset', type: 'module', exports })
const PRESET = `
const demo = { id: 'demo', group: 'Template', stage: 'source', run: (ctx) => [
  { level: 'warn', key: 'demo-fired', message: 'settings ' + Object.keys(ctx.settings).join() + ' flags ' + Object.keys(ctx.opts.flags).join() + ' preset ' + ctx.preset.name, atLaunch: true },
] }
const headings = { id: 'headings', group: 'Meta tags', stage: 'built', run: (ctx) => [
  { level: 'info', key: 'headings-replaced', message: 'pages ' + ctx.html.checked.length },
] }
const crashes = { id: 'crashes', group: 'Template', stage: 'source', run: () => { throw new Error('boom') } }
export default () => ({ rules: [demo, headings, crashes] })
`

try {
  write(join(SITE, 'node_modules/demo-preset/package.json'), PKG({ './preset': './preset.js' }))
  write(join(SITE, 'node_modules/demo-preset/preset.js'), PRESET)
  write(join(SITE, 'content/settings/site.js'), `export default { preset: 'demo-preset', siteUrl: 'https://acme.test' }\n`)
  write(join(SITE, 'content/settings/site.md'), '---\ncompany_name: Acme\n---\n')
  write(join(SITE, 'content/routes/index.md'), [
    '---', 'render: static', 'title: Home', 'description: The home page.', '---', '',
    '# Welcome to {company_name}', '',
    'Call {company_phone} today.', '',
    '<Nope />', '',
    'A line of text', '====', '',
    '[Pricing](/pricing/) and ![](/media/none.png)', '',
    '<img src="/media/none.png">', '',
  ].join('\n'))
  write(join(SITE, 'content/routes/about.md'), ['---', 'render: static', 'layout: Nowhere', 'title: About', '---', '', 'About us.', ''].join('\n'))
  write(join(SITE, 'content/routes/broken.md'), ['---', 'title: [unclosed', '---', '', 'Body.', ''].join('\n'))

  // ─── the source stage, before any build ───────────────────────────────────
  {
    const r = await runCheck({ root: SITE, stages: ['source'], flags: { launch: true } })
    const by = (key) => r.findings.filter((f) => f.key === key)
    const where = (key) => by(key).flatMap((f) => f.where ?? []).map((w) => `${w.file}:${w.line}`)
    check('an unknown component is an error naming the file and line', by('unknown-component')[0]?.level === 'error' && where('unknown-component').includes('content/routes/index.md:11'), where('unknown-component').join())
    check("the message names the directories the build searches", /looked for Nope\.md or Nope\.mesa in no directory/.test(by('unknown-component')[0]?.message ?? ''), by('unknown-component')[0]?.message)
    check('an unknown layout is an error naming the kit\'s layouts directory', by('unknown-layout')[0]?.level === 'error' && /src\/layouts/.test(by('unknown-layout')[0]?.message), by('unknown-layout')[0]?.message)
    check('a merge field site.md does not hold is an error', by('unknown-merge-field')[0]?.message.includes('{company_phone}'), JSON.stringify(by('unknown-merge-field')))
    check('a divider with no blank line above is a warning', where('divider-no-blank-line').includes('content/routes/index.md:14'), where('divider-no-blank-line').join())
    check('front-matter that is not YAML is an error', where('frontmatter-invalid').includes('content/routes/broken.md:1'), where('frontmatter-invalid').join())
    check("a preset rule runs, reading the settings, the flags and the preset's name",
      by('demo-fired')[0]?.message === 'settings company_name flags launch preset demo-preset', by('demo-fired')[0]?.message)
    check("a preset's group sorts after the kit's", r.findings.findIndex((f) => f.group === 'Template') > r.findings.findIndex((f) => f.group === 'Content'))
    check('a preset rule that throws is one check-crashed error naming it', by('check-crashed')[0]?.message === 'The crashes check crashed: boom', by('check-crashed')[0]?.message)
    const both = await runCheck({ root: SITE, stages: ['source', 'built'] })
    check('built rules do not run without a build, and the report says so', !both.rules.includes('links') && both.notes.some((n) => /No build in dist/.test(n)), `${both.rules.join()} ${both.notes.join()}`)
    check('--only narrows to one rule', (await runCheck({ root: SITE, stages: ['source'], only: ['dividers'] })).rules.join() === 'dividers')
  }

  // ─── the built stage ───────────────────────────────────────────────────────
  // The source defects that stop a build (an unknown tag or layout, FJS-1495)
  // go; the built rules read what the build wrote.
  rmSync(join(SITE, 'content/routes/broken.md'))
  write(join(SITE, 'content/routes/index.md'), [
    '---', 'render: static', 'title: Home', 'description: The home page.', '---', '',
    '# Welcome to {company_name}', '',
    '[Pricing](/pricing/) and ![](/media/none.png)', '',
    '<img src="/media/none.png">', '',
  ].join('\n'))
  write(join(SITE, 'content/routes/about.md'), ['---', 'render: static', 'title: About', '---', '', 'About us.', ''].join('\n'))
  const built = spawnSync('bun', [join(ROOT, 'bin/site-kit.js'), 'build', SITE], { encoding: 'utf8' })
  check('the site builds', built.status === 0, `${built.stdout}\n${built.stderr}`.slice(-1200))
  if (built.status === 0) {
    const r = await runCheck({ root: SITE })
    const by = (key) => r.findings.filter((f) => f.key === key)
    check('the build is read: indexable pages come from the sitemap', r.source === 'dist' && r.pages.includes('/') && r.pages.includes('/about/'), r.pages.join())
    check('a link to a page the build lacks is an error', by('broken-link').some((f) => f.message.includes('/pricing/')), JSON.stringify(by('broken-link')))
    check('an image the build lacks is an error', by('image-missing').some((f) => f.message.includes('/media/none.png')))
    check('an image with no alt is a warning', by('image-alt-missing').length === 1)
    check('a page with no description is a warning naming it', by('description-missing')[0]?.pages.join() === '/about/', JSON.stringify(by('description-missing')))
    check("a preset rule with a kit rule's id replaces it", by('headings-replaced')[0]?.message === 'pages 2' && by('h1-missing').length === 0, JSON.stringify(by('h1-missing')))
    check('the kit\'s schema rule runs with no fix hints', r.rules.includes('schema') && r.findings.filter((f) => f.rule === 'schema').every((f) => f.fix === undefined))

    const cmd = (...args) => spawnSync('bun', [join(ROOT, 'bin/site-kit.js'), 'check', SITE, ...args], { encoding: 'utf8' })
    const run = cmd()
    check('the command exits 1 on an error and prints the report', run.status === 1 && /✗ error\s+broken-link/.test(run.stdout) && /site-kit check — https:\/\/acme\.test · demo-preset/.test(run.stdout), run.stdout.slice(0, 400) + run.stderr)
    check('a preset\'s own flag is marked in the report', /\[error at launch\]/.test(cmd('--launch').stdout))
    const json = cmd('--json', '--source', '--only', 'dividers')
    const parsed = (() => { try { return JSON.parse(json.stdout) } catch { return null } })()
    check('--json is the result, and --source with --only narrows it', parsed?.rules.join() === 'dividers' && parsed.counts.error === 0 && json.status === 0, json.stdout.slice(0, 300))
    check('a directory with no content/ exits 2', spawnSync('bun', [join(ROOT, 'bin/site-kit.js'), 'check', join(SITE, 'dist')], { encoding: 'utf8' }).status === 2)
  }

  // ─── what loadPreset refuses ───────────────────────────────────────────────
  // One site each: an imported module is cached by its URL for the process.
  let n = 0
  const refuses = async (label, preset, pattern) => {
    const root = join(SITE, `refused-${++n}`)
    write(join(root, 'content/routes/index.md'), '# Home\n')
    write(join(root, 'content/settings/site.js'), `export default { preset: 'demo-preset' }\n`)
    write(join(root, 'node_modules/demo-preset/package.json'), PKG({ './preset': './preset.js' }))
    write(join(root, 'node_modules/demo-preset/preset.js'), preset)
    try {
      await siteKit({ root })
      check(label, false, 'siteKit() resolved')
    } catch (err) {
      check(label, pattern.test(err.message), err.message)
    }
  }
  await refuses('rules that are not a list stop the build', 'export default () => ({ rules: {} })', /returned rules that are not a list/)
  await refuses('a rule missing a key stops the build naming it', "export default () => ({ rules: [{ id: 'x', group: 'G', run() {} }] })", /a rule \(index 0, 'x'\) without stage/)
  await refuses('a rule with a stage that is neither source nor built stops the build', "export default () => ({ rules: [{ id: 'x', group: 'G', stage: 'live', run() {} }] })", /'x' with stage 'live'/)
} finally {
  rmSync(SITE, { recursive: true, force: true })
}

if (failed.length) {
  console.error(`\n${failed.length} failed`)
  process.exit(1)
}
