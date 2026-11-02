# -*- coding: utf-8 -*-
"""בונה את ערכת הלוגו של משימון: סמל, לוגוטייפ ונעילות, הכל כווקטור נקי."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from text2path import text_path

SCR  = os.path.dirname(os.path.abspath(__file__))
# קובצי Assistant (OFL) — מורידים מ-Google Fonts לתיקיית העבודה או לתיקיית הסקריפט.
FONT_DIR = os.environ.get('MESIMON_FONT_DIR', SCR)
F800 = os.path.join(FONT_DIR, 'assistant-800.woff2')
F600 = os.path.join(FONT_DIR, 'assistant-600.woff2')
for _f in (F800, F600):
    if not os.path.exists(_f):
        sys.exit('חסר גופן: %s — ראו public/brand/README.md' % _f)
OUT  = sys.argv[1]
os.makedirs(OUT, exist_ok=True)

BRAND, BRAND_DARK, BRAND_DEEP = '#0f766e', '#115e59', '#0b4a45'
MINT, INK = '#5eead4', '#0f172a'
MINT_MID = '#2dd4bf'   # הפאה הבהירה על רקע בהיר, כדי לשמור ניגוד
WORD, TAG = 'משימון', 'משימות שעובדות בשבילך'

# ---------- the symbol, drawn inside a 512×512 box ----------
# הגאומטריה הרשמית של הסמל (UI.logoMark, tools/make-icons.js) בתיבת 64,
# מוגדלת פי 8: שני לוחות מוטים בצורת הלוגו של אשל הירדן, ומתחתם וי אחד.
FACES = [[(120, 132), (216, 112), (216, 160), (120, 180)],
         [(120, 220), (216, 200), (216, 248), (120, 268)]]
INKS  = [[(216, 112), (320, 124), (320, 172), (216, 160)],
         [(216, 200), (264, 212), (264, 260), (216, 248)]]
CHECK_D, CHECK_W = 'M128 356 L200 424 L384 208', 56
BB = (120, 112, 384 + CHECK_W / 2, 424 + CHECK_W / 2)
BB_W, BB_H = BB[2] - BB[0], BB[3] - BB[1]

def _poly(pts, fill):
    return '<path fill="%s" d="M%s z"/>' % (fill, ' L'.join('%g %g' % p for p in pts))

def symbol(body, lead, chk):
    """body = הפאה המלאה, lead = הפאה הבהירה, chk = הווי."""
    out = ''.join(_poly(p, lead) for p in FACES) + ''.join(_poly(p, body) for p in INKS)
    return (out + f'<path d="{CHECK_D}" fill="none" stroke="{chk}" stroke-width="{CHECK_W}"'
                  f' stroke-linecap="round" stroke-linejoin="round"/>')

def symbol_at(x, y, h, body, lead, chk):
    """הסמל, לפי גובה חזותי h, כשפינתו השמאלית-עליונה ב-(x,y)."""
    s = h / BB_H
    return (f'<g transform="translate({x:.2f},{y:.2f}) scale({s:.5f}) '
            f'translate({-BB[0]:.2f},{-BB[1]:.2f})">' + symbol(body, lead, chk) + '</g>')

GRAD = ('<linearGradient id="g" x1="0" y1="0" x2="1" y2="1">'
        '<stop offset="0" stop-color="#14857c"/><stop offset=".55" stop-color="' + BRAND + '"/>'
        '<stop offset="1" stop-color="' + BRAND_DEEP + '"/></linearGradient>')

def svg(w, h, body, defs='', vb=None):
    vb = vb or f'0 0 {w} {h}'
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" width="{w}" height="{h}" '
            f'role="img" aria-label="משימון"><title>משימון</title>'
            + (f'<defs>{defs}</defs>' if defs else '') + body + '</svg>\n')

def write(name, content):
    open(os.path.join(OUT, name), 'w', encoding='utf-8').write(content)
    print('wrote', name)

# 1. app icon — full bleed (the platform rounds it)
write('mesimon-icon.svg',
      svg(512, 512, '<rect width="512" height="512" fill="url(#g)"/>' + symbol('#ffffff', MINT, '#ffffff'), GRAD))
# 2. rounded tile — avatars, marketing
write('mesimon-mark.svg',
      svg(512, 512, '<rect width="512" height="512" rx="136" fill="url(#g)"/>' + symbol('#ffffff', MINT, '#ffffff'), GRAD))
# 3. the bare symbol, cropped to its own box
def bare(body, lead, chk):
    return svg(round(BB_W), round(BB_H), symbol_at(0, 0, BB_H, body, lead, chk))
write('mesimon-symbol.svg',       bare(BRAND, MINT_MID, BRAND))
write('mesimon-symbol-white.svg', bare('#ffffff', '#ffffff', '#ffffff'))
write('mesimon-symbol-ink.svg',   bare(INK, INK, INK))

# 4. wordmark
def wordmark(color, tag=False):
    size, pad = 200, 10
    d, w, (top, bot) = text_path(F800, WORD, size, tracking=-2)
    H = top + bot + 2 * pad
    body = f'<g transform="translate({w + pad:.2f},{top + pad:.2f})"><path fill="{color}" d="{d}"/></g>'
    W = w + 2 * pad
    if tag:
        ts = size * .28
        td, tw, (tt, tb) = text_path(F600, TAG, ts)
        step = bot + ts * .62 + tt
        H += step - bot + tb
        body += (f'<g transform="translate({w + pad:.2f},{top + pad + step:.2f})" opacity=".85">'
                 f'<path fill="{color}" d="{td}"/></g>')
        W = max(W, tw + 2 * pad)
    return svg(round(W), round(H), body)
write('mesimon-wordmark.svg',       wordmark(BRAND_DARK))
write('mesimon-wordmark-white.svg', wordmark('#ffffff'))

# 5. horizontal lockup — RTL: the symbol leads on the right
def lockup(color, body_c, lead_c, chk_c, tag=False):
    size, pad, gap = 112, 14, 30
    sym_h = 124
    d, w, (top, bot) = text_path(F800, WORD, size, tracking=-1.5)
    tag_h = 0.0; td = tw = None
    if tag:
        ts = 38
        td, tw, (tt, tb) = text_path(F600, TAG, ts)
        tag_h = bot + ts * .55 + tt
        bot = bot - bot + tb + 0  # the tagline now owns the bottom ink
    text_h = top + bot + tag_h
    H = max(sym_h, text_h) + 2 * pad
    W = pad + max(w, tw or 0) + gap + sym_h * (BB_W / BB_H) + pad
    sym_w = sym_h * (BB_W / BB_H)
    base = (H - text_h) / 2 + top
    body = (symbol_at(W - pad - sym_w, (H - sym_h) / 2, sym_h, body_c, lead_c, chk_c)
            + f'<g transform="translate({W - pad - sym_w - gap:.2f},{base:.2f})"><path fill="{color}" d="{d}"/></g>')
    if tag:
        body += (f'<g transform="translate({W - pad - sym_w - gap:.2f},{base + tag_h:.2f})" opacity=".82">'
                 f'<path fill="{color}" d="{td}"/></g>')
    return svg(round(W), round(H), body)
write('mesimon-logo-horizontal.svg',         lockup(BRAND_DARK, BRAND, MINT_MID, BRAND))
write('mesimon-logo-horizontal-white.svg',   lockup('#ffffff', '#ffffff', '#ffffff', '#ffffff'))
write('mesimon-logo-horizontal-tagline.svg', lockup(BRAND_DARK, BRAND, MINT_MID, BRAND, tag=True))

# 6. stacked lockup
def stacked(color, body_c, lead_c, chk_c):
    size, pad, gap, sym_h = 112, 14, 26, 150
    d, w, (top, bot) = text_path(F800, WORD, size, tracking=-1.5)
    sym_w = sym_h * (BB_W / BB_H)
    W = max(sym_w, w) + 2 * pad
    H = pad + sym_h + gap + top + bot + pad
    body = (symbol_at((W - sym_w) / 2, pad, sym_h, body_c, lead_c, chk_c)
            + f'<g transform="translate({(W + w) / 2:.2f},{pad + sym_h + gap + top:.2f})">'
              f'<path fill="{color}" d="{d}"/></g>')
    return svg(round(W), round(H), body)
write('mesimon-logo-stacked.svg',       stacked(BRAND_DARK, BRAND, MINT_MID, BRAND))
write('mesimon-logo-stacked-white.svg', stacked('#ffffff', '#ffffff', '#ffffff', '#ffffff'))

# 7. social / OG card 1200×630
def social():
    sym_h = 190
    sym_w = sym_h * (BB_W / BB_H)
    size = 150
    d, w, (wtop, wbot) = text_path(F800, WORD, size, tracking=-2)
    ts = 46
    td, tw, (ttop, tbot) = text_path(F600, TAG, ts)
    cx = 600
    block_h = sym_h + 64 + wtop + wbot + ts * .7 + ttop + tbot
    sym_y = (630 - block_h) / 2
    base = sym_y + sym_h + 64 + wtop
    tbase = base + wbot + ts * .7 + ttop
    body = ('<rect width="1200" height="630" fill="url(#g)"/>'
            + symbol_at(cx - sym_w / 2, sym_y, sym_h, '#ffffff', MINT, '#ffffff')
            + f'<g transform="translate({cx + w / 2:.2f},{base:.2f})"><path fill="#ffffff" d="{d}"/></g>'
            + f'<g transform="translate({cx + tw / 2:.2f},{tbase:.2f})" opacity=".9">'
              f'<path fill="{MINT}" d="{td}"/></g>')
    return svg(1200, 630, body, GRAD)
write('mesimon-social.svg', social())

# 8. compact icon — for 32px and below: the check only, so it stays legible
COMPACT = 'M112 290 L200 378 L406 162'
def compact(tile_rx=0):
    body = (f'<rect width="512" height="512" rx="{tile_rx}" fill="url(#g)"/>'
            f'<path d="{COMPACT}" fill="none" stroke="#ffffff" stroke-width="72"'
            f' stroke-linecap="round" stroke-linejoin="round"/>')
    return svg(512, 512, body, GRAD)
write('mesimon-icon-compact.svg', compact())
