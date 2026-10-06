"""
FrontierJS Serif — procedural font builder.

Builds a bold Clarendon-style serif (capitals, true lowercase, digits, symbols)
from geometric primitives (ellipses, stems, bracketed serifs) combined with
boolean path operations (skia-pathops), then compiles TrueType quadratics.

Usage:
    pip install fonttools skia-pathops brotli
    python3 build_serif.py              # -> out/FrontierJS_Serif_Regular.ttf/.woff2
    WORN=1 python3 build_serif.py       # -> out/FrontierJS_Serif_Worn_Regular.ttf/.woff2
    OUT_DIR=/some/path python3 build_serif.py
Then run kern.py to add kerning to both.
"""
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.areaPen import AreaPen
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from pathops import Path, PathOp, op, LineCap, LineJoin

import os, random, zlib
def _env(name, default):
    v = os.environ.get(name)
    return type(default)(v) if v not in (None, "") else default

WORN = _env("WORN", 0) == 1
OUT_DIR = _env("OUT_DIR", "./out")
FAMILY = _env("FAMILY", "FrontierJS Serif")
os.makedirs(OUT_DIR, exist_ok=True)
UPM = 1000
CH = _env("CH", 700)      # cap height
S = _env("S", 175)        # thick stem
HL = _env("HL", 105)       # hairline / horizontal bar
ST = _env("ST", 62)       # serif thickness
SB = _env("SB", 20)       # side bearing
EXT = _env("EXT", 55)     # serif reach past the stem
COND = _env("COND", 0.78)  # horizontal squeeze applied to every glyph; stems squeeze too, so raise S with it
EMB = _env("EMB", 16)      # embolden the hand-drawn outlines (S, digits, symbols) whose weight ignores S
WEAR = _env("WEAR", 1.0)  # worn: how many nibbles and specks
GRIT = _env("GRIT", 1.0)  # worn: how big each one is
SEED = _env("SEED", 0)    # worn: reseed the pattern
K = 0.5522847498  # circle kappa

# ------------------------------------------------------------------ primitives
def poly(pts):
    p = Path(); p.moveTo(*pts[0])
    for q in pts[1:]: p.lineTo(*q)
    p.close(); return p

def rect(x0, y0, x1, y1):
    return poly([(x0,y0),(x1,y0),(x1,y1),(x0,y1)])

def ell(cx, cy, rx, ry, sq=1.0):
    p = Path(); kx, ky = rx*K*sq, ry*K*sq
    p.moveTo(cx+rx, cy)
    p.cubicTo(cx+rx, cy+ky, cx+kx, cy+ry, cx, cy+ry)
    p.cubicTo(cx-kx, cy+ry, cx-rx, cy+ky, cx-rx, cy)
    p.cubicTo(cx-rx, cy-ky, cx-kx, cy-ry, cx, cy-ry)
    p.cubicTo(cx+kx, cy-ry, cx+rx, cy-ky, cx+rx, cy)
    p.close(); return p

def U(*ps):
    r = Path()
    for p in ps: r = op(r, p, PathOp.UNION)
    return r

def D(a, *bs):
    for b in bs: a = op(a, b, PathOp.DIFFERENCE)
    return a

def I(a, b): return op(a, b, PathOp.INTERSECTION)

def ring(cx, cy, rx, ry, tx=S, ty=HL, shift=0, sq=1.0):
    """Elliptical ring: thick sides (tx), thin top/bottom (ty)."""
    return D(ell(cx, cy, rx, ry, sq), ell(cx+shift, cy, rx-tx+ (abs(shift)/2 if shift else 0), ry-ty, sq))

def lring(cx, cy, rx, ry, tl, tr, ty=HL, sq=1.0):
    """Elliptical ring with different left/right thickness."""
    ic = ((cx-rx+tl) + (cx+rx-tr)) / 2
    return D(ell(cx, cy, rx, ry, sq), ell(ic, cy, (2*rx-tl-tr)/2, ry-ty, sq))

def tophalf(p, cy):  return I(p, rect(-800, cy, 1800, 1500))
def bothalf(p, cy):  return I(p, rect(-800, -1500, 1800, cy))

def xform(p, sx=1, sy=1, dx=0, dy=0):
    out = Path()
    p.draw(TransformPen(out.getPen(), (sx, 0, 0, sy, dx, dy)))
    return out

