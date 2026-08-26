// The ROOT route's companion. It is here because the root is a synthesised node
// — it stands for the routes directory itself — and the entry's fields are
// copied onto it one at a time; `companion` was left out of that copy, so a
// home page's load() silently never ran while every other route's did.
export async function load() {
  return { greeting: 'hello' }
}
