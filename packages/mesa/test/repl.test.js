/**
 * repl.test.js — the browser REPL (`index.html` + `examples.js`).
 *
 * The REPL had no test at all, and had been broken twice over:
 *
 *   1. index.html imported `DEFAULT_EXAMPLE`, which examples.js had stopped
 *      exporting. A missing named export is a LINK-time error in ESM, so the
 *      whole script module never ran — blank page, one console SyntaxError.
 *   2. It mounted by calling the component function directly. Delegation roots
 *      are registered only by mount(), so every example rendered correctly and
 *      responded to no event whatsoever.
 *
 * Neither is subtle once you look, and neither was visible from the source.
 * This file exists so they cannot come back quietly.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { compileSource } from '../src/compiler.js'
import * as $rt from '../src/runtime.js'
import { EXAMPLES, EXAMPLE_GROUPS, DEFAULT_EXAMPLE } from '../example/examples.js'

/** The REPL's own directory — every specifier in index.html resolves from here. */
const REPL_DIR = path.join(process.cwd(), 'example')
const INDEX = readFileSync(path.join(REPL_DIR, 'index.html'), 'utf8')

/**
 * index.html's own execCompiled, transcribed — including the userImports
 * plumbing, without which no multi-file example can run.
 */
function execCompiled(compiledJs, userImports = {}) {
  const names = [], vals = []
  const re = /^import\s+(.+?)\s+from\s+'([^']+)';$/gm
  let m
  while ((m = re.exec(compiledJs)) !== null) {
    const spec = m[1].trim(), src = m[2]
    if (src === '@frontierjs/mesa/runtime.js') continue
    const mock = userImports[src] || {}
    if (spec.startsWith('* as ')) {
      names.push(spec.slice(5).trim()); vals.push(mock)
    } else if (spec.startsWith('{')) {
      spec.replace(/^\{|\}$/g, '').trim().split(',').forEach((b) => {
        const [o, a] = b.trim().split(/\s+as\s+/)
        names.push((a || o).trim()); vals.push(mock[o.trim()])
      })
    } else if (spec.includes(',')) {
      const [defPart, namedPart] = spec.split(/,\s*\{/)
      names.push(defPart.trim()); vals.push(mock['default'])
      if (namedPart) namedPart.replace('}', '').split(',').forEach((b) => {
        const [o, a] = b.trim().split(/\s+as\s+/)
        names.push((a || o).trim()); vals.push(mock[o.trim()])
      })
    } else {
      names.push(spec); vals.push(mock['default'])
    }
  }
  let code = compiledJs.replace(/^import\s+.+?from\s+'[^']+';$/gm, '').trim()
  code = code.replace(/^export default\s+/m, 'const __component = ')
  // <script module> named exports — new Function() rejects an export declaration.
  code = code.replace(/^(\s*)export (function|class|const|let|var) /gm, '$1$2 ')
  return new Function('$$runtime', ...names, code + '\nreturn __component')($rt, ...vals)
}

/** index.html's evalExtraFile, transcribed. */
async function evalExtraFile(file, allUserImports) {
  const { name, content } = file
  if (name.endsWith('.mesa')) {
    const ctx = await compileSource(content, { filename: name, css: false, debug: false })
    return { default: execCompiled(ctx.result, allUserImports) }
  }
  const namedRe = /^export\s+(const|let|var)\s+(\w+)\s*=/gm
  const fnRe = /^export\s+function\s+(\w+)/gm
  const names = [], fnNames = []
  let m
  while ((m = namedRe.exec(content)) !== null) names.push(m[2])
  while ((m = fnRe.exec(content)) !== null) fnNames.push(m[1])
  let code = content
    .replace(/^export\s+default\s+/mg, 'var __default = ')
    .replace(/^export\s+(const|let|var|function|class)\s+/mg, '$1 ')
  code += '\n'
  ;[...names, ...fnNames].forEach((n) => {
    code += `if(typeof ${n}!=='undefined') __exports.${n}=${n};\n`
  })
  code += 'if(typeof __default!=="undefined") __exports.default=__default;\n'
  const exports = {}
  new Function('__exports', code)(exports)
  return exports
}

