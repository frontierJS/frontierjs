/**
 * test/page-reads-real.mjs — which prerendered pages a write reaches
 * (`FJS-3034`, `FJS-D1262`), against a REAL Litestone client. Run with bun:
 *
 *     bun run test:safety
 *
 * Under bun for the reason `static-safety-real.mjs` gives: the manifest is only
 * as good as the tap events a real client emits — the table name, the args an
 * include's child statement does not carry — and a fake emits what the test
 * author expected. The blog here is ghost's shape at one-hundredth the size:
 * an index of cards, a page per post with its tags, a page per tag.
 *
 * Exits non-zero on the first failure.
 */

import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync, writeFileSync } from 'fs'

import { prerenderRoutes } from '../src/build/prerender.js'
import { affectedPages } from '../src/build/page-reads.js'
import { createClient, autoMigrate } from '@frontierjs/litestone'
import { tmpDir } from './tmp.js'

const HERE = dirname(fileURLToPath(import.meta.url))

let passed = 0
const failures = []
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ok    ${name}`) })
    .catch(err => { failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`) })
}
function assert(cond, msg) { if (!cond) throw new Error(msg) }
const same = (got, want) => JSON.stringify([...got].sort()) === JSON.stringify([...want].sort())

const SCHEMA = `
model BlogPost {
  id          Int       @id @default(autoincrement())
  slug        String    @unique
  title       String
  body        String
  status      String
  publishedAt DateTime?
  tags        PostTag[]
}

model Tag {
  id    Int       @id @default(autoincrement())
  slug  String    @unique
  name  String
  posts PostTag[]
}

model PostTag {
  id     Int      @id @default(autoincrement())
  postId Int
  tagId  Int
  post   BlogPost @relation(fields: [postId], references: [id])
  tag    Tag      @relation(fields: [tagId], references: [id])
}
`

const page = body => `---\nrender: static\n---\n<script>export let data = null</script>\n${body}\n`

async function blog() {
  const root = tmpDir('sierra-reads-')
  mkdirSync(resolve(root, 'db'), { recursive: true })
  const schemaPath = resolve(root, 'db/schema.lite')
  writeFileSync(schemaPath, SCHEMA)
  const db = await createClient({ schema: schemaPath, db: ':memory:' })
  autoMigrate(db)

  const tags = []
  for (const s of ['a', 'b', 'c']) tags.push(await db.tag.create({ data: { slug: s, name: `Tag ${s}` } }))
  for (let i = 1; i <= 4; i++) {
    const p = await db.blogPost.create({ data: {
      slug: `p${i}`, title: `Post ${i}`, body: `Body ${i}`, status: 'published',
      publishedAt: new Date(Date.UTC(2026, 0, i)).toISOString(),
    } })
    await db.postTag.create({ data: { postId: p.id, tagId: tags[i % 3].id } })
  }
  await db.blogPost.create({ data: { slug: 'draft', title: 'Draft', body: 'Soon', status: 'draft' } })

  globalThis.__BLOGDB__ = db
  const routes = resolve(root, 'src/routes')
  mkdirSync(resolve(routes, 'posts'), { recursive: true })
  mkdirSync(resolve(routes, 'tags'), { recursive: true })

  writeFileSync(resolve(routes, 'index.mesa'), page('<h1>{data.cards.length}</h1>'))
  writeFileSync(resolve(routes, 'index.meta.js'),
    `export async function load() {\n` +
    `  const cards = await globalThis.__BLOGDB__.blogPost.findMany({\n` +
    `    where: { status: 'published' }, orderBy: { publishedAt: 'desc' },\n` +
    `    select: { slug: true, title: true, publishedAt: true } })\n` +
    `  return { cards }\n}\n`)

  writeFileSync(resolve(routes, 'posts/[slug].mesa'), page('<h1>{data.post.title}</h1>'))
  writeFileSync(resolve(routes, 'posts/[slug].meta.js'),
    `const db = () => globalThis.__BLOGDB__\n` +
    `export async function getStaticPaths() {\n` +
    `  const rows = await db().blogPost.findMany({ where: { status: 'published' }, select: { slug: true } })\n` +
    `  return rows.map(r => ({ slug: r.slug }))\n}\n` +
    `export async function load({ params }) {\n` +
    `  const post = await db().blogPost.findUnique({ where: { slug: params.slug },\n` +
    `    include: { tags: { include: { tag: { select: { slug: true, name: true } } } } } })\n` +
    `  return { post }\n}\n`)

  writeFileSync(resolve(routes, 'tags/[slug].mesa'), page('<h1>{data.tag.name}</h1>'))
  writeFileSync(resolve(routes, 'tags/[slug].meta.js'),
    `const db = () => globalThis.__BLOGDB__\n` +
    `export async function getStaticPaths() {\n` +
    `  const rows = await db().tag.findMany({ select: { slug: true } })\n` +
    `  return rows.map(r => ({ slug: r.slug }))\n}\n` +
    `export async function load({ params }) {\n` +
    `  const tag = await db().tag.findUnique({ where: { slug: params.slug } })\n` +
    `  const links = await db().postTag.findMany({ where: { tagId: tag.id }, select: { postId: true } })\n` +
    `  const posts = await db().blogPost.findMany({\n` +
    `    where: { id: { in: links.map(l => l.postId) }, status: 'published' },\n` +
    `    select: { slug: true, title: true } })\n` +
    `  return { tag, posts }\n}\n`)

  const { renderComponent } = await import('@frontierjs/mesa/render-component')
  const { scan } = await import('../src/scanner/index.js')
  const tree = await scan('src/routes', { cwd: root })
  const res = await prerenderRoutes({
    tree, root,
    outDir: tmpDir('sierra-reads-out-'),
    renderComponent,
    db,
    tmpDir: resolve(HERE, '../node_modules/.sierra/render'),
  })
  return { db, res }
}

