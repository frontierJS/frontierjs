/*
 * boot — the plugin's output, executed.
 *
 * Every assertion here has a counterpart in `vite-server.test.js` that checks
 * the BYTES. This is the same route asked whether the bytes run: a boundary
 * that parses and throws on import, a scoped style that is emitted and never
 * placed, a delegation root the entry forgot to register — all of them are
 * green in Node and blank in a browser.
 */
export const name = 'boot — the served module runs'
export const covers = ['transform', 'hmr-boundary', 'scoped-styles', 'devtools-route']

export async function run(t) {
  t.is(await t.evaluate(`return document.querySelector('#counter-version').textContent;`), 'v1',
    'the component rendered through the real plugin')
  t.is(await t.boots(), 1, 'on one navigation')

  // The boundary is wrapped around the default export. If the wrap is broken
  // the module throws on import and nothing above would have rendered — but a
  // HALF wrap renders and never registers, which only the next spec can see.
  t.ok((await t.log()).every((l) => !/\[Mesa/.test(l)),
    'and said nothing on the console while doing it')

  await t.clickAt('#counter')
  await t.eventually(`document.querySelector('#counter').textContent`, 'count 1',
    'a real click reaches a delegated handler through the built module')

  // Scoped styles are INLINED by both Vite plugins as `addStyles(...)`, so the
  // rule only exists if the module executed the call. A rule that was emitted
  // into the file and never placed reads identically from Node.
  t.is(await t.evaluate(`
    return getComputedStyle(document.querySelector('#counter-version')).color;
  `), 'rgb(1, 2, 3)', 'the scoped rules were placed by the module, not just emitted')

  // The virtual HMR client is a module id nothing on disk answers for; another
  // plugin resolving it first is exactly the class of failure a hand-rolled
  // plugin context cannot see.
  const client = await t.evaluate(`
    // The resolved id is '\\0@frontierjs/mesa-client' — no slash after the NUL,
    // which is not what the virtual id it is resolved FROM looks like. Getting
    // that wrong reads as a 200 with the SPA fallback's index.html in it.
    const r = await fetch('/@id/__x00__@frontierjs/mesa-client');
    const text = await r.text();
    // Tested over the WHOLE body, with a head kept only for the failure
    // message: the client is assembled from two files, so a marker that used
    // to be near the top is now a few KB down and a slice would say the
    // client is missing when it is merely later.
    return {
      status:   r.status,
      register: /__mesa_register/.test(text),
      swap:     /function swapInstances/.test(text),
      imports:  text.includes("from './swap.js'"),
      head:     text.slice(0, 120),
    };
  `)
  t.is(client.status, 200, 'the virtual HMR client is served')
  t.ok(client.register, `and is the client, not an index.html fallback — ${JSON.stringify(client.head)}`)
  // The client is two files joined by `client-source.js`. A virtual id resolves
  // no relative import, so serving `client.js` alone is a 200 that dies in the
  // browser and puts every component back on the full-reload path.
  t.ok(client.swap, 'with the DOM swap inlined rather than imported')
  t.ok(!client.imports, 'and no relative import left behind to resolve against nothing')

  const devtools = await t.evaluate(`
    const r = await fetch('/__mesa/devtools');
    const body = await r.text();
    return { status: r.status, type: r.headers.get('content-type'), html: body.slice(0, 200), len: body.length };
  `)
  t.is(devtools.status, 200, 'the devtools route answers')
  t.match(devtools.type, /text\/html/, 'as HTML')
  t.ok(devtools.len > 1000, 'with the panel in it, rather than an SPA fallback')
}