def embolden(p, d):
    """Grow an outline outward by d: union it with its own stroke of width 2d."""
    if d <= 0: return p
    s = Path(); p.draw(s.getPen())
    s.stroke(2*d, LineCap.BUTT_CAP, LineJoin.MITER_JOIN, 4)
    s.simplify(fix_winding=True)
    return U(p, s)

def stroke(cmds, w):
    p = Path()
    for c in cmds:
        k = c[0]
        if k == "M": p.moveTo(*c[1:])
        elif k == "L": p.lineTo(*c[1:])
        elif k == "Q": p.quadTo(*c[1:])
        elif k == "C": p.cubicTo(*c[1:])
    p.stroke(w, LineCap.BUTT_CAP, LineJoin.MITER_JOIN, 4)
    return p

def bracket(x, y, dx, dy):
    """Curved bracket filling the corner between a serif and a stem.
    (x,y) is the corner on the stem; dx,dy point along serif / along stem."""
    bw, bh = EXT*0.95, ST*1.3
    p = Path()
    p.moveTo(x + dx*bw, y)
    p.quadTo(x + dx*bw*0.17, y + dy*bh*0.09, x, y + dy*bh)
    p.lineTo(x, y); p.close(); return p

def vstem_s(x0, x1, y0=0, y1=CH, TL=True, TR=True, BL=True, BR=True, ext=None):
    ext = EXT if ext is None else ext
    parts = [rect(x0, y0, x1, y1)]
    if BL: parts += [rect(x0-ext, y0, x0, y0+ST), bracket(x0, y0+ST, -1, 1)]
    if BR: parts += [rect(x1, y0, x1+ext, y0+ST), bracket(x1, y0+ST, 1, 1)]
    if TL: parts += [rect(x0-ext, y1-ST, x0, y1), bracket(x0, y1-ST, -1, -1)]
    if TR: parts += [rect(x1, y1-ST, x1+ext, y1), bracket(x1, y1-ST, 1, -1)]
    return U(*parts)

def vstem(x0, x1, y0=0, y1=CH, top=True, bot=True):
    return vstem_s(x0, x1, y0, y1, top, top, bot, bot)

def dserif(cx, y, up, half=78):
    return rect(cx-half, y, cx+half, y+ST) if up else rect(cx-half, y-ST, cx+half, y)

def hbar_with_end(x0, x1, y, th, end_x, end_dir, end_len):
    """horizontal hairline with a vertical end serif."""
    parts = [rect(x0, y, x1, y+th)]
    if end_dir > 0:   # serif goes up
        parts.append(rect(end_x-HL, y, end_x, y+end_len))
    else:             # serif goes down
        parts.append(rect(end_x-HL, y+th-end_len, end_x, y+th))
    return U(*parts)

# ------------------------------------------------------------------ capitals
G = {}

G["I"] = vstem(100, 100+S)
_h2 = 100+S+220
G["H"] = U(vstem(100,100+S), vstem(_h2,_h2+S), rect(100+S,330,_h2,330+HL))
_tw = 40 + S + 2*200                   # crossbar: the stem plus an arm each side
_ts = 40 + (_tw-40)/2 - S/2
G["T"] = U(rect(40,CH-HL,_tw,CH), rect(40,CH-130,40+HL,CH), rect(_tw-HL,CH-130,_tw,CH),
           vstem(_ts,_ts+S, top=False))
G["L"] = U(vstem(100,100+S), rect(100,0,500,HL), rect(500-HL,0,500,130))
_ea = 100+S+265                        # arm reach past the stem
G["E"] = U(vstem(100,100+S),
           rect(100,CH-HL,_ea,CH), rect(_ea-HL,CH-130,_ea,CH),
           rect(100,330,_ea-60,330+HL), rect(_ea-60-HL,330-34,_ea-60,330+HL+34),
           rect(100,0,_ea+15,HL), rect(_ea+15-HL,0,_ea+15,130))
_fa = _ea-30
G["F"] = U(vstem(100,100+S),
           rect(100,CH-HL,_fa,CH), rect(_fa-HL,CH-130,_fa,CH),
           rect(100,320,_fa-70,320+HL), rect(_fa-70-HL,320-34,_fa-70,320+HL+34))

def bowl(cx, cy, rx, ry, tx=S, ty=HL):
    """Right-hand half ring, clipped at x=cx."""
    return I(ring(cx, cy, rx, ry, tx, ty), rect(cx, cy-ry-5, cx+rx+5, cy+ry+5))