describe('REPL module graph', () => {
  it('every name index.html imports from a local module actually exists', async () => {
    // The failure this catches is not a bad render — it is the entire script
    // module refusing to link, which no amount of example testing would show.
    // `../` as well as `./` — the REPL lives in example/ and imports the
    // library from ../src/. Matching only './' would skip every library
    // import and leave this test asserting nothing about them.
    const re = /import\s*\{([^}]+)\}\s*from\s*'(\.\.?\/[^']+)'/g
    const checked = []
    let m
    while ((m = re.exec(INDEX)) !== null) {
      // Resolve from the REPL's directory, not the package root, and keep the
      // whole specifier rather than a basename — '../src/compiler.js' and
      // './examples.js' live in different places and neither is beside this test.
      const abs = path.resolve(REPL_DIR, m[2])
      // index.html also embeds example sources as template literals, and those
      // import REPL-virtual files ('./store.js') that exist only in the editor.
      // Only real files on disk are module-graph imports.
      if (!existsSync(abs)) continue
      const names = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean)
      const mod = await import(/* @vite-ignore */ pathToFileURL(abs).href)
      for (const name of names) {
        expect(mod, `${m[2]} does not export '${name}' (index.html imports it)`)
          .toHaveProperty(name)
      }
      checked.push(path.relative(process.cwd(), abs))
    }
    // Guard the guard: if the regex stops matching, this test silently passes.
    expect(checked).toEqual(expect.arrayContaining(['src/compiler.js', 'example/examples.js']))
  })

  it('DEFAULT_EXAMPLE names a real example', () => {
    expect(typeof DEFAULT_EXAMPLE).toBe('string')
    expect(EXAMPLES).toHaveProperty(DEFAULT_EXAMPLE)
  })

  it('every example is well-formed and grouped', () => {
    for (const [key, ex] of Object.entries(EXAMPLES)) {
      expect(ex.file, `${key}.file`).toMatch(/\.(mesa|md)$/)
      expect(typeof ex.src, `${key}.src`).toBe('string')
      expect(ex.group, `${key}.group`).toBeTruthy()
    }
    const grouped = Object.values(EXAMPLE_GROUPS).flat().length
    expect(grouped).toBe(Object.keys(EXAMPLES).length)
  })
})

describe('REPL examples compile', () => {
  const entries = Object.entries(EXAMPLES)

  // Compile with the REPL's own options, not the defaults — it passes
  // `css: false, debug: false`, and CSS scoping changes what the compiler emits.
  const compileLikeRepl = (src, filename) =>
    compileSource(src, { filename, css: false, debug: false })

  it(`all ${entries.length} examples compile without errors or warnings`, async () => {
    const bad = []
    for (const [key, ex] of entries) {
      for (const f of [{ name: ex.file, content: ex.src }, ...(ex.files ?? [])]) {
        if (!f.name.endsWith('.mesa') && !f.name.endsWith('.md')) continue
        try {
          const ctx = await compileLikeRepl(f.content, f.name)
          const errs = ctx.analysis?.errors ?? []
          const warns = ctx.analysis?.warnings ?? []
          if (errs.length || warns.length) bad.push(`${key}/${f.name}: ${[...errs, ...warns].join(' | ')}`)
        } catch (e) {
          bad.push(`${key}/${f.name}: threw ${e.message}`)
        }
      }
    }
    expect(bad).toEqual([])
  })

  it('compiled output is valid JavaScript', async () => {
    // Compiling without errors is not the same as emitting code that parses.
    // Two compiler bugs found on 2026-08-02 — assignment inside `$: { }`, and
    // `bind:` on a component — produced clean compiles and invalid JS, which
    // only surfaced when the REPL tried to run them.
    const bad = []
    for (const [key, ex] of entries) {
      for (const f of [{ name: ex.file, content: ex.src }, ...(ex.files ?? [])]) {
        if (!f.name.endsWith('.mesa') && !f.name.endsWith('.md')) continue
        const ctx = await compileLikeRepl(f.content, f.name)
        // index.html's exact transformation, including stripping `export`
        // from <script module> named exports.
        const code = ctx.result
          .replace(/^import\s+.+?from\s+'[^']+';$/gm, '')
          .replace(/^export default\s+/m, 'const __component = ')
          .replace(/^(\s*)export (function|class|const|let|var) /gm, '$1$2 ')
        try { new Function('$$runtime', code) } catch (e) { bad.push(`${key}/${f.name}: ${e.message}`) }
      }
    }
    expect(bad).toEqual([])
  })
})

