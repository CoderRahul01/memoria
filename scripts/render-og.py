#!/usr/bin/env python3
"""Renders the 1200×630 social preview (public/media/og-card.png) from the demo's cover frame.

Usage: python3 scripts/render-og.py   (needs Pillow; fonts are in design/fonts, all OFL)
"""
import os
import random
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONTS = os.path.join(ROOT, 'design', 'fonts')
MEDIA = os.path.join(ROOT, 'public', 'media')
S = 2                      # draw at 2x, downscale for crisp edges
W, H = 1200 * S, 630 * S

PAPER, CARD, INK, INK2, ACCENT, NIGHT = '#F5EFE4', '#FBF8F2', '#221C17', '#5A4F45', '#B4472C', '#2A211B'


def font(name, size, axes=None, named=None):
    f = ImageFont.truetype(os.path.join(FONTS, name), size * S)
    if named:
        f.set_variation_by_name(named)
    if axes:
        current = {a['name'].decode() if isinstance(a['name'], bytes) else a['name']: a['default'] for a in f.get_variation_axes()}
        current.update(axes)
        f.set_variation_by_axes(list(current.values()))
    return f


serif = font('Fraunces.ttf', 52, axes={'Optical size': 144, 'Weight': 440})
serif_i = font('Fraunces-Italic.ttf', 52, axes={'Optical size': 144, 'Weight': 400})
logo_f = font('Fraunces.ttf', 30, axes={'Optical size': 48, 'Weight': 600})
body = font('InstrumentSans.ttf', 22, named='Regular')
semi = font('InstrumentSans.ttf', 20, named='SemiBold')
small = font('InstrumentSans.ttf', 17, named='SemiBold')
hand = font('Caveat.ttf', 32, named='Bold')

img = Image.new('RGB', (W, H), PAPER)

# Paper grain
random.seed(7)
grain = Image.new('L', (W // 2, H // 2))
grain.putdata([random.randint(0, 255) for _ in range(grain.width * grain.height)])
grain = grain.resize((W, H)).filter(ImageFilter.GaussianBlur(0.6))
img = Image.composite(Image.new('RGB', (W, H), '#E9E0CF'), img, grain.point(lambda v: 22 if v > 200 else 0))
d = ImageDraw.Draw(img)


def p(x, y):
    return (x * S, y * S)


# Logo: a small cassette + wordmark
lx, ly = 64, 58
d.rounded_rectangle([p(lx, ly), p(lx + 44, ly + 28)], radius=4 * S, outline=ACCENT, width=round(2.4 * S))
for cx in (lx + 14, lx + 30):
    d.ellipse([p(cx - 5, ly + 9), p(cx + 5, ly + 19)], outline=ACCENT, width=round(2.4 * S))
d.line([p(lx + 14, ly + 19), p(lx + 30, ly + 19)], fill=ACCENT, width=round(2.4 * S))
d.text(p(lx + 56, ly - 4), 'memoria', font=logo_f, fill=INK)

# Headline
x0, y = 64, 132
d.text(p(x0, y), 'The stories only they', font=serif, fill=INK)
y += 58
w_know = d.textlength('know, ', font=serif) / S
d.text(p(x0, y), 'know, ', font=serif, fill=INK)
d.text(p(x0 + w_know, y), 'kept in their', font=serif_i, fill=ACCENT)
y += 58
d.text(p(x0, y), 'own words.', font=serif_i, fill=ACCENT)

# Supporting line
y += 92
for line in ('Press record and let them talk. The whole', 'family can ask about it, years from now.'):
    d.text(p(x0, y), line, font=body, fill=INK2)
    y += 32

# CTA pill with a play triangle
y += 26
label = 'Watch the 2-minute demo'
tw = d.textlength(label, font=semi) / S
pw, ph = tw + 76, 54
shadow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
ImageDraw.Draw(shadow).rounded_rectangle([p(x0, y + 10), p(x0 + pw, y + ph + 10)], radius=27 * S, fill=(180, 71, 44, 110))
img.paste(shadow.filter(ImageFilter.GaussianBlur(14 * S)), (0, 0), shadow.filter(ImageFilter.GaussianBlur(14 * S)))
d = ImageDraw.Draw(img)
d.rounded_rectangle([p(x0, y), p(x0 + pw, y + ph)], radius=27 * S, fill=ACCENT)
d.polygon([p(x0 + 26, y + 17), p(x0 + 26, y + 37), p(x0 + 42, y + 27)], fill='#FFF8F2')
d.text(p(x0 + 54, y + 15), label, font=semi, fill='#FFF8F2')

# Address line
d.text(p(64, 572), 'memoria-family.vercel.app  ·  free to start', font=small, fill=INK2)

# ── The "video" photo on the right ────────────────────────────
cw, shot_h, pad, foot = 540, 316, 14, 58
card = Image.new('RGBA', (cw * S, (pad + shot_h + foot) * S), (0, 0, 0, 0))
cd = ImageDraw.Draw(card)
cd.rounded_rectangle([0, 0, card.width - 1, card.height - 1], radius=6 * S, fill=CARD)

frame = Image.open(os.path.join(MEDIA, 'memoria-demo.jpg')).convert('RGB')
sw, sh = (cw - 2 * pad) * S, shot_h * S
scale = max(sw / frame.width, sh / frame.height)
frame = frame.resize((round(frame.width * scale), round(frame.height * scale)), Image.LANCZOS)
top = 0
left = 0  # keep Rahul's webcam bubble (top-left) and the cassette in frame
frame = frame.crop((left, top, left + sw, top + sh))
# Darken the bottom a little so the badges read
grad = Image.linear_gradient('L').resize((sw, sh)).point(lambda v: max(0, v - 128) * 0.7)
frame = Image.composite(Image.new('RGB', (sw, sh), '#221C17'), frame, grad.convert('L'))
mask = Image.new('L', (sw, sh), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, sw - 1, sh - 1], radius=3 * S, fill=255)
card.paste(frame, (pad * S, pad * S), mask)

cd = ImageDraw.Draw(card)
# Play button with a soft ring
cx, cy, r = pad * S + round(sw * 0.5), pad * S + round(sh * 0.62), 40 * S
ring = Image.new('RGBA', card.size, (0, 0, 0, 0))
rd = ImageDraw.Draw(ring)
rd.ellipse([cx - r - 11 * S, cy - r - 11 * S, cx + r + 11 * S, cy + r + 11 * S], fill=(255, 248, 242, 120))
rd.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(180, 71, 44, 245))
card = Image.alpha_composite(card, ring)
cd = ImageDraw.Draw(card)
cd.polygon([(cx - 11 * S, cy - 17 * S), (cx - 11 * S, cy + 17 * S), (cx + 19 * S, cy)], fill='#FFF8F2')

