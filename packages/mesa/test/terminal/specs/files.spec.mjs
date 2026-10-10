/*
 * files — `fixtures/Files.mesa`: a hidden `<input type="file">`.
 *
 * A green run pins a file input hidden by `class="visually-hidden"` or by
 * `hidden` as painting nothing between its neighbors, and `input.click()`,
 * which the kit's `FileUpload` calls from its button, as firing `click` at
 * the input and opening nothing. One on screen is refused at compile, in
 * `terminal-emit.test.js`.
 */
export const name = 'files'

export async function run(t) {
  const Files = await t.compile('Files')
  await t.mount(Files, {}, { width: 40, height: 10 })
  await t.settle()
  const lines = (await t.frame()).split('\n').map((l) => l.trim())
  const at = lines.indexOf('before')
  t.ok(at >= 0 && lines[at + 1] === 'after', 'a hidden file input takes no line')

  await t.click('Browse')
  t.expectFrame(await t.frame(), ['heard [1]'], 'click() on a hidden file input fires click and opens nothing')
}
