/*
 * attach — `fixtures/Attach.mesa`: `{@attach}` on terminal elements, through
 * the same `attach()` in runtime.js the DOM path calls.
 *
 * A green run pins: the attachment receives the renderable and runs after the
 * node is in the tree (an attachment that ran on a detached node is the
 * defect VISION §10.6 rules out); a reactive expression that turns to null
 * runs the cleanup and one that turns back attaches again; a block that goes
 * runs the cleanup of the attachments inside it; and a callback in the
 * attachment's arguments writes state, which needs the setters the DOM path
 * rewrites with (FJS-1958).
 */
export const name = 'attach'

export async function run(t) {
  const Attach = await t.compile('Attach')
  await t.mount(Attach, {}, { height: 16 })
  await t.settle()

  let frame = await t.frame()
  t.expectFrame(frame, ['runs 1 placed cleanups 0'], 'the attachment ran once, on a node already in the tree')
  t.expectFrame(frame, ['seen BoxRenderable'], 'it receives the renderable, and a callback argument writes state')

  await t.tab()          // Arm
  await t.enter()
  frame = await t.frame()
  t.expectFrame(frame, ['cleanups 1', 'armed false'], 'an expression turning to null runs the cleanup')

  await t.enter()
  frame = await t.frame()
  t.expectFrame(frame, ['cleanups 1', 'armed true'], 'turning back attaches again without a cleanup')

  await t.tab()          // Show
  await t.enter()
  frame = await t.frame()
  t.ok(!frame.includes('shown'), 'the block went')
  t.expectFrame(frame, ['cleanups 2'], 'a block that goes runs the cleanup of the attachment inside it')
  t.expectFrame(frame, ['runs 1 '], 'nothing else re-ran the counted attachment')
}
