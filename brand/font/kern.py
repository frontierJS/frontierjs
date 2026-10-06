"""
Auto-kerning for FrontierJS Serif.

Renders every A-Z / a-z glyph, measures the optical gap between each pair of
outlines, compares it to a reference pair (nn / HH / Hn), and writes the
corrections into both fonts as a GPOS 'kern' feature plus a legacy kern table.
A collision floor stops serifs/strokes from touching.

Usage:
    pip install fonttools pillow numpy
    python3 kern.py        # run after build_serif.py (both variants)
"""
import sys, numpy as np
from PIL import Image, ImageDraw, ImageFont
from fontTools.ttLib import TTFont, newTable
from fontTools.feaLib.builder import addOpenTypeFeaturesFromString

import os
import glob
OUT = os.environ.get("OUT_DIR", "./out")
# FONTS=a.ttf,b.ttf picks the targets; default is every ttf in OUT_DIR.
# Gaps are measured on the clean font when one is there, because wear adds noise to the edge profile.
TARGETS = [t for t in os.environ.get("FONTS", "").split(",") if t] or sorted(glob.glob(f"{OUT}/*.ttf"))
if not TARGETS: sys.exit("kern: no .ttf in " + OUT)
SRC = next((t for t in TARGETS if "Worn" not in t), TARGETS[0])
LETTERS = [chr(c) for c in range(65,91)] + [chr(c) for c in range(97,123)]
CAP = 260          # depth limit for optical gap
STRENGTH = 0.75
STRENGTH_UU = 0.55
MINGAP = 34
LO, HI = -150, 30
YS = list(range(0, 761, 10))

font = ImageFont.truetype(SRC, 1000)
tt = TTFont(SRC)
adv = {g: tt["hmtx"][g][0] for g in LETTERS}
ORIGIN_X, BASE_Y, W, H = 200, 1000, 1500, 1500

prof = {}
for ch in LETTERS:
    im = Image.new("L", (W, H), 0)
    ImageDraw.Draw(im).text((ORIGIN_X, BASE_Y), ch, font=font, fill=255, anchor="ls")
    a = np.array(im) > 110
    L, R = {}, {}
    for y in YS:
        row = a[BASE_Y - y]
        xs = np.nonzero(row)[0]
        if xs.size: L[y] = xs.min() - ORIGIN_X; R[y] = xs.max() + 1 - ORIGIN_X
    prof[ch] = (L, R, max(L) if L else 0)

def mingap(a, b):
    La, Ra, _ = prof[a]; Lb, Rb, _ = prof[b]
    v = [(adv[a] - Ra[y]) + Lb[y] for y in YS if y in Ra and y in Lb]
    return min(v) if v else 999

def area(a, b):
    La, Ra, ta = prof[a]; Lb, Rb, tb = prof[b]
    top = min(ta, tb)
    vals = []
    for y in YS:
        if y > top: break
        if y in Ra and y in Lb:
            vals.append(min(CAP, (adv[a] - Ra[y]) + Lb[y]))
        else:
            vals.append(CAP)
    return float(np.mean(vals))

tgt = {("l","l"): area("n","n"), ("u","u"): area("H","H"),
       ("u","l"): area("H","n"), ("l","u"): area("n","H")}

pairs = {}
for a in LETTERS:
    for b in LETTERS:
        t = tgt[("u" if a.isupper() else "l", "u" if b.isupper() else "l")]
        st = STRENGTH_UU if (a.isupper() and b.isupper()) else STRENGTH
        k = st * (t - area(a, b))
        k = max(k, MINGAP - mingap(a, b))      # never let serifs/strokes collide
        k = max(LO, min(HI, k))
        k = int(round(k / 5.0) * 5)
        if abs(k) >= 10: pairs[(a, b)] = k

print("pairs:", len(pairs))
for p in [("A","V"),("T","o"),("W","a"),("Y","o"),("L","T"),("r","i"),("F","r"),("v","a"),("T","A"),("o","o"),("n","n"),("r","o")]:
    print(p, pairs.get(p, 0))

fea = "feature kern {\n" + "\n".join(f"  pos {a} {b} {v};" for (a, b), v in sorted(pairs.items())) + "\n} kern;\n"
open(f"{OUT}/kern.fea", "w").write(fea)

for path in TARGETS:
    f = TTFont(path)
    for t in ("GPOS", "GSUB", "kern"):
        if t in f: del f[t]
    addOpenTypeFeaturesFromString(f, fea)
    k = newTable("kern"); k.version = 0
    sub = __import__("fontTools.ttLib.tables._k_e_r_n", fromlist=["KernTable_format_0"]).KernTable_format_0()
    sub.coverage = 1; sub.format = 0; sub.kernTable = dict(pairs)
    k.kernTables = [sub]
    f["kern"] = k
    f.save(path)
    f2 = TTFont(path); f2.flavor = "woff2"; f2.save(path.replace(".ttf", ".woff2"))
    print("kerned", path.split("/")[-1])
