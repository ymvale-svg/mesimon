# מצלמה וירטואלית לסרטוני "מה חדש": חיתוך מוגדל לכל פריים לפי נקודות המפתח
# שהבמאי רשם, עם האטה רכה בתחילת כל תנועה ובסופה. החיתוך בדיוק תת-פיקסלי
# (resize עם box), ולכן ההתקרבות חלקה ובלי רעד.
#
#   python3 camera.py <recording.json> <out-dir> <fps>
#
# הפריימים בהקלטה אינם בקצב קבוע (צילום נגמר כשהוא נגמר) — לכל פריים בפלט
# נלקח הפריים האחרון שצולם עד אותו רגע.
import glob
import json
import os
import sys

from PIL import Image

cfg = json.load(open(sys.argv[1]))
out, fps = sys.argv[2], int(sys.argv[3])
W, H = cfg['W'], cfg['H']
cam, begin, end, frames = cfg['cam'], cfg['begin'], cfg['end'], cfg['frames']


def ease(s):
    return s * s * (3 - 2 * s)


def at(t):
    if t <= cam[0]['t']:
        k = cam[0]
        return k['cx'], k['cy'], k['z']
    for a, b in zip(cam, cam[1:]):
        if t <= b['t']:
            s = ease((t - a['t']) / max(1e-6, b['t'] - a['t']))
            return tuple(a[f] + (b[f] - a[f]) * s for f in ('cx', 'cy', 'z'))
    k = cam[-1]
    return k['cx'], k['cy'], k['z']


os.makedirs(out, exist_ok=True)
for f in glob.glob(f'{out}/*.png'):
    os.remove(f)

n = int((end - begin) * fps)
j = 0
for i in range(n):
    t = begin + i / fps
    while j + 1 < len(frames) and frames[j + 1]['t'] <= t:
        j += 1
    img = Image.open(frames[j]['file']).convert('RGB')
    S = img.width / W                       # פיקסלים בפריים לכל פיקסל CSS
    cx, cy, z = at(t)
    w, h = W / z, H / z
    x0 = min(max(cx - w / 2, 0), W - w)
    y0 = min(max(cy - h / 2, 0), H - h)
    img.resize((W, H), Image.LANCZOS, box=(x0 * S, y0 * S, (x0 + w) * S, (y0 + h) * S)).save(f'{out}/{i:05d}.png')
print(n)
