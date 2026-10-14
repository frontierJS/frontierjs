// check/html.js — what the rules need from a rendered page, read with regexes:
// prerendered output is regular enough, and it keeps the check dependency-free.

const decode = (s) =>
  String(s ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')

/** `<a href="x" class=y hidden>` → { href: 'x', class: 'y', hidden: '' } */
export function attrs(tag) {
  const out = {}
  const body = tag.replace(/^<[\w:-]+/, '').replace(/\/?>$/, '')
  for (const m of body.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g))
    out[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? '')
  return out
}

const tags = (html, name) =>
  [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map((m) => attrs(m[0]))

const stripTags = (s) => decode(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()

export function makePage(path, url, html) {
  // NOTE: Scripts and styles can hold strings that look like markup
  const markup = html.replace(/<(script|style|template)\b[\s\S]*?<\/\1>/gi, '')
  const head = markup.slice(0, Math.max(0, markup.search(/<\/head>/i)) || markup.length)
  const metas = tags(head, 'meta')
  const meta = (key) =>
    metas.filter((m) => m.name === key || m.property === key).map((m) => m.content ?? '')
  const canonicals = tags(head, 'link').filter((l) => (l.rel || '').toLowerCase() === 'canonical')
  const robots = meta('robots').join(',').toLowerCase()

  return {
    path,
    url,
    html,
    titles: [...head.matchAll(/<title[^>]*>([\s\S]*?)<\/title>/gi)].map((m) => stripTags(m[1])),
    descriptions: meta('description'),
    robots,
    noindex: robots.includes('noindex'),
    canonicals: canonicals.map((l) => l.href ?? ''),
    og: { title: meta('og:title')[0], image: meta('og:image')[0], url: meta('og:url')[0] },
    h1s: [...markup.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => stripTags(m[1])),
    links: tags(markup, 'a').filter((a) => a.href != null),
    images: tags(markup, 'img')
  }
}
