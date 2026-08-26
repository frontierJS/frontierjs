/**
 * bun run email:preview — render the transactional emails to files you can open.
 *
 * An email is the one thing in a framework nobody looks at: it is rendered on a
 * server, delivered to somebody else, and read in a client you do not control.
 * `bun run verify:notify` asserts the structure; this is for the other half —
 * seeing it. Open the file it prints in a browser, and forward it to yourself
 * from `curl localhost:8111/outbox` when you want a real mail client's opinion.
 */
import { renderEmailFile } from '@frontierjs/email-kit/render'
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname }          from 'node:path'

const OUT = new URL('./.preview/', import.meta.url).pathname

const SAMPLES = [
  ['order-confirmation', 'order-confirmation.mesa', {
    reference: 'ORD-1042',
    customer:  'Acme Corp',
    total:     '128.40',
    orderUrl:  'http://localhost:8010/orders/1042/',
  }],
]

await mkdir(OUT, { recursive: true })

for (const [name, file, data] of SAMPLES) {
  const { html, text, subject } = await renderEmailFile(
    new URL(`./${file}`, import.meta.url).pathname, { data })

  const line = typeof subject === 'function' ? subject(data) : subject
  await writeFile(`${OUT}${name}.html`, html)
  await writeFile(`${OUT}${name}.txt`,  text)

  console.log(`${name}`)
  console.log(`  subject  ${line}`)
  console.log(`  html     ${OUT}${name}.html   (${html.length} bytes)`)
  console.log(`  text     ${OUT}${name}.txt`)
}
void dirname
