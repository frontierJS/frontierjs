// site/src/routes/journey/index.meta.js — the journey's index, built.

import { loadPosts } from '../../data/journey.js'

const LONG = new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' })

export async function load() {
  const posts = await loadPosts()
  return {
    posts: posts.map((p) => ({ ...p, when: LONG.format(new Date(p.date + 'T00:00:00Z')) })),
  }
}