describe('REPL examples run', () => {
  // Compiling and parsing is not running. On 2026-08-04 every example using
  // `{#each xs as x, i}` threw "i is not a function" on first render — the
  // runtime's makeBlock() factory took only `(v)` and dropped the index getter
  // $$eachBlock passes as its second argument. Both tests above were green:
  // the emission was correct, the runtime contract was not. This is the ratchet
  // that only a real mount can hold.
  //
  // Multi-file examples run too — their `files` are compiled and evaluated into
  // userImports first, exactly as index.html does. Only an example importing a
  // BARE specifier is out of reach: `@ui/...` is fetched over the network by the
  // real REPL, and there is no network here.
  const isRelative = (src) =>
    [...src.matchAll(/^\s*import\s.+?\sfrom\s+'([^']+)'/gm)].every((m) => m[1].startsWith('.'))
  const runnable = Object.entries(EXAMPLES).filter(
    ([, ex]) => ex.file.endsWith('.mesa') &&
      isRelative(ex.src) && (ex.files ?? []).every((f) => isRelative(f.content))
  )

  it(`all ${runnable.length} runnable examples mount and render`, async () => {
    // happy-dom has no Web Animations API; the entrance/exit example calls
    // el.animate(). Stub it so the example runs rather than being skipped.
    const proto = globalThis.Element?.prototype
    const hadAnimate = proto && 'animate' in proto
    if (proto && !hadAnimate) {
      proto.animate = () => ({ finished: Promise.resolve(), cancel() {}, finish() {}, onfinish: null })
    }
    const bad = []
    try {
      for (const [key, ex] of runnable) {
        const ctx = await compileSource(ex.src, { filename: ex.file, css: false, debug: false })
        const container = document.createElement('div')
        document.body.appendChild(container)
        const label = document.createElement('span')
        container.appendChild(label)
        try {
          // The REPL keys userImports by specifier — './Panel.mesa' — and lets a
          // later file import an earlier one through the same object.
          const userImports = {}
          for (const f of ex.files ?? []) {
            userImports[`./${f.name}`] = await evalExtraFile(f, userImports)
          }
          let instance, disposeRoot
          $rt.createRoot((dispose) => {
            disposeRoot = dispose
            instance = $rt.mount(label, execCompiled(ctx.result, userImports), { props: {}, root: container })
            $rt.flushSync()
          })
          disposeRoot(); instance.destroy()
        } catch (e) {
          bad.push(`${key}/${ex.file}: ${e.message}`)
        }
        container.remove()
      }
    } finally {
      if (proto && !hadAnimate) delete proto.animate
    }
    expect(bad).toEqual([])
  })

  it('an indexed {#each} row is given both item and index getters', async () => {
    // The narrow pin on the bug above — compiled emission calls i() and the
    // block factory must forward $$eachBlock's second argument to reach it.
    const src = `<script>\n  let xs = ['a', 'b']\n</script>\n` +
      `<ul>{#each xs as x, i (x)}<li>{i}:{x}</li>{/each}</ul>`
    const ctx = await compileSource(src, { filename: 'Indexed.mesa', css: false, debug: false })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const label = document.createElement('span')
    container.appendChild(label)

    let instance, disposeRoot
    $rt.createRoot((dispose) => {
      disposeRoot = dispose
      instance = $rt.mount(label, execCompiled(ctx.result), { props: {}, root: container })
      $rt.flushSync()
    })
    expect([...container.querySelectorAll('li')].map((l) => l.textContent)).toEqual(['0:a', '1:b'])

    disposeRoot(); instance.destroy(); container.remove()
  })
})