G["D"] = U(vstem(100,100+S),
           rect(100,CH-HL,330,CH), rect(100,0,330,HL),
           bowl(330, 350, S+60, 350))
G["P"] = U(vstem(100,100+S),
           rect(100,CH-HL,320,CH), rect(100,300,320,300+HL),
           bowl(320, 500, S+40, 200))
_rb = S+40                             # bowl radius; the leg starts under its far edge
G["R"] = U(vstem(100,100+S, top=True, bot=True),
           rect(100,CH-HL,320,CH), rect(100,330,320,330+HL),
           bowl(320, 515, _rb, 185),
           poly([(300,362),(320+_rb-40,362),(320+_rb+90,0),(320+_rb-60,0)]), dserif(320+_rb+15,0,True,110))
G["B"] = U(vstem(100,100+S),
           rect(100,CH-HL,300,CH), rect(100,332,300,332+HL), rect(100,0,300,HL),
           bowl(300, 528, 210, 172, 108), bowl(300, 183, 245, 183, 108))

_or = S+131                            # O: a narrow counter, so the radius follows the stem
G["O"] = ring(40+_or, 350, _or, 360, S, HL, sq=1.22)
G["Q"] = U(G["O"], poly([(40+_or-30,70),(40+_or+70,110),(40+2*_or+40,-120),(40+2*_or-40,-165)]))

def cring():
    return ring(40+_or, 350, _or, 360, S, HL, sq=1.22)
import math as _m
_ORX = 40 + 2*_or
_TX0 = 40+_or + (_or-S)*_m.sqrt(1-(120/(360-HL))**2)
_TX1 = 40+_or + _or*_m.sqrt(1-(120/360)**2)
_IRX = 40 + 2*_or - S
G["C"] = U(D(cring(), rect(40+_or+40,225,900,470)),
           rect(_TX0,418,_TX1,472))
G["G"] = U(D(cring(), rect(40+_or+40,350,900,470)),
           rect(_TX0,418,_TX1,472),
           rect(_IRX-60,296,_ORX,296+50), rect(_IRX,235,_ORX,346))

# S: a figure-eight blob minus two counters. Each counter sits off-center so
# the wall is thick on the spine side and thin at the top or bottom, and an
# angled wedge opens it into the aperture. The spine is what is left between
# the two counters, so it comes out as a true diagonal with no seam.
def _build_S():
    cx = 280
    outer = U(ell(cx, 505, 226, 205, 1.1), ell(cx, 180, 236, 200, 1.1))
    ct = ell(cx+25, 522, 128, 102, 1.1)
    cb = ell(cx-25, 170, 133, 104, 1.1)
    wt = poly([(300, 400), (560, 300), (560, 392), (300, 560)])
    wb = poly([(260, 300), (0, 400), (0, 300), (260, 140)])
    body = D(outer, ct, wt, cb, wb)
    return D(body, rect(482, 250, 900, 480), rect(-400, 220, 68, 450))   # flat vertical terminal faces
G["S"] = _build_S()

_jx, _jy = 330, 120                      # stem's left edge; where the hook leaves the stem
_jcx = 362                               # hook center, so the hook's outer right edge is the stem's right edge
_jrx = _jx + S - _jcx
G["J"] = U(vstem(_jx,_jx+S,y0=_jy,top=True,bot=False),
           bothalf(lring(_jcx, _jy, _jrx, _jy+30, 90, S, HL+20), _jy),
           ell(_jcx-_jrx+52, _jy+30, 54, 54))
G["U"] = U(vstem(60,60+S,y0=330,bot=False),
           vstem(560,604,y0=330,bot=False),
           I(D(ell(332,330,272,340), ell(60+S+(604-44-60-S)/2, 330, (604-44-60-S)/2, 304)), rect(0,-30,700,330)))

# diagonals
def dpoly(x0,y0,x1,y1,w):
    return poly([(x0-w/2,y0),(x0+w/2,y0),(x1+w/2,y1),(x1-w/2,y1)])
def diag(t0,t1,b0,b1): return poly([(t0,CH),(t1,CH),(b1,0),(b0,0)])

G["A"] = U(diag(340,382,98,150), diag(382,500,600,722),
           rect(185,215,540,215+HL), rect(330,CH-ST,510,CH),
           dserif(124,0,True,90), dserif(661,0,True,100))
