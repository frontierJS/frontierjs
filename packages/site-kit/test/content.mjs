/*
 * content.mjs — a collection's items, the settings module, and what siteKit()
 * hands Sierra for them.
 *
 * test/content-build.mjs is the proof that a real build reads them; this one
 * pins each piece's shape and refusals without a build.
 *
 * Run: node test/content.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readSettings, writeSettingsModule } from '../config/content.js'
import { siteKit } from '../config/vite.js'
import { collection } from '../src/collection.js'
import { LOCKED_KEYS, applyEdit, applyPhoto, arrangeCollection, changeRefusal, collectionOf, formOf, lockedKeysChanged, pathRefusal, photoName, photoOf } from '../src/editable.js'
import { changedBlocks, plainSwap } from '../src/editor/live.js'

const failed = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `\n    ${detail}`}`)
  if (!ok) failed.push(label)
}

const TMP = mkdtempSync(join(tmpdir(), 'site-kit-content-'))
const write = (path, text) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

try {
  // ─── collection() ──────────────────────────────────────────────────────────
  {
    const Body = () => {}
    const items = collection({
      '/content/collections/reviews/91-alison.md': { frontmatter: { rating: 5 }, default: Body },
      '/content/collections/reviews/9-grant.md':   { frontmatter: { rating: 4 }, default: Body },
      '/content/collections/reviews/1-annie.md':   { default: Body },
    })
    check('items come in file-name order, by code unit', items.map((i) => i.slug).join() === '1-annie,9-grant,91-alison', items.map((i) => i.slug).join())
    check('an item is its slug, front-matter and Body', items[1].frontmatter.rating === 4 && items[1].Body === Body)
    check('an item without front-matter has an empty object', JSON.stringify(items[0].frontmatter) === '{}')
    check('an empty glob is an empty list', collection({}).length === 0)
    const placed = collection({
      '/content/collections/reviews/1-annie.md': { default: Body },
      '/content/collections/reviews/2-bo.md':    { frontmatter: { order: 2 }, default: Body },
      '/content/collections/reviews/3-cy.md':    { frontmatter: { order: 1 }, default: Body },
    })
    check('an order: number places an item, and one without follows by name (FJS-D1403)',
      placed.map((i) => i.slug).join() === '3-cy,2-bo,1-annie', placed.map((i) => i.slug).join())
  }

  // ─── an owner's lists: menu entries and collection items ──────────────────
  {
    const menu = [
      '---',
      'items:',
      '-',
      '  name: Logo',
      '  type: image',
      '-',
      '  name: Services   # the hub',
      '  link: /services/',
      '  items:',
      '  - name: Deep',
      '    link: /deep/',
      '  - name: Move',
      '    link: /move/',
      '- name: Contact',
      '  link: /contact/',
      '---',
      '',
    ].join('\n')
    const read = (text) => JSON.stringify(formOf(text).entries.map((e) => [e.label, e.depth, e.index]))
    check('a menu\'s entries are listed with their depth, place and words',
      read(menu) === '[["Logo",0,0],["Services",0,1],["Deep",1,0],["Move",1,1],["Contact",0,2]]', read(menu))
    const names = (r) => r.text ? JSON.stringify(formOf(r.text).entries.map((e) => e.label)) : r.refused
    const at = (label) => formOf(menu).entries.find((e) => e.label === label).line
    const up = applyEdit(menu, { entry: { line: at('Services') + 1, act: 'earlier' } })
    check('Earlier swaps an entry with the one before it, its sub-entries and comment going with it',
      names(up) === '["Services","Deep","Move","Logo","Contact"]' && up.text.includes('Services   # the hub'), names(up))
    check('a line inside a sub-entry moves the sub-entry, not its parent',
      names(applyEdit(menu, { entry: { line: at('Move'), act: 'earlier' } })) === '["Logo","Services","Move","Deep","Contact"]')
    check('Copy repeats the entry below itself (FJS-D1404)',
      names(applyEdit(menu, { entry: { line: at('Logo'), act: 'copy' } })) === '["Logo","Logo","Services","Deep","Move","Contact"]')
    const gone = applyEdit(menu, { entry: { line: at('Contact'), act: 'remove' } })
    check('Remove takes the entry out, any entry being the owner\'s (FJS-D1405)',
      names(gone) === '["Logo","Services","Deep","Move"]' && gone.text.endsWith('---\n'), names(gone))
    check('the first entry is not moved earlier', /already first/.test(applyEdit(menu, { entry: { line: at('Logo'), act: 'earlier' } }).refused ?? ''))
    check('the last entry is not moved later', /already last/.test(applyEdit(menu, { entry: { line: at('Move'), act: 'later' } }).refused ?? ''))
    const only = '---\nitems:\n- name: One\n  link: /\n---\n'
    check('a list\'s only entry is not removed', /only entry/.test(applyEdit(only, { entry: { line: 3, act: 'remove' } }).refused ?? ''))
    check('a line with no entry is refused', /no list entry/.test(applyEdit(menu, { entry: { line: 2, act: 'copy' } }).refused ?? ''))
    check('an entry is changed on its own', /on its own/.test(applyEdit(menu, { body: 'x', entry: { line: 3, act: 'copy' } }).refused ?? ''))

    check('a collection is a folder under content/collections',
      collectionOf('content/collections/reviews/1-a.md') === 'content/collections/reviews' &&
      collectionOf('content/routes/a.md') === null && collectionOf('content/collections/a.md') === null)
    const dir = 'content/collections/reviews'
    const files = [
      { path: `${dir}/1-annie.md`, source: '---\nreviewer: Annie\n---\nGood.\n' },
      { path: `${dir}/2-bo.md`,    source: '---\nreviewer: Bo # kept\n---\nFine.\n' },
      { path: `${dir}/3-cy.md`,    source: 'Plain.\n' },
    ]
    const order = (plan) => {
      const now = new Map(files.map((f) => [f.path, f.source]))
      for (const w of plan.writes) w.text === null ? now.delete(w.path) : now.set(w.path, w.text)
      return collection(Object.fromEntries([...now].map(([p, t]) => ['/' + p, { frontmatter: formOf(t).keys.reduce((o, k) => ({ ...o, [k.key]: k.value }), {}), default: null }])))
        .map((i) => i.slug).join()
    }
    const later = arrangeCollection(files, { path: `${dir}/1-annie.md`, act: 'later' })
    check('a move writes order: on each item whose place is new, front matter or none (FJS-D1403)',
      order(later) === '2-bo,1-annie,3-cy' && later.writes.length === 3 &&
      later.writes.find((w) => w.path.endsWith('2-bo.md')).text === '---\nreviewer: Bo # kept\norder: 1\n---\nFine.\n' &&
      later.writes.find((w) => w.path.endsWith('3-cy.md')).text === '---\norder: 3\n---\nPlain.\n', JSON.stringify(later))
    const placedFiles = files.map((f, k) => ({ ...f, source: f.source.replace(/^---\n|^/, `---\norder: ${k + 1}\n${f.source.startsWith('---') ? '' : '---\n'}`) }))
    const again = arrangeCollection(placedFiles, { path: `${dir}/3-cy.md`, act: 'earlier' })
    check('an item already at its number keeps its file', again.writes.length === 2 && !again.writes.some((w) => w.path.endsWith('1-annie.md')), JSON.stringify(again.writes.map((w) => w.path)))
    const copy = arrangeCollection(files, { path: `${dir}/1-annie.md`, act: 'copy' })
    check('Copy is the item\'s file whole, named beside it and placed after it (FJS-D1404)',
      copy.path === `${dir}/1-annie-copy.md` && order(copy) === '1-annie,1-annie-copy,2-bo,3-cy' &&
      copy.writes.find((w) => w.path === copy.path).text.includes('reviewer: Annie\norder: 2'), JSON.stringify(copy))
    check('a second copy takes the next free name',
      arrangeCollection([...files, { path: `${dir}/1-annie-copy.md`, source: 'x' }], { path: `${dir}/1-annie.md`, act: 'copy' }).path === `${dir}/1-annie-copy-2.md`)
    const removed = arrangeCollection(files, { path: `${dir}/2-bo.md`, act: 'remove' })
    check('Remove deletes the file and moves nothing', JSON.stringify(removed.writes) === JSON.stringify([{ path: `${dir}/2-bo.md`, text: null }]))
    check('the only item is not removed', /only item/.test(arrangeCollection(files.slice(0, 1), { path: files[0].path, act: 'remove' }).refused ?? ''))
    check('the first item is not moved earlier', /already first/.test(arrangeCollection(files, { path: files[0].path, act: 'earlier' }).refused ?? ''))
    check('a file outside a collection is refused', /not an item/.test(arrangeCollection(files, { path: 'content/routes/a.md', act: 'later' }).refused ?? ''))
  }

  // ─── an owner's photos (FJS-D1406, FJS-D1407) ─────────────────────────────
  {
    const src = [
      '---',
      'title: About',
      'hero_image: /media/images/owner.jpg?width=800&height=600 # the porch',
      'logo: /media/images/logo.svg',
      'background: /media/images/band.jpg',
      'away: https://example.com/a.jpg',
      '---',
      'Words.',
    ].join('\n')
    const keys = Object.fromEntries(formOf(src).keys.map((k) => [k.key, k.photo]))
    check('a front-matter path to a raster photo is a photo, with its file under content/public/',
      keys.hero_image?.file === 'content/public/media/images/owner.jpg' && keys.hero_image.src === '/media/images/owner.jpg' && keys.hero_image.alt === '')
    check('an SVG, a locked key, another site\'s photo and words are not photos',
      !keys.logo && !keys.background && !keys.away && !keys.title)
    check('?text= is the photo\'s words (FJS-D1406)', photoOf('/media/a%20b.png?text=The+porch').alt === 'The porch' && photoOf('/media/a%20b.png').file === 'content/public/media/a b.png')

    const swapped = applyPhoto(src, { key: 'hero_image', alt: '  Our  front porch ', src: '/media/images/porch.jpg' })
    const line = swapped.text?.split('\n')[2]
    check('a swap writes the new address with the words as ?text=, keeps the sizing and the comment, and drops the old height',
      line === 'hero_image: /media/images/porch.jpg?width=800&text=Our+front+porch # the porch', line ?? swapped.refused)
    check('only that line changes', swapped.text?.split('\n').filter((l, i) => l !== src.split('\n')[i]).length === 1)
    const worded = applyPhoto(src, { key: 'hero_image', alt: 'The porch' })
    check('words alone keep the photo and its height', worded.text?.split('\n')[2] === 'hero_image: /media/images/owner.jpg?width=800&height=600&text=The+porch # the porch', worded.text?.split('\n')[2] ?? worded.refused)
    check('a photo without words is refused', /what it shows/.test(applyPhoto(src, { key: 'hero_image', alt: ' ', src: '/media/images/porch.jpg' }).refused ?? ''))
    check('a key that is not a photo is refused', /not one of the site's photos/.test(applyPhoto(src, { key: 'logo', alt: 'Logo' }).refused ?? ''))
    check('a new address that is not a photo is refused', /not one of the site's photos/.test(applyPhoto(src, { key: 'hero_image', alt: 'x', src: '/media/x.svg' }).refused ?? ''))

    const taken = new Set(['my-porch.jpg', 'my-porch-2.jpg'])
    check('a new photo is named for the upload, past a name already taken',
      photoName('My Porch!.HEIC', 'jpg', (n) => taken.has(n)) === 'my-porch-3.jpg' && photoName('...', 'png') === 'photo.png')
  }

  // ─── readSettings / writeSettingsModule ───────────────────────────────────
  {
    const root = join(TMP, 'settings')
    check('a site without site.md has no settings', JSON.stringify(readSettings(root)) === '{}')

    write(join(root, 'content/settings/site.md'), [
      '---',
      'company_name: Acme',
      'company_rating: 5.0',
      'company_serviceAreas:',
      'company_services:',
      '  - name: Cleaning',
      '    description: Homes',
      '---',
    ].join('\n'))
    const settings = readSettings(root)
    check('site.md front-matter is the settings, nesting included',
      settings.company_name === 'Acme' && settings.company_rating === 5 && settings.company_serviceAreas === null
      && settings.company_services[0].description === 'Homes', JSON.stringify(settings))

    const file = writeSettingsModule(root, settings)
    check('the module sits beside the route table', file === join(root, '.sierra/settings.js'))
    const mod = await import(pathToFileURL(file).href)
    check('the module exports each key by name', mod.company_name === 'Acme' && mod.company_services[0].name === 'Cleaning' && mod.company_serviceAreas === null)
    check('the module says where to edit', readFileSync(file, 'utf8').startsWith('// Generated by site-kit from content/settings/site.md'))

    for (const [key, label] of [['site-url', 'a key that is not a JavaScript name'], ['class', 'a reserved word']]) {
      write(join(root, 'content/settings/site.md'), `---\n${key}: x\n---\n`)
      try {
        readSettings(root)
        check(`${label} is refused`, false, 'readSettings returned')
      } catch (err) {
        check(`${label} is refused, by name`, err.message.includes(`'${key}'`) && err.message.includes('content/settings/site.md'), err.message)
      }
    }
  }

  // ─── what siteKit() does with them ────────────────────────────────────────
  // Whether Sierra binds the names is test/content-build.mjs's to prove.
  {
    const root = join(TMP, 'site')
    write(join(root, 'content/routes/index.md'), '# Home\n')
    const bare = await siteKit({ root })
    const alias = bare.plugins.flat().find((p) => p?.name === 'site-kit:content')?.config()?.resolve?.alias?.['@content']
    check("@content names the site's content/", alias === join(root, 'content'), String(alias))
    check('a site without site.md gets no settings module', !existsSync(join(root, '.sierra/settings.js')))

    write(join(root, 'content/settings/site.md'), '---\ncompany_name: Acme\n---\n')
    await siteKit({ root })
    const mod = await import(pathToFileURL(join(root, '.sierra/settings.js')).href)
    check('siteKit() writes the settings module from site.md', mod.company_name === 'Acme')

    write(join(root, 'content/settings/site.md'), '---\nlet: 1\n---\n')
    try {
      await siteKit({ root })
      check('siteKit() refuses a settings key no page can name', false, 'siteKit() resolved')
    } catch (err) {
      check('siteKit() refuses a settings key no page can name', /'let'/.test(err.message), err.message)
    }
  }

  // ─── what an owner may change (FJS-D1226) ─────────────────────────────────
  {
    for (const path of ['content/routes/index.md', 'content/collections/reviews/1-annie.md', 'content/settings/site.md',
      'content/menus/main.md', 'content/media/spa/room.JPG', 'content/public/hero.webp']) {
      check(`${path} is the owner's`, pathRefusal(path) === null, pathRefusal(path))
    }
    for (const path of ['content/settings/site.js', 'content/layouts/Page.mesa', 'content/settings/site.css',
      'content/settings/_redirects', 'content/public/logo.svg', 'content/fonts/a.woff2', 'package.json', 'content']) {
      check(`${path} is the developer's`, /developer's/.test(pathRefusal(path) ?? ''), pathRefusal(path))
    }
    for (const path of ['', '/content/routes/index.md', 'content/../package.json', 'content//a.md', './content/a.md']) {
      check(`"${path}" is not a path inside the site`, /not a path inside the site/.test(pathRefusal(path) ?? ''), pathRefusal(path))
    }
    check('the locked keys are layout, name and Block\'s six look keys',
      LOCKED_KEYS.join() === 'layout,name,template,tone,treatment,density,align,background', LOCKED_KEYS.join())
    const block = { layout: 'Block', name: 'Hero', tone: 'muted', title: 'Welcome', menu: [{ name: 'Home' }] }
    check('a changed title, or a menu entry\'s name, locks nothing',
      lockedKeysChanged(block, { ...block, title: 'Hello', menu: [{ name: 'Start' }] }).length === 0)
    check('a changed, added or removed locked key is named',
      lockedKeysChanged(block, { ...block, tone: 'danger', template: 'split', name: undefined }).join() === 'name,template,tone'
        && lockedKeysChanged(block, { title: 'Welcome' }).join() === 'layout,name,tone')

    const page = '---\nlayout: Block\ntone: muted\ntitle: Welcome\n---\nWe open at nine.\n'
    const item = '---\ntitle: Hours\n---\nOpen at nine.\n'
    check('a change of words, or an item added or removed, is the owner\'s',
      changeRefusal('content/routes/index.md', page, page.replace('nine', 'eight')) === null
        && changeRefusal('content/collections/faq/hours.md', null, item) === null
        && changeRefusal('content/collections/faq/hours.md', item, null) === null)
    check('a moved look key is refused, naming the file and the key',
      changeRefusal('content/routes/index.md', page, page.replace('muted', 'danger')) === 'content/routes/index.md changes tone, which is the developer\'s',
      changeRefusal('content/routes/index.md', page, page.replace('muted', 'danger')))
    check('a page added or removed moves its layout',
      /changes layout, tone, which are the developer's/.test(changeRefusal('content/routes/new.md', null, page) ?? '')
        && /changes layout, tone/.test(changeRefusal('content/routes/index.md', page, null) ?? ''))
    check('a front matter that no longer reads is refused',
      /front matter no longer reads/.test(changeRefusal('content/routes/index.md', page, '---\nlayout: [Block\n---\n') ?? ''),
      changeRefusal('content/routes/index.md', page, '---\nlayout: [Block\n---\n'))
    check('a developer file is refused by its path before its text is read',
      changeRefusal('content/settings/site.js', 'a', 'b') === pathRefusal('content/settings/site.js')
        && changeRefusal('notes.md', null, 'x') === pathRefusal('notes.md'))
  }

  // ─── the owner's form: a field per key, written line by line ──────────────
  {
    const file = [
      '---',
      'layout: Block',
      'tone: muted',
      'title: Welcome   # the hero line',
      'stars: 5',
      'open: true',
      'hours: "9 # 5"',
      'intro: >',
      '  two lines',
      '  folded',
      'menu:',
      '  - name: Home',
      '---',
      'Body text.',
      '',
    ].join('\n')
    const form = formOf(file)
    const field = (k) => form.keys.find((e) => e.key === k)
    check('the form names the body and every key',
      form.body === 'Body text.\n' && form.keys.map((e) => e.key).join() === 'layout,tone,title,stars,open,hours,intro,menu')
    check('a one-line text, number or yes/no is a field; a locked, folded or listed key is not',
      ['title', 'stars', 'open', 'hours'].every((k) => field(k).field)
        && ['layout', 'tone', 'intro', 'menu'].every((k) => !field(k).field)
        && field('tone').locked && !field('intro').locked)
    // A preview's stamp names a file line, and the editor finds it in the body by this.
    check('the form says which file line the body starts on',
      form.bodyLine === file.split('\n').indexOf('Body text.') + 1 && formOf('# Bare\n').bodyLine === 1,
      `${form.bodyLine}`)

    const edited = applyEdit(file, { body: 'New body.\n', values: { title: 'Hello: there', stars: 4, open: false, hours: '10 # 6' } })
    const lines = edited.text?.split('\n') ?? []
    check('a write changes only its own lines and keeps the trailing comment',
      lines[3] === 'title: "Hello: there"   # the hero line' && lines[4] === 'stars: 4' && lines[5] === 'open: false'
        && lines[6] === 'hours: "10 # 6"' && lines.slice(7, 12).join('\n') === file.split('\n').slice(7, 12).join('\n')
        && edited.text.endsWith('---\nNew body.\n'), edited.refused ?? edited.text)
    check('the written file reads back as the values asked for',
      formOf(edited.text ?? '').keys.find((e) => e.key === 'title')?.value === 'Hello: there')

    const refused = (label, edit, pattern) => {
      const out = applyEdit(file, edit)
      check(label, pattern.test(out.refused ?? ''), out.refused ?? out.text)
    }
    refused('a locked key is refused', { values: { tone: 'danger' } }, /developer's/)
    refused('a folded or listed key is refused', { values: { intro: 'one line' } }, /spans several lines/)
    refused('a key the file does not hold is refused', { values: { subtitle: 'x' } }, /not in this file/)
    refused('a number written as text is refused', { values: { stars: 'five' } }, /a number, not a string/)
    const opened = applyEdit('Just prose.\n', { body: '---\nlayout: Other\n---\n' })
    check('a body that opens a front-matter block of its own is refused', /also change layout/.test(opened.refused ?? ''),
      opened.refused ?? opened.text)
    check('a file with no front matter takes a body and refuses a key',
      applyEdit('Just prose.\n', { body: 'More prose.\n' }).text === 'More prose.\n'
        && /no front matter/.test(applyEdit('Just prose.\n', { values: { title: 'x' } }).refused ?? ''))

    // FJS-D1250: the body's code is the developer's, and a build runs it.
    const coded = '<script>\nconst n = 3\n</script>\n\nWe open {n} days. <a href="/book" class="cta">Book</a>\n\n<Image source="/a.jpg" />\n'
    const body = (b) => applyEdit(coded, { body: b })
    check('an owner rewrites the words around the code, and may delete a piece of it',
      body(coded.replace('We open', 'Open').replace('Book</a>', 'Book now</a>')).text !== undefined
        && body(coded.replace('<Image source="/a.jpg" />\n', '')).text !== undefined,
      body(coded.replace('We open', 'Open')).refused)
    const codeRefused = (label, b, pattern) => {
      const out = body(b)
      check(label, pattern.test(out.refused ?? ''), out.refused ?? out.text)
    }
    codeRefused('a second script block is refused', coded + '<script>fetch("/x")</script>\n', /<script>fetch.*developer's/)
    codeRefused('a changed script block is refused', coded.replace('const n = 3', 'const n = process.env.HOME'), /<script>/)
    codeRefused('a new expression is refused', coded + '{process.exit()}\n', /\{process\.exit\(\)\} is code/)
    codeRefused('an expression used once more than before is refused', coded + 'Still {n}.\n', /\{n\} is code/)
    codeRefused('a new attribute on a held tag is refused', coded.replace('class="cta"', 'class="cta" onclick="x()"'), /onclick/)
    codeRefused('a component tag is refused', coded + '<Button text="Go" />\n', /<Button/)
    codeRefused('a markdown link to javascript: is refused', coded + '[tap](javascript:alert(1))\n', /javascript:/)
    codeRefused('a reference link to javascript: is refused', coded + '[tap]\n\n[tap]: javascript:alert(1)\n', /javascript:/)
    check('prose with no code reads as none, and an autolink is not a tag',
      applyEdit('Plain.\n', { body: 'See <https://example.com> for 2 < 3.\n' }).text !== undefined)

    // FJS-D1231: a value a preview stamped is written by its line, at any depth.
    check("the form gives each one-line key its file line, the preview stamp's number",
      field('title').line === 4 && field('hours').line === 7 && field('menu').line === null, `${field('title').line} ${field('menu').line}`)
    const set = (line, old, next) => applyEdit(file, { field: { line, old, next } })
    const entry = set(12, 'Home', 'Start: here')
    check("a menu entry's words change on their own line, quoted where YAML needs it",
      entry.text === file.replace('  - name: Home', '  - name: "Start: here"'), entry.refused ?? entry.text)
    check('a top-level value keeps its trailing comment',
      set(4, 'Welcome', 'Hi there').text?.split('\n')[3] === 'title: Hi there   # the hero line')
    const fieldRefused = (label, out, pattern) => check(label, pattern.test(out.refused ?? ''), out.refused ?? out.text)
    fieldRefused('words the line no longer holds are refused', set(12, 'House', 'Start'), /menu\.0\.name has changed/)
    fieldRefused('a line with no value is refused', set(11, 'Home', 'Start'), /no value is written on that line/)
    fieldRefused('a locked key is refused', set(3, 'muted', 'danger'), /tone decides/)
    fieldRefused('a number is not words', set(5, '5', 'five'), /stars is a number, not words/)
    fieldRefused('a folded value is not changed in place', set(8, 'two lines folded', 'one'), /spans several lines/)
    fieldRefused('empty words are refused', set(12, 'Home', '  '), /empty/)
    fieldRefused('a field edit is made alone', applyEdit(file, { body: 'x', field: { line: 12, old: 'Home', next: 'S' } }), /on its own/)
  }

  // ─── what a preview shows before a save (FJS-D1399) ───────────────────────
  {
    const body = 'Intro line\nwraps here\n\nSecond\n\nThird\n'
    const one = changedBlocks(body, 'Intro line\nwraps here\n\nSecond, changed\n\nThird\n')
    check('one changed block is found at its own line',
      one.unplaced === 0 && one.changes.length === 1 && one.changes[0].index === 3 && one.changes[0].next === 'Second, changed', JSON.stringify(one))
    check('a block\'s lines come back joined', changedBlocks(body, 'Intro\nwraps\n\nSecond\n\nThird\n').changes[0].old === 'Intro line\nwraps here')
    check('an added block is one the page cannot place', changedBlocks(body, body + '\nFourth\n').unplaced === 1)
    check('an unchanged body changes nothing', JSON.stringify(changedBlocks(body, body)) === '{"changes":[],"unplaced":0}')

    check('plain words swap', plainSwap('Open daily', 'Open every day, 9 to 5'))
    for (const next of ['Open *daily*', 'See [us](/x)', '# Open', '- Open', '1. Open', 'Open {x}', 'Open <b>now</b>', 'Call (512) 555-0134', 'Open ==now==', 'Visit www.acme.com']) {
      check(`"${next}" waits for the rebuild`, !plainSwap('Open daily', next))
    }
    check('words that become a kicker wait', !plainSwap('Welcome in', 'WELCOME IN'))
    check('a kicker that stays one swaps', plainSwap('WELCOME', 'HELLO THERE'))
  }

  // ─── a content/ with no content/routes (FJS-2546) ─────────────────────────
  // A legacy ksite keeps its pages in content/pages. Built as-is it is an
  // empty shell that Sierra blames on frontmatter, so the folder is named here.
  {
    const refused = async (label, root, pattern) => {
      try {
        await siteKit({ root })
        check(label, false, 'siteKit() resolved')
      } catch (err) {
        check(label, pattern.test(err.message), err.message)
      }
    }
    const legacy = join(TMP, 'legacy')
    write(join(legacy, 'content/pages/index.md'), '# Home\n')
    write(join(legacy, 'content/settings/site.md'), '---\ncompany_name: Acme\n---\n')
    await refused('a content/pages site is refused, naming content/pages and content/routes', legacy,
      /content\/pages[\s\S]*content\/routes/)

    const empty = join(TMP, 'no-routes')
    write(join(empty, 'content/settings/site.md'), '---\ncompany_name: Acme\n---\n')
    await refused('a content/ with no content/routes is refused by name', empty, /content\/routes/)
  }
} finally {
  rmSync(TMP, { recursive: true, force: true })
}

if (failed.length) {
  console.error(`\n${failed.length} failed`)
  process.exit(1)
}
