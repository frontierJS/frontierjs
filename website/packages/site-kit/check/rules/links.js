// check/rules/links.js — links and images in the built pages. Reads dist/ only:
// resolving every target of a live site would mean crawling it.

import { existsSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { norm, TRAILING_SLASH } from '../context.js'
import { finding } from '../finding.js'
import { redirectRules } from './crawl.js'

const GROUP = 'Links & images'

/** Group values → pages, preserving first-seen order. */
const collect = () => {
  const m = new Map()
  m.add = (key, page) => {
    const list = m.get(key) || m.set(key, []).get(key)
    if (!list.includes(page)) list.push(page)
  }
  return m
}

const isFile = (f) => existsSync(f) && statSync(f).isFile()

function inBuild(dist, path) {
  const p = decodeURIComponent(path)
  if (p.endsWith('/')) return isFile(join(dist, p, 'index.html'))
  return isFile(join(dist, p)) || isFile(join(dist, p, 'index.html')) || isFile(join(dist, p + '.html'))
}

function redirectSources(ctx) {
  const { fromPages, fromFile } = redirectRules(ctx)
  return new Set([...fromPages, ...fromFile].map((r) => norm(r.from)))
}

/** The pages whose links matter: content pages and the 404. */
const sources = (ctx) => ctx.html.pages.filter((p) => p.path === '/404.html' || ctx.contentFor(p.path))

function links(ctx) {
  const { dist } = ctx.html
  const host = ctx.base ? new URL(ctx.base).host : null
  const redirected = redirectSources(ctx)
  const slash = TRAILING_SLASH
  const broken = collect()
  const noSlash = collect()
  const tel = collect()

  for (const page of sources(ctx)) {
    for (const { href } of page.links) {
      if (href.startsWith('tel:')) {
        const n = decodeURIComponent(href.slice(4)).trim()
        if (!/^\+[1-9]\d{6,14}$/.test(n)) tel.add(href, page.path)
        continue
      }
      let url
      try {
        url = new URL(href, `https://${host || 'x.invalid'}${page.path}`)
      } catch {
        broken.add(href, page.path)
        continue
      }
      if (!/^https?:$/.test(url.protocol) || (host && url.host !== host) || (!host && !href.startsWith('/'))) continue
      const path = url.pathname
      if (redirected.has(norm(path))) continue
      if (!inBuild(dist, path)) {
        broken.add(path, page.path)
        continue
      }
      const isPage = !/\.[a-z0-9]+$/i.test(path)
      if (slash && isPage && path !== '/' && !path.endsWith('/')) noSlash.add(path, page.path)
    }
  }

  const out = []
  for (const [target, pages] of broken)
    out.push(finding('error', 'broken-link', `Link to ${target}, which isn't in the build.`, { pages }))
  if (noSlash.size)
    out.push(
      finding('info', 'link-trailing-slash', `Internal links without the trailing slash every route has, so each click costs a redirect: ${[...noSlash.keys()].slice(0, 6).join(', ')}${noSlash.size > 6 ? ', …' : ''}.`, {
        pages: [...new Set([...noSlash.values()].flat())]
      })
    )
  for (const [href, pages] of tel)
    out.push(finding('warn', 'tel-format', `${href} isn't E.164 (like tel:+15555555555), which some phones and call trackers misread.`, { pages }))
  return out
}

const words = (s) => String(s).toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, ' ').trim()

function images(ctx) {
  const { dist } = ctx.html
  const missing = collect()
  const noAlt = collect()
  const fileAlt = collect()
  for (const page of sources(ctx)) {
    for (const img of page.images) {
      const src = img.src || ''
      const decorative = img['aria-hidden'] === 'true' || img.role === 'presentation'
      if (src.startsWith('/') && !src.startsWith('//')) {
        const path = src.split(/[?#]/)[0]
        if (!isFile(join(dist, decodeURIComponent(path)))) missing.add(path, page.path)
      }
      if (decorative) continue
      if (img.alt == null) noAlt.add(src, page.path)
      else if (img.alt && words(img.alt) === words(basename(src.split(/[?#]/)[0]))) fileAlt.add(`${src.split('?')[0]} (alt="${img.alt}")`, page.path)
    }
  }
  const out = []
  for (const [src, pages] of missing) out.push(finding('error', 'image-missing', `Image ${src} isn't in the build.`, { pages }))
  if (noAlt.size)
    out.push(finding('warn', 'image-alt-missing', `Images with no alt attribute: ${[...noAlt.keys()].slice(0, 5).join(', ')}. Use alt="" for decorative ones.`, { pages: [...new Set([...noAlt.values()].flat())] }))
  if (fileAlt.size)
    out.push(
      finding('warn', 'image-alt-filename', `Images using their filename as alt text: ${[...fileAlt.keys()].slice(0, 5).join(', ')}${fileAlt.size > 5 ? ', …' : ''}. Describe the image, or alt="" if it's decorative.`, {
        pages: [...new Set([...fileAlt.values()].flat())]
      })
    )
  return out
}

export default [
  { id: 'links', group: GROUP, stage: 'built', distOnly: true, run: links },
  { id: 'images', group: GROUP, stage: 'built', distOnly: true, run: images }
]