console.log('\n  page reads — which prerendered pages a write reaches\n')

const { db, res } = await blog()
const manifest = res.pageReads

await check('the build keeps each written URL\'s reads', async () => {
  assert(manifest, 'prerenderRoutes returned no pageReads with a client wired')
  const urls = manifest.routes.flatMap(r => r.pages.map(p => p.url))
  assert(same(urls, ['/', '/posts/p1/', '/posts/p2/', '/posts/p3/', '/posts/p4/', '/tags/a/', '/tags/b/', '/tags/c/']),
    `manifest URLs were ${JSON.stringify(urls)}`)
})

await check('a body edit reaches its own page and nothing else', async () => {
  const before = await db.blogPost.findUnique({ where: { slug: 'p2' } })
  const got = affectedPages(manifest, { model: 'BlogPost', before, after: { ...before, body: 'Edited' } })
  assert(same(got.urls, ['/posts/p2/']), `reached ${JSON.stringify(got.urls)}`)
  assert(got.sitemap === false && got.routes.length === 0, `page list reached: ${JSON.stringify(got.routes)}`)
})

await check('a title edit reaches its page, the index and its tag\'s page', async () => {
  const before = await db.blogPost.findUnique({ where: { slug: 'p2' } })
  const got = affectedPages(manifest, { model: 'BlogPost', before, after: { ...before, title: 'New' } })
  // p2 carries tag c (index 2 % 3); the tag page's post read is pinned by `id in`.
  assert(same(got.urls, ['/', '/posts/p2/', '/tags/c/']), `reached ${JSON.stringify(got.urls)}`)
})

await check('publishing a draft reaches the index, the post route\'s list and the sitemap', async () => {
  const before = await db.blogPost.findUnique({ where: { slug: 'draft' } })
  const got = affectedPages(manifest, { model: 'BlogPost', before,
    after: { ...before, status: 'published', publishedAt: '2026-02-01T00:00:00.000Z' } })
  assert(got.urls.includes('/'), `the index was not reached: ${JSON.stringify(got.urls)}`)
  assert(got.routes.includes('/posts/:slug/'), `the post route's page list was not reached: ${JSON.stringify(got.routes)}`)
  assert(got.sitemap === true, 'the sitemap was not reached')
  assert(!got.urls.some(u => /^\/posts\/p\d\/$/.test(u)), `another post's page was reached: ${JSON.stringify(got.urls)}`)
})

await check('tagging a post reaches the pages that read the join', async () => {
  const got = affectedPages(manifest, { model: 'PostTag', after: { id: 99, postId: 1, tagId: 1 } })
  assert(got.urls.includes('/posts/p1/'), `the post's page was not reached: ${JSON.stringify(got.urls)}`)
  assert(got.urls.includes('/tags/a/'), `the tag's page was not reached: ${JSON.stringify(got.urls)}`)
})

await check('a write the manifest never read reaches nothing', async () => {
  const got = affectedPages(manifest, { model: 'Comment', after: { id: 1 } })
  assert(got.urls.length === 0 && !got.sitemap, `reached ${JSON.stringify(got)}`)
})

console.log(`\n  ${passed}/${passed + failures.length} passed\n`)
if (failures.length) process.exit(1)