G["V"] = U(diag(40,160,370,452), diag(560,602,400,442),
           dserif(100,CH,False,100), dserif(581,CH,False,78))
G["W"] = U(diag(30,150,290,372), diag(520,562,330,372), diag(520,640,780,862),
           diag(1020,1062,810,852),
           dserif(90,CH,False,100), dserif(541,CH,False,110), dserif(1041,CH,False,78),
           rect(300,0,400,0+ST), rect(790,0,890,ST))
G["M"] = U(vstem(100,100+HL), diag(100,230,380,480), diag(690,740,430,480),
           vstem(740,860), rect(340,0,520,ST))
_nx = 665
G["N"] = U(vstem(100,100+HL), diag(100,100+S-20,_nx-S+20,_nx), vstem(_nx-S,_nx,top=True,bot=False),
           dserif(_nx-S/2-10,0,True,95))
G["X"] = U(diag(60,180,580,700), diag(560,610,130,190),
           dserif(120,CH,False,95), dserif(585,CH,False,75),
           dserif(160,0,True,75), dserif(640,0,True,95))
G["K"] = U(vstem(100,100+S),
           dpoly(200,310,590,CH,56), dserif(590,CH,False,85),
           dpoly(345,400,600,0,120), dserif(610,0,True,100))
G["Y"] = U(vstem(320,320+S,top=False,y1=320),
           poly([(40,CH),(160,CH),(450,300),(330,300)]),
           poly([(590,CH),(640,CH),(440,300),(390,300)]),
           dserif(100,CH,False,100), dserif(615,CH,False,78))
G["Z"] = U(rect(70,CH-HL,620,CH), rect(70,CH-130,70+HL,CH),
           poly([(430,CH-HL),(570,CH-HL),(200,HL),(60,HL)]),
           rect(60,0,620,HL), rect(620-HL,0,620,130))

# ------------------------------------------------------------------ lowercase (true)
XH, ASC, DESC, T = 440, 730, -200, int(round(S*0.83))
W = 470



lower = {}
RINGO = lring(255, 222, 252, 226, T+6, T+6)
RX0, RX1 = 255-252, 255+252          # ring outer x-range
lower["o"] = RINGO
lower["c"] = U(D(RINGO, rect(340,130,900,330)), ell(418,346,60,60))
lower["e"] = U(D(RINGO, rect(330,-100,900,205)), rect(130,200,400,248))
lower["b"] = U(RINGO, vstem_s(RX0,RX0+T+6,0,ASC, TL=True,TR=False))
lower["d"] = U(RINGO, vstem_s(RX1-T-6,RX1,0,ASC, TL=True,TR=False, BL=False, BR=True))
lower["p"] = U(RINGO, vstem_s(RX0,RX0+T+6,DESC,XH, TL=True,TR=False))
lower["q"] = U(RINGO, vstem_s(RX1-T-6,RX1,DESC,XH+8, TL=False,TR=False))
lower["g"] = U(RINGO, vstem_s(RX1-T-6,RX1,-100,XH+8, TL=False,TR=False, BL=False,BR=False),
               rect(RX1,XH+8-46,RX1+70,XH+8),
               bothalf(lring(255,-90,252,110,T+6,T+6), -90),
               rect(RX0,-90,RX0+T+6,-46))

def arch(x0, w, base=230, ry=218):
    cx, rx = x0 + w/2, w/2
    return tophalf(lring(cx, base, rx, ry, T, T), base)

lower["n"] = U(vstem_s(70,70+T,0,XH, TL=True,TR=False), arch(70,W),
               vstem_s(70+W-T,70+W,0,230, TL=False,TR=False))
lower["h"] = U(vstem_s(70,70+T,0,ASC, TL=True,TR=False), arch(70,W),
               vstem_s(70+W-T,70+W,0,230, TL=False,TR=False))
_aw = 430; _X = _aw - T
lower["m"] = U(vstem_s(70,70+T,0,XH, TL=True,TR=False), arch(70,_aw), arch(70+_X,_aw),
               vstem_s(70+_X,70+_X+T,0,230, TL=False,TR=False),
               vstem_s(70+2*_X,70+2*_X+T,0,230, TL=False,TR=False))
lower["u"] = U(vstem_s(70,70+T,210,XH, TL=True,TR=True, BL=False,BR=False),
               bothalf(lring(70+W/2,210,W/2,220,T,T), 210),
               vstem_s(70+W-T,70+W,0,XH, TL=False,TR=True))
