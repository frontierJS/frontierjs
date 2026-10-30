// web/test/frames.mjs — `bun run frames`: render every scene and write its
// picture to `src/components/scenes/<name>.frame.txt`, the file `scenes.test.js` pins.
// Read the diff before committing: a row that moved without a change you
// meant to make is a piece on the wrong cell.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SCENES, WEB, mountScene } from './stage.mjs'
import { worldOf, worldJson } from '../src/lib/scene/world.js'

for (const { name, slug } of SCENES) {
  const { stage, dispose } = await mountScene(name)
  const file = join(WEB, 'src/components/scenes', `${slug}.frame.txt`)
  writeFileSync(file, stage.picture().join('\n') + '\n')
  const world = join(WEB, 'src/components/scenes', `${slug}.world.json`)
  writeFileSync(world, worldJson(worldOf(stage)))
  dispose()
  console.log(`wrote ${file} and ${world}`)
}
process.exit(0)
