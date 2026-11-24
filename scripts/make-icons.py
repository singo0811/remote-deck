"""Generate every icon size / platform asset from assets/icons/icon-1024.png."""
import json
import os
import sys
from PIL import Image

repo = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else '.')
src = Image.open(os.path.join(repo, 'assets', 'icons', 'icon-1024.png')).convert('RGBA')

def save(img, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, 'PNG', optimize=True)

# --- generic size set ---
for size in (16, 24, 32, 48, 64, 128, 180, 192, 256, 512):
    save(src.resize((size, size), Image.LANCZOS), os.path.join(repo, 'assets', 'icons', f'icon-{size}.png'))

# --- Windows .ico (multi resolution) ---
ico_path = os.path.join(repo, 'assets', 'icons', 'remotedeck.ico')
src.save(ico_path, format='ICO', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print('ico', ico_path)

# --- web assets ---
web_public = os.path.join(repo, 'apps', 'web', 'public')
save(src.resize((512, 512), Image.LANCZOS), os.path.join(web_public, 'icon-512.png'))
save(src.resize((192, 192), Image.LANCZOS), os.path.join(web_public, 'icon-192.png'))
save(src.resize((180, 180), Image.LANCZOS), os.path.join(web_public, 'apple-touch-icon.png'))
save(src.resize((32, 32), Image.LANCZOS), os.path.join(web_public, 'favicon-32.png'))

# --- harmony layered icon: background = gradient plate, foreground = screen art ---
harmony_media = os.path.join(repo, 'apps', 'harmony', 'entry', 'src', 'main', 'resources', 'base', 'media')
plate = src.copy()
# foreground keeps only the white screen + stand on transparency
fw, fh = plate.size
fg = Image.new('RGBA', plate.size, (0, 0, 0, 0))
px = plate.load()
fgpx = fg.load()
for y in range(fh):
    for x in range(fw):
        r, g, b, a = px[x, y]
        # keep near-white pixels (screen face, stand, play triangle) as foreground
        if a > 200 and r > 210 and g > 220 and b > 230:
            fgpx[x, y] = (255, 255, 255, a)
        elif a > 200 and r > 180 and g > 200 and b > 210 and abs(r - g) < 40:
            fgpx[x, y] = (255, 255, 255, a)
save(fg.resize((512, 512), Image.LANCZOS), os.path.join(harmony_media, 'foreground.png'))
save(src.resize((512, 512), Image.LANCZOS), os.path.join(harmony_media, 'background.png'))
save(src.resize((256, 256), Image.LANCZOS), os.path.join(harmony_media, 'startIcon.png'))

# --- desktop tray / window icon ---
desktop_assets = os.path.join(repo, 'apps', 'desktop', 'assets')
save(src.resize((256, 256), Image.LANCZOS), os.path.join(desktop_assets, 'icon-256.png'))
save(src.resize((64, 64), Image.LANCZOS), os.path.join(desktop_assets, 'tray-64.png'))
print('done')