lower["i"] = U(vstem_s(70,70+T,0,XH, TL=True,TR=False), ell(70+T/2,645,70,70))
lower["j"] = U(vstem_s(70,70+T,-120,XH, TL=True,TR=False, BL=False,BR=False),
               I(bothalf(lring(70+T-215,-100,215,110,T,T), -100), rect(-200,-400,900,0)),
               ell(70+T/2,645,70,70))
lower["l"] = vstem_s(70,70+T,0,ASC, TL=True,TR=False)
lower["r"] = U(vstem_s(70,70+T,0,XH, TL=True,TR=False),
               I(tophalf(lring(70+230,235,230,215,T,T), 235), rect(-800,-100,400,900)),
               ell(402,382,66,66))
# a: hood + stem + bowl (open aperture)
_aw = 410
_sx0, _sx1 = 70+_aw-T, 70+_aw
lower["a"] = U(tophalf(lring((70+_sx1)/2,338,(_sx1-70)/2,110,T-8,T), 338),
               ell(100,384,57,57),
               vstem_s(_sx0,_sx1,0,338, TL=False,TR=False, BL=False,BR=True),
               D(ell(70+(_aw-20)/2,126,(_aw-20)/2+5,136), ell(((70+T-6)+_sx0)/2,126,(_sx0-(70+T-6))/2,136-HL)))
# f: stem + hook with ball
lower["f"] = U(vstem_s(120,120+T,0,600, TL=False,TR=False),
               I(tophalf(lring(333,600,213,130,T,T), 600), rect(-800,-100,365,900)),
               ell(372,690,58,58),
               rect(30,XH-40,390,XH))
# t: stem + foot curl + crossbar
lower["t"] = U(vstem_s(110,110+T,112,610, TL=False,TR=False, BL=False,BR=False),
               rect(30,XH-40,350,XH),
               I(bothalf(lring(310,112,200,122,T,T), 112), rect(-800,-100,400,900)))
lower["k"] = U(vstem_s(70,70+T,0,ASC, TL=True,TR=False),
               poly([(150,190),(225,190),(488,XH),(430,XH)]), dserif(458,XH,False,72),
               poly([(262,262),(352,262),(520,0),(396,0)]), dserif(458,0,True,96))
lower["v"] = U(poly([(20,XH),(172,XH),(318,0),(218,0)]), poly([(432,XH),(478,XH),(326,0),(268,0)]),
               dserif(96,XH,False,92), dserif(455,XH,False,62))
lower["w"] = U(poly([(10,XH),(152,XH),(280,0),(192,0)]), poly([(380,XH),(424,XH),(284,0),(228,0)]),
               poly([(380,XH),(522,XH),(650,0),(560,0)]), poly([(748,XH),(792,XH),(656,0),(600,0)]),
               dserif(81,XH,False,86), dserif(402,XH,False,62), dserif(770,XH,False,58))
lower["x"] = U(poly([(20,XH),(172,XH),(488,0),(340,0)]), poly([(414,XH),(460,XH),(136,0),(84,0)]),
               dserif(96,XH,False,90), dserif(437,XH,False,58), dserif(112,0,True,58), dserif(414,0,True,90))
lower["y"] = U(poly([(14,XH),(160,XH),(322,112),(262,112)]), dpoly(446,XH,160,-170,48),
               dserif(87,XH,False,90), dserif(446,XH,False,60), ell(168,-166,58,58))
lower["z"] = U(rect(40,XH-44,450,XH), rect(40,XH-124,80,XH),
               poly([(335,XH-44),(450,XH-44),(155,44),(40,44)]),
               rect(40,0,450,44), rect(410,0,450,124))
lower["s"] = xform(G["S"], 0.80, 0.64)

# ------------------------------------------------------------------ digits
N = {}
N["0"] = ring(280, 350, 235, 360, 112, HL)
N["1"] = U(vstem(210,210+S,bot=True,top=False),
           poly([(210,CH),(210,610),(95,560),(95,615)]))
N["2"] = stroke([("M",80,540),("Q",90,675,240,672),("Q",410,668,410,530),("Q",410,420,250,270),
                 ("L",80,52),("L",450,52)], 90)
N["3"] = stroke([("M",80,610),("Q",130,672,240,672),("Q",385,672,385,548),("Q",385,420,215,398),
                 ("Q",425,380,425,215),("Q",425,55,245,52),("Q",120,52,65,130)], 88)
