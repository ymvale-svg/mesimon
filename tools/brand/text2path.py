from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.misc.transform import Transform
from fontTools.pens.boundsPen import BoundsPen

def text_path(font_file, text, size, x=0.0, y=0.0, tracking=0.0):
    """Return (path_d, width). Hebrew RTL. (x,y) = baseline start at the RIGHT edge."""
    f = TTFont(font_file)
    upm = f['head'].unitsPerEm
    cmap = f.getBestCmap()
    hmtx = f['hmtx']
    gs = f.getGlyphSet()
    scale = size / upm
    names, advances = [], []
    for ch in text:
        gn = cmap.get(ord(ch))
        if gn is None:
            raise SystemExit('missing glyph for %r' % ch)
        names.append(gn)
        advances.append(hmtx[gn][0] * scale + tracking)
    total = sum(advances)
    pen = SVGPathPen(gs, ntos=lambda v: ('%.2f' % v).rstrip('0').rstrip('.'))
    cur = x - total
    # draw left-to-right in visual order = reversed logical order
    for gn, adv in zip(reversed(names), reversed(advances)):
        t = Transform(scale, 0, 0, -scale, cur, y)
        gs[gn].draw(TransformPen(pen, t))
        cur += adv
    bp = BoundsPen(gs)
    for gn in names:
        gs[gn].draw(bp)
    if bp.bounds:
        x0, y0, x1, y1 = bp.bounds
        ink = (y1 * scale, -y0 * scale)   # (above baseline, below baseline)
    else:
        ink = (size * 0.72, 0.0)
    return pen.getCommands(), total, ink
