# FrontierJS imagery

The kit for making a FrontierJS image: a painted landscape, a hero or social
card, a realm illustration, a texture plate, or an AI image prompt. Copy the
prompt blocks as written, add the realm line and the figure line when they
apply, and judge the result against § 8 before it goes into `assets/`.

**Scope: pictures, not the interface.** The logo, the icons and anything a page
renders follow `README.md` § 2–4 and `theme-field`. A logo has to read in one
flat color at 16px, and this kit asks for painterly depth. Both are right,
because they cover different things.

The reference image is `fjs-backdrop-portrait.png` at the repo root. When a
prompt and that image disagree, the image wins. `assets/moodboard.image-ref.png`
is the board for the whole range: the swatches, the material close-ups and the
collage layout. It is gitignored, so it exists only on the owner's machine. Its
mountain-peak mark is not the logo (`README.md` § 2).

---

## 1 · The defining contrast

**Grand cinematic wilderness, plus intimate handcrafted field-journal detail.**
The landscape supplies the scale and the emotion, and the journal supplies the
character and the texture. An image that has only one half is not finished. A
vista with no hand in it reads as stock photography, and parchment with no
horizon reads as a craft store.

## 2 · The five anchors

Use these as shorthand in prompts, design reviews and briefs. Together they say
more than *rustic*, *outdoorsy* or *vintage* does.

1. **Cinematic wilderness**: dramatic, expansive, atmospheric landscapes.
2. **Vintage field guide**: parchment, cartography, engraving, editorial
   composition.
3. **Earthy expedition palette**: sandstone, rust, amber, forest green, slate.
4. **Tactile heritage craftsmanship**: leather, brass, weathered wood, aged
   paper.
5. **Rugged sophistication**: adventurous and rugged, and still refined. It is
   a surveyor's kit, not a Western costume.

## 3 · Scene base and master prompt

**Paste the scene base first in any prompt for a single picture.** It anchors
on 19th-century American landscape painting, which is what keeps the realism.

```text
Cinematic oil painting in the tradition of Albert Bierstadt and Thomas Moran,
painterly realism with believable geology, scale and light. Golden hour, low
sun, amber rim light, long shadows, volumetric light through atmospheric haze
between receding ridges, dramatic clouds catching warm light. Earthy palette
of sandstone, burnt sienna, rust, amber, deep forest green, muted slate blue
and warm charcoal shadows. Rich tonal depth, visible brushwork, subtle film
grain, restrained detail, open sky as negative space.
```

**Anchor a scene on `fjs-backdrop-portrait.png`, not `territory.webp`.** The
territory map is a fantasy board-game map, and prompts written to match it come
out as cartoons. The positive prompt describes real terrain and real light. The
words *fantasy*, *glowing*, *cutaway* and *map* belong in the negative prompt.

**The master prompt is the brief for a moodboard or for a person.** It asks for
a "visual identity", so a model given it makes a collage board instead of a
scene.

```text
Create a cinematic, rugged, frontier-inspired visual identity rooted in
wilderness exploration, cartography, and old-world craftsmanship. Blend the
grandeur of American desert canyons, alpine mountain ranges, and deep evergreen
forests with the warmth of a golden-hour sunset. Use a rich, earthy palette of
weathered parchment, sandstone, burnt sienna, rust, amber, saddle leather, deep
forest green, and muted slate blue. Layer tactile materials such as aged paper,
topographic maps, worn leather, brushed brass, weathered wood, and engraved
metal. Imagery should feel like a vintage field journal meets a premium outdoor
expedition brand, captured with cinematic lighting, dramatic landscapes,
atmospheric haze, deep shadows, warm highlights, and subtle film grain.
Incorporate refined engraving, restrained linework, heritage typography,
natural imperfections, and carefully composed negative space. The result should
feel adventurous, grounded, timeless, handcrafted, and quietly powerful — a
field guide to the unknown, not a generic outdoor brand. Favor rich tonal
depth, natural textures, sophisticated composition, and painterly realism over
flat graphics, sterile minimalism, or overly polished digital aesthetics.
```

## 4 · Add-on lines

Append whichever of these apply, after the master prompt.

**Realm terrain.** Each realm has its own ground, so a series reads as one
territory with three regions. These assignments come from `README.md` § 1.

| Realm | Package | Line to append |
| ----- | ------- | -------------- |
| Data | Litestone | `Layered desert canyon strata in sandstone and burnt sienna, exposed rock bands like a geological cross-section, low sun raking across the walls.` |
| API | Junction | `A river confluence seen from a high ledge, two waters meeting and running on as one, braided channels catching amber light.` |
| UI | Sierra | `A forested alpine ridge in deep evergreen, snow-touched peaks behind, layered silhouettes fading into slate-blue haze.` |
| All three | — | `A single panoramic valley holding desert mesas, a winding river and evergreen ridges under snowcapped peaks at golden hour.` |

**The figure.** A figure is optional. When one appears, it is small against the
land and it is working, not posing.

```text
A lone surveyor seen from behind or in three-quarter view, small in the frame,
wearing a dark brown felt field hat with a pinched teardrop crown and a flat
working brim, a long weathered coat and a canvas pack, holding a wooden staff.
A wolf-like working dog sits beside them. They look out over the land rather
than at the viewer.
```

