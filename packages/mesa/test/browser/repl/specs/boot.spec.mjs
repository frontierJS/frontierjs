/*
 * boot — the REPL loads, compiles, and the preview responds.
 *
 * Both defects this page has had are here, and neither is visible from the
 * file:
 *
 *   `index.html` imported a named export `examples.js` had stopped providing.
 *   A missing named export is a LINK-time error in ESM, so the whole module
 *   script never ran — blank page, one console SyntaxError, nothing else.
 *
 *   It mounted by CALLING the component instead of through `mount()`.
 *   Delegation roots are registered by `mount()` alone (Invariant 11), so every
 *   example rendered perfectly and responded to no event whatsoever. Nothing
 *   short of a real click can tell that from a working page.
 */
export const name = 'repl — boots, compiles, responds'
export const covers = ['repl-boot', 'repl-compile', 'repl-mount']

export async function run(t) {
  const page = await t.evaluate(`
    return {
      status:   document.getElementById('pvlbl')?.textContent ?? '(no label)',
      editor:   !!document.querySelector('#cm-editor .cm-content'),
      examples: document.querySelectorAll('#ex-drawer-body .ex-item').length,
      preview:  document.getElementById('pv-container')?.children.length ?? 0,
    };
  `)

  // A link-time failure leaves the document standing and every one of these
  // empty, which is why the assertion is on what the module BUILT rather than
  // on the page having loaded.
  t.ok(page.editor, 'CodeMirror mounted — the module script ran to the end')
  t.ok(page.examples > 20, `the examples module resolved and its list was built (${page.examples})`)
  t.ok(page.preview > 0, 'the default example compiled and rendered into the preview')
  t.ok(!/error|failed/i.test(page.status), `the status line is not an error (${page.status})`)

  // The preview is a mounted Mesa component. Clicking it is the only thing
  // that separates "rendered" from "mounted": a component called directly
  // draws identically and handles nothing.
  const clickable = await t.evaluate(`
    const el = document.querySelector('#pv-container button, #pv-container [role=button], #pv-container input');
    if (!el) return { sel: null };
    el.id = el.id || 'repl-probe-target';
    return { sel: '#' + el.id, before: document.getElementById('pv-container').textContent.trim().slice(0, 200) };
  `)
  t.ok(clickable.sel, 'the default example renders something that can be interacted with')

  if (clickable.sel) {
    await t.clickAt(clickable.sel)
    const after = await t.evaluate(`
      await new Promise(r => setTimeout(r, 200));
      return { text: document.getElementById('pv-container').textContent.trim().slice(0, 200) };
    `)
    t.ok(after.text !== clickable.before,
      'and a real click CHANGES it — so the preview was mounted, not just called')
  }
}
