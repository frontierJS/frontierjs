export async function getStaticPaths() {
  return [{ slug: 'hello-world' }, { slug: 'second-post' }]
}
export async function load({ params }) {
  return { post: { title: `Post: ${params.slug}` } }
}
// A dynamic route's pages share one frontmatter, so a per-path <title> has to
// come from somewhere the params are in scope. `head()` is called once per
// emitted path with that path's own `data`.
export function head({ params, data }) {
  return {
    title:       `Read ${params.slug} — the blog`,
    description: `Everything about ${params.slug}.`,
  }
}
