/*
 * scoped styles — against a real cascade.
 *
 * Reading the emitted CSS text proves a rule was written. Only a real CSSOM
 * proves it MATCHES, and matching is the whole contract: a scoped selector
 * must not reach into a child component, `:global(...)` must, and the class a
 * parent pushes down has to merge with the child's own rather than replace it.
 *
 * `getComputedStyle` is read here and not after a class change — it goes stale
 * in headless Chrome once a class moves, which is what `matchedRules` is for.
 */
export const name = 'scoped styles'
export const covers = ['scoped-styles', 'global-selector', 'class-passthrough']

export async function run(t) {
  await t.mount('scoped')

  const note = await t.evaluate(`
    const el = document.querySelector('.note');
    return { color: getComputedStyle(el).color, cls: el.className, rules: window.matchedRules(el) };
  `)
  t.is(note.color, 'rgb(1, 2, 3)', 'a scoped rule applies to the element it names')
  t.ok(note.rules.some((r) => /\.note\.m[0-9a-z]+/i.test(r)),
    'and the selector SUBJECT carries the scope hash')

  const child = await t.evaluate(`
    const el = document.querySelector('.child');
    return { color: getComputedStyle(el).color, style: getComputedStyle(el).fontStyle, cls: el.className };
  `)
  t.ok(child.color !== 'rgb(9, 9, 9)',
    'a scoped rule does NOT reach into a child component')
  t.is(child.style, 'italic', ':global(...) does')

  t.ok(child.cls.includes('child') && child.cls.includes('pushed'),
    'the class a parent pushed down merges with the child\'s own, never replaces it')
}