# "Recording" pill and duration badge
rec = "Recording Nani's advice"
rw = d.textlength(rec, font=small) / S + 40
pill = Image.new('RGBA', card.size, (0, 0, 0, 0))
pd = ImageDraw.Draw(pill)
bx, by = (pad + 12) * S, (pad + shot_h - 44) * S
pd.rounded_rectangle([bx, by, bx + rw * S, by + 32 * S], radius=16 * S, fill=(20, 16, 13, 205))
dx, dy = (pad + cw - 2 * pad - 12) * S, (pad + shot_h - 12) * S
dur_w = d.textlength('1:56', font=small) / S + 22
pd.rounded_rectangle([dx - dur_w * S, dy - 30 * S, dx, dy], radius=6 * S, fill=(20, 16, 13, 215))
card = Image.alpha_composite(card, pill)
cd = ImageDraw.Draw(card)
cd.ellipse([bx + 13 * S, by + 11 * S, bx + 23 * S, by + 21 * S], fill='#E2543A')
cd.text((bx + 30 * S, by + 6 * S), rec, font=small, fill='white')
cd.text((dx - (dur_w - 11) * S, dy - 26 * S), '1:56', font=small, fill='white')

# Handwritten caption under the photo
cd.text((22 * S, (pad + shot_h + 10) * S), 'rahul shows how it works', font=hand, fill=INK2)

rot = card.rotate(-2.2, resample=Image.BICUBIC, expand=True)
ox, oy = 616 * S, 86 * S
sh_layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
alpha = rot.split()[3].point(lambda v: int(v * 0.42))
sh_layer.paste((60, 40, 20, 255), (ox + 4 * S, oy + 26 * S), alpha)
sh_layer = sh_layer.filter(ImageFilter.GaussianBlur(26 * S))
img = Image.alpha_composite(img.convert('RGBA'), sh_layer)
img.alpha_composite(rot, (ox, oy))

out = img.convert('RGB').resize((1200, 630), Image.LANCZOS)
out.save(os.path.join(MEDIA, 'og-card.png'), optimize=True)
out.save(os.path.join(MEDIA, 'og-card.jpg'), quality=88, optimize=True, progressive=True)
print('wrote public/media/og-card.png and og-card.jpg')