N["4"] = U(stroke([("M",340,0),("L",340,CH)], 100),
           stroke([("M",330,CH-10),("L",40,215),("L",490,215)], 92))
N["5"] = stroke([("M",410,668),("L",135,668),("L",110,400),("Q",165,448,255,448),
                 ("Q",440,448,440,245),("Q",440,52,255,52),("Q",130,52,65,135)], 88)
N["6"] = stroke([("M",410,640),("Q",340,692,255,692),("Q",90,692,90,365),("Q",90,52,255,52),
                 ("Q",420,52,420,235),("Q",420,420,255,420),("Q",120,420,92,300)], 88)
N["7"] = stroke([("M",60,665),("L",460,665),("L",190,0)], 90)
N["8"] = U(ring(255,527,180,170,86,HL), ring(255,185,210,190,92,HL))
N["9"] = xform(N["6"], -1, -1, 520, 700)

# ------------------------------------------------------------------ punctuation / symbols
P = {}
P["."] = ell(80,52,52,52)
P[","] = U(ell(80,52,52,52), poly([(40,40),(110,40),(70,-110),(20,-100)]))
P[":"] = U(ell(80,52,52,52), ell(80,398,52,52))
P[";"] = U(ell(80,398,52,52), ell(80,52,52,52), poly([(40,40),(110,40),(70,-110),(20,-100)]))
P["!"] = U(poly([(30,CH),(150,CH),(118,215),(62,215)]), ell(90,52,52,52))
P["?"] = U(stroke([("M",70,545),("Q",90,675,235,672),("Q",385,668,385,545),("Q",385,420,230,360),("L",230,250)], 90),
           ell(230,52,52,52))
P["'"] = poly([(30,CH),(130,CH),(100,440),(60,440)])
P['"'] = U(poly([(30,CH),(130,CH),(100,440),(60,440)]), poly([(200,CH),(300,CH),(270,440),(230,440)]))
P["-"] = rect(40,290,330,290+HL+14)
P["_"] = rect(0,-90,560,-50)
P["/"] = poly([(20,-60),(120,-60),(450,CH),(350,CH)])
P["\\"] = poly([(350,-60),(450,-60),(120,CH),(20,CH)])
P["("] = stroke([("M",290,CH+40),("Q",90,420,90,320),("Q",90,220,290,-120)], 60)
P[")"] = xform(P["("], -1, 1, 380, 0)
P["["] = U(rect(90,-110,150,CH+60), rect(90,CH,300,CH+60), rect(90,-110,300,-50))
P["]"] = xform(P["["], -1, 1, 390, 0)
P["+"] = U(rect(60,300,440,360), rect(220,140,280,520))
P["="] = U(rect(60,220,440,274), rect(60,380,440,434))
P["<"] = stroke([("M",440,480),("L",80,330),("L",440,180)], 60)
P[">"] = xform(P["<"], -1, 1, 520, 0)
P["*"] = U(stroke([("M",230,600),("L",230,300)], 56),
           stroke([("M",90,520),("L",370,380)], 56), stroke([("M",90,380),("L",370,520)], 56))
P["#"] = U(stroke([("M",170,60),("L",250,640)], 52), stroke([("M",330,60),("L",410,640)], 52),
           rect(60,250,470,302), rect(90,400,500,452))
P["$"] = U(G["S"], rect(307,-70,367,780))
P["%"] = U(ring(130,560,100,140,40,26), ring(450,140,100,140,40,26),
           poly([(80,0),(170,0),(500,CH),(410,CH)]))
P["&"] = U(stroke([("M",500,0),("L",210,470),("Q",120,570,150,630),("Q",190,690,260,675),
                   ("Q",340,650,320,560),("Q",300,490,180,360),("Q",60,235,90,130),
                   ("Q",130,40,250,45),("Q",360,50,470,230)], 64))
P["@"] = U(ring(330,300,300,330,70,40),
           ring(330,300,125,140,45,34), rect(400,160,460,430))

# ------------------------------------------------------------------ assemble
def finish(path, adv=None, sb=SB):
    if COND != 1.0: path = xform(path, COND, 1)
    path.simplify(fix_winding=True)
    bx0, by0, bx1, by1 = path.bounds
    dx = sb - bx0
    out = Path()
    path.draw(TransformPen(out.getPen(), (1,0,0,1,dx,0)))
    out.simplify(fix_winding=True)
    w = int(round(bx1 - bx0 + 2*sb)) if adv is None else adv
    return out, w


