"""Build HarmonyOS layered-icon resources (background plate + transparent foreground)."""
import os
import sys
from PIL import Image, ImageDraw

repo = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else '.')
src = Image.open(os.path.join(repo, 'assets', 'icons', 'icon-1024.png')).convert('RGBA')

# --- background: brand gradient plate, full bleed ---
bg = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
bd = ImageDraw.Draw(bg)
top = (56, 189, 248)
bottom = (30, 58, 138)
for y in range(1024):
    t = y / 1023
    # bias the highlight toward the top-left like the master artwork
    color = tuple(int(top[i] + (bottom[i] - top[i]) * (t ** 0.85)) for i in range(3))
    bd.line([(0, y), (1024, y)], fill=color + (255,))
bd.rounded_rectangle([0, 0, 1023, 1023], radius=232, fill=None, outline=None, width=0)

# --- foreground: solid white console silhouette (screen + stand) ---
fg = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
fd = ImageDraw.Draw(fg)
S = 2  # master coordinates are 512 based
screen = [(110, 181), (401, 151), (419, 339), (121, 374)]
fd.polygon([(x * S, y * S) for x, y in screen], fill=(255, 255, 255, 255))
fd.polygon([(x * S, y * S) for x, y in [(228, 386), (283, 381), (293, 424), (218, 430)]], fill=(255, 255, 255, 255))
fd.rounded_rectangle([196 * S, 424 * S, 336 * S, 444 * S], radius=10 * S, fill=(255, 255, 255, 255))
# punch the play badge out so the background gradient shows through
badge = [330 * S - 34 * S, 214 * S - 34 * S, 330 * S + 34 * S, 214 * S + 34 * S]
mask = Image.new('L', (1024, 1024), 0)
ImageDraw.Draw(mask).ellipse(badge, fill=255)
fg.putalpha(Image.composite(Image.new('L', (1024, 1024), 0), fg.getchannel('A'), mask))
# two bars inside the screen become gaps
for bar in ([(136, 302), (386, 276)], [(158, 336), (352, 316)]):
    fd.line([(bar[0][0] * S, bar[0][1] * S), (bar[1][0] * S, bar[1][1] * S)],
            fill=(255, 255, 255, 0), width=14 * S)

# scale the artwork to ~66% so the launcher mask never clips it
def shrink(img):
    inner = img.resize((int(1024 * 0.66), int(1024 * 0.66)), Image.LANCZOS)
    out = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
    out.paste(inner, ((1024 - inner.width) // 2, (1024 - inner.height) // 2), inner)
    return out

fg = shrink(fg)

targets = [
    os.path.join(repo, 'apps', 'harmony', 'AppScope', 'resources', 'base', 'media'),
    os.path.join(repo, 'apps', 'harmony', 'entry', 'src', 'main', 'resources', 'base', 'media'),
]
for d in targets:
    os.makedirs(d, exist_ok=True)
    bg.resize((512, 512), Image.LANCZOS).save(os.path.join(d, 'background.png'), 'PNG', optimize=True)
    fg.resize((512, 512), Image.LANCZOS).save(os.path.join(d, 'foreground.png'), 'PNG', optimize=True)
    src.resize((256, 256), Image.LANCZOS).save(os.path.join(d, 'startIcon.png'), 'PNG', optimize=True)
    src.resize((216, 216), Image.LANCZOS).save(os.path.join(d, 'app_icon.png'), 'PNG', optimize=True)
print('harmony icons written')
