/*
 * consts — `fixtures/Consts.mesa`: `{@const}` in a row and in a branch.
 *
 * A green run pins the Combobox shape: a const reading the row's index and
 * outer state follows that state, and a destructured one reads the row. Then
 * the scope: a const lives to the end of its block, so the same name after
 * the `{#if}` reads the script's own `x` and `y` again — and inside it a
 * const reading no state wins over the outer signal it shadows. A const in an
 * element's children lives to the end of the enclosing block, since the
 * element is built in that block's function, as on the DOM path.
 */
export const name = 'consts'

export async function run(t) {
  const Consts = await t.compile('Consts')
  await t.mount(Consts, {}, { height: 16 })
  await t.settle()

  let frame = await t.frame()
  t.expectFrame(frame, ['> ann 6', '  bo 20'], 'a row const reads the index and outer state, a pattern reads the row')
  t.expectFrame(frame, ['in 4 plain', 'out outer signal', 'z 3'], 'a const ends with its block, and a plain one shadows a signal')

  await t.click('next')
  frame = await t.frame()
  t.expectFrame(frame, ['  ann 6', '> bo 20'], 'the row const follows the state it reads')

  await t.click('more')
  frame = await t.frame()
  t.expectFrame(frame, ['in 6 plain', 'out outer signal', 'z 4'], 'the branch const, and one declared inside an element, follow the state they read')
}