Write *wolf-like dog*. With *wolf* alone the model paints a wild animal, which
pushes the image toward fantasy art.

Name the hat's shape exactly as written above. Image models default to a cowboy
hat when the prompt says only *hat* or *Western*.

**Field-journal plate.** Use this for a texture, a background or a collage
panel rather than a vista.

```text
Flat-lay of an open expedition field journal on weathered wood: aged parchment
with faint topographic contour lines, a pencil survey sketch of a ridge, a
brass compass and an engraved brass benchmark disk, a worn leather strap,
torn-paper edges, soft raking golden light, fine paper grain.
```

**Material detail.** Use this for a close-up tile in a collage or a section
break. Swap the subject: sandstone, pine needles, weathered wood grain, a brass
buckle, worn leather, felt.

```text
Macro close-up of wind-carved sandstone, shallow depth of field, amber rim
light grazing the surface, deep earthy shadow in the grain, subtle film grain.
```

**Engraved horizon band.** Use this for a border, a footer strip or a divider.

```text
A long panoramic strip of mesas and ridgelines rendered as a faded sepia
engraving on aged parchment, fine hatched linework, edges dissolving into the
paper.
```

## 5 · Negative prompt

Paste this into the tool's negative-prompt field. Where a tool has no such
field, append it as `Avoid: …`.

```text
generic startup branding, corporate stock photography, sterile minimalism, flat
vector art, neon colors, saturated electric blue, hacker green, pure white
background, pure black background, cyberpunk, steampunk, western caricature,
cowboy hat, cowboy clichés, revolvers, saloon, wanted poster, excessive foliage,
cluttered composition, glossy plastic surfaces, futuristic interface, esports
aesthetic, oversaturated HDR, artificial lens flare, cartoon landscape, overly
distressed grunge, excessive ornamentation, generic AI fantasy art, fantasy
illustration, storybook, cel shading, anime, video game concept art, board game
map, glowing magic, isometric, cutaway diagram, cross-section diagram,
infographic, miniature, tilt-shift, toy-like, text, lettering, labels,
watermark, logo
```

`text, lettering, watermark, logo` is there because type is set by the page and
the mark comes from `assets/`. A model writes its own lettering badly, and a
picture with lettering burned in cannot be reused at another size or in another
language.

## 6 · Keyword bank

Use these to vary a prompt or to write a brief for a person. Pick from a row;
don't paste every row at once.

| Facet | Words |
| ----- | ----- |
| Mood | rugged · cinematic · adventurous · timeless · grounded · exploratory · nostalgic · elemental · quietly powerful · frontier spirit |
| Color | weathered parchment · sandstone · burnt sienna · rust · terracotta · sunset amber · antique gold · saddle brown · deep forest green · muted slate blue · charcoal · warm sepia |
| Materials | aged parchment · topographic contour lines · weathered leather · engraved brass · patinated metal · film grain · distressed wood · worn canvas · natural stone · faded ink · fine paper grain |
| Light | golden hour · amber rim light · volumetric sunlight · long shadows · atmospheric haze · layered mountain silhouettes · dramatic clouds · warm highlights · deep earthy shadows · cinematic grade |
| Visual language | vintage field guide · expedition journal · national-park heritage · antique cartography · engraved illustration · surveyor aesthetic · heritage craftsmanship · editorial collage · natural asymmetry · restrained ornament |
| Composition | layered landscape · panoramic vista · framed illustration · torn-paper edge · overlapping material samples · balanced negative space · tactile collage · editorial layout · organic border · strong hierarchy |

## 7 · Palette in pictures

**A painted color is named, not given a hex value.** The words in § 6 steer a
model better than a hex value does, and the brand has no hex value outside
`theme-field` (`README.md` § 3). If an approved image is sampled for a light
theme or print, the samples go into `packages/css/src/themes/` as tokens, not
into this file.

Two rules connect pictures to the page:

- **The darkest value in an image is warm charcoal or deep slate blue, and the
  lightest is parchment.** Charcoal matches `theme-field`'s near-black ground
  and parchment its sand ink, so an image sits on a page without a visible
  seam. Deep slate is for a ground that is meant to read as its own panel,
  such as a topographic plate with pale contour lines.
- **Leave negative space where the page's type will go**: sky, haze, or the
  bare parchment of a journal plate. A hero image is a ground for a headline,
  not a picture with the headline crowded beside it.

## 8 · Acceptance check

An image ships when every line is true. Judge it at the size it will be used at.

- [ ] It has both halves of § 1: scale, and something handmade.
- [ ] The light is golden hour or lamplight, with long shadows and haze between
      the layers.
- [ ] The palette stays within the § 6 color row, and nothing is neon,
      electric blue or pure white or black.
- [ ] Any hat is the field hat in § 4.
- [ ] It contains no lettering, watermark or invented logo.
- [ ] It is painterly. Flat vector, glossy CGI or HDR punch fails.
- [ ] Its ornament is restrained. Engraving and linework frame the image and do
      not fill it.
- [ ] It reads as the same territory as `fjs-backdrop-portrait.png`.

A shippable file goes in `assets/`. Keep the prompt that made it in a sidecar
`<name>.prompt.txt` beside it, so the image can be regenerated or varied. A
large source or contact sheet is named `*.image-ref.*`, which keeps it out of
git (`README.md`, top).
