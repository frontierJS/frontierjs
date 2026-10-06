# FrontierJS brand

The one place that says what FrontierJS looks and sounds like. The website,
the README, the CLI, `fli gui`, the atlas pages and the VS Code extension all
read from here. None of them should decide it for themselves.

**This guide points and does not restate.** Three of its sections already
have an owner somewhere else in the repo, and a copy here would drift from it:

| Question | Owner |
| -------- | ----- |
| What we believe | `PHILOSOPHY.md` |
| What the words mean | `VOCABULARY.md`, `ARCHITECT.md` § 2 |
| Semantic color, tones, light/dark, the type ladder, components | `@frontierjs/css`, `packages/css/src/foundation/tokens.css` |

What this file owns is what nothing else holds: the territory, the mark, the
brand palette, the faces, and the voice.

`assets/` holds committed, shippable files (logo SVGs, favicons, social cards).
A large design source goes beside them named `*.image-ref.*`, which the root
`.gitignore` excludes. That is the same rule `example/db/brand-sheets/` follows.
`assets/icons/<name>.png` are the package and project-section icons. They are
cropped from `fjs-icons.image-ref.png` and `fjs-new-icons.image-ref.png`, and
each file is named for a package folder or a section (`issues`, `decisions` …).
The rings page draws a crate for a package with no file there.
Those sheets and `example/site/public/brand/` are the example shop's brand,
not this one.

---

## 1 · Foundation

**Territory: a surveyor's field manual.** FrontierJS maps unclaimed ground. The
schema is the survey, and everything else is built out from the marks it sets.
The look comes from the working documents of that job: contour maps, benchmark
markers, ruled notebooks, a printed field guide read by lamplight. It does not
come from the Old West as a costume.

The reference image is `fjs-backdrop-portrait.png` at the repo root. It shows
a figure on a ledge with a pack and a staff, a dog beside them, and a river
valley running to the mountains at golden hour. The palette and the mood both
start there. `fli ws:atlas` already uses it as its backdrop.

**Audience.** A developer who owns the whole app, from schema to screen, and
who wants one mental model instead of five tools glued together.

**Positioning.** Schema-seeded and fullstack. One seed file grows the Data,
API and UI realms, and every part traces back to it.

**The hat is a field hat.** A figure wears a dark brown fur-felt or wool-felt
safari/outback fedora: a pinched or teardrop crown and a flat working brim. A
cowboy hat is the costume this brand refuses. A tall cattleman crease or a brim
curled up at the sides turns a surveyor into a gunslinger.

**Painted landscapes are illustration, and they are allowed.** Each realm has
its own terrain: desert strata for Litestone, a river confluence for Junction,
a forest ridge for Sierra. The current paintings are first drafts that will be
refined. Their palette and composition are not settled yet.

**Don'ts.** No cowboy hats, revolvers, saloon type or wanted posters. No CSS
gradient passed off as a landscape: a landscape is painted or it is absent. No
neon or "hacker" green.

## 2 · Logo

**Not drawn yet.** Once it exists, this section holds the mark, the wordmark
and the lockup, the clear space, the smallest size (favicon and CLI banner
included), and a misuse grid. The files go in `assets/`.

Brief: something a surveyor would stamp. A benchmark disk, a triangulation
mark or a contour ring. It has to work in one color at 16px.

## 3 · Color

**The brand palette is `theme-field`** (`packages/css/src/themes/field.css`).
That file holds the hex values and their contrast measurements, so they are
not repeated here. In summary: a warm near-black ground, sand ink, and
surveyor's inks for accents (verdigris for primary, then olive and ochre).

Page code never asks for a color. It asks for a tone and a treatment
(Invariant 13), and the theme answers. A brand color that is not a token in
`field.css` does not exist yet.

Open question: `field` is dark only. A light counterpart (paper ground, the
same inks) is still needed for print and for readers who want light mode.

## 4 · Typography

These faces are also set in `theme-field`:

- **Display:** a book serif (Iowan Old Style → Palatino → Georgia), tracked
  wide. The tracking is what gives it the field-guide look.
- **Body and code:** the system monospace.
- **No webfonts.** A webfont renders in a fallback face on first paint, and on
  a locked-down network it never loads at all.

The hierarchy and spacing are the css type ladder (`--text-*`, `--space-*`),
not a separate scale.

## 5 · Voice

**Precise, plain and a little dry.** We write the way a field manual does:
this is what the ground is like, and this is what happens if you step there.
Say the constraint flatly and don't sell it. Every number has been measured.

- **Headlines** make a claim, not a pun. "One schema, three realms" beats
  "Blaze a trail".
- **Docs** follow the house style in `CLAUDE.md`: state the claim in bold, then
  say what it cost.
- **Marketing** uses the same voice at a lower density. The frontier metaphor
  goes in images and headings and is never forced into feature names.
- **Terms** come from `VOCABULARY.md`. Do not coin a synonym for marketing.

---

## Later, when there is material

Illustration (style, characters, landscapes, diagrams), graphic language
(lines, contours, markers, texture) and worked examples for the website, docs,
GitHub, CLI and social. Each one gets a section here once there is a real
asset to show.
