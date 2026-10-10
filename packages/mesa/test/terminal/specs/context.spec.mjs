/*
 * context — `fixtures/Context.mesa`: `$context` in what is built late.
 *
 * `Provide` sets `$context.word` and `Hear` reads it at setup, as the kit's
 * DropdownItem reads its menu's `close`. A green run pins that a child built
 * after its provider's setup still hears it: in an `{#if}` branch that opens
 * later, in a slot inside that branch (the DropdownMenu shape), in an
 * `{#each}` row added later and an `{:else}` shown later, and in a
 * `<mesa:element this>` rebuilt for a new tag. Each is built inside an
 * effect, after the provider's frame has left the stack.
 */
export const name = 'context'

export async function run(t) {
  await t.mount(await t.compile('Context'), {}, { width: 40, height: 10 })
  await t.settle()
  t.expectFrame(await t.frame(), ['row x heard', 'unkeyed heard'], 'built at setup, a child hears its provider')

  await t.click('open')
  const frame = await t.frame()
  t.expectFrame(frame, ['branch heard'], 'a branch that opens later')
  t.expectFrame(frame, ['slot heard'], 'a slot inside it')
  t.expectFrame(frame, ['row a heard'], 'a row added later')
  t.expectFrame(frame, ['keyed heard'], 'an element rebuilt for a new tag')

  await t.click('empty')
  t.expectFrame(await t.frame(), ['else heard'], 'an {:else} shown later')
}
