/*
 * $.context — content a block creates later still finds the provider.
 *
 * The context stack is setup-time state, so a block that instantiates its
 * content after the provider's frame has unwound would read `undefined` — and
 * every fallback for an absent provider is silent, which is why this is
 * asserted on the rendered text rather than on a thrown error. It broke every
 * compound component behind a conditional (`FJS-311`).
 */
export const name = '$.context'
export const covers = ['context-provide', 'context-late-blocks']

export async function run(t) {
  await t.mount('context')

  const at = (tag) => `document.querySelector('[data-tag="${tag}"]')?.textContent ?? '(absent)'`

  t.is(await t.evaluate(`return ${at('immediate')};`), 'provided',
    'a consumer rendered with the provider reads it')

  await t.clickAt('#open')
  await t.eventually(at('conditional'), 'provided',
    'so does one an {#if} creates afterwards')

  await t.clickAt('#add')
  await t.eventually(at('late'), 'provided',
    'and one that arrives as an {#each} row')
}
