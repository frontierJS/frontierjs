---
id: site-kit-images
status: partial
dated: 2026-10-12
---

# Proposal — responsive images for a site-kit build

**Status: PARTIAL. Built 2026-10-12 as `website/packages/site-kit/config/images.js`
(`FJS-D926`, `FJS-D932`); § Left is what remains. Do not cite as behavior.** The
gap is [`FJS-2737`](../ISSUES.md#fjs-2737). `site-kit-parity.md` § 4 listed it,
`FJS-D608` placed it in site-kit until a second consumer needs it, and
`site-kit-plan.md` Phase 3 step 6 sequences it.

## The gap, measured

The Luminous Heart port (`~/code/CLIENTS/luminousheart/luminousheartportal.com-fjs/fjs`)
builds to a 24 MB `dist/` that ships all 59 raster photos at source size. Its
largest, `gallery/lhw-22.jpg`, is 1.45 MB at 2560 px, so a phone downloads all
of it for a 390 px slot. Legacy ksite runs the same photos through sharp at
build time. Re-encoded to WebP with `Bun.Image` on Bun 1.4.2:

| source | 480w | 1080w | 1920w |
| --- | --- | --- | --- |
| `lhw-22.jpg`, 1,454 KB | 51 KB · 49 ms | 213 KB · 147 ms | 489 KB · 352 ms |
| `page-hero-park.jpg`, 870 KB | 30 KB · 38 ms | 105 KB · 133 ms | 226 KB · 310 ms |

All 59 images, every width at or below their source width, take **14.5 s
serially** and produce 10.3 MB of variants from 20.5 MB of sources. So a
rebuild that re-encodes everything is not acceptable: the cache is part of the
design, not an optimization added later.

**`Bun.Image` refuses AVIF encoding on Linux x64** (`ERR_IMAGE_FORMAT_UNSUPPORTED`:
*"AVIF encode needs an AV1 encoder"*). It uses the OS codec, so whether AVIF
works depends on the build host. `FJS-D311` and `bun-natives.md` list five
encoders; on this machine there are four. sharp 0.34.3 measured AVIF against
WebP on the same resized buffers:

| | 480w | 1080w | 1920w |
| --- | --- | --- | --- |
| `lhw-22.jpg` | 43 → 34 KB | 201 → 155 KB | 460 → 353 KB |
| `page-hero-park.jpg` | 26 → 20 KB | 101 → 75 KB | 222 → 156 KB |

**AVIF is 21–30% smaller than WebP, and WebP is 94–97% smaller than the source.**
Resizing is where nearly all of the saving comes from; AVIF only adds the
remaining fraction.

## How legacy ksite does it

There are two halves, and they agree only through a naming convention:

1. `make-images.js` scans `src/` and `content/` with a regex for any
   `/images/*.{jpg,jpeg,png,webp}` string. It reads `width=`, `loading=` and
   `mobile` off the surrounding text and treats hero, `image:` and logo keys as
   eager. `imageMaker.js` (sharp) writes `public/g/images/<basename>_<width>.<format>`
   at 480/1080/1920 plus the requested width, in WebP, adding AVIF for eager
   and `-mobile` images. It runs only when `appEnv` is production.
2. `Image.svelte` rebuilds those same filenames from its `source` prop and emits
   a `<picture>` with an AVIF and a WebP `<source>`. Its `sizes` is
   `(max-width: 1920px) 100vw, 2000px` for every image.

What that design costs:
- The output path drops the directory, so `gallery/a.jpg` and `team/a.jpg`
  write to the same file.
- An image rendered by anything other than `Image.svelte` gets variants
  generated and never used.
- A fixed `sizes` makes a 340 px thumbnail download a variant sized for the
  full viewport.

The port's `Image.mesa` in `@kobami/ksite` intentionally left the srcset half
out (its header comment explains why).

## Prior art

| | Where images are found | When | Formats and widths | Cache |
| --- | --- | --- | --- | --- |
| **SvelteKit** `@sveltejs/enhanced-img` | an `<enhanced:img>` with a static `src`, or an import using `?enhanced` | build (Vite plugin, built on vite-imagetools) | AVIF/WebP plus the original; 1x/2x, or a set of widths starting at 540 when `sizes` is given; intrinsic `width`/`height`; strips EXIF | `node_modules/.cache/imagetools` |
| **Astro** `astro:assets` | imports from `src/`, markdown `![]()`, the content-collection `image()` helper; **`public/` is never processed** | build for prerendered pages, request time for on-demand ones | `<Image>` / `<Picture>`; since 5.10 a `layout` (`constrained`, `full-width`) produces `srcset` and `sizes`; sharp by default, passthrough service where sharp cannot run | `cacheDir`, `node_modules/.astro` |
| **Eleventy** Image, HTML transform | **post-processes the built HTML** and rewrites every `<img>`, whatever template produced it | build; on request under `--serve` | WebP + JPEG by default, AVIF optional; `sizes` is **required** once there is more than one width; `eleventy:*` attributes override per image | in memory per (source, options), on disk by content hash |
| **Next.js** `next/image` | the component | at request time, on its own server | negotiated from `Accept` | the server's cache; a static export needs a custom loader or `unoptimized` |
| **Image CDN** (Cloudflare Images, Netlify Image CDN, `@unpic`) | a URL convention | at request time, at the edge | negotiated from `Accept` | the CDN; SvelteKit's docs warn that lazy generation hurts low-traffic sites |

What carries over:
- **Astro and enhanced-img both work from imports**, which a site-kit site does
  not have. A ksite page is markdown and frontmatter holding absolute paths
  into `content/public/`, which is exactly the `public/` Astro declines to
  process. Adopting their model would mean migrating the content of every
  client site, and "a site is its `content/` folder" (`site-kit-plan.md` goal)
  rules that out.
- **Eleventy's transform matches this shape.** Every image, whether from
  markdown, a frontmatter list, a block, or a gallery, ends up as an `<img>` in
  the prerendered page. That page is the one place they all meet.
- **All three build-time tools key their cache on content**, add intrinsic
  dimensions, and leave a `sizes` the author wrote alone.
- **Request-time optimizers need a server or a CDN account.** A Kobami site is
  static files on a static host and gets little traffic, which is the case
  SvelteKit's docs warn about.

## Design

**A site-kit postbuild step rewrites every local raster `<img>` in the
prerendered pages.** It plugs into the existing user-plugin seam in Sierra's
postbuild (`plugins[].closeBundle`, `packages/sierra/src/postbuild/index.js`),
last in site-kit's list, and walks pages with Sierra's own `htmlFiles`, now
exported from `@frontierjs/sierra/postbuild`. Under `FJS-D608` it moves into Sierra as
a numbered step once a non-site-kit app needs it.

For each `<img>` whose `src` resolves to a `.jpg`, `.jpeg`, `.png` or `.webp`
file in `dist/`:
- **Widths:** 480, 1080 and 1920 for a source wider than 1920. A narrower
  source gets the widths below it plus its own width as the largest
  candidate. Nothing is upscaled; `Bun.Image` would upscale if asked.
- **Output:** written to `dist/_img/<name>.<hash8>.<width>.webp`. The hash
  comes from the source bytes, which removes legacy's basename collision and
  makes every variant safe to serve with an immutable cache header.
- **Cache:** content-addressed under `node_modules/.cache/site-kit/images`,
  keyed by (transformer, source hash, width, quality). An unchanged photo costs
  a file copy rather than an encode.
- **`srcset` and `sizes`:** `srcset` lists the WebP variants. A block that
  knows its layout states `sizes` itself (a full-bleed hero says `100vw`) and
  the step leaves it alone. Otherwise `sizes` is derived from the rendered
  `width` attribute: `(max-width: Wpx) 100vw, Wpx`. Never `sizes="auto"`:
  Chromium holds a lazy image's fetch until layout, which failed ksite's About
  Us grade by 238 px (the photo landed after the screenshot). At the
  source's own width, an encode no smaller than the source is dropped and the
  original stands as that candidate.
- **Dimensions:** intrinsic `width`/`height` are added where the tag has none.
- **`src`:** the original stays as the fallback, and the original file stays in
  `dist/`, because `og:image` and direct links point at it.

**Skipped:** SVG, GIF, external URLs, `data:` URIs, a tag with its own
`srcset`, an `<img>` inside a script, style, template, textarea or comment, and
any `<img data-original>` (the opt-out). A source that will not decode is
reported as a warning and its tag left as it is.

**Dev serves originals**, as legacy does. Only a build pays the encode cost.

**The transformer is `Bun.Image` under `FJS-D311`'s seam.** The step is handed
a transformer rather than importing one, so an app that needs AVIF or sprites
can pass its own without a change to the step.

**Art direction (`-mobile` sources) moves on demand under `FJS-D607`.** Two
client trees use it (kobami.com and maid.tech, 30 files each) and Luminous
Heart uses none. It ships with the first of those two to move.

## Measured

On the Luminous Heart port: 208 tags on 23 pages, 54 sources, 136 variants. A
cold build is 31 s against about 10 s without the step; a warm one is 10.5 s,
every variant from the cache. Chromium loading `/`, `/gallery/`, `/spa/` and
`/about/` with every lazy image scrolled in fetched, for 74 images:

| viewport | originals | fetched |
| --- | --- | --- |
| 390 px at 3x | 23.8 MB | 9.62 MB (−60%) |
| 390 px at 2x | 23.8 MB | 5.76 MB (−76%) |
| 1280 px at 1x | 23.8 MB | 5.99 MB (−75%) |

None broken, no request answered 4xx. With `sizes="auto"` on lazy images the
same run fetched 75%, 86% and 87% less; the gap is `Image`'s default
`width="768"` steering the pick (§ Left). ksite's Playwright grade is 4/4.

## Left

- **`sizes` on blocks that know their layout.** ksite's header logo and the
  home hero render `width="768"` and `width="560"` while laid out far smaller
  or full-bleed, so an eager image (no `auto`) picks a candidate for the wrong
  box. The fix is in the block (`sizes` stated), not the step.
- **`Image`'s default box is fictional.** It renders `width="768"
  height="430"` whatever the photo is, so a 900×921 portrait reserves a
  landscape box and the page jumps when it loads, as legacy's did. The step
  keeps a stated pair. Correcting it means the block states the real size or
  states none; a theme that crops through the `height` attribute decides which.
- **Art direction**, under `FJS-D607` as above.
- **An immutable cache header for `/_img/*`**, which belongs to Sierra's host
  files (`site-hosting.md`, `FJS-D919`).
- **Moving into Sierra** ahead of the offline shell, once a non-site-kit app
  needs it (`FJS-D608`); the refusal of `offline` lifts with it.

## Open questions

- ~~**Where does the build find the images to optimize?**~~ **Answered 2026-10-12 (`FJS-D932`): A — the built HTML: a postbuild step rewrites every local `<img>` in the prerendered pages.**
  - **A** — the built HTML: a postbuild step rewrites every local `<img>` in the prerendered pages (Eleventy's transform).
  - **B** — the `Image` block: it emits `srcset` from a manifest the build writes, and every block that renders a photo has to go through it (Astro's and enhanced-img's component model).
  - **C** — legacy's model: a regex scan of source and content, plus a component that rebuilds the variant filenames.
  - **Recommend A** — the rendered `<img>` is the one place every reference ends up, so there is exactly one origin. B misses a gallery or hero that writes its own `<img>`, which is a gap nothing reports. C keeps two halves agreeing through a naming convention, and that convention is what caused the basename collision.

- ~~**Which codec and which formats?**~~ **Answered 2026-10-12 (`FJS-D926`): A — `Bun.Image`, WebP only, on every host.**
  - **A** — `Bun.Image`, WebP only, on every host.
  - **B** — sharp as site-kit's transformer, adding AVIF for eager images (legacy parity).
  - **C** — `Bun.Image`, adding AVIF wherever the build host can encode it.
  - **Recommend A** — WebP already gives 94–97% of the saving, and AVIF's extra 21–30% costs a native dependency. C makes `dist/` depend on which machine built it (it differs between Linux and macOS), so the same commit would ship different files. Because the transformer is handed in under `FJS-D311`, B can be adopted later by passing sharp, without changing the step. B is worth reopening only with an LCP measurement on a real client's hero.

## The nine

These were answered before any code was written.

1. **Origin** — one: the rendered `<img>`. Nothing restates a variant's filename; the step writes the name and the `srcset` together.
2. **Concept** — no new noun. *Variant* is already `map-packages.md`'s word for this.
3. **Complexity** — the problem's own: `srcset`, `sizes` and art direction are the web platform's terms for it.
4. **Predictability** — every local `<img>` gets the same treatment whichever block or markdown line produced it, with one opt-out attribute.
5. **Derived** — widths come from the source's intrinsic size, `sizes` from the rendered `width`, and file names from the content hash. Nothing is configured per image.
6. **Owner** — Sierra's postbuild owns rewriting built pages, and this step goes in through its plugin seam rather than beside it. `FJS-D608` keeps it as site-kit code until there is a second consumer, and `FJS-D311` names the transformer.
7. **Boundary** — `closeBundle({ outDir, root, config, routeTable })`, Sierra's postbuild plugin protocol. **Sierra runs user plugins after the offline shell takes its digest**, so an app that combines this step with `config.offline` would precache pages from before the rewrite. The step refuses to run in that combination until it moves into Sierra ahead of step 11.
8. **Failure** — a source that will not decode is reported as a warning and its tag is left unchanged. A missed image costs bytes, not correctness, so failing the build would be out of proportion to the cost of being wrong.
9. **Silence** — the invariant: every local raster `<img>` in `dist/` over 100 KB has a `srcset` whose files exist. The artefact is the check's built-stage `images` rule (`site-kit-plan.md` step 5b), which grades this. Until that rule moves into site-kit the answer is `none`, so the step's own test asserts the invariant over a fixture build.

Tensions considered: *batteries vs. smallness* (site-kit is the battery, and the
step is one severable plugin) and *paved road vs. the workaround* (one image
path for every block, rather than each block opting in). The tier is
Assessment: this paper. The gap is the Register row `FJS-2737`.