describe('REPL examples cover the language', () => {
  // The REPL is Mesa's documentation. A feature with no example is a feature
  // nobody can discover, and on 2026-08-02 sixteen documented features had
  // none — including {#await} and <slot>. This is the ratchet.
  const corpus = Object.values(EXAMPLES)
    .flatMap((ex) => [ex.src, ...(ex.files ?? []).map((f) => f.content)])
    .join('\n')

  const FEATURES = {
    '{#if}': /\{#if\b/,               '{#each}': /\{#each\b/,
    '{#await}': /\{#await\b/,         '{#key}': /\{#key\b/,
    '{#snippet}': /\{#snippet\b/,     '{@render}': /\{@render\b/,
    '{@html}': /\{@html\b/,           '{@attach}': /\{@attach\b/,
    '{#virtual each}': /\{#virtual\s+each\b/,
    '<slot>': /<slot[\s/>]/,          'named slot': /\bslot="/,
    '<mesa:boundary>': /<mesa:boundary/, '<mesa:mounted>': /<mesa:mounted/,
    '<mesa:portal>': /<mesa:portal/,  '<mesa:window>': /<mesa:window/,
    '<mesa:head>': /<mesa:head/,      '<mesa:document>': /<mesa:document/,
    '<mesa:body>': /<mesa:body/,
    '$: auto-effect': /\$:\s*\{/,     '$: multi-path watch': /\$:\s*\([\w.]+\s*,/,
    '$: watch+handler': /\$:\s*[\w.]+\s*,\s*(\(|async|\w)/,
    '$.mounted()': /\$\.mounted\s*\(/, '$context': /(?<![\w$])\$context\b/,
    '$.onMount': /\$\.onMount\s*\(/,
    '{class} shorthand': /\{class\}/,
    'export let prop': /export\s+let\s/, 'export const prop': /export\s+const\s/,
    'export var prop': /export\s+var\s/,
    'bind:value': /bind:value/,       'bind:group': /bind:group/,
    '<script module>': /<script\s+module>/,
    'nested CSS': /&[.:&\w]/,         ':global()': /:global\(/,
    '@layer': /@layer/,               '@container': /@container/,
    '@apply': /@apply/,               '@keyframes': /@keyframes/,
    // Added 2026-08-05. Each of these was fully implemented and entirely
    // undemonstrated; three of them were also broken, which is the same fact
    // seen from the other side.
    '$attributes': /(?<![\w$])\$attributes\b/, '$props': /(?<![\w$])\$props\b/,
    '$slots': /(?<![\w$])\$slots\b/,
    'spread attributes': /\{\.\.\.\w/,
    'bind:value|mask': /bind:value\|mask/,
    '$: { dep, handler }': /\$:\s*\{[^}]*=>\s*\{/,
    '$: path on a local object': /\$:\s*\w+\.\w+\s*,\s*\(/,
    'indexed {#each}': /\{#each\s+[\w.]+\s+as\s+\w+\s*,\s*\w+/,
    'nested {#each}': /\{#each[\s\S]*\{#each[\s\S]*\{\/each\}[\s\S]*\{\/each\}/,
    'Map/Set state': /new (Map|Set)\(/,
    'delete obj.key': /\bdelete\s+\w+\.\w/,
    '<select multiple>': /<select[^>]*\bmultiple\b/,
    'bind:files': /bind:files/,
    'object option value': /<option value=\{\w+\}/,
  }

  it('every documented feature appears in at least one example', () => {
    const missing = Object.entries(FEATURES)
      .filter(([, re]) => !re.test(corpus))
      .map(([name]) => name)
    expect(missing).toEqual([])
  })
})

describe('REPL preview is interactive', () => {
  it('mounts through mount(), so delegated events fire', async () => {
    // Mirrors the mount sequence in index.html. If that sequence regresses to
    // calling the component directly, this fails: the click does nothing.
    const ctx = await compileSource(EXAMPLES[DEFAULT_EXAMPLE].src, {
      filename: EXAMPLES[DEFAULT_EXAMPLE].file, dev: false,
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const label = document.createElement('span')
    container.appendChild(label)

    let instance, disposeRoot
    $rt.createRoot((dispose) => {
      disposeRoot = dispose
      instance = $rt.mount(label, execCompiled(ctx.result), { props: {}, root: container })
      $rt.flushSync()
    })

    const read = () => container.textContent.match(/count:\s*(-?\d+)/)?.[1]
    expect(read()).toBe('0')

    const plus = [...container.querySelectorAll('button')].find((b) => b.textContent.trim() === '+')
    expect(plus, 'Counter example should have a "+" button').toBeTruthy()
    plus.click()
    $rt.flushSync()
    expect(read()).toBe('1')

    disposeRoot(); instance.destroy(); container.remove()
  })

  it('index.html mounts via mount() and owns the instance with createRoot', () => {
    // A structural guard on the file itself — the behavioral test above uses a
    // transcription, so this is what ties it to the real thing.
    const preview = INDEX.slice(INDEX.indexOf('// Mount new component'), INDEX.indexOf('setPvStatus(\'ok\')'))
    const code = preview.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
    expect(code).toMatch(/\$rt\.mount\(/)
    expect(code).toMatch(/\$rt\.createRoot\(/)
    expect(code).not.toMatch(/componentFn\(anchor/)   // the direct call is the bug
  })

  it('disposing an instance stops its effects', () => {
    // Switching examples used to clear innerHTML and leave the graph alive.
    const [n, setN] = $rt.createSignal(0)
    let runs = 0
    const Comp = (anchor) => {
      const p = document.createElement('p')
      $rt.createEffect(() => { p.textContent = String(n()); runs++ })
      anchor.before(p)
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const label = document.createElement('span')
    container.appendChild(label)

    let instance, disposeRoot
    $rt.createRoot((dispose) => {
      disposeRoot = dispose
      instance = $rt.mount(label, Comp, { props: {}, root: container })
      $rt.flushSync()
    })
    expect(runs).toBe(1)

    disposeRoot(); instance.destroy(); container.remove()
    setN(1); $rt.flushSync()
    expect(runs).toBe(1)
  })
})
