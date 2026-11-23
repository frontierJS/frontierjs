#!/usr/bin/env python3
"""Write the one-color icon sets: assets/icons/white/ and assets/icons/gray/.

Run from anywhere after an icon in assets/icons/ is added or redrawn:

    python3 brand/mono-icons.py [--sheet out.png]

Needs Pillow. --sheet also writes a contact sheet (color, gray, white rows on
a dark tile) to check the result by eye.
"""
import glob
import os
import re
import sys

from PIL import Image, ImageDraw

ICONS = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'assets', 'icons')
WHITE = os.path.join(ICONS, 'white')
GRAY = os.path.join(ICONS, 'gray')

# A plain desaturation leaves a red icon far darker than a lime one, so the
# gray set looks uneven in a grid. Every icon is stretched into the same band.
GRAY_LO, GRAY_HI = 110, 220
GRAY_SVG = '#c8c8c8'


def white_png(im):
    a = im.getchannel('A')
    full = Image.new('L', im.size, 255)
    return Image.merge('RGBA', (full, full, full, a))


def gray_png(im):
    a = im.getchannel('A')
    lum = im.convert('L')
    opaque = [v for v, al in zip(lum.getdata(), a.getdata()) if al > 128]
    lo, hi = (min(opaque), max(opaque)) if opaque else (0, 255)

    def band(v):
        if hi == lo:
            return (GRAY_LO + GRAY_HI) // 2
        return int(GRAY_LO + (v - lo) * (GRAY_HI - GRAY_LO) / (hi - lo))

    g = lum.point(band)
    return Image.merge('RGBA', (g, g, g, a))


# A traced SVG here is one path in one fill, so recoloring is a fill swap.
def recolor_svg(text, color):
    return re.sub(r'fill="#[0-9a-fA-F]{3,8}"', f'fill="{color}"', text)


def sheet(names, out):
    w = 110
    rows = (len(names) + 9) // 10
    img = Image.new('RGBA', (w * 10, (w + 20) * 3 * rows), (30, 30, 32, 255))
    draw = ImageDraw.Draw(img)
    for i, n in enumerate(names):
        for row, src in enumerate([ICONS, GRAY, WHITE]):
            x = (i % 10) * w + 7
            y = ((i // 10) * 3 + row) * (w + 20) + 7
            img.alpha_composite(Image.open(f'{src}/{n}.png').convert('RGBA'), (x, y))
            if row == 0:
                draw.text((x, y + 98), n, fill=(170, 170, 170, 255))
    img.save(out)


def main(argv):
    os.makedirs(WHITE, exist_ok=True)
    os.makedirs(GRAY, exist_ok=True)
    names = sorted(os.path.basename(f)[:-4] for f in glob.glob(f'{ICONS}/*.png'))
    for n in names:
        im = Image.open(f'{ICONS}/{n}.png').convert('RGBA')
        white_png(im).save(f'{WHITE}/{n}.png', optimize=True)
        gray_png(im).save(f'{GRAY}/{n}.png', optimize=True)
    svgs = sorted(glob.glob(f'{ICONS}/*.svg'))
    for f in svgs:
        text = open(f).read()
        base = os.path.basename(f)
        open(f'{WHITE}/{base}', 'w').write(recolor_svg(text, '#ffffff'))
        open(f'{GRAY}/{base}', 'w').write(recolor_svg(text, GRAY_SVG))
    if '--sheet' in argv:
        sheet(names, argv[argv.index('--sheet') + 1])
    print(f'{len(names)} png, {len(svgs)} svg -> white/ gray/')


if __name__ == '__main__':
    main(sys.argv[1:])
