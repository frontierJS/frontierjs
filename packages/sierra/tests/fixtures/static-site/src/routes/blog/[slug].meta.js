export async function getStaticPaths() {
  return [{ slug: 'hello-world' }, { slug: 'second-post' }]
}
export async function load({ params }) {
  return { post: { title: `Post: ${params.slug}` } }
}
