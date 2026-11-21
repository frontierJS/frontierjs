// The data travels in the page as JSON, so the hostile characters are here on
// purpose: each must reach the client as written and close nothing on the way.
export async function load() {
  return { greeting: 'hello </script><!-- \u2028 \u2029 & done', count: 3, published: new Date('2026-11-21T15:04:00.000Z') }
}
