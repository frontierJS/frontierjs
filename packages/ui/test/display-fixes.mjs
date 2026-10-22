/*
 * display-fixes.mjs
 * FJS-2610: the display components' small defects that a server render can
 * see -- a page past the last or typed as a string, and a breadcrumb limit of
 * one.
 *
 * Run: node test/display-fixes.mjs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderComponent } from '../../mesa/src/render-component.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

async function render(file, data) {
  const out = await renderComponent(readFileSync(join(ROOT, file), 'utf8'), {
    data, cwd: ROOT, filename: file, styleTag: false,
    tmpDir: join(ROOT, 'components', '.mesa-tmp'),
  })
  return out.html
}

let failed = 0
const check = (ok, label) => { if (!ok) { console.error(`✗ ${label}`); failed++ } }
const PAGINATION = 'components/display/Pagination.mesa'

// Past the last page: 30 items at 25 a page is two pages, and page 9 is page 2.
{
  const html = await render(PAGINATION, { page: 9, total: 30, perPage: 25 })
  check(html.includes('Showing 26–30 of 30'), `a page past the end reads as the last page's range: ${html.match(/Showing[^<]*/)?.[0]}`)
  check(/aria-current="page"[^>]*>\s*2\s*</.test(html) || /aria-label="Page 2"[^>]*aria-current="page"/.test(html), 'and marks the last page current')
  const prev = html.match(/<button[^>]*aria-label="Previous page"[^>]*>/)?.[0] ?? ''
  check(!/disabled/.test(prev), 'so Previous is live')
}

// A page off a URL or an <input> is a string, and '3' + 1 is '31'.
{
  const html = await render(PAGINATION, { page: '3', total: 200, perPage: 20, compact: true })
  check(html.includes('Page 3 of 10'), `a string page reads as its number: ${html.match(/Page [^<]*/)?.[0]}`)
  check(html.includes('Showing 41–60 of 200'), `and so does its range: ${html.match(/Showing[^<]*/)?.[0]}`)
}

// maxItems of one is the current page alone, not every crumb.
{
  const items = [{ label: 'Home', href: '/' }, { label: 'Settings', href: '/s' }, { label: 'Keys' }]
  const html = await render('components/display/Breadcrumbs.mesa', { items, maxItems: 1 })
  check((html.match(/<li/g) ?? []).length === 1 && html.includes('Keys') && !html.includes('Home'),
    `maxItems={1} shows only the current page: ${(html.match(/<li/g) ?? []).length} crumbs`)
}

// FJS-2120: a size writes a type-scale rung, never a literal rem -- a theme that
// rescales --text-* has to reach a sized control.
{
  const SIZED = [
    ['components/forms/Button.mesa',   ['xs', 'sm', 'lg']],
    ['components/display/Badge.mesa',  ['xs', 'md']],
    ['components/display/Pill.mesa',   ['xs', 'md']],
    ['components/display/Kbd.mesa',     ['xs', 'md']],
    ['components/display/Mono.mesa',   ['xs', 'md']],
  ]
  for (const [file, sizes] of SIZED) {
    for (const size of sizes) {
      const html = await render(file, { size })
      const style = html.match(/style="([^"]*)"/)?.[1] ?? ''
      check(/font-size:\s*var\(--text-[a-z0-9]+\)/.test(style) && !/font-size:\s*[\d.]+r?em/.test(style),
        `${file} size=${size} reads the type scale: ${style || html.slice(0, 80)}`)
    }
  }
}

// FJS-3233: a hue that is the data reaches a Slider as --data-accent, the one
// custom property name Invariant 13 lets carry a raw color; the tone is the fallback.
{
  const file = 'components/forms/Slider.mesa'
  const out = await renderComponent(readFileSync(join(ROOT, file), 'utf8'), {
    data: {}, cwd: ROOT, filename: file, styleTag: false,
    tmpDir: join(ROOT, 'components', '.mesa-tmp'),
  })
  const accent = (out.css ?? '').match(/--slider-accent:\s*([^;]*);/)?.[1] ?? ''
  check(/^var\(--data-accent,\s*var\(--bg-mix,/.test(accent), `--slider-accent reads --data-accent before the tone: ${accent}`)
}

// FJS-3402: a Table that sorts its own rows holds no schema, so a column the
// schema declares nocase is told to it; unstated, a column is BINARY.
{
  const host = (attrs) => `<script>
  import Table from './display/Table.mesa'
  const columns = [{ name: 'name', label: 'Name', sortable: true }]
  const rows = [{ name: 'BNI' }, { name: 'Bing' }, { name: 'apple' }]
</script>
<Table {columns} {rows} orderBy="name" ${attrs}>
  {#snippet row(r)}<tr><td class="n">{r.name}</td></tr>{/snippet}
</Table>`
  const names = async (attrs) => {
    const out = await renderComponent(host(attrs), {
      data: {}, cwd: ROOT, filename: 'components/Host.mesa', styleTag: false,
      tmpDir: join(ROOT, 'components', '.mesa-tmp'),
    })
    return [...out.html.matchAll(/<td class="n[^"]*">([^<]*)</g)].map(m => m[1]).join(',')
  }
  const nocase = await names(`collations={{ name: 'nocase' }}`)
  check(nocase === 'apple,Bing,BNI', `a column stated nocase sorts apple, Bing, BNI: ${nocase}`)
  const binary = await names('')
  check(binary === 'BNI,Bing,apple', `an unstated column stays BINARY: ${binary}`)
}

console.log(failed ? `${failed} display-fixes case(s) failed` : 'display-fixes cases hold')
if (failed) process.exit(1)
