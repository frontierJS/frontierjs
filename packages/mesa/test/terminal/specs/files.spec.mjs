/*
 * files — `fixtures/Files.mesa`: `<input type="file">`, on screen and hidden.
 *
 * A green run pins a file input on screen as a field a path is typed into,
 * whose commit reads that file into `files` and fires `change`, and a path
 * that reads nothing as leaving `files` alone and saying so in the field. A
 * hidden one paints nothing between its neighbors until `input.click()`,
 * which the kit's `FileUpload` calls from its button: then it opens in place,
 * and Enter reads the file, hides it again and hands focus back.
 *
 * The file chosen is this spec's fixture, read from `packages/mesa`, the
 * directory the drive runs from.
 */
import { statSync } from 'node:fs'

export const name = 'files'

const PATH = 'test/terminal/fixtures/Files.mesa'
const SIZE = statSync(PATH).size

export async function run(t) {
  const Files = await t.compile('Files')
  await t.mount(Files, {}, { width: 60, height: 14 })
  await t.settle()
  const lines = async () => (await t.frame()).split('\n').map((l) => l.trim())
  const at = (await lines()).indexOf('before')
  t.ok(at >= 0 && (await lines())[at + 1] === 'after', 'a hidden file input takes no line')

  await t.click('path to a file')
  await t.type('test/terminal/nowhere.txt')
  await t.enter()
  t.expectFrame(await t.frame(), ['no file at test/terminal/nowhere.txt', 'shown []'],
    'a path that reads no file is said in the field and fires nothing')

  await t.type(PATH)
  await t.enter()
  await t.eventually(async () => (await t.frame()).includes(`shown [Files.mesa ${SIZE} C:\\fakepath\\Files.mesa]`),
    'Enter reads the typed path into files and fires change')

  await t.click('Browse')
  t.expectFrame(await t.frame(), ['before', 'path to a file', 'after', 'Browse', 'heard [1] picked []'],
    'click() on a hidden file input fires click and opens it in place')
  await t.type(PATH)
  await t.enter()
  await t.eventually(async () => (await t.frame()).includes(`picked [Files.mesa ${SIZE} `),
    'the opened field reads its path into files')
  const after = await lines()
  t.ok(after[after.indexOf('after') + 1].includes('Browse'), 'Enter hides the opened field again')
  await t.enter()
  t.expectFrame(await t.frame(), ['heard [2]'], 'focus went back to the button that opened it')
}
