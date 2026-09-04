/*
 * inspect — click a rendered element, open the line that wrote it.
 *
 * The claim is a chain, and every link is invisible from Node: the compiler
 * stamps a location on a template element, the plugin injects a client that
 * reads it, and a modified click reaches that client BEFORE the app's own
 * handler. A spec asserting the attribute alone would pass against an
 * inspector that never armed, and one asserting the fetch alone would pass
 * against a location pointing at the wrong line.
 */
export const name = 'inspect — click-to-source'
export const covers = ['inspect-attr', 'inspect-client', 'inspect-open']

export async function run(t) {
  await t.goto('/', 'window.__appReady')

  // ── the attribute ─────────────────────────────────────────────────────
  // Graded against the FILE rather than against a literal: a line number in a
  // spec goes stale the first time somebody adds a line to the fixture, and
  // then says the compiler is wrong.
  const at = await t.evaluate(`
    const el  = document.querySelector('#counter');
    const loc = el.getAttribute('data-fjs-loc');
    if (!loc) return { loc: null };
    const src   = (await import('/src/Counter.mesa?raw')).default;
    const parts = loc.split(':');
    const line  = src.split('\\n')[Number(parts[1]) - 1] ?? '';
    return {
      loc,
      file:   parts[0],
      column: Number(parts[2]),
      line,
      // Every element carries one, not only the ones with a binding — the
      // attribute goes into the template, so a plain <p> has it too.
      plain: document.querySelector('#counter-version').getAttribute('data-fjs-loc'),
    };
  `)
  t.ok(at.loc, 'a dev build stamps the source location on a rendered element')
  t.is(at.file, 'src/Counter.mesa', 'as a path relative to the app root, not an absolute one')
  t.match(at.line, /<button/, 'naming the line the element was written on')
  t.is(at.line[at.column - 1], '<', 'and the column the tag opens at')
  t.ok(at.plain, 'an element with no binding carries one too')

  // ── the client ────────────────────────────────────────────────────────
  t.ok(await t.evaluate(`return !!window.__fjsInspect;`),
    'the plugin injected the inspector into the page')

  // ── the open ──────────────────────────────────────────────────────────
  // A held modifier arms it and the click is swallowed. Both halves are the
  // behavior: an inspector that opens the editor AND fires the app's own
  // click handler navigates away from the page you were inspecting.
  const opened = await t.evaluate(`
    const before = document.querySelector('#counter').textContent;
    const asked  = [];
    const real   = window.fetch;
    window.fetch  = (url, ...rest) => {
      if (String(url).includes('__open-in-editor')) { asked.push(String(url)); return Promise.resolve(new Response('')); }
      return real(url, ...rest);
    };
    const el = document.querySelector('#counter');
    const at = (type) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, altKey: true }));
    at('mousemove');
    const highlighted = !!document.querySelector('div[style*="2147483647"]');
    at('mousedown');
    at('click');
    await new Promise((r) => setTimeout(r, 50));
    window.fetch = real;
    return { asked, highlighted, before, after: document.querySelector('#counter').textContent };
  `)
  t.is(opened.asked.length, 1, 'an alt-click asks the dev server to open the file')
  t.match(decodeURIComponent(opened.asked[0] ?? ''), /\/src\/Counter\.mesa:\d+:\d+$/,
    'with an absolute path, line and column — what launch-editor takes')
  t.ok(opened.highlighted, 'and the element under the pointer was outlined while armed')
  t.is(opened.after, opened.before, "while the app's own click handler never ran")

  // The middleware is Vite's own. A spec that stubbed the whole path would
  // pass against a dev server that has no such route at all.
  const route = await t.evaluate(`
    const r = await fetch('/__open-in-editor?file=');
    return { status: r.status, type: r.headers.get('content-type') || '' };
  `)
  t.ok(!/text\/html/.test(route.type),
    `the /__open-in-editor route is Vite's middleware, not the SPA fallback — got ${route.status} ${route.type}`)
}
