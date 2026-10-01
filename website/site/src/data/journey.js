// site/src/data/journey.js — the journey's entries, read off the post files.
//
// A post is a `.mesa` page in src/routes/journey/ and its frontmatter is the
// one place its title, date and summary are written. A list kept here as well
// would be a second copy, and the index would drift the first time a title
// changed in one and not the other.

import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const POSTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'routes', 'journey')

/** `key: value` lines between the fences; quotes optional. Enough for a post. */
function frontmatter(src) {
  const m = src.match(/^---\n([\s\S]*?)\n---/)
  if (!m) return {}
  return Object.fromEntries(m[1].split('\n')
    .map((l) => l.match(/^(\w+):\s*(.*)$/))
    .filter(Boolean)
    .map(([, k, v]) => [k, v.replace(/^(["'])(.*)\1$/, '$2')]))
}

/** Newest first. A post with no `date` is a draft and is not listed. */
export async function loadPosts() {
  const files = (await readdir(POSTS))
    .filter((f) => f.endsWith('.mesa') && f !== 'index.mesa' && !f.startsWith('_') && !f.startsWith('['))
  const posts = await Promise.all(files.map(async (f) => {
    const fm = frontmatter(await readFile(join(POSTS, f), 'utf8'))
    return {
      slug:  f.replace(/\.mesa$/, ''),
      title: fm.title?.replace(/ — The journey$/, '') ?? f,
      date:  fm.date ?? null,
      summary: fm.description ?? '',
    }
  }))
  return posts.filter((p) => p.date).sort((a, b) => b.date.localeCompare(a.date))
}
