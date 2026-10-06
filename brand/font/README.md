# FrontierJS Serif — font build

A heavy condensed Clarendon built from primitives (stems, rings, bracketed
slabs) with boolean path ops, compiled to TrueType. Worn variant nibbles the
edges for the letterpress look.

    pip install fonttools skia-pathops brotli pillow numpy
    python3 build_serif.py            # clean   -> out/FrontierJS_Serif_Regular.{ttf,woff2}
    WORN=1 python3 build_serif.py     # worn    -> out/FrontierJS_Serif_Worn_Regular.{ttf,woff2}
    python3 kern.py                   # kerns every .ttf in out/ (FONTS=a.ttf,b.ttf narrows)

## GUI

    python3 gui.py                    # http://localhost:8787  (PORT=... to move it)

Sliders rebuild the font and swap it into the page. The page shows the env
line that reproduces what you see. Download buttons give the last build.

## Knobs (environment variables)

| Knob | Default | What |
| --- | --- | --- |
| `S` | 175 | thick stem, before the squeeze |
| `HL` | 105 | horizontal bar |
| `ST` | 62 | serif slab thickness; brackets scale with it |
| `EXT` | 55 | serif reach past the stem |
| `COND` | 0.78 | horizontal squeeze applied to every glyph; stems squeeze too |
| `EMB` | 16 | embolden the hand-drawn outlines (S, digits, symbols) that ignore `S` |
| `SB` | 20 | side bearing |
| `CH` | 700 | cap height |
| `WORN` | 0 | 1 for the worn variant |
| `WEAR` `GRIT` `SEED` | 1 1 0 | worn: how many nibbles, how big, which pattern |
| `FAMILY` | FrontierJS Serif | family name |
| `OUT_DIR` | ./out | output folder |

The glyph recipes are the second half of `build_serif.py`. Many of their
numbers are literal, so a big change to `S` or `CH` breaks a glyph or two:
the GUI is how you find which.

## Font options for the wordmark

The mockup (a heavy condensed Clarendon on worn paper) matches no free font.
Thirty Google Fonts slabs and Clarendons were rendered against it on
2026-10-05; the mockup is most likely AI-rendered, so there is a nearest
neighbor and not a source.

| Option | Cost | Verdict |
| --- | --- | --- |
| Clarendon Bold Condensed (Linotype or Bitstream) | paid | Closest real face. Full character set, right at text sizes. |
| Egyptienne F Bold Condensed | paid | Same genre, slightly softer. |
| Sutro Bold | paid | Wood-type Clarendon, good worn-poster fit. |
| Bevan, condensed to ~74% | free (OFL) | Nearest free shape: brackets, hooked J, flat S terminals. Too black, low contrast. Logo SVG only. |
| Coustard Black, Ultra, Holtwood One SC | free (OFL) | Right genre, too wide and too heavy even condensed. |
| This procedural builder | free | Wordmark acceptable after tuning; the rest of the alphabet looks crude. Keep for the worn effect only. |
| `FrontierJS Field` (website/site/content/media/fonts) | ours | Geometric stencil, unrelated to the mockup. |
