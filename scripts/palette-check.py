# Distinguishability of the graph's four column colours (Spec §6.3, D53): CIEDE2000 between every pair, with normal
# vision and with simulated protanopia and deuteranopia (Machado et al. 2009, severity 1.0), and each colour's lightness
# on the graph's background. Plan and Work item share a shape, so that pair has to hold up under colour-vision
# deficiency; the other pairs also differ by shape and by the category written on the object.
# usage: python palette-check.py <name>=<#hex> ... [--bg #hex]
import sys, math, itertools

def srgb_to_lin(c):
    c /= 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
def lin_to_srgb(c):
    c = min(1.0, max(0.0, c))
    return 255.0 * (12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055)
def hex_rgb(h): h = h.lstrip('#'); return [int(h[i:i + 2], 16) for i in (0, 2, 4)]
MACHADO = {
    'protan': [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
    'deutan': [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
}
def simulate(rgb, kind):
    lin = [srgb_to_lin(c) for c in rgb]
    m = MACHADO[kind]
    return [lin_to_srgb(sum(m[i][j] * lin[j] for j in range(3))) for i in range(3)]
def lab(rgb):
    r, g, b = [srgb_to_lin(c) for c in rgb]
    x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047
    y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b
    z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883
    f = lambda t: t ** (1 / 3) if t > 216 / 24389 else (24389 / 27 * t + 16) / 116
    return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))]
def de2000(l1, l2):
    L1, a1, b1 = l1; L2, a2, b2 = l2
    C1, C2 = math.hypot(a1, b1), math.hypot(a2, b2)
    Cb = (C1 + C2) / 2
    G = 0.5 * (1 - math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)))
    a1p, a2p = (1 + G) * a1, (1 + G) * a2
    C1p, C2p = math.hypot(a1p, b1), math.hypot(a2p, b2)
    h1p = math.degrees(math.atan2(b1, a1p)) % 360
    h2p = math.degrees(math.atan2(b2, a2p)) % 360
    dLp, dCp = L2 - L1, C2p - C1p
    dhp = 0 if C1p * C2p == 0 else (h2p - h1p if abs(h2p - h1p) <= 180 else h2p - h1p - 360 if h2p - h1p > 180 else h2p - h1p + 360)
    dHp = 2 * math.sqrt(C1p * C2p) * math.sin(math.radians(dhp / 2))
    Lbp, Cbp = (L1 + L2) / 2, (C1p + C2p) / 2
    hbp = h1p + h2p if C1p * C2p == 0 else ((h1p + h2p) / 2 if abs(h1p - h2p) <= 180 else (h1p + h2p + 360) / 2 if h1p + h2p < 360 else (h1p + h2p - 360) / 2)
    T = 1 - 0.17 * math.cos(math.radians(hbp - 30)) + 0.24 * math.cos(math.radians(2 * hbp)) + 0.32 * math.cos(math.radians(3 * hbp + 6)) - 0.20 * math.cos(math.radians(4 * hbp - 63))
    dth = 30 * math.exp(-(((hbp - 275) / 25) ** 2))
    Rc = 2 * math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7))
    Sl = 1 + 0.015 * (Lbp - 50) ** 2 / math.sqrt(20 + (Lbp - 50) ** 2)
    Sc, Sh = 1 + 0.045 * Cbp, 1 + 0.015 * Cbp * T
    Rt = -math.sin(math.radians(2 * dth)) * Rc
    return math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh))
def rel_lum(rgb):
    r, g, b = [srgb_to_lin(c) for c in rgb]
    return 0.2126 * r + 0.7152 * g + 0.0722 * b

args = sys.argv[1:]
bg = '#1c1c1a'
if '--bg' in args: i = args.index('--bg'); bg = args[i + 1]; args = args[:i] + args[i + 2:]
cols = dict(a.split('=') for a in args)
lb = rel_lum(hex_rgb(bg))
print(f'background {bg}')
print(f'{"colour":<10}{"hex":<9}{"L*":>6}{"contrast":>10}')
for n, hx in cols.items():
    rgb = hex_rgb(hx); L = lab(rgb)[0]; lr = rel_lum(rgb)
    print(f'{n:<10}{hx:<9}{L:>6.1f}{(max(lr, lb) + 0.05) / (min(lr, lb) + 0.05):>10.2f}')
Ls = [lab(hex_rgb(h))[0] for h in cols.values()]
print(f'L* spread {max(Ls) - min(Ls):.1f}')
print(f'{"pair":<22}{"normal":>8}{"protan":>8}{"deutan":>8}')
for (n1, h1), (n2, h2) in itertools.combinations(cols.items(), 2):
    r1, r2 = hex_rgb(h1), hex_rgb(h2)
    row = [de2000(lab(r1), lab(r2))] + [de2000(lab(simulate(r1, k)), lab(simulate(r2, k))) for k in ('protan', 'deutan')]
    print(f'{n1 + " / " + n2:<22}' + ''.join(f'{v:>8.1f}' for v in row))