def worn(path, name):
    """Letterpress wear: nibble the edges and sprinkle tiny ink-voids."""
    rng = random.Random(zlib.crc32(name.encode()) + SEED)
    x0, y0, x1, y1 = path.bounds
    area = max(1.0, (x1-x0)*(y1-y0))
    pts = list(path.points)
    cuts = []
    # edge nibbles
    n_edge = int((14 + area/9000) * WEAR)
    for _ in range(n_edge):
        px, py = rng.choice(pts)
        px += rng.uniform(-12, 12); py += rng.uniform(-12, 12)
        r = rng.uniform(4, 15) * GRIT
        cuts.append(ell(px, py, r*rng.uniform(0.6,1.4), r*rng.uniform(0.6,1.4)))
    # interior specks
    n_spk = int((10 + area/12000) * WEAR)
    tries = 0
    while len([1 for _ in cuts]) < n_edge + n_spk and tries < 400:
        tries += 1
        px, py = rng.uniform(x0, x1), rng.uniform(y0, y1)
        if path.contains((px, py)):
            r = rng.uniform(2.2, 7) * GRIT
            cuts.append(ell(px, py, r*rng.uniform(0.7,1.3), r*rng.uniform(0.7,1.3)))
    if not cuts: return path
    holes = U(*cuts)
    return D(path, holes)

def to_glyph(path):
    rec = RecordingPen(); path.draw(rec)
    ap = AreaPen(); rec.replay(ap)
    rev = ap.value > 0     # TrueType wants clockwise outers
    tt = TTGlyphPen(None)
    rec.replay(Cu2QuPen(tt, 1.0, reverse_direction=rev))
    return tt.glyph()

allg = {}
allg.update(G); allg.update(lower); allg.update(N); allg.update(P)

glyph_order = [".notdef", "space"] + sorted(allg.keys(), key=lambda c: (c.islower(), ord(c)))
glyphs, metrics = {}, {}

# .notdef: simple box
nd = D(rect(80,0,520,700), rect(130,50,470,650))
pth, w = finish(nd, 600, 0); glyphs[".notdef"] = to_glyph(nd); metrics[".notdef"] = (600, 80)
glyphs["space"] = TTGlyphPen(None).glyph(); metrics["space"] = (300, 0)

EMB_GLYPHS = set("Ss&?%@$2345679()")
for ch, p in allg.items():
    sb = SB if ch.isalnum() else 40
    if ch in EMB_GLYPHS: p = embolden(p, EMB/2 if ch in "Ss" else EMB)   # the S outline's counters close at full strength
    fp, w = finish(p, None, sb)
    if WORN:
        fp = worn(fp, ch); fp.simplify(fix_winding=True)
    glyphs[ch] = to_glyph(fp)
    metrics[ch] = (w, sb)

FAM = FAMILY + (' Worn' if WORN else '')
FSLUG = FAM.replace(' ', '_')
fb = FontBuilder(UPM, isTTF=True)
fb.setupGlyphOrder(glyph_order)
fb.setupCharacterMap({**{ord(c): c for c in allg}, 32: "space"})
fb.setupGlyf(glyphs)
# lsb from actual bounds
glyf = fb.font["glyf"]
hm = {}
for gn, (adv, _) in metrics.items():
    g = glyf[gn]
    if g.numberOfContours:
        g.recalcBounds(glyf); hm[gn] = (adv, g.xMin)
    else:
        hm[gn] = (adv, 0)
fb.setupHorizontalMetrics(hm)
fb.setupHorizontalHeader(ascent=860, descent=-260)
fb.setupNameTable({
    "familyName": FAM, "styleName": "Regular",
    "fullName": FAM + " Regular", "psName": FAM.replace(" ", "") + "-Regular",
    "uniqueFontIdentifier": FAM + " Regular 1.0", "version": "Version 1.0",
})
fb.setupOS2(sTypoAscender=860, sTypoDescender=-260, usWinAscent=940, usWinDescent=300,
            sxHeight=XH, sCapHeight=CH)
fb.setupPost()
fb.setupMaxp()
out = f"{OUT_DIR}/{FSLUG}_Regular.ttf"
fb.save(out)

f = TTFont(out); f.flavor = "woff2"; f.save(f"{OUT_DIR}/{FSLUG}_Regular.woff2")
print("ok", len(glyph_order), "glyphs")
